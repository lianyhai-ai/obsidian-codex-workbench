import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import {
  Editor,
  FileSystemAdapter,
  MarkdownView,
  Menu,
  Notice,
  normalizePath,
  Plugin,
  TFile,
  TFolder,
} from "obsidian";
import { promptForApproval } from "./approval-modal";
import { requestCompletion, showRequestFailure } from "./api-client";
import { openContextPackModal } from "./context-pack-modal";
import { CodexWorkbenchSettingTab, DEFAULT_SETTINGS } from "./settings";
import { CodexWorkbenchView, VIEW_TYPE_CODEX_WORKBENCH } from "./chat-view";
import {
  LocalCodexAppServerClient,
  type LocalCodexApprovalRequest,
  type LocalCodexApprovalResponse,
  LocalCodexTurnInterruptedError,
} from "./local-codex-client";
import { SelectionToolbarController } from "./selection-toolbar";
import type {
  ChatTurn,
  CodexContext,
  ContextCitation,
  ContextPack,
  ContextScope,
  CodexWorkbenchSettings,
  CompletionResult,
  LearningArtifactType,
  WorkbenchMode,
} from "./types";

const MAX_HISTORY = 24;
const DEFAULT_SELECTION_PROMPT = "Explain, critique, or improve this selection.";
const MAX_CONTEXT_SNIPPET_CHARS = 2200;
const MAX_FOLDER_NOTES = 4;
const MAX_TAG_NOTES = 4;
const MAX_REPO_FILES = 6;
const LEARNING_ARTIFACT_FOLDER_SUFFIX = ".learning";
const LEARNING_ARTIFACT_BLOCK_START = "<!-- codex-workbench:learning-artifacts:start -->";
const LEARNING_ARTIFACT_BLOCK_END = "<!-- codex-workbench:learning-artifacts:end -->";

interface ResolvedContextSource {
  kind: ContextCitation["kind"];
  label: string;
  path?: string;
  detail?: string;
  content: string;
}

interface ResolvedContextBundle {
  promptBlock: string;
  citations: ContextCitation[];
}

interface CodexWorkbenchPluginData {
  settings?: Partial<CodexWorkbenchSettings>;
  localCodexThreadId?: string | null;
  composerDraft?: string | null;
  workbenchMode?: WorkbenchMode;
  activeContextScope?: ContextScope;
  activeContextPackId?: string | null;
  activeRepoPath?: string | null;
  activeTag?: string | null;
  contextPacks?: ContextPack[];
}

export default class CodexWorkbenchPlugin extends Plugin {
  settings: CodexWorkbenchSettings = DEFAULT_SETTINGS;
  history: ChatTurn[] = [];
  pendingContext: CodexContext | null = null;
  lastAssistantReply = "";
  isBusy = false;
  isInterrupting = false;
  isGeneratingLearningArtifact = false;
  activeLearningArtifactTurnId: string | null = null;
  composerDraft = "";
  workbenchMode: WorkbenchMode = "default";
  activeContextScope: ContextScope = "note";
  activeContextPackId: string | null = null;
  activeRepoPath: string | null = null;
  activeTag: string | null = null;
  contextPacks: ContextPack[] = [];

  private localCodexClient = new LocalCodexAppServerClient();
  private selectionToolbar?: SelectionToolbarController;
  private localCodexThreadId: string | null = null;
  private restorePromise: Promise<void> | null = null;
  private draftSaveHandle: number | null = null;

  async onload(): Promise<void> {
    await this.loadPluginData();

    this.registerView(
      VIEW_TYPE_CODEX_WORKBENCH,
      (leaf) => new CodexWorkbenchView(leaf, this),
    );

    this.addRibbonIcon("bot", "Open workbench", () => {
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
        if (this.app.workspace.getLeavesOfType(VIEW_TYPE_CODEX_WORKBENCH).length === 0) {
          void this.activateView();
        }
      });
    }

    this.app.workspace.onLayoutReady(() => {
      if (this.history.length === 0) {
        return;
      }

      const view = this.getWorkbenchView();
      if (!view) {
        return;
      }

      view.requestScrollToLatest();
      this.refreshViews();
    });
  }

  onunload(): void {
    if (this.draftSaveHandle !== null) {
      window.clearTimeout(this.draftSaveHandle);
      this.draftSaveHandle = null;
    }

    void this.savePluginData();
    this.localCodexClient.dispose();
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
    this.composerDraft = hasNestedSettings
      ? (rawData as CodexWorkbenchPluginData).composerDraft ?? ""
      : "";
    this.workbenchMode = hasNestedSettings
      ? (rawData as CodexWorkbenchPluginData).workbenchMode ?? "default"
      : "default";
    this.activeContextScope = hasNestedSettings
      ? (rawData as CodexWorkbenchPluginData).activeContextScope ?? "note"
      : "note";
    this.activeContextPackId = hasNestedSettings
      ? (rawData as CodexWorkbenchPluginData).activeContextPackId ?? null
      : null;
    this.activeRepoPath = hasNestedSettings
      ? (rawData as CodexWorkbenchPluginData).activeRepoPath ?? null
      : null;
    this.activeTag = hasNestedSettings
      ? (rawData as CodexWorkbenchPluginData).activeTag ?? null
      : null;
    this.contextPacks = hasNestedSettings
      ? ((rawData as CodexWorkbenchPluginData).contextPacks ?? []).map((pack) => normalizeContextPack(pack))
      : [];
  }

  async saveSettings(): Promise<void> {
    await this.savePluginData();
    this.refreshViews();
  }

  async savePluginData(): Promise<void> {
    const payload: CodexWorkbenchPluginData = {
      settings: this.settings,
      localCodexThreadId: this.localCodexThreadId,
      composerDraft: this.composerDraft,
      workbenchMode: this.workbenchMode,
      activeContextScope: this.activeContextScope,
      activeContextPackId: this.activeContextPackId,
      activeRepoPath: this.activeRepoPath,
      activeTag: this.activeTag,
      contextPacks: this.contextPacks,
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
    const existingLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CODEX_WORKBENCH)[0];
    if (existingLeaf) {
      await existingLeaf.setViewState({
        type: VIEW_TYPE_CODEX_WORKBENCH,
        active: true,
      });

      if (existingLeaf.view instanceof CodexWorkbenchView) {
        existingLeaf.view.requestScrollToLatest();
      }
      void this.app.workspace.revealLeaf(existingLeaf);
      this.refreshViews();
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) {
      new Notice("Could not open the right sidebar leaf.");
      return;
    }

    await leaf.setViewState({
      type: VIEW_TYPE_CODEX_WORKBENCH,
      active: true,
    });

    if (leaf.view instanceof CodexWorkbenchView) {
      leaf.view.requestScrollToLatest();
    }
    void this.app.workspace.revealLeaf(leaf);
    this.refreshViews();
  }

  clearPendingContext(): void {
    this.pendingContext = null;
    this.refreshViews();
  }

  setComposerDraft(value: string): void {
    if (value === this.composerDraft) {
      return;
    }

    this.composerDraft = value;
    this.schedulePluginDataSave();
  }

  async setWorkbenchMode(mode: WorkbenchMode): Promise<void> {
    if (mode === this.workbenchMode) {
      return;
    }

    this.workbenchMode = mode;
    await this.savePluginData();
    this.refreshViews();
  }

  async handleComposerCommand(input: string): Promise<string | null> {
    const trimmed = input.trim();
    if (!trimmed.startsWith("/")) {
      return trimmed;
    }

    const [command, ...restParts] = trimmed.split(/\s+/);
    const remainder = restParts.join(" ").trim();

    if (command === "/learning-mode") {
      await this.setWorkbenchMode("learning");
      new Notice("Learning mode is now active.");
      return remainder || null;
    }

    if (command === "/default-mode") {
      await this.setWorkbenchMode("default");
      new Notice("Switched back to the default mode.");
      return remainder || null;
    }

    return trimmed;
  }

  getAvailableContextScopes(): ContextScope[] {
    return ["note", "folder", "tag", "repo"];
  }

  async setActiveContextScope(scope: ContextScope): Promise<void> {
    if (scope === this.activeContextScope) {
      return;
    }

    this.activeContextScope = scope;
    this.activeContextPackId = null;
    await this.savePluginData();
    this.refreshViews();
  }

  getProjectContextPaths(): string[] {
    return this.settings.projectContextPaths
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
  }

  getAvailableRepoPaths(): string[] {
    return this.getProjectContextPaths();
  }

  getActiveRepoPath(): string | null {
    const repoPaths = this.getAvailableRepoPaths();
    if (repoPaths.length === 0) {
      return null;
    }

    if (this.activeRepoPath && repoPaths.includes(this.activeRepoPath)) {
      return this.activeRepoPath;
    }

    return repoPaths[0] ?? null;
  }

  async setActiveRepoPath(repoPath: string): Promise<void> {
    if (repoPath === this.activeRepoPath) {
      return;
    }

    this.activeRepoPath = repoPath;
    this.activeContextPackId = null;
    await this.savePluginData();
    this.refreshViews();
  }

  getAvailableTags(context?: CodexContext | null): string[] {
    const seen = new Set<string>();
    const orderedTags: string[] = [];
    const anchorFile = this.getContextAnchorFile(context);
    const preferredTags = anchorFile ? this.getFileTags(anchorFile) : [];

    preferredTags.forEach((tag) => {
      if (!seen.has(tag)) {
        seen.add(tag);
        orderedTags.push(tag);
      }
    });

    this.app.vault.getMarkdownFiles().forEach((file) => {
      this.getFileTags(file).forEach((tag) => {
        if (!seen.has(tag)) {
          seen.add(tag);
          orderedTags.push(tag);
        }
      });
    });

    return orderedTags;
  }

  getActiveTag(context?: CodexContext | null): string | null {
    const availableTags = this.getAvailableTags(context);
    if (availableTags.length === 0) {
      return null;
    }

    if (this.activeTag && availableTags.includes(this.activeTag)) {
      return this.activeTag;
    }

    return availableTags[0] ?? null;
  }

  async setActiveTag(tag: string): Promise<void> {
    if (tag === this.activeTag) {
      return;
    }

    this.activeTag = tag;
    this.activeContextPackId = null;
    await this.savePluginData();
    this.refreshViews();
  }

  getContextPacks(): ContextPack[] {
    return this.contextPacks;
  }

  getActiveContextPack(): ContextPack | null {
    if (!this.activeContextPackId) {
      return null;
    }

    return this.contextPacks.find((pack) => pack.id === this.activeContextPackId) ?? null;
  }

  getCurrentFolderPath(context?: CodexContext | null): string | null {
    const anchorFile = this.getContextAnchorFile(context);
    return anchorFile?.parent?.path ?? null;
  }

  async applyContextPack(packId: string | null): Promise<void> {
    if (!packId) {
      this.activeContextPackId = null;
      await this.savePluginData();
      this.refreshViews();
      return;
    }

    const pack = this.contextPacks.find((entry) => entry.id === packId);
    if (!pack) {
      new Notice("Could not find that context pack.");
      return;
    }

    this.activeContextPackId = pack.id;
    this.activeContextScope = pack.scope;
    this.activeRepoPath = pack.repoPath ?? this.activeRepoPath;
    this.activeTag = pack.tag ?? this.activeTag;
    await this.savePluginData();
    this.refreshViews();
  }

  async saveCurrentContextPack(): Promise<void> {
    const draft = this.buildContextPackDraft();
    const nextPack = await openContextPackModal(this.app, {
      initialPack: draft,
      availableRepos: this.getAvailableRepoPaths(),
      availableTags: this.getAvailableTags(this.pendingContext),
      isEditing: false,
    });
    if (!nextPack) {
      return;
    }

    await this.upsertContextPack(nextPack);
    new Notice(`Saved context pack: ${nextPack.name}`);
  }

  async editActiveContextPack(): Promise<void> {
    const activePack = this.getActiveContextPack();
    if (!activePack) {
      new Notice("Select a context pack first.");
      return;
    }

    const editedPack = await openContextPackModal(this.app, {
      initialPack: normalizeContextPack(activePack),
      availableRepos: this.getAvailableRepoPaths(),
      availableTags: this.getAvailableTags(this.pendingContext),
      isEditing: true,
    });
    if (!editedPack) {
      return;
    }

    await this.upsertContextPack(editedPack);
    new Notice(`Updated context pack: ${editedPack.name}`);
  }

  private async upsertContextPack(pack: ContextPack): Promise<void> {
    this.contextPacks = [
      ...this.contextPacks.filter((entry) => entry.id !== pack.id),
      normalizeContextPack(pack),
    ];
    this.activeContextPackId = pack.id;
    this.activeContextScope = pack.scope;
    this.activeRepoPath = pack.repoPath ?? this.activeRepoPath;
    this.activeTag = pack.tag ?? this.activeTag;
    await this.savePluginData();
    this.refreshViews();
  }

  private buildContextPackDraft(): ContextPack {
    return normalizeContextPack({
      id: `pack-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: `${titleCase(this.activeContextScope)} pack`,
      scope: this.activeContextScope,
      folderPath: this.getCurrentFolderPath(this.pendingContext),
      repoPath: this.getActiveRepoPath(),
      tag: this.getActiveTag(this.pendingContext),
      includeCurrentNote: true,
      extraNotePaths: [],
      extraRepoFiles: [],
    });
  }

  async deleteActiveContextPack(): Promise<void> {
    const activePack = this.getActiveContextPack();
    if (!activePack) {
      new Notice("There is no active context pack to delete.");
      return;
    }

    this.contextPacks = this.contextPacks.filter((pack) => pack.id !== activePack.id);
    this.activeContextPackId = null;
    await this.savePluginData();
    this.refreshViews();
    new Notice(`Deleted context pack: ${activePack.name}`);
  }

  async openCitation(citation: ContextCitation): Promise<boolean> {
    if (!citation.path) {
      new Notice("That citation does not point to a file.");
      return false;
    }

    const vaultFile = this.resolveVaultCitationFile(citation.path);
    if (vaultFile) {
      await this.app.workspace.getLeaf(true).openFile(vaultFile);
      return true;
    }

    const externalPath = citation.path;
    if (!existsSync(externalPath)) {
      new Notice(`Could not find ${citation.label}.`);
      return false;
    }

    try {
      const shell = getElectronShell();
      if (!shell) {
        throw new Error("Electron shell is unavailable in this environment.");
      }

      const errorMessage = await shell.openPath(externalPath);
      if (errorMessage) {
        throw new Error(errorMessage);
      }

      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown open failure";
      new Notice(`Could not open ${citation.label}: ${message}`);
      return false;
    }
  }

  private resolveVaultCitationFile(citationPath: string): TFile | null {
    const directMatch = this.app.vault.getAbstractFileByPath(citationPath);
    if (directMatch instanceof TFile) {
      return directMatch;
    }

    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      return null;
    }

    const basePath = adapter.getBasePath();
    if (!citationPath.startsWith(basePath)) {
      return null;
    }

    const relativePath = normalizePath(path.relative(basePath, citationPath));
    const file = this.app.vault.getAbstractFileByPath(relativePath);
    return file instanceof TFile ? file : null;
  }

  setPendingContext(context: CodexContext | null): void {
    if (isSameContext(this.pendingContext, context)) {
      return;
    }

    this.pendingContext = context;
    this.refreshViews();
  }

  syncPendingContextFromActiveSelection(): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      return;
    }

    const selection = view.editor.getSelection().trim();
    if (!selection) {
      return;
    }

    const context = this.captureContextFromEditor(view.editor, view);
    if (!context) {
      return;
    }

    this.setPendingContext(context);
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
      tags: file ? this.getFileTags(file) : [],
    };
  }

  async askSelectionFromActiveEditor(): Promise<void> {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view) {
        new Notice("Open a Markdown note first.");
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
    const resolvedContext = await this.resolveContextBundle(context);
    const userTurn = this.pushTurn("user", question, context, false, resolvedContext.citations);
    this.isInterrupting = false;
    this.setBusy(true);

    try {
      if (this.settings.providerMode === "local-codex") {
        if (this.restorePromise) {
          await this.restorePromise;
        }

        const assistantTurn = this.pushTurn("assistant", "", context, true, resolvedContext.citations);
        try {
          const result = await this.localCodexClient.sendTurn({
            prompt: this.buildCodexPrompt(question, resolvedContext),
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
          if (error instanceof LocalCodexTurnInterruptedError) {
            const partialAnswer = assistantTurn.content.trim();
            const interruptedReply = partialAnswer
              ? `${partialAnswer}\n\n_Stopped by user._`
              : "_Stopped before a full reply was generated._";
            this.completeTurn(assistantTurn.id, interruptedReply);
            if (partialAnswer) {
              this.lastAssistantReply = partialAnswer;
            }
            new Notice("Stopped the current turn.");
            return {
              mode: "local-codex",
              answer: partialAnswer,
            };
          }

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
        resolvedContextBlock: resolvedContext.promptBlock,
        workbenchMode: this.workbenchMode,
      });

      this.lastAssistantReply = result.answer;
      this.pushTurn("assistant", result.answer, context, false, resolvedContext.citations);
      return result;
    } catch (error) {
      showRequestFailure(error);
      return null;
    } finally {
      this.isInterrupting = false;
      this.setBusy(false);
    }
  }

  supportsInterruptCurrentTurn(): boolean {
    return this.settings.providerMode === "local-codex";
  }

  canInterruptCurrentTurn(): boolean {
    return this.supportsInterruptCurrentTurn() && this.localCodexClient.hasActiveTurn;
  }

  async interruptCurrentTurn(): Promise<boolean> {
    if (!this.supportsInterruptCurrentTurn()) {
      new Notice("Stopping is only available in local sessions.");
      return false;
    }

    if (this.isInterrupting) {
      return false;
    }

    if (!this.localCodexClient.hasActiveTurn) {
      new Notice("There is no active turn to stop.");
      return false;
    }

    this.isInterrupting = true;
    this.refreshViews();

    try {
      return await this.localCodexClient.interruptTurn();
    } catch (error) {
      this.isInterrupting = false;
      this.refreshViews();
      const message = error instanceof Error ? error.message : "Unknown interrupt failure";
      new Notice(`Could not stop the current turn: ${message}`);
      return false;
    }
  }

  async insertLastReply(): Promise<void> {
    if (!this.lastAssistantReply) {
      new Notice("There is no assistant reply to insert yet.");
      return;
    }

    this.insertReplyText(this.lastAssistantReply);
  }

  insertReplyText(reply: string): boolean {
    const content = reply.trim();
    if (!content) {
      new Notice("There is no assistant reply to insert yet.");
      return false;
    }

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      new Notice("Open a Markdown note first.");
      return false;
    }

    view.editor.replaceRange(content, view.editor.getCursor());
    new Notice("Inserted the assistant reply at the cursor.");
    this.refreshViewInteractions();
    return true;
  }

  async replaceSelectionWithLastReply(): Promise<void> {
    if (!this.lastAssistantReply) {
      new Notice("There is no assistant reply to use yet.");
      return;
    }

    this.replaceSelectionWithReplyText(this.lastAssistantReply);
  }

  replaceSelectionWithReplyText(reply: string): boolean {
    const content = reply.trim();
    if (!content) {
      new Notice("There is no assistant reply to use yet.");
      return false;
    }

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      new Notice("Open a Markdown note first.");
      return false;
    }

    if (!view.editor.getSelection().trim()) {
      new Notice("Select the text you want to replace first.");
      return false;
    }

    view.editor.replaceSelection(content);
    new Notice("Replaced the selection with the assistant reply.");
    this.refreshViewInteractions();
    return true;
  }

  async copyLastReply(): Promise<void> {
    if (!this.lastAssistantReply) {
      new Notice("There is no assistant reply to copy yet.");
      return;
    }

    await this.copyReplyText(this.lastAssistantReply);
  }

  async copyReplyText(reply: string): Promise<boolean> {
    const content = reply.trim();
    if (!content) {
      new Notice("There is no assistant reply to copy yet.");
      return false;
    }

    try {
      await navigator.clipboard.writeText(content);
      new Notice("Copied the assistant reply.");
      return true;
    } catch {
      new Notice("Could not copy the assistant reply.");
      return false;
    }
  }

  canCreateLearningArtifactForTurn(turnId: string): boolean {
    const turn = this.history.find((entry) => entry.id === turnId);
    if (!turn || turn.role !== "assistant" || turn.streaming) {
      return false;
    }

    if (turn.mode !== "learning") {
      return false;
    }

    return Boolean(this.getContextAnchorFile(turn.context));
  }

  async createLearningArtifactFromTurn(turnId: string, artifactType: LearningArtifactType): Promise<boolean> {
    const turn = this.history.find((entry) => entry.id === turnId);
    const artifact = getLearningArtifactDefinition(artifactType);
    if (!turn || turn.role !== "assistant") {
      new Notice("Could not find the assistant reply for this learning artifact.");
      return false;
    }

    if (turn.streaming || !turn.content.trim()) {
      new Notice("Wait for the reply to finish before saving a learning artifact.");
      return false;
    }

    if (turn.mode !== "learning") {
      new Notice("Learning artifacts are available for replies generated in learning mode.");
      return false;
    }

    if (this.isBusy) {
      new Notice("Wait for the current turn to finish first.");
      return false;
    }

    if (this.isGeneratingLearningArtifact) {
      new Notice("A learning artifact is already being generated.");
      return false;
    }

    const anchorFile = this.getContextAnchorFile(turn.context);
    if (!anchorFile) {
      new Notice("Open a Markdown note first so the learning artifact has a home.");
      return false;
    }

    this.isGeneratingLearningArtifact = true;
    this.activeLearningArtifactTurnId = turn.id;
    this.refreshViewInteractions();
    new Notice(`Generating ${artifact.label}...`);

    try {
      const resolvedContext = await this.resolveContextBundle(turn.context);
      const artifactBody = await this.generateLearningArtifactBody(turn, artifactType, resolvedContext);
      const artifactFile = await this.persistLearningArtifact(anchorFile, turn, artifactType, artifactBody);
      await this.syncLearningArtifactLinks(anchorFile);
      new Notice(`Saved ${artifact.label} to ${artifactFile.path}.`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown artifact generation failure";
      new Notice(`Could not create ${artifact.label}: ${message}`);
      return false;
    } finally {
      this.isGeneratingLearningArtifact = false;
      this.activeLearningArtifactTurnId = null;
      this.refreshViewInteractions();
    }
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
    new Notice("Started a fresh session.");
  }

  private addCommands(): void {
    this.addCommand({
      id: "open-workbench",
      name: "Open workbench",
      callback: () => {
        void this.activateView();
      },
    });

    this.addCommand({
      id: "ask-about-selection",
      name: "Ask about selection",
      editorCallback: async (editor, view) => {
        if (!(view instanceof MarkdownView)) {
          new Notice("Open a Markdown editor first.");
          return;
        }
        await this.askSelectionFromActiveEditor();
      },
    });

    this.addCommand({
      id: "insert-last-reply",
      name: "Insert last reply at cursor",
      editorCallback: async () => {
        await this.insertLastReply();
      },
    });

    this.addCommand({
      id: "replace-selection-with-last-reply",
      name: "Replace selection with last reply",
      editorCallback: async () => {
        await this.replaceSelectionWithLastReply();
      },
    });

    this.addCommand({
      id: "copy-last-reply",
      name: "Copy last reply",
      callback: async () => {
        await this.copyLastReply();
      },
    });

    this.addCommand({
      id: "interrupt-current-turn",
      name: "Stop current turn",
      callback: async () => {
        await this.interruptCurrentTurn();
      },
    });

    this.addCommand({
      id: "enable-learning-mode",
      name: "Enable learning mode",
      callback: async () => {
        await this.setWorkbenchMode("learning");
        new Notice("Learning mode is now active.");
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
            .setTitle("Ask about selection")
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
      this.syncPendingContextFromActiveSelection();
      this.selectionToolbar?.queueUpdate();
      this.refreshViewInteractions();
    });

    this.registerDomEvent(document, "scroll", () => {
      this.selectionToolbar?.queueUpdate();
    });

    this.registerDomEvent(document, "mousedown", () => {
      window.setTimeout(() => {
        this.selectionToolbar?.queueUpdate();
      }, 0);
    });

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.syncPendingContextFromActiveSelection();
        this.selectionToolbar?.queueUpdate();
        this.refreshViewInteractions();
      }),
    );

    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        this.syncPendingContextFromActiveSelection();
        this.selectionToolbar?.queueUpdate();
        this.refreshViewInteractions();
      }),
    );
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
      tags: file ? this.getFileTags(file) : [],
    };
  }

  private pushTurn(
    role: ChatTurn["role"],
    content: string,
    context?: CodexContext | null,
    streaming = false,
    citations: ContextCitation[] = [],
  ): ChatTurn {
    const turn: ChatTurn = {
      id: `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role,
      content,
      context,
      createdAt: Date.now(),
      streaming,
      citations,
      mode: this.workbenchMode,
      scope: this.activeContextScope,
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

  private refreshViewInteractions(): void {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CODEX_WORKBENCH);
    leaves.forEach((leaf) => {
      if (leaf.view instanceof CodexWorkbenchView) {
        leaf.view.refreshInteractiveState();
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

  private getContextAnchorFile(context?: CodexContext | null): TFile | null {
    if (context?.notePath) {
      const abstractFile = this.app.vault.getAbstractFileByPath(context.notePath);
      if (abstractFile instanceof TFile) {
        return abstractFile;
      }
    }

    const activeFile = this.app.workspace.getActiveFile();
    return activeFile instanceof TFile ? activeFile : null;
  }

  private getFileTags(file: TFile): string[] {
    const fileCache = this.app.metadataCache.getFileCache(file);
    const inlineTags = fileCache?.tags?.map((entry) => normalizeTag(entry.tag)) ?? [];
    const frontmatterTags = normalizeFrontmatterTags(fileCache?.frontmatter?.tags);
    return Array.from(new Set([...inlineTags, ...frontmatterTags]));
  }

  private async resolveContextBundle(context?: CodexContext | null): Promise<ResolvedContextBundle> {
    const sections: string[] = [];
    const citations: ContextCitation[] = [];
    const sources: ResolvedContextSource[] = [];
    const contextPack = this.getActiveContextPack();
    const anchorFile = this.getContextAnchorFile(context);
    const repoPaths = this.getProjectContextPaths();
    const activeRepoPath = this.getActiveRepoPath();
    const activeTag = this.getActiveTag(context);
    const includeCurrentNote = contextPack?.includeCurrentNote ?? true;
    const activeFolderPath = contextPack?.folderPath?.trim() || this.getCurrentFolderPath(context);

    sections.push(`Workbench mode: ${titleCase(this.workbenchMode)}`);
    sections.push(`Context scope: ${titleCase(this.activeContextScope)}`);

    if (contextPack) {
      sections.push(`Active context pack: ${contextPack.name}`);
    }

    sections.push(
      [
        `Vault workspace root: ${this.getConversationCwd()}`,
        repoPaths.length > 0
          ? `Configured repo roots:\n${repoPaths.map((projectPath, index) => `${index + 1}. ${projectPath}`).join("\n")}`
          : "Configured repo roots: (none configured)",
      ].join("\n\n"),
    );

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

      if (context.selection) {
        sources.push({
          kind: "selection",
          label: `Selection · ${context.noteTitle}`,
          path: context.notePath,
          detail: context.selectionPreview,
          content: context.selection,
        });
      }
    }

    if (includeCurrentNote && anchorFile) {
      const noteContent = await this.readVaultFileSnippet(anchorFile, MAX_CONTEXT_SNIPPET_CHARS);
      if (noteContent) {
        sources.push({
          kind: "note",
          label: `Note · ${anchorFile.basename}`,
          path: anchorFile.path,
          detail: "Current note",
          content: noteContent,
        });
      }
    }

    if (contextPack?.extraNotePaths.length) {
      const explicitNotes = await this.collectExplicitNoteSources(contextPack.extraNotePaths);
      sources.push(...explicitNotes);
    }

    if (this.activeContextScope === "folder" && activeFolderPath) {
      const folderNotes = await this.collectFolderSources(activeFolderPath, anchorFile?.path ?? null);
      sources.push(...folderNotes);
      sections.push(`Active folder context: ${activeFolderPath}`);
    }

    if (this.activeContextScope === "tag" && activeTag) {
      const tagNotes = await this.collectTagSources(activeTag, anchorFile);
      sources.push(...tagNotes);
      sections.push(`Active tag context: ${activeTag}`);
    }

    if (this.activeContextScope === "repo" && activeRepoPath) {
      const repoSources = this.collectRepoSources(activeRepoPath, contextPack?.extraRepoFiles ?? []);
      sources.push(...repoSources);
      sections.push(`Active repo context: ${activeRepoPath}`);
    } else if (contextPack?.extraRepoFiles.length && activeRepoPath) {
      sources.push(...this.collectRepoSources(activeRepoPath, contextPack.extraRepoFiles, true));
    }

    const dedupedSources = dedupeSources(sources);
    if (dedupedSources.length > 0) {
      sections.push(
        `Source index:\n${dedupedSources.map((source, index) => {
          const location = source.path ? ` (${source.path})` : "";
          return `${index + 1}. ${source.label}${location}`;
        }).join("\n")}`,
      );

      dedupedSources.forEach((source, index) => {
        citations.push({
          kind: source.kind,
          label: source.label,
          path: source.path,
          detail: source.detail,
        });

        sections.push(
          [
            `Source ${index + 1}: ${source.label}`,
            source.path ? `Path: ${source.path}` : "",
            source.content,
          ].filter(Boolean).join("\n"),
        );
      });
    }

    sections.push(this.buildModeInstructionBlock());

    sections.push(
      [
        "Answer inside the Obsidian sidebar.",
        "Base the answer on the provided sources and current note context.",
        "Keep the response directly useful for the current note and avoid taking external actions unless the user explicitly asks.",
      ].join(" "),
    );

    return {
      promptBlock: sections.join("\n\n"),
      citations: dedupeCitations(citations),
    };
  }

  private async collectFolderSources(folderPath: string, excludedPath: string | null): Promise<ResolvedContextSource[]> {
    const siblingNotes = this.app.vault.getMarkdownFiles()
      .filter((file) => file.path !== excludedPath && (file.parent?.path ?? "") === folderPath)
      .slice(0, MAX_FOLDER_NOTES);

    const sources = await Promise.all(siblingNotes.map(async (file): Promise<ResolvedContextSource | null> => {
      const content = await this.readVaultFileSnippet(file, 1400);
      if (!content) {
        return null;
      }

      return {
        kind: "folder-note" as const,
        label: `Folder note · ${file.basename}`,
        path: file.path,
        detail: folderPath || "/",
        content,
      };
    }));

    return sources.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  }

  private async collectExplicitNoteSources(notePaths: string[]): Promise<ResolvedContextSource[]> {
    const sources = await Promise.all(notePaths.map(async (notePath): Promise<ResolvedContextSource | null> => {
      const file = this.app.vault.getAbstractFileByPath(notePath);
      if (!(file instanceof TFile)) {
        return null;
      }

      const content = await this.readVaultFileSnippet(file, 1400);
      if (!content) {
        return null;
      }

      return {
        kind: "note",
        label: `Pack note · ${file.basename}`,
        path: file.path,
        detail: "Context pack",
        content,
      };
    }));

    return sources.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  }

  private async collectTagSources(tag: string, anchorFile: TFile | null): Promise<ResolvedContextSource[]> {
    const taggedNotes = this.app.vault.getMarkdownFiles()
      .filter((file) => this.getFileTags(file).includes(tag))
      .sort((left, right) => {
        if (anchorFile && left.path === anchorFile.path) {
          return -1;
        }

        if (anchorFile && right.path === anchorFile.path) {
          return 1;
        }

        return left.basename.localeCompare(right.basename);
      })
      .slice(0, MAX_TAG_NOTES);

    const sources = await Promise.all(taggedNotes.map(async (file): Promise<ResolvedContextSource | null> => {
      const content = await this.readVaultFileSnippet(file, 1400);
      if (!content) {
        return null;
      }

      return {
        kind: "tag-note" as const,
        label: `Tag ${tag} · ${file.basename}`,
        path: file.path,
        detail: tag,
        content,
      };
    }));

    return sources.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  }

  private collectRepoSources(repoPath: string, extraRepoFiles: string[] = [], explicitOnly = false): ResolvedContextSource[] {
    if (!existsSync(repoPath)) {
      return [];
    }

    const candidateFiles = new Set<string>();
    if (!explicitOnly) {
      const topLevelEntries = safeReadDirectory(repoPath);

      topLevelEntries.forEach((entry) => {
        const lowerName = entry.name.toLowerCase();
        if (!entry.isFile) {
          return;
        }

        if (
          lowerName.startsWith("readme") ||
          lowerName === "package.json" ||
          lowerName === "pyproject.toml" ||
          lowerName === "cargo.toml" ||
          lowerName === "go.mod" ||
          lowerName.includes("arch") ||
          lowerName.includes("design") ||
          lowerName.includes("overview")
        ) {
          candidateFiles.add(path.join(repoPath, entry.name));
        }
      });

      ["docs", "doc", "architecture", "architectures"].forEach((dirName) => {
        const absoluteDir = path.join(repoPath, dirName);
        if (!existsSync(absoluteDir) || !safeIsDirectory(absoluteDir)) {
          return;
        }

        safeReadDirectory(absoluteDir)
          .filter((entry) => entry.isFile && isContextFriendlyFile(entry.name))
          .slice(0, 3)
          .forEach((entry) => {
            candidateFiles.add(path.join(absoluteDir, entry.name));
          });
      });
    }

    extraRepoFiles.forEach((repoFile) => {
      const absolutePath = path.isAbsolute(repoFile) ? repoFile : path.join(repoPath, repoFile);
      candidateFiles.add(absolutePath);
    });

    return Array.from(candidateFiles)
      .slice(0, MAX_REPO_FILES)
      .flatMap((absolutePath) => {
        try {
          const content = readFileSync(absolutePath, "utf8").trim();
          if (!content) {
            return [];
          }

          return [{
            kind: "repo-file" as const,
            label: `Repo file · ${path.relative(repoPath, absolutePath)}`,
            path: absolutePath,
            detail: repoPath,
            content: truncateContent(content, 1800),
          }];
        } catch {
          return [];
        }
      });
  }

  private async readVaultFileSnippet(file: TFile, maxLength: number): Promise<string> {
    try {
      const content = (await this.app.vault.cachedRead(file)).trim();
      if (!content) {
        return "";
      }

      return truncateContent(content, maxLength);
    } catch {
      return "";
    }
  }

  private buildModeInstructionBlock(): string {
    if (this.workbenchMode === "learning") {
      return [
        "Learning mode is active.",
        "Teach step by step, surface assumptions, explain jargon in plain language, and connect the answer back to the current note.",
        "When appropriate, end with a short self-check or one follow-up question that helps the user learn.",
      ].join(" ");
    }

    return [
      "Default mode is active.",
      "Optimize for a concise, directly useful response that helps the user continue writing or working immediately.",
    ].join(" ");
  }

  private buildCodexPrompt(question: string, resolvedContext: ResolvedContextBundle): string {
    return [
      `User request:\n${question}`,
      resolvedContext.promptBlock,
    ].join("\n\n");
  }

  private async generateLearningArtifactBody(
    turn: ChatTurn,
    artifactType: LearningArtifactType,
    resolvedContext: ResolvedContextBundle,
  ): Promise<string> {
    const prompt = this.buildLearningArtifactPrompt(turn, artifactType, resolvedContext);

    if (this.settings.providerMode === "local-codex") {
      const client = new LocalCodexAppServerClient();
      client.setApprovalHandler(async (request) => {
        const decision = await promptForApproval(this.app, request);
        return this.mapApprovalDecision(request, decision);
      });

      try {
        const result = await client.sendTurn({
          prompt,
          cwd: this.getConversationCwd(),
          settings: {
            ...this.settings,
            codexSandboxMode: "read-only",
          },
        });
        const answer = result.answer.trim();
        if (!answer) {
          throw new Error("Codex returned an empty learning artifact.");
        }
        return answer;
      } finally {
        client.dispose();
      }
    }

    const result = await requestCompletion(this.settings, {
      question: prompt,
      context: turn.context ?? null,
      history: [],
      resolvedContextBlock: resolvedContext.promptBlock,
      workbenchMode: "learning",
    });

    const answer = result.answer.trim();
    if (!answer) {
      throw new Error("The provider returned an empty learning artifact.");
    }
    return answer;
  }

  private buildLearningArtifactPrompt(
    turn: ChatTurn,
    artifactType: LearningArtifactType,
    resolvedContext: ResolvedContextBundle,
  ): string {
    const artifact = getLearningArtifactDefinition(artifactType);
    const sourceQuestion = this.getSourceQuestionForTurn(turn.id);
    const citationLines = (turn.citations ?? [])
      .map((citation) => `- ${citation.label}${citation.path ? ` (${citation.path})` : ""}`)
      .join("\n");

    return [
      "Create a reusable Obsidian learning artifact in Markdown.",
      "Work only from the provided material. Do not use tools, do not run commands, do not ask follow-up questions, and do not wrap the whole output in a code fence.",
      "Write the artifact in Chinese unless the source material clearly needs another language.",
      `Artifact type: ${artifact.label}.`,
      artifact.promptInstruction,
      "Do not include frontmatter. Do not include an H1 title. Start directly with the body sections.",
      sourceQuestion
        ? `Original learner request:\n${sourceQuestion}`
        : "Original learner request: (not available)",
      `Assistant answer to transform:\n${turn.content}`,
      citationLines
        ? `Citations attached to this answer:\n${citationLines}`
        : "Citations attached to this answer: (none)",
      `Additional workbench context:\n${resolvedContext.promptBlock}`,
    ].join("\n\n");
  }

  private getSourceQuestionForTurn(turnId: string): string {
    const turnIndex = this.history.findIndex((entry) => entry.id === turnId);
    if (turnIndex <= 0) {
      return "";
    }

    for (let index = turnIndex - 1; index >= 0; index -= 1) {
      const candidate = this.history[index];
      if (candidate && candidate.role === "user" && candidate.content.trim()) {
        return candidate.content.trim();
      }
    }

    return "";
  }

  private async persistLearningArtifact(
    anchorFile: TFile,
    turn: ChatTurn,
    artifactType: LearningArtifactType,
    artifactBody: string,
  ): Promise<TFile> {
    const artifact = getLearningArtifactDefinition(artifactType);
    const folderPath = getLearningArtifactFolderPath(anchorFile);
    await this.ensureVaultFolder(folderPath);

    const artifactPath = normalizePath(`${folderPath}/${artifact.fileName}.md`);
    const noteContent = this.buildLearningArtifactNote(anchorFile, turn, artifactType, artifactBody);
    const existing = this.app.vault.getAbstractFileByPath(artifactPath);
    if (existing instanceof TFile) {
      await this.app.vault.process(existing, () => noteContent);
      return existing;
    }

    return await this.app.vault.create(artifactPath, noteContent);
  }

  private buildLearningArtifactNote(
    anchorFile: TFile,
    turn: ChatTurn,
    artifactType: LearningArtifactType,
    artifactBody: string,
  ): string {
    const artifact = getLearningArtifactDefinition(artifactType);
    const sourceQuestion = this.getSourceQuestionForTurn(turn.id);
    const generatedAt = new Date().toLocaleString([], {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    const sourceLinks = [
      `- 当前笔记：${toWikiLink(anchorFile.path, anchorFile.basename)}`,
      ...((turn.citations ?? []).map((citation) => `- ${formatCitationAsLink(citation)}`)),
    ];

    return [
      `# ${artifact.label}`,
      "",
      `> 来源笔记：${toWikiLink(anchorFile.path, anchorFile.basename)}`,
      `> 生成时间：${generatedAt}`,
      sourceQuestion ? `> 来源问题：${truncate(sourceQuestion.replace(/\s+/g, " "), 180)}` : null,
      "",
      artifactBody.trim(),
      "",
      "## 来源",
      ...sourceLinks,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
  }

  private async syncLearningArtifactLinks(anchorFile: TFile): Promise<void> {
    const folderPath = getLearningArtifactFolderPath(anchorFile);
    const artifactLinks = LEARNING_ARTIFACT_TYPES.flatMap((artifactType) => {
      const artifact = getLearningArtifactDefinition(artifactType);
      const artifactPath = normalizePath(`${folderPath}/${artifact.fileName}.md`);
      const existing = this.app.vault.getAbstractFileByPath(artifactPath);
      if (!(existing instanceof TFile)) {
        return [];
      }

      return [`- ${toWikiLink(existing.path, artifact.label)}`];
    });

    if (artifactLinks.length === 0) {
      return;
    }

    const managedBlock = [
      LEARNING_ARTIFACT_BLOCK_START,
      "## 学习收录",
      `> 收录目录：\`${folderPath}\``,
      ...artifactLinks,
      LEARNING_ARTIFACT_BLOCK_END,
    ].join("\n");

    await this.app.vault.process(anchorFile, (content) => upsertManagedBlock(
      content,
      LEARNING_ARTIFACT_BLOCK_START,
      LEARNING_ARTIFACT_BLOCK_END,
      managedBlock,
    ));
  }

  private async ensureVaultFolder(folderPath: string): Promise<void> {
    if (!folderPath) {
      return;
    }

    const existing = this.app.vault.getAbstractFileByPath(folderPath);
    if (existing instanceof TFolder) {
      return;
    }

    if (existing instanceof TFile) {
      throw new Error(`A file already exists at ${folderPath}.`);
    }

    await this.app.vault.createFolder(folderPath);
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
      this.getWorkbenchView()?.requestScrollToLatest();
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

  private schedulePluginDataSave(): void {
    if (this.draftSaveHandle !== null) {
      window.clearTimeout(this.draftSaveHandle);
    }

    this.draftSaveHandle = window.setTimeout(() => {
      this.draftSaveHandle = null;
      void this.savePluginData();
    }, 250);
  }
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1)}…`;
}

function truncateContent(value: string, maxLength: number): string {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}…`;
}

function normalizeTag(tag: string): string {
  if (!tag) {
    return "";
  }

  return tag.startsWith("#") ? tag : `#${tag}`;
}

function normalizeFrontmatterTags(rawValue: unknown): string[] {
  if (typeof rawValue === "string") {
    return rawValue
      .split(",")
      .map((value) => normalizeTag(value.trim()))
      .filter(Boolean);
  }

  if (Array.isArray(rawValue)) {
    return rawValue
      .flatMap((value) => typeof value === "string" ? [normalizeTag(value.trim())] : [])
      .filter(Boolean);
  }

  return [];
}

function dedupeCitations(citations: ContextCitation[]): ContextCitation[] {
  const seen = new Set<string>();
  return citations.filter((citation) => {
    const key = `${citation.kind}:${citation.label}:${citation.path ?? ""}:${citation.detail ?? ""}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function dedupeSources(sources: ResolvedContextSource[]): ResolvedContextSource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = `${source.kind}:${source.label}:${source.path ?? ""}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function isSameContext(left: CodexContext | null, right: CodexContext | null): boolean {
  if (!left && !right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return left.notePath === right.notePath
    && left.noteTitle === right.noteTitle
    && left.selection === right.selection
    && left.selectionPreview === right.selectionPreview
    && left.surroundingText === right.surroundingText;
}

function safeReadDirectory(dirPath: string): Array<{ name: string; isFile: boolean; isDirectory: boolean }> {
  try {
    return readdirSync(dirPath).flatMap((entryName) => {
      const entryPath = path.join(dirPath, entryName);
      try {
        const stats = statSync(entryPath);
        return [{
          name: entryName,
          isFile: stats.isFile(),
          isDirectory: stats.isDirectory(),
        }];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function safeIsDirectory(dirPath: string): boolean {
  try {
    return statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function isContextFriendlyFile(fileName: string): boolean {
  const lowerName = fileName.toLowerCase();
  return lowerName.endsWith(".md") || lowerName.endsWith(".mdx") || lowerName.endsWith(".txt");
}

function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((segment) => segment[0]?.toUpperCase() + segment.slice(1))
    .join(" ");
}

type LearningArtifactDefinition = {
  label: string;
  fileName: string;
  promptInstruction: string;
};

const LEARNING_ARTIFACT_DEFINITIONS: Record<LearningArtifactType, LearningArtifactDefinition> = {
  "study-note": {
    label: "学习笔记",
    fileName: "学习笔记",
    promptInstruction: "Turn the answer into a concise study note with sections for 核心概念, 分步理解, 例子或类比, and 下一步追问.",
  },
  "term-cards": {
    label: "术语卡片",
    fileName: "术语卡片",
    promptInstruction: "Extract the key terms and format them as compact term cards. Each card should explain 定义, 为什么重要, and 容易混淆点.",
  },
  confusions: {
    label: "错题与易混点",
    fileName: "错题与易混点",
    promptInstruction: "Rewrite the answer as a list of common mistakes or confusions. Each item should include 易错点, 正确理解, and 一个快速自测问题.",
  },
  "qa-cards": {
    label: "Anki问答卡",
    fileName: "Anki问答卡",
    promptInstruction: "Rewrite the material into spaced-repetition friendly Q/A cards. Use concise answers and cover definitions, reasoning, and comparisons.",
  },
};

const LEARNING_ARTIFACT_TYPES = Object.keys(LEARNING_ARTIFACT_DEFINITIONS) as LearningArtifactType[];

function getLearningArtifactDefinition(artifactType: LearningArtifactType): LearningArtifactDefinition {
  return LEARNING_ARTIFACT_DEFINITIONS[artifactType];
}

function normalizeContextPack(pack: Partial<ContextPack>): ContextPack {
  return {
    id: pack.id ?? `pack-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: pack.name?.trim() || "Untitled pack",
    scope: pack.scope ?? "note",
    folderPath: pack.folderPath?.trim() || null,
    repoPath: pack.repoPath?.trim() || null,
    tag: pack.tag?.trim() || null,
    includeCurrentNote: pack.includeCurrentNote ?? true,
    extraNotePaths: Array.isArray(pack.extraNotePaths) ? pack.extraNotePaths.map((entry) => entry.trim()).filter(Boolean) : [],
    extraRepoFiles: Array.isArray(pack.extraRepoFiles) ? pack.extraRepoFiles.map((entry) => entry.trim()).filter(Boolean) : [],
  };
}

function getElectronShell(): { openPath: (targetPath: string) => Promise<string> } | null {
  const globalWindow = window as Window & { require?: (id: string) => { shell?: { openPath: (targetPath: string) => Promise<string> } } };
  return globalWindow.require?.("electron")?.shell ?? null;
}

function getLearningArtifactFolderPath(anchorFile: TFile): string {
  const parentPath = path.posix.dirname(anchorFile.path);
  const folderName = `${anchorFile.basename}${LEARNING_ARTIFACT_FOLDER_SUFFIX}`;
  return parentPath === "." ? folderName : normalizePath(`${parentPath}/${folderName}`);
}

function stripMarkdownExtension(filePath: string): string {
  return filePath.replace(/\.md$/i, "");
}

function toWikiLink(filePath: string, alias?: string): string {
  const target = stripMarkdownExtension(filePath);
  return alias ? `[[${target}|${alias}]]` : `[[${target}]]`;
}

function formatCitationAsLink(citation: ContextCitation): string {
  if (citation.path) {
    if (path.isAbsolute(citation.path)) {
      return `${citation.label} (\`${citation.path}\`)`;
    }
    return toWikiLink(citation.path, citation.label);
  }

  return citation.label;
}

function upsertManagedBlock(content: string, startMarker: string, endMarker: string, block: string): string {
  const pattern = new RegExp(`${escapeForRegExp(startMarker)}[\\s\\S]*?${escapeForRegExp(endMarker)}\\n?`, "m");
  const normalized = content.trimEnd();
  if (pattern.test(normalized)) {
    return normalized.replace(pattern, `${block}\n`);
  }

  if (!normalized) {
    return `${block}\n`;
  }

  return `${normalized}\n\n${block}\n`;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
