import {
  Editor,
  FileSystemAdapter,
  MarkdownView,
  Menu,
  Notice,
  Plugin,
} from "obsidian";
import { promptForApproval } from "./approval-modal";
import { requestCompletion, showRequestFailure } from "./api-client";
import { CodexWorkbenchSettingTab, DEFAULT_SETTINGS } from "./settings";
import { CodexWorkbenchView, VIEW_TYPE_CODEX_WORKBENCH } from "./chat-view";
import {
  LocalCodexAppServerClient,
  type LocalCodexApprovalRequest,
  type LocalCodexApprovalResponse,
} from "./local-codex-client";
import { SelectionToolbarController } from "./selection-toolbar";
import type {
  ChatTurn,
  CodexContext,
  CodexWorkbenchSettings,
  CompletionResult,
} from "./types";

const MAX_HISTORY = 24;
const DEFAULT_SELECTION_PROMPT = "Explain, critique, or improve this selection.";

interface CodexWorkbenchPluginData {
  settings?: Partial<CodexWorkbenchSettings>;
  localCodexThreadId?: string | null;
}

export default class CodexWorkbenchPlugin extends Plugin {
  settings: CodexWorkbenchSettings = DEFAULT_SETTINGS;
  history: ChatTurn[] = [];
  pendingContext: CodexContext | null = null;
  lastAssistantReply = "";
  isBusy = false;

  private localCodexClient = new LocalCodexAppServerClient();
  private selectionToolbar?: SelectionToolbarController;
  private localCodexThreadId: string | null = null;
  private restorePromise: Promise<void> | null = null;

  async onload(): Promise<void> {
    await this.loadPluginData();

    this.registerView(
      VIEW_TYPE_CODEX_WORKBENCH,
      (leaf) => new CodexWorkbenchView(leaf, this),
    );

    this.addRibbonIcon("bot", "Open Codex Workbench", () => {
      void this.activateView();
    });

    this.addCommands();
    this.addSettingTab(new CodexWorkbenchSettingTab(this.app, this));
    this.registerEditorMenu();
    this.registerDomEvents();
    this.localCodexClient.setApprovalHandler(async (request) => {
      const decision = await promptForApproval(this.app, request);
      return this.mapApprovalDecision(request, decision);
    });

    this.selectionToolbar = new SelectionToolbarController(this);
    this.register(() => this.selectionToolbar?.destroy());
    this.refreshSelectionButtonState();

    if (this.settings.providerMode === "local-codex" && this.localCodexThreadId) {
      this.restorePromise = this.restoreSavedThread().finally(() => {
        this.restorePromise = null;
      });
    }

    if (this.settings.autoOpenView) {
      this.app.workspace.onLayoutReady(() => {
        void this.activateView();
      });
    }
  }

  async onunload(): Promise<void> {
    await this.localCodexClient.dispose();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_CODEX_WORKBENCH);
  }

  async loadPluginData(): Promise<void> {
    const rawData = (await this.loadData()) as Partial<CodexWorkbenchPluginData> | Partial<CodexWorkbenchSettings> | null;
    const hasNestedSettings = Boolean(rawData && "settings" in rawData);
    const settingsData = hasNestedSettings
      ? (rawData as CodexWorkbenchPluginData).settings ?? {}
      : (rawData as Partial<CodexWorkbenchSettings> | null) ?? {};

    this.settings = Object.assign({}, DEFAULT_SETTINGS, settingsData);
    this.localCodexThreadId = hasNestedSettings
      ? (rawData as CodexWorkbenchPluginData).localCodexThreadId ?? null
      : null;
  }

  async saveSettings(): Promise<void> {
    await this.savePluginData();
    this.refreshViews();
  }

  async savePluginData(): Promise<void> {
    const payload: CodexWorkbenchPluginData = {
      settings: this.settings,
      localCodexThreadId: this.localCodexThreadId,
    };

    await this.saveData(payload);
  }

  refreshSelectionButtonState(): void {
    if (!this.selectionToolbar) {
      return;
    }

    if (this.settings.showSelectionButton) {
      this.selectionToolbar.enable();
      this.selectionToolbar.queueUpdate();
      return;
    }

    this.selectionToolbar.disable();
  }

  async activateView(): Promise<void> {
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) {
      new Notice("Could not open the right sidebar leaf.");
      return;
    }

    await leaf.setViewState({
      type: VIEW_TYPE_CODEX_WORKBENCH,
      active: true,
    });

    this.app.workspace.revealLeaf(leaf);
    this.refreshViews();
  }

  clearPendingContext(): void {
    this.pendingContext = null;
    this.refreshViews();
  }

  setPendingContext(context: CodexContext | null): void {
    this.pendingContext = context;
    this.refreshViews();
  }

  captureContextFromActiveEditor(): CodexContext | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      return null;
    }

    return this.captureContextFromEditor(view.editor, view);
  }

  captureContextFromEditor(editor: Editor, view: MarkdownView): CodexContext | null {
    const selection = editor.getSelection().trim();
    if (!selection) {
      return this.captureNoteContext(editor, view);
    }

    const file = view.file;
    const from = editor.getCursor("from");
    const to = editor.getCursor("to");

    const lines: string[] = [];
    const startLine = Math.max(0, from.line - 2);
    const endLine = Math.min(editor.lineCount() - 1, to.line + 2);
    for (let line = startLine; line <= endLine; line += 1) {
      lines.push(editor.getLine(line));
    }

    return {
      notePath: file?.path ?? "Untitled note",
      noteTitle: file?.basename ?? "Untitled",
      selection,
      selectionPreview: truncate(selection.replace(/\s+/g, " "), 180),
      surroundingText: lines.join("\n").trim(),
    };
  }

  async askSelectionFromActiveEditor(): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      new Notice("Open a markdown note first.");
      return;
    }

    const selection = view.editor.getSelection().trim();
    if (!selection) {
      this.selectionToolbar?.notifyUnavailableSelection();
      return;
    }

    const context = this.captureContextFromEditor(view.editor, view);
    if (!context) {
      new Notice("Could not capture the current selection context.");
      return;
    }

    this.setPendingContext(context);
    await this.activateView();
    await this.submitQuestion(DEFAULT_SELECTION_PROMPT, context);
  }

  async submitQuestion(question: string, explicitContext?: CodexContext | null): Promise<CompletionResult | null> {
    const context = explicitContext ?? this.pendingContext ?? this.captureContextFromActiveEditor();
    const userTurn = this.pushTurn("user", question, context);
    this.setBusy(true);

    try {
      if (this.settings.providerMode === "local-codex") {
        if (this.restorePromise) {
          await this.restorePromise;
        }

        const assistantTurn = this.pushTurn("assistant", "", context, true);
        try {
          const result = await this.localCodexClient.sendTurn({
            prompt: this.buildCodexPrompt(question, context),
            cwd: this.getConversationCwd(),
            settings: this.settings,
            onDelta: (delta) => {
              this.appendToTurn(assistantTurn.id, delta);
            },
          });

          const answer = result.answer || "Codex finished the turn without returning visible text.";
          this.completeTurn(assistantTurn.id, answer);
          this.lastAssistantReply = answer;
          await this.persistThreadId(this.localCodexClient.threadId);

          return {
            mode: "local-codex",
            answer,
          };
        } catch (error) {
          this.completeTurn(
            assistantTurn.id,
            error instanceof Error ? `Codex app-server request failed: ${error.message}` : "Codex app-server request failed.",
          );
          throw error;
        }
      }

      const result = await requestCompletion(this.settings, {
        question,
        context,
        history: this.history.filter((turn) => turn.id !== userTurn.id),
      });

      this.lastAssistantReply = result.answer;
      this.pushTurn("assistant", result.answer, context);
      return result;
    } catch (error) {
      showRequestFailure(error);
      return null;
    } finally {
      this.setBusy(false);
    }
  }

  async insertLastReply(): Promise<void> {
    if (!this.lastAssistantReply) {
      new Notice("There is no assistant reply to insert yet.");
      return;
    }

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      new Notice("Open a markdown note first.");
      return;
    }

    view.editor.replaceRange(this.lastAssistantReply, view.editor.getCursor());
    new Notice("Inserted the last assistant reply at the cursor.");
  }

  async replaceSelectionWithLastReply(): Promise<void> {
    if (!this.lastAssistantReply) {
      new Notice("There is no assistant reply to use yet.");
      return;
    }

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      new Notice("Open a markdown note first.");
      return;
    }

    if (!view.editor.getSelection()) {
      new Notice("Select the text you want to replace first.");
      return;
    }

    view.editor.replaceSelection(this.lastAssistantReply);
    new Notice("Replaced the selection with the last assistant reply.");
  }

  async copyLastReply(): Promise<void> {
    if (!this.lastAssistantReply) {
      new Notice("There is no assistant reply to copy yet.");
      return;
    }

    await navigator.clipboard.writeText(this.lastAssistantReply);
    new Notice("Copied the last assistant reply.");
  }

  async resetConversationSession(): Promise<void> {
    if (this.isBusy) {
      new Notice("Wait for the current turn to finish before starting a new session.");
      return;
    }

    this.localCodexClient.resetThread();
    this.localCodexThreadId = null;
    this.history = [];
    this.lastAssistantReply = "";
    this.pendingContext = null;
    await this.savePluginData();
    this.refreshViews();
    new Notice("Started a fresh Codex session.");
  }

  private addCommands(): void {
    this.addCommand({
      id: "open-codex-workbench",
      name: "Open Codex Workbench",
      callback: () => {
        void this.activateView();
      },
    });

    this.addCommand({
      id: "ask-about-selection",
      name: "Ask Codex about selection",
      editorCallback: async (editor, view) => {
        if (!(view instanceof MarkdownView)) {
          new Notice("Open a markdown editor first.");
          return;
        }
        await this.askSelectionFromActiveEditor();
      },
    });

    this.addCommand({
      id: "insert-last-reply",
      name: "Insert last Codex reply at cursor",
      editorCallback: async () => {
        await this.insertLastReply();
      },
    });

    this.addCommand({
      id: "replace-selection-with-last-reply",
      name: "Replace selection with last Codex reply",
      editorCallback: async () => {
        await this.replaceSelectionWithLastReply();
      },
    });

    this.addCommand({
      id: "copy-last-reply",
      name: "Copy last Codex reply",
      callback: async () => {
        await this.copyLastReply();
      },
    });
  }

  private registerEditorMenu(): void {
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor, view: MarkdownView) => {
        const selection = editor.getSelection().trim();
        if (!selection) {
          return;
        }

        menu.addItem((item) => {
          item
            .setTitle("Ask Codex about selection")
            .setIcon("highlighter")
            .onClick(async () => {
              const context = this.captureContextFromEditor(editor, view);
              if (!context) {
                new Notice("Could not capture selection context.");
                return;
              }

              this.setPendingContext(context);
              await this.activateView();
              await this.submitQuestion(DEFAULT_SELECTION_PROMPT, context);
            });
        });
      }),
    );
  }

  private registerDomEvents(): void {
    this.registerDomEvent(document, "selectionchange", () => {
      this.selectionToolbar?.queueUpdate();
    });

    this.registerDomEvent(document, "scroll", () => {
      this.selectionToolbar?.queueUpdate();
    });

    this.registerDomEvent(document, "mousedown", () => {
      window.setTimeout(() => {
        this.selectionToolbar?.queueUpdate();
      }, 0);
    });
  }

  private captureNoteContext(editor: Editor, view: MarkdownView): CodexContext | null {
    const file = view.file;
    const cursor = editor.getCursor();
    const startLine = Math.max(0, cursor.line - 2);
    const endLine = Math.min(editor.lineCount() - 1, cursor.line + 2);
    const lines: string[] = [];
    for (let line = startLine; line <= endLine; line += 1) {
      lines.push(editor.getLine(line));
    }

    return {
      notePath: file?.path ?? "Untitled note",
      noteTitle: file?.basename ?? "Untitled",
      selection: "",
      selectionPreview: "Current cursor context",
      surroundingText: lines.join("\n").trim(),
    };
  }

  private pushTurn(role: ChatTurn["role"], content: string, context?: CodexContext | null, streaming = false): ChatTurn {
    const turn: ChatTurn = {
      id: `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role,
      content,
      context,
      createdAt: Date.now(),
      streaming,
    };

    this.history.push(turn);
    if (this.history.length > MAX_HISTORY) {
      this.history = this.history.slice(-MAX_HISTORY);
    }
    this.refreshViews();
    return turn;
  }

  private appendToTurn(turnId: string, delta: string): void {
    const turn = this.history.find((entry) => entry.id === turnId);
    if (!turn) {
      return;
    }

    turn.content += delta;
    this.refreshViews();
  }

  private completeTurn(turnId: string, finalContent: string): void {
    const turn = this.history.find((entry) => entry.id === turnId);
    if (!turn) {
      return;
    }

    turn.content = finalContent;
    turn.streaming = false;
    this.refreshViews();
  }

  private setBusy(value: boolean): void {
    this.isBusy = value;
    this.refreshViews();
  }

  private getWorkbenchView(): CodexWorkbenchView | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CODEX_WORKBENCH);
    const view = leaves[0]?.view;
    return view instanceof CodexWorkbenchView ? view : null;
  }

  private refreshViews(): void {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CODEX_WORKBENCH);
    leaves.forEach((leaf) => {
      if (leaf.view instanceof CodexWorkbenchView) {
        leaf.view.refresh();
      }
    });
  }

  private getConversationCwd(): string {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      return adapter.getBasePath();
    }

    return "/";
  }

  private buildCodexPrompt(question: string, context?: CodexContext | null): string {
    const sections = [`User request:\n${question}`];

    if (context) {
      sections.push(
        [
          `Active note: ${context.noteTitle}`,
          `Path: ${context.notePath}`,
          context.selection
            ? `Selected text:\n${context.selection}`
            : `Selection: (none, use the nearby cursor context)`,
          context.surroundingText
            ? `Nearby note context:\n${context.surroundingText}`
            : "Nearby note context: (none)",
        ].join("\n\n"),
      );
    }

    sections.push(
      "Answer inside the Obsidian sidebar. Keep the response directly useful for the current note and avoid taking external actions unless the user explicitly asks.",
    );

    return sections.join("\n\n");
  }

  private async restoreSavedThread(): Promise<void> {
    if (!this.localCodexThreadId || this.settings.providerMode !== "local-codex") {
      return;
    }

    try {
      const restored = await this.localCodexClient.restoreThread(
        this.localCodexThreadId,
        this.getConversationCwd(),
        this.settings,
      );

      this.localCodexThreadId = restored.threadId;
      this.history = restored.history.map((entry) => ({
        id: `${entry.role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: entry.role,
        content: entry.content,
        createdAt: Date.now(),
      }));
      this.lastAssistantReply = [...this.history].reverse().find((entry) => entry.role === "assistant")?.content ?? "";
      this.refreshViews();
      await this.savePluginData();
    } catch (error) {
      this.localCodexThreadId = null;
      this.history = [];
      this.lastAssistantReply = "";
      await this.savePluginData();
      const message = error instanceof Error ? error.message : "Unknown restore failure";
      new Notice(`Could not restore the previous Codex session: ${message}`);
    }
  }

  private async persistThreadId(threadId: string | null): Promise<void> {
    if (threadId === this.localCodexThreadId) {
      return;
    }

    this.localCodexThreadId = threadId;
    await this.savePluginData();
  }

  private mapApprovalDecision(
    request: LocalCodexApprovalRequest,
    decision: Awaited<ReturnType<typeof promptForApproval>>,
  ): LocalCodexApprovalResponse {
    if (decision.kind === "permissions") {
      if (decision.decision === "decline") {
        return {
          permissions: {},
          scope: "turn",
        };
      }

      return {
        permissions: request.kind === "permissions" ? request.permissions : {},
        scope: decision.decision === "grant-session" ? "session" : "turn",
      };
    }

    return {
      decision: decision.decision,
    };
  }
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1)}…`;
}
