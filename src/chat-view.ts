import { ItemView, MarkdownRenderer, MarkdownView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type CodexWorkbenchPlugin from "./main";
import type { ChatTurn } from "./types";

export const VIEW_TYPE_CODEX_WORKBENCH = "codex-workbench-view";
const STREAMING_MARKDOWN_INITIAL_DELAY_MS = 40;
const STREAMING_MARKDOWN_DEBOUNCE_MS = 120;
const MATH_SOURCE_ATTRIBUTE = "data-codex-math-source";

type RenderedTurnRefs = {
  turnId: string;
  wrapper: HTMLElement;
  body: HTMLElement;
  role: ChatTurn["role"];
  content: string;
  streaming: boolean;
  sourcePath: string;
  renderMode: "plain" | "markdown";
  copyButton: HTMLButtonElement | null;
  insertButton: HTMLButtonElement | null;
  replaceButton: HTMLButtonElement | null;
  markdownRenderHandle: number | null;
  markdownRenderVersion: number;
};

export class CodexWorkbenchView extends ItemView {
  plugin: CodexWorkbenchPlugin;
  private messageListEl: HTMLElement | null = null;
  private composerEl: HTMLTextAreaElement | null = null;
  private contextCardEl: HTMLElement | null = null;
  private sendButtonEl: HTMLButtonElement | null = null;
  private askSelectionButtonEl: HTMLButtonElement | null = null;
  private newSessionButtonEl: HTMLButtonElement | null = null;
  private insertLastButtonEl: HTMLButtonElement | null = null;
  private replaceSelectionButtonEl: HTMLButtonElement | null = null;
  private copyLastButtonEl: HTMLButtonElement | null = null;
  private messageRenderVersion = 0;
  private isComposerComposing = false;
  private renderedTurns = new Map<string, RenderedTurnRefs>();
  private emptyStateEl: HTMLElement | null = null;
  private loadingRowEl: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: CodexWorkbenchPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_CODEX_WORKBENCH;
  }

  getDisplayText(): string {
    return "Codex Workbench";
  }

  getIcon(): string {
    return "bot";
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  async onClose(): Promise<void> {
    this.disposeRenderedTurns();
    this.emptyStateEl = null;
    this.loadingRowEl = null;
    this.contentEl.empty();
  }

  refresh(): void {
    void this.renderMessages();
    this.renderContextCard();
    this.refreshInteractiveState();
  }

  refreshInteractiveState(): void {
    this.renderHeaderState();
    this.refreshMessageActionStates();
  }

  setComposerValue(value: string): void {
    if (this.composerEl) {
      this.applyComposerValue(value, true);
      this.composerEl.focus();
    }
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("codex-workbench-view");
    this.disposeRenderedTurns();
    this.emptyStateEl = null;
    this.loadingRowEl = null;

    const shell = contentEl.createDiv({ cls: "codex-workbench-shell" });

    this.contextCardEl = shell.createDiv({ cls: "codex-workbench-context-card" });

    this.messageListEl = shell.createDiv({ cls: "codex-workbench-message-list" });

    const composerWrap = shell.createDiv({ cls: "codex-workbench-composer-wrap" });
    const composerTopline = composerWrap.createDiv({ cls: "codex-workbench-composer-topline" });
    composerTopline.createEl("span", {
      text: "Chat",
      cls: "codex-workbench-composer-label",
    });
    composerTopline.createEl("span", {
      text: "Enter to send, Shift+Enter for newline",
      cls: "codex-workbench-composer-hint",
    });

    this.composerEl = composerWrap.createEl("textarea", {
      cls: "codex-workbench-composer",
      attr: {
        rows: "1",
        placeholder: "Ask Codex to explain, rewrite, draft, or continue from the current note context...",
      },
    });
    this.applyComposerValue(this.plugin.composerDraft, false);

    this.composerEl.addEventListener("compositionstart", () => {
      this.isComposerComposing = true;
    });

    this.composerEl.addEventListener("compositionend", () => {
      this.isComposerComposing = false;
    });

    this.composerEl.addEventListener("keydown", (event) => {
      const nativeEvent = event as KeyboardEvent & { isComposing?: boolean; keyCode?: number };
      if (nativeEvent.isComposing || this.isComposerComposing || nativeEvent.keyCode === 229) {
        return;
      }

      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void this.submitComposer();
      }
    });

    this.composerEl.addEventListener("input", () => {
      if (!this.composerEl) {
        return;
      }

      this.applyComposerValue(this.composerEl.value, false);
    });

    const composerFooter = composerWrap.createDiv({ cls: "codex-workbench-composer-footer" });
    const footerActions = composerFooter.createDiv({ cls: "codex-workbench-composer-actions" });
    this.askSelectionButtonEl = this.createActionButton(footerActions, "Ask selection", "highlighter", async () => {
      await this.plugin.askSelectionFromActiveEditor();
    });
    this.newSessionButtonEl = this.createActionButton(footerActions, "New session", "rotate-ccw", () => {
      void this.plugin.resetConversationSession();
    });
    this.insertLastButtonEl = this.createActionButton(footerActions, "Insert last", "corner-down-left", () => {
      void this.plugin.insertLastReply();
    });
    this.replaceSelectionButtonEl = this.createActionButton(footerActions, "Replace selection", "replace", () => {
      void this.plugin.replaceSelectionWithLastReply();
    });
    this.copyLastButtonEl = this.createActionButton(footerActions, "Copy last", "copy", () => {
      void this.plugin.copyLastReply();
    });

    this.sendButtonEl = composerFooter.createEl("button", {
      cls: "mod-cta codex-workbench-send-button",
      text: "Send",
    });
    this.sendButtonEl.addEventListener("click", () => {
      void this.submitComposer();
    });

    this.refresh();
  }

  private renderHeaderState(): void {
    const hasDraft = Boolean(this.composerEl?.value.trim());
    const hasLastReply = Boolean(this.plugin.lastAssistantReply);
    const hasActiveEditor = this.hasActiveMarkdownView();
    const hasSelection = this.hasActiveSelection();

    if (this.sendButtonEl) {
      this.sendButtonEl.disabled = this.plugin.isBusy || !hasDraft;
      this.sendButtonEl.setText(this.plugin.isBusy ? "Working..." : "Send");
    }

    this.setButtonState(this.askSelectionButtonEl, !this.plugin.isBusy && hasSelection);
    this.setButtonState(this.newSessionButtonEl, !this.plugin.isBusy);
    this.setButtonState(this.insertLastButtonEl, hasLastReply && hasActiveEditor);
    this.setButtonState(this.replaceSelectionButtonEl, hasLastReply && hasSelection);
    this.setButtonState(this.copyLastButtonEl, hasLastReply);
  }

  private renderContextCard(): void {
    if (!this.contextCardEl) {
      return;
    }

    this.contextCardEl.empty();
    const context = this.plugin.pendingContext;
    const projectContextPaths = this.plugin.getProjectContextPaths();
    this.contextCardEl.toggleClass("is-empty", !context && projectContextPaths.length === 0);

    const noteRow = this.contextCardEl.createDiv({ cls: "codex-workbench-context-row codex-workbench-context-row--note" });
    noteRow.createEl("span", {
      text: "Note",
      cls: "codex-workbench-context-eyebrow",
    });

    const noteSummary = noteRow.createDiv({
      cls: "codex-workbench-context-summary",
      attr: context ? { title: context.notePath } : {},
    });

    if (!context) {
      noteSummary.createEl("span", {
        text: "No pinned selection",
        cls: "codex-workbench-context-title",
      });
      noteSummary.createEl("span", {
        text: "Select text to anchor the next turn.",
        cls: "codex-workbench-context-copy codex-workbench-context-copy--compact",
      });
    } else {
      noteSummary.createEl("span", {
        text: context.noteTitle,
        cls: "codex-workbench-context-title",
      });
      noteSummary.createEl("span", {
        text: context.selectionPreview,
        cls: "codex-workbench-context-preview",
      });

      const clearButton = noteRow.createEl("button", {
        text: "Clear",
        cls: "clickable-icon codex-workbench-inline-button codex-workbench-inline-button--compact",
      });
      clearButton.addEventListener("click", () => {
        this.plugin.clearPendingContext();
      });
    }

    if (projectContextPaths.length > 0) {
      const projectRow = this.contextCardEl.createDiv({ cls: "codex-workbench-context-row codex-workbench-context-row--project" });
      projectRow.createEl("span", {
        text: "Project",
        cls: "codex-workbench-context-eyebrow",
      });
      projectRow.createEl("span", {
        text: this.buildProjectContextSummary(projectContextPaths),
        cls: "codex-workbench-context-copy codex-workbench-context-copy--compact",
        attr: {
          title: projectContextPaths.join("\n"),
        },
      });
    }
  }

  private async renderMessages(): Promise<void> {
    if (!this.messageListEl) {
      return;
    }

    const shouldStickToBottom = this.isMessageListNearBottom();
    const renderVersion = ++this.messageRenderVersion;
    const history = this.plugin.history;

    if (history.length === 0) {
      this.clearRenderedTurns();
      this.syncLoadingRow(false);
      if (!this.emptyStateEl) {
        this.emptyStateEl = this.buildEmptyState();
      }
      if (this.messageListEl.firstChild !== this.emptyStateEl || this.messageListEl.childElementCount !== 1) {
        this.messageListEl.empty();
        this.messageListEl.appendChild(this.emptyStateEl);
      }
      return;
    }

    if (this.emptyStateEl) {
      this.emptyStateEl.remove();
      this.emptyStateEl = null;
    }

    const historyIds = new Set(history.map((turn) => turn.id));
    for (const [turnId, refs] of Array.from(this.renderedTurns.entries())) {
      if (historyIds.has(turnId)) {
        continue;
      }

      this.disposeRenderedTurn(refs);
      this.renderedTurns.delete(turnId);
    }

    let cursor: ChildNode | null = this.messageListEl.firstChild;
    for (const turn of history) {
      let refs = this.renderedTurns.get(turn.id);
      if (!refs) {
        refs = this.buildMessage(turn);
        this.renderedTurns.set(turn.id, refs);
      }
      refs.sourcePath = this.getSourcePath(turn);

      if (refs.wrapper !== cursor) {
        this.messageListEl.insertBefore(refs.wrapper, cursor);
      }
      cursor = refs.wrapper.nextSibling;

      await this.renderMessageBody(refs, turn);
      if (renderVersion !== this.messageRenderVersion) {
        return;
      }
    }

    this.syncLoadingRow(this.plugin.isBusy && !history.some((turn) => turn.streaming));
    this.refreshMessageActionStates();

    if (shouldStickToBottom || history.length <= 1) {
      this.scrollMessagesToBottom();
    }
  }

  private buildEmptyState(): HTMLElement {
    const emptyState = createDiv({ cls: "codex-workbench-empty-state" });
    emptyState.createEl("div", {
      text: "Start from chat, then push the result back into the note.",
      cls: "codex-workbench-empty-title",
    });
    emptyState.createEl("div", {
      text: "Select text to ask about a paragraph, or type a direct request like “rewrite this section in a cleaner style” or “turn this outline into a draft”.",
      cls: "codex-workbench-empty-copy",
    });
    return emptyState;
  }

  private buildMessage(turn: ChatTurn): RenderedTurnRefs {
    const wrapper = createDiv({ cls: `codex-workbench-turn codex-workbench-turn--${turn.role}` });

    wrapper.createDiv({
      cls: `codex-workbench-avatar codex-workbench-avatar--${turn.role}`,
      text: turn.role === "assistant" ? "C" : "Y",
    });

    const card = wrapper.createDiv({
      cls: `codex-workbench-message-card codex-workbench-message-card--${turn.role}`,
    });

    const meta = card.createDiv({ cls: "codex-workbench-message-meta" });
    meta.createEl("span", {
      text: turn.role === "assistant" ? "Codex" : "You",
      cls: "codex-workbench-message-role",
    });
    meta.createEl("span", {
      text: new Date(turn.createdAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
      cls: "codex-workbench-message-time",
    });

    if (turn.context?.selectionPreview) {
      const contextBadge = card.createDiv({ cls: "codex-workbench-message-context" });
      contextBadge.setText(turn.context.selectionPreview);
    }

    const body = card.createDiv({ cls: "codex-workbench-message-content" });
    if (turn.streaming) {
      body.addClass("is-streaming");
    }

    let copyButton: HTMLButtonElement | null = null;
    let insertButton: HTMLButtonElement | null = null;
    let replaceButton: HTMLButtonElement | null = null;

    if (turn.role === "assistant") {
      const footer = card.createDiv({ cls: "codex-workbench-message-footer" });
      copyButton = this.createActionButton(footer, "Copy", "copy", () => {
        void this.plugin.copyReplyText(turn.content);
      }, "codex-workbench-message-action");
      insertButton = this.createActionButton(footer, "Insert", "corner-down-left", () => {
        void this.plugin.insertReplyText(turn.content);
      }, "codex-workbench-message-action");
      replaceButton = this.createActionButton(footer, "Replace", "replace", () => {
        void this.plugin.replaceSelectionWithReplyText(turn.content);
      }, "codex-workbench-message-action");
    }

    const refs: RenderedTurnRefs = {
      turnId: turn.id,
      wrapper,
      body,
      role: turn.role,
      content: "",
      streaming: Boolean(turn.streaming),
      sourcePath: this.getSourcePath(turn),
      renderMode: "plain",
      copyButton,
      insertButton,
      replaceButton,
      markdownRenderHandle: null,
      markdownRenderVersion: 0,
    };

    body.addEventListener("copy", (event) => {
      this.handleBodyCopy(event, refs);
    });

    return refs;
  }

  private async renderMessageBody(refs: RenderedTurnRefs, turn: ChatTurn): Promise<void> {
    const content = turn.content || (turn.streaming ? "Thinking..." : "");
    const streaming = Boolean(turn.streaming);
    if (refs.content === content && refs.streaming === streaming) {
      return;
    }

    if (!content) {
      this.cancelScheduledMarkdownRender(refs);
      refs.body.empty();
      refs.body.removeClass("is-plain");
      refs.body.removeClass("is-streaming");
      refs.body.removeClass("codex-workbench-message-content--markdown");
      refs.content = "";
      refs.streaming = streaming;
      refs.renderMode = "plain";
      this.refreshMessageActionStates();
      return;
    }

    refs.content = content;
    refs.streaming = streaming;

    if (turn.role !== "assistant") {
      this.cancelScheduledMarkdownRender(refs);
      this.renderPlainBody(refs, content, streaming);
      this.refreshMessageActionStates();
      return;
    }

    if (streaming) {
      this.scheduleStreamingMarkdownRender(refs, content);
      if (!refs.body.hasChildNodes()) {
        this.renderPlainBody(refs, content, true);
      }
      this.refreshMessageActionStates();
      return;
    }

    this.cancelScheduledMarkdownRender(refs);
    await this.renderMarkdownBody(refs, content, false);
    this.refreshMessageActionStates();
  }

  private renderPlainBody(refs: RenderedTurnRefs, content: string, streaming: boolean): void {
    refs.body.empty();
    refs.body.addClass("is-plain");
    refs.body.removeClass("codex-workbench-message-content--markdown");
    refs.body.toggleClass("is-streaming", streaming);
    refs.body.setText(content);
    refs.renderMode = "plain";
  }

  private scheduleStreamingMarkdownRender(refs: RenderedTurnRefs, content: string): void {
    this.cancelScheduledMarkdownRender(refs);

    const delay = refs.renderMode === "markdown"
      ? STREAMING_MARKDOWN_DEBOUNCE_MS
      : STREAMING_MARKDOWN_INITIAL_DELAY_MS;

    refs.markdownRenderHandle = window.setTimeout(() => {
      refs.markdownRenderHandle = null;
      void this.flushStreamingMarkdownRender(refs, content);
    }, delay);
  }

  private async flushStreamingMarkdownRender(refs: RenderedTurnRefs, content: string): Promise<void> {
    if (!refs.streaming || refs.content !== content) {
      return;
    }

    if (this.hasUserSelectionInside(refs.body)) {
      this.scheduleStreamingMarkdownRender(refs, content);
      return;
    }

    await this.renderMarkdownBody(refs, content, true);
    this.refreshMessageActionStates();
  }

  private async renderMarkdownBody(refs: RenderedTurnRefs, content: string, streaming: boolean): Promise<void> {
    const renderVersion = ++refs.markdownRenderVersion;
    const fragment = createDiv();

    try {
      await MarkdownRenderer.render(this.app, content, fragment, refs.sourcePath, this);
      if (renderVersion !== refs.markdownRenderVersion) {
        return;
      }

      this.attachMathSources(fragment, content);

      refs.body.empty();
      refs.body.removeClass("is-plain");
      refs.body.addClass("codex-workbench-message-content--markdown");
      refs.body.toggleClass("is-streaming", streaming);
      refs.body.append(...Array.from(fragment.childNodes));
      refs.renderMode = "markdown";
    } catch {
      if (renderVersion !== refs.markdownRenderVersion) {
        return;
      }

      this.renderPlainBody(refs, content, streaming);
    }
  }

  private attachMathSources(container: HTMLElement, content: string): void {
    const mathSources = this.extractMathSources(content);
    if (mathSources.length === 0) {
      return;
    }

    const mathElements = this.getRenderedMathElements(container);
    const count = Math.min(mathSources.length, mathElements.length);
    for (let index = 0; index < count; index += 1) {
      const source = mathSources[index];
      if (!source) {
        continue;
      }

      mathElements[index]?.setAttribute(MATH_SOURCE_ATTRIBUTE, source);
    }
  }

  private getRenderedMathElements(container: HTMLElement): HTMLElement[] {
    const wrapperNodes = Array.from(container.querySelectorAll<HTMLElement>(".math"));
    if (wrapperNodes.length > 0) {
      return wrapperNodes;
    }

    return Array.from(container.querySelectorAll<HTMLElement>("mjx-container"));
  }

  private extractMathSources(content: string): string[] {
    const matches = content.match(/(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|(?<!\\)\$[^$\n]+?(?<!\\)\$)/g);
    return matches ?? [];
  }

  private cancelScheduledMarkdownRender(refs: RenderedTurnRefs): void {
    if (refs.markdownRenderHandle !== null) {
      window.clearTimeout(refs.markdownRenderHandle);
      refs.markdownRenderHandle = null;
    }
  }

  private hasUserSelectionInside(element: HTMLElement): boolean {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return false;
    }

    const range = selection.getRangeAt(0);
    const anchorNode = range.commonAncestorContainer;
    const anchorElement = anchorNode instanceof HTMLElement ? anchorNode : anchorNode.parentElement;
    return Boolean(anchorElement && element.contains(anchorElement));
  }

  private handleBodyCopy(event: ClipboardEvent, refs: RenderedTurnRefs): void {
    if (refs.renderMode !== "markdown") {
      return;
    }

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return;
    }

    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    const anchorElement = anchorNode instanceof HTMLElement ? anchorNode : anchorNode?.parentElement;
    const focusElement = focusNode instanceof HTMLElement ? focusNode : focusNode?.parentElement;
    if (!anchorElement || !focusElement) {
      return;
    }

    if (!refs.body.contains(anchorElement) || !refs.body.contains(focusElement)) {
      return;
    }

    const source = refs.content.trim();
    if (!source) {
      return;
    }

    event.clipboardData?.setData("text/plain", source);
    event.preventDefault();
  }

  private getSourcePath(turn: ChatTurn): string {
    return turn.context?.notePath ?? this.plugin.pendingContext?.notePath ?? "";
  }

  private scrollMessagesToBottom(): void {
    if (!this.messageListEl) {
      return;
    }

    this.messageListEl.scrollTop = this.messageListEl.scrollHeight;
  }

  private createActionButton(
    parent: HTMLElement,
    label: string,
    icon: string,
    action: () => void | Promise<void>,
    extraClass = "",
  ): HTMLButtonElement {
    const button = parent.createEl("button", {
      cls: extraClass
        ? `clickable-icon codex-workbench-toolbar-button ${extraClass}`
        : "clickable-icon codex-workbench-toolbar-button",
      attr: {
        "aria-label": label,
        type: "button",
      },
    });

    const iconContainer = button.createSpan({ cls: "codex-workbench-toolbar-button-icon" });
    setIcon(iconContainer, icon);
    button.createSpan({ text: label, cls: "codex-workbench-toolbar-button-text" });

    button.addEventListener("click", () => {
      void action();
    });

    return button;
  }

  private applyComposerValue(value: string, persist = true): void {
    if (!this.composerEl) {
      return;
    }

    this.composerEl.value = value;
    this.resizeComposer();
    if (persist) {
      this.plugin.setComposerDraft(value);
    }
    this.renderHeaderState();
  }

  private resizeComposer(): void {
    if (!this.composerEl) {
      return;
    }

    this.composerEl.style.height = "0px";
    const nextHeight = Math.min(Math.max(this.composerEl.scrollHeight, 78), 220);
    this.composerEl.style.height = `${nextHeight}px`;
  }

  private isMessageListNearBottom(): boolean {
    if (!this.messageListEl) {
      return true;
    }

    const remaining = this.messageListEl.scrollHeight - this.messageListEl.scrollTop - this.messageListEl.clientHeight;
    return remaining < 48;
  }

  private hasActiveMarkdownView(): boolean {
    return Boolean(this.plugin.app.workspace.getActiveViewOfType(MarkdownView));
  }

  private hasActiveSelection(): boolean {
    const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    return Boolean(view?.editor.getSelection().trim());
  }

  private setButtonState(button: HTMLButtonElement | null, enabled: boolean): void {
    if (!button) {
      return;
    }

    button.disabled = !enabled;
  }

  private async submitComposer(): Promise<void> {
    if (!this.composerEl) {
      return;
    }

    if (this.plugin.isBusy) {
      new Notice("Wait for the current Codex turn to finish before sending the next one.");
      return;
    }

    const rawValue = this.composerEl.value;
    const question = rawValue.trim();
    if (!question) {
      new Notice("Type a question before sending.");
      return;
    }

    this.applyComposerValue("", true);
    const result = await this.plugin.submitQuestion(question);
    if (result) {
      return;
    }

    this.applyComposerValue(rawValue, true);
    this.composerEl.focus();
  }

  private refreshMessageActionStates(): void {
    const hasActiveEditor = this.hasActiveMarkdownView();
    const hasSelection = this.hasActiveSelection();

    this.renderedTurns.forEach((refs) => {
      if (refs.role !== "assistant") {
        return;
      }

      const hasReply = Boolean(refs.content.trim()) && !refs.streaming;
      this.setButtonState(refs.copyButton, hasReply);
      this.setButtonState(refs.insertButton, hasReply && hasActiveEditor);
      this.setButtonState(refs.replaceButton, hasReply && hasSelection);
    });
  }

  private clearRenderedTurns(): void {
    this.disposeRenderedTurns();
  }

  private syncLoadingRow(shouldShow: boolean): void {
    if (!this.messageListEl) {
      return;
    }

    if (!shouldShow) {
      this.loadingRowEl?.remove();
      this.loadingRowEl = null;
      return;
    }

    if (!this.loadingRowEl) {
      const loading = createDiv({
        cls: "codex-workbench-loading-row",
      });
      loading.createDiv({ cls: "codex-workbench-avatar codex-workbench-avatar--assistant", text: "C" });
      const card = loading.createDiv({ cls: "codex-workbench-message-card codex-workbench-message-card--assistant" });
      const body = card.createDiv({ cls: "codex-workbench-message-content is-plain" });
      body.setText("Thinking...");
      this.loadingRowEl = loading;
    }

    if (this.loadingRowEl.parentElement !== this.messageListEl) {
      this.messageListEl.appendChild(this.loadingRowEl);
    } else if (this.messageListEl.lastChild !== this.loadingRowEl) {
      this.messageListEl.appendChild(this.loadingRowEl);
    }
  }

  private buildProjectContextSummary(projectContextPaths: string[]): string {
    const labels = projectContextPaths
      .slice(0, 2)
      .map((projectPath) => this.getPathLabel(projectPath));
    const remainder = projectContextPaths.length - labels.length;

    if (projectContextPaths.length === 1) {
      return labels[0] || "1 directory";
    }

    if (projectContextPaths.length === 2) {
      return labels.join(" • ");
    }

    return `${labels.join(" • ")} +${remainder}`;
  }

  private getPathLabel(projectPath: string): string {
    const segments = projectPath.split(/[\\/]/).filter(Boolean);
    return segments[segments.length - 1] ?? projectPath;
  }

  private disposeRenderedTurns(): void {
    this.renderedTurns.forEach((refs) => {
      this.disposeRenderedTurn(refs);
    });
    this.renderedTurns.clear();
  }

  private disposeRenderedTurn(refs: RenderedTurnRefs): void {
    this.cancelScheduledMarkdownRender(refs);
    refs.wrapper.remove();
  }
}
