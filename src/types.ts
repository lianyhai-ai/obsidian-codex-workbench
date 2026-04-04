export type ProviderMode = "local-codex" | "mock" | "openai-compatible" | "generic-json";
export type WorkbenchMode = "default" | "learning";
export type ContextScope = "note" | "folder" | "tag" | "repo";
export type LearningArtifactType = "study-note" | "term-cards" | "confusions" | "qa-cards";

export interface ContextCitation {
  kind: "note" | "selection" | "folder-note" | "tag-note" | "repo-file";
  label: string;
  path?: string;
  detail?: string;
}

export interface ContextPack {
  id: string;
  name: string;
  scope: ContextScope;
  folderPath?: string | null;
  repoPath?: string | null;
  tag?: string | null;
  includeCurrentNote: boolean;
  extraNotePaths: string[];
  extraRepoFiles: string[];
}

export interface CodexContext {
  notePath: string;
  noteTitle: string;
  selection: string;
  selectionPreview: string;
  surroundingText: string;
  tags?: string[];
}

export interface ChatTurn {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  context?: CodexContext | null;
  streaming?: boolean;
  citations?: ContextCitation[];
  mode?: WorkbenchMode;
  scope?: ContextScope;
}

export interface CompletionRequest {
  question: string;
  context?: CodexContext | null;
  history: ChatTurn[];
  resolvedContextBlock?: string;
  workbenchMode?: WorkbenchMode;
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
