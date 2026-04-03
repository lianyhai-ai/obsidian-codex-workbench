export type ProviderMode = "local-codex" | "mock" | "openai-compatible" | "generic-json";

export interface CodexContext {
  notePath: string;
  noteTitle: string;
  selection: string;
  selectionPreview: string;
  surroundingText: string;
}

export interface ChatTurn {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  context?: CodexContext | null;
  streaming?: boolean;
}

export interface CompletionRequest {
  question: string;
  context?: CodexContext | null;
  history: ChatTurn[];
}

export interface CompletionResult {
  answer: string;
  mode: ProviderMode;
  raw?: unknown;
}

export interface CodexWorkbenchSettings {
  providerMode: ProviderMode;
  codexCliPath: string;
  codexSandboxMode: "read-only" | "workspace-write";
  codexApprovalMode: "never" | "on-request" | "untrusted";
  projectContextPaths: string;
  endpointUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  autoOpenView: boolean;
  showSelectionButton: boolean;
}
