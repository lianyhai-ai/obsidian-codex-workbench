import { spawn, type ChildProcess } from "child_process";
import { existsSync, readFileSync, realpathSync } from "fs";
import { createServer } from "net";
import path from "path";
import WebSocket, { type RawData } from "ws";
import type { CodexWorkbenchSettings } from "./types";

const CLIENT_NAME = "codex-workbench";
const CLIENT_VERSION = "0.1.0";
const SOCKET_CONNECT_ATTEMPTS = 30;
const SOCKET_CONNECT_DELAY_MS = 250;
const REQUEST_TIMEOUT_MS = 90_000;
const COMMON_EXECUTABLE_DIRS = [
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];

type JsonRpcResponse = {
  id: number | string;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

type JsonRpcNotification = {
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcServerRequest = {
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
};

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeoutHandle: ReturnType<typeof globalThis.setTimeout>;
};

type ActiveTurn = {
  threadId: string;
  turnId: string;
  answer: string;
  interruptRequested: boolean;
  onDelta?: (delta: string) => void;
  resolve: (value: LocalCodexTurnResult) => void;
  reject: (reason?: unknown) => void;
};

export interface LocalCodexTurnRequest {
  prompt: string;
  cwd: string;
  settings: CodexWorkbenchSettings;
  onDelta?: (delta: string) => void;
}

export interface LocalCodexTurnResult {
  threadId: string;
  turnId: string;
  answer: string;
}

export interface LocalCodexHistoryEntry {
  role: "user" | "assistant";
  content: string;
}

export interface LocalCodexRestoreResult {
  threadId: string;
  history: LocalCodexHistoryEntry[];
}

export class LocalCodexTurnInterruptedError extends Error {
  partialAnswer: string;

  constructor(partialAnswer = "") {
    super("Codex turn was interrupted.");
    this.name = "LocalCodexTurnInterruptedError";
    this.partialAnswer = partialAnswer;
  }
}

export type LocalCodexApprovalRequest =
  | {
      kind: "command";
      reason: string;
      command: string;
      cwd: string;
      canApproveForSession: boolean;
    }
  | {
      kind: "file-change";
      reason: string;
      summary: string;
      canApproveForSession: boolean;
    }
  | {
      kind: "permissions";
      reason: string;
      summary: string;
      permissions: {
        network?: unknown;
        fileSystem?: unknown;
      };
    };

export type LocalCodexApprovalResponse =
  | {
      decision: "accept" | "acceptForSession" | "decline" | "cancel";
    }
  | {
      permissions: {
        network?: unknown;
        fileSystem?: unknown;
      };
      scope: "turn" | "session";
    };

type ApprovalHandler = (request: LocalCodexApprovalRequest) => Promise<LocalCodexApprovalResponse>;

export class LocalCodexAppServerClient {
  private childProcess: ChildProcess | null = null;
  private socket: WebSocket | null = null;
  private port: number | null = null;
  private initialized = false;
  private requestCounter = 0;
  private connectPromise: Promise<void> | null = null;
  private pendingRequests = new Map<number, PendingRequest>();
  private activeTurn: ActiveTurn | null = null;
  private activeThreadId: string | null = null;
  private activeThreadReadyOnServer = false;
  private activeThreadConfigSignature: string | null = null;
  private activeCliPath: string | null = null;
  private lastProcessError = "";
  private isDisposing = false;
  private approvalHandler: ApprovalHandler | null = null;

  get threadId(): string | null {
    return this.activeThreadId;
  }

  get hasActiveTurn(): boolean {
    return Boolean(this.activeTurn);
  }

  setApprovalHandler(handler: ApprovalHandler): void {
    this.approvalHandler = handler;
  }

  resetThread(): void {
    this.activeThreadId = null;
    this.activeThreadReadyOnServer = false;
    this.activeThreadConfigSignature = null;
  }

  async restoreThread(threadId: string, cwd: string, settings: CodexWorkbenchSettings): Promise<LocalCodexRestoreResult> {
    await this.ensureConnected(settings);

    const response = (await this.sendRequest("thread/resume", buildThreadResumeParams(threadId, cwd, settings))) as {
      thread?: {
        id?: string;
        turns?: Array<{
          items?: Array<Record<string, unknown>>;
        }>;
      };
    };

    const restoredThreadId = response.thread?.id;
    if (!restoredThreadId) {
      throw new Error("Codex app-server could not resume the saved thread.");
    }

    this.activeThreadId = restoredThreadId;
    this.activeThreadReadyOnServer = true;
    this.activeThreadConfigSignature = buildThreadConfigSignature(cwd, settings);

    return {
      threadId: restoredThreadId,
      history: parseThreadHistory(response.thread?.turns ?? []),
    };
  }

  async sendTurn(request: LocalCodexTurnRequest): Promise<LocalCodexTurnResult> {
    if (this.activeTurn) {
      throw new Error("Codex is still working on the previous turn.");
    }

    await this.ensureConnected(request.settings);

    const threadId = await this.prepareThread(request);
    const turnResponse = (await this.sendRequest("turn/start", {
      threadId,
      approvalPolicy: request.settings.codexApprovalMode,
      model: request.settings.model || null,
      input: [
        {
          type: "text",
          text: request.prompt,
          text_elements: [],
        },
      ],
    })) as {
      turn?: {
        id?: string;
      };
    };

    const turnId = turnResponse.turn?.id;
    if (!turnId) {
      throw new Error("Codex app-server did not return a turn id.");
    }

    return await new Promise<LocalCodexTurnResult>((resolve, reject) => {
      this.activeTurn = {
        threadId,
        turnId,
        answer: "",
        interruptRequested: false,
        onDelta: request.onDelta,
        resolve,
        reject,
      };
    });
  }

  async interruptTurn(): Promise<boolean> {
    const activeTurn = this.activeTurn;
    if (!activeTurn) {
      return false;
    }

    if (activeTurn.interruptRequested) {
      return true;
    }

    activeTurn.interruptRequested = true;

    try {
      await this.sendRequest("turn/interrupt", {
        threadId: activeTurn.threadId,
        turnId: activeTurn.turnId,
      });
      return true;
    } catch (error) {
      if (this.activeTurn?.turnId === activeTurn.turnId) {
        this.activeTurn.interruptRequested = false;
      }
      throw error;
    }
  }

  async dispose(): Promise<void> {
    this.isDisposing = true;
    this.rejectPendingRequests(new Error("Codex app-server client disposed."));
    this.rejectActiveTurn(new Error("Codex app-server client disposed."));

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }

    if (this.childProcess && this.childProcess.exitCode === null && !this.childProcess.killed) {
      this.childProcess.kill();
    }

    this.childProcess = null;
    this.port = null;
    this.initialized = false;
    this.connectPromise = null;
    this.activeThreadReadyOnServer = false;
    this.activeCliPath = null;
  }

  private async prepareThread(request: LocalCodexTurnRequest): Promise<string> {
    const configSignature = buildThreadConfigSignature(request.cwd, request.settings);

    if (this.activeThreadId && this.activeThreadReadyOnServer && this.activeThreadConfigSignature === configSignature) {
      return this.activeThreadId;
    }

    if (this.activeThreadId) {
      const response = (await this.sendRequest(
        "thread/resume",
        buildThreadResumeParams(this.activeThreadId, request.cwd, request.settings),
      )) as {
        thread?: {
          id?: string;
        };
      };

      const resumedThreadId = response.thread?.id;
      if (!resumedThreadId) {
        throw new Error("Codex app-server could not resume the active thread.");
      }

      this.activeThreadId = resumedThreadId;
      this.activeThreadReadyOnServer = true;
      this.activeThreadConfigSignature = configSignature;
      return resumedThreadId;
    }

    const response = (await this.sendRequest("thread/start", {
      ...buildThreadStartParams(request.cwd, request.settings),
    })) as {
      thread?: {
        id?: string;
      };
    };

    const threadId = response.thread?.id;
    if (!threadId) {
      throw new Error("Codex app-server did not return a thread id.");
    }

    this.activeThreadId = threadId;
    this.activeThreadReadyOnServer = true;
    this.activeThreadConfigSignature = configSignature;
    return threadId;
  }

  private async ensureConnected(settings: CodexWorkbenchSettings): Promise<void> {
    const cliPath = settings.codexCliPath || "codex";
    if (this.socket?.readyState === WebSocket.OPEN && this.initialized && this.activeCliPath === cliPath) {
      return;
    }

    if (this.connectPromise) {
      return await this.connectPromise;
    }

    this.connectPromise = this.startAndInitialize(settings).finally(() => {
      this.connectPromise = null;
    });

    return await this.connectPromise;
  }

  private async startAndInitialize(settings: CodexWorkbenchSettings): Promise<void> {
    this.isDisposing = false;
    await this.restartServerProcess(settings.codexCliPath || "codex");
    await this.connectSocket();
    await this.sendRequest("initialize", {
      clientInfo: {
        name: CLIENT_NAME,
        title: "Codex Workbench",
        version: CLIENT_VERSION,
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.initialized = true;
    this.activeThreadReadyOnServer = false;
  }

  private async restartServerProcess(cliPath: string): Promise<void> {
    if (this.childProcess && this.childProcess.exitCode === null && !this.childProcess.killed) {
      this.childProcess.kill();
    }

    this.port = await findOpenPort();
    this.lastProcessError = "";
    this.activeCliPath = cliPath;

    const listenUrl = `ws://127.0.0.1:${this.port}`;
    const launch = resolveCodexLaunch(cliPath, ["app-server", "--listen", listenUrl]);
    const childProcess = spawn(launch.command, launch.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: launch.env,
    });

    this.childProcess = childProcess;

    childProcess.stdout?.on("data", (chunk) => {
      this.lastProcessError = tailLog(this.lastProcessError, chunk.toString());
    });

    childProcess.stderr?.on("data", (chunk) => {
      this.lastProcessError = tailLog(this.lastProcessError, chunk.toString());
    });

    childProcess.on("error", (error) => {
      this.lastProcessError = tailLog(this.lastProcessError, error.message);
    });

    childProcess.on("exit", (code, signal) => {
      if (this.isDisposing) {
        return;
      }

      const details = code !== null ? `exit code ${code}` : `signal ${signal ?? "unknown"}`;
      const error = new Error(`Codex app-server stopped unexpectedly (${details}). ${this.lastProcessError}`.trim());
      this.initialized = false;
      this.socket = null;
      this.activeThreadReadyOnServer = false;
      this.rejectPendingRequests(error);
      this.rejectActiveTurn(error);
    });
  }

  private async connectSocket(): Promise<void> {
    const port = this.port;
    if (!port) {
      throw new Error("Codex app-server port is not available.");
    }

    const url = `ws://127.0.0.1:${port}`;
    let lastError: unknown = null;

    for (let attempt = 0; attempt < SOCKET_CONNECT_ATTEMPTS; attempt += 1) {
      try {
        const socket = await openWebSocket(url);
        this.socket = socket;
        socket.on("message", (data: RawData) => {
          this.handleSocketMessage(String(data));
        });
        socket.on("close", () => {
          if (this.isDisposing) {
            return;
          }
          this.socket = null;
          this.initialized = false;
          this.activeThreadReadyOnServer = false;
        });
        socket.on("error", () => {
          if (!this.isDisposing) {
            this.initialized = false;
            this.activeThreadReadyOnServer = false;
          }
        });
        return;
      } catch (error) {
        lastError = error;
        await delay(SOCKET_CONNECT_DELAY_MS);
      }
    }

    const message = lastError instanceof Error ? lastError.message : "Unknown socket connection failure";
    throw new Error(`Could not connect to the local Codex app-server. ${message} ${this.lastProcessError}`.trim());
  }

  private async sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Codex app-server socket is not connected.");
    }

    const id = ++this.requestCounter;

    return await new Promise((resolve, reject) => {
      const timeoutHandle = globalThis.setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Timed out waiting for ${method} response from Codex app-server.`));
      }, REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(id, {
        method,
        resolve,
        reject,
        timeoutHandle,
      });

      this.socket?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          params,
        }),
      );
    });
  }

  private handleSocketMessage(rawMessage: string): void {
    const message = JSON.parse(rawMessage) as JsonRpcResponse | JsonRpcNotification | JsonRpcServerRequest;

    if ("method" in message && "id" in message) {
      void this.handleServerRequest(message);
      return;
    }

    if ("id" in message) {
      this.handleResponse(message);
      return;
    }

    this.handleNotification(message);
  }

  private handleResponse(message: JsonRpcResponse): void {
    const requestId = typeof message.id === "string" ? Number(message.id) : message.id;
    const pendingRequest = this.pendingRequests.get(requestId);
    if (!pendingRequest) {
      return;
    }

    globalThis.clearTimeout(pendingRequest.timeoutHandle);
    this.pendingRequests.delete(requestId);

    if (message.error) {
      pendingRequest.reject(new Error(message.error.message || `Codex app-server ${pendingRequest.method} request failed.`));
      return;
    }

    pendingRequest.resolve(message.result);
  }

  private async handleServerRequest(message: JsonRpcServerRequest): Promise<void> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      const result = await this.resolveServerRequest(message);
      this.socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result,
        }),
      );
    } catch (error) {
      this.socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : `Codex Workbench could not resolve ${message.method}.`,
          },
        }),
      );
    }
  }

  private async resolveServerRequest(message: JsonRpcServerRequest): Promise<unknown> {
    if (!this.approvalHandler) {
      throw new Error(`No approval handler is registered for ${message.method}.`);
    }

    const params = message.params ?? {};

    if (message.method === "item/commandExecution/requestApproval") {
      const availableDecisions = Array.isArray(params.availableDecisions) ? params.availableDecisions : [];
      const response = await this.approvalHandler({
        kind: "command",
        reason: readString(params.reason) || "Codex wants to run a shell command.",
        command: readString(params.command) || "(command unavailable)",
        cwd: readString(params.cwd) || "(cwd unavailable)",
        canApproveForSession: availableDecisions.some((decision) => decision === "acceptForSession"),
      });
      return response;
    }

    if (message.method === "item/fileChange/requestApproval") {
      const grantRoot = readString(params.grantRoot);
      const response = await this.approvalHandler({
        kind: "file-change",
        reason: readString(params.reason) || "Codex wants to apply file changes.",
        summary: grantRoot ? `Requested root: ${grantRoot}` : "Codex requested file-change approval.",
        canApproveForSession: true,
      });
      return response;
    }

    if (message.method === "item/permissions/requestApproval") {
      const permissions = (params.permissions ?? {}) as Record<string, unknown>;
      const response = await this.approvalHandler({
        kind: "permissions",
        reason: readString(params.reason) || "Codex is asking for additional permissions.",
        summary: summarizePermissions(permissions),
        permissions,
      });
      return response;
    }

    throw new Error(`Codex Workbench MVP does not implement server request handling for ${message.method}.`);
  }

  private handleNotification(message: JsonRpcNotification): void {
    if (!this.activeTurn) {
      return;
    }

    const params = message.params ?? {};
    const threadId = readString(params.threadId);
    const turnId = readString(params.turnId);

    if (threadId && threadId !== this.activeTurn.threadId) {
      return;
    }

    if (turnId && turnId !== this.activeTurn.turnId) {
      return;
    }

    if (message.method === "item/agentMessage/delta") {
      const delta = readString(params.delta) || "";
      if (!delta) {
        return;
      }

      this.activeTurn.answer += delta;
      this.activeTurn.onDelta?.(delta);
      return;
    }

    if (message.method === "item/completed") {
      const item = params.item as Record<string, unknown> | undefined;
      if (item?.type === "agentMessage" && typeof item.text === "string") {
        this.activeTurn.answer = item.text;
      }
      return;
    }

    if (message.method === "error") {
      const errorPayload = params.error as Record<string, unknown> | undefined;
      const errorMessage = readString(errorPayload?.message) || "Codex app-server turn failed.";
      this.rejectActiveTurn(new Error(errorMessage));
      return;
    }

    if (message.method === "turn/completed") {
      const turn = params.turn as Record<string, unknown> | undefined;
      const status = readString(turn?.status);
      if (status === "interrupted") {
        this.rejectActiveTurn(new LocalCodexTurnInterruptedError(this.activeTurn.answer.trim()));
        return;
      }

      if (status === "failed") {
        const turnError = turn?.error as Record<string, unknown> | undefined;
        const errorMessage = readString(turnError?.message) || "Codex app-server turn failed.";
        this.rejectActiveTurn(new Error(errorMessage));
        return;
      }

      const result: LocalCodexTurnResult = {
        threadId: this.activeTurn.threadId,
        turnId: this.activeTurn.turnId,
        answer: this.activeTurn.answer.trim(),
      };
      this.activeTurn.resolve(result);
      this.activeTurn = null;
    }
  }

  private rejectPendingRequests(error: Error): void {
    this.pendingRequests.forEach((pendingRequest) => {
      globalThis.clearTimeout(pendingRequest.timeoutHandle);
      pendingRequest.reject(error);
    });
    this.pendingRequests.clear();
  }

  private rejectActiveTurn(error: Error): void {
    if (!this.activeTurn) {
      return;
    }

    this.activeTurn.reject(error);
    this.activeTurn = null;
  }
}

async function findOpenPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a port for Codex app-server."));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
  });
}

async function openWebSocket(url: string): Promise<WebSocket> {
  return await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url);

    const cleanup = () => {
      socket.off("open", handleOpen);
      socket.off("error", handleError);
    };

    const handleOpen = () => {
      cleanup();
      resolve(socket);
    };

    const handleError = () => {
      cleanup();
      socket.close();
      reject(new Error(`WebSocket connection failed for ${url}`));
    };

    socket.on("open", handleOpen);
    socket.on("error", handleError);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

function resolveCodexLaunch(cliPath: string, args: string[]): {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
} {
  const cliExecutable = resolveExecutable(cliPath);
  if (!cliExecutable) {
    throw new Error(
      `Could not find the Codex CLI at "${cliPath}". Update the plugin setting to the full codex path, such as /usr/local/bin/codex.`,
    );
  }

  const nodeExecutable = resolveExecutable("node", [path.dirname(cliExecutable)]);
  const env = buildLaunchEnv(cliExecutable, nodeExecutable);

  if (nodeExecutable && isNodeScript(cliExecutable)) {
    return {
      command: nodeExecutable,
      args: [cliExecutable, ...args],
      env,
    };
  }

  return {
    command: cliExecutable,
    args,
    env,
  };
}

function tailLog(current: string, nextChunk: string): string {
  const merged = `${current}\n${nextChunk}`.trim();
  if (merged.length <= 1200) {
    return merged;
  }

  return merged.slice(-1200);
}

function parseThreadHistory(turns: Array<{ items?: Array<Record<string, unknown>> }>): LocalCodexHistoryEntry[] {
  const history: LocalCodexHistoryEntry[] = [];

  turns.forEach((turn) => {
    turn.items?.forEach((item) => {
      if (item.type === "userMessage") {
        const content = Array.isArray(item.content)
          ? item.content
              .flatMap((entry) => {
                if (!entry || typeof entry !== "object") {
                  return [];
                }

                const text = readString((entry as Record<string, unknown>).text);
                return text ? [text] : [];
              })
              .join("\n")
          : "";

        if (content) {
          history.push({
            role: "user",
            content,
          });
        }
      }

      if (item.type === "agentMessage") {
        const text = readString(item.text);
        if (text) {
          history.push({
            role: "assistant",
            content: text,
          });
        }
      }
    });
  });

  return history;
}

function buildThreadStartParams(cwd: string, settings: CodexWorkbenchSettings): Record<string, unknown> {
  return {
    cwd,
    approvalPolicy: settings.codexApprovalMode,
    approvalsReviewer: "user",
    sandbox: settings.codexSandboxMode,
    model: settings.model || null,
    baseInstructions: settings.systemPrompt || null,
    experimentalRawEvents: false,
    persistExtendedHistory: true,
  };
}

function buildThreadResumeParams(
  threadId: string,
  cwd: string,
  settings: CodexWorkbenchSettings,
): Record<string, unknown> {
  return {
    threadId,
    cwd,
    approvalPolicy: settings.codexApprovalMode,
    approvalsReviewer: "user",
    sandbox: settings.codexSandboxMode,
    model: settings.model || null,
    baseInstructions: settings.systemPrompt || null,
    persistExtendedHistory: true,
  };
}

function buildThreadConfigSignature(cwd: string, settings: CodexWorkbenchSettings): string {
  return JSON.stringify({
    cwd,
    approvalPolicy: settings.codexApprovalMode,
    sandbox: settings.codexSandboxMode,
    model: settings.model || "",
    baseInstructions: settings.systemPrompt || "",
  });
}

function summarizePermissions(permissions: Record<string, unknown>): string {
  const lines: string[] = [];
  const fileSystem = permissions.fileSystem as Record<string, unknown> | undefined;
  const network = permissions.network as Record<string, unknown> | undefined;

  if (fileSystem) {
    const readRoots = Array.isArray(fileSystem.read) ? fileSystem.read : [];
    const writeRoots = Array.isArray(fileSystem.write) ? fileSystem.write : [];

    if (readRoots.length > 0) {
      lines.push(`Read access:\n${readRoots.map(String).join("\n")}`);
    }

    if (writeRoots.length > 0) {
      lines.push(`Write access:\n${writeRoots.map(String).join("\n")}`);
    }
  }

  if (network) {
    lines.push(`Network enabled: ${Boolean(network.enabled)}`);
  }

  if (lines.length === 0) {
    return "Codex requested additional permissions, but the exact scope was not included.";
  }

  return lines.join("\n\n");
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function resolveExecutable(command: string, extraDirs: string[] = []): string | null {
  if (path.isAbsolute(command)) {
    return existsSync(command) ? command : null;
  }

  const searchDirs = uniquePaths([
    ...extraDirs,
    ...splitPath(process.env.PATH),
    ...COMMON_EXECUTABLE_DIRS,
    ...homeScopedExecutableDirs(),
  ]);

  for (const directory of searchDirs) {
    const candidate = path.join(directory, command);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function buildLaunchEnv(cliExecutable: string, nodeExecutable: string | null): NodeJS.ProcessEnv {
  const currentPath = splitPath(process.env.PATH);
  const pathEntries = uniquePaths([
    path.dirname(cliExecutable),
    nodeExecutable ? path.dirname(nodeExecutable) : null,
    ...currentPath,
    ...COMMON_EXECUTABLE_DIRS,
    ...homeScopedExecutableDirs(),
  ]);

  return {
    ...process.env,
    PATH: pathEntries.join(path.delimiter),
  };
}

function splitPath(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value.split(path.delimiter).filter(Boolean);
}

function homeScopedExecutableDirs(): string[] {
  const home = process.env.HOME;
  if (!home) {
    return [];
  }

  return [
    path.join(home, ".local", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, "bin"),
  ];
}

function uniquePaths(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function isNodeScript(executablePath: string): boolean {
  try {
    const realPath = realpathSync(executablePath);
    if (realPath.endsWith(".js") || realPath.endsWith(".mjs") || realPath.endsWith(".cjs")) {
      return true;
    }

    const contents = readFileSync(realPath, "utf8");
    const firstLine = contents.split(/\r?\n/, 1)[0] ?? "";
    return firstLine.includes("env node") || firstLine.includes("/node");
  } catch {
    return false;
  }
}
