import { ItemView, MarkdownRenderer, MarkdownView, Menu, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type CodexWorkbenchPlugin from "./main";
import type { ChatTurn } from "./types";

export const VIEW_TYPE_CODEX_WORKBENCH = "codex-workbench-view";
const STREAMING_MARKDOWN_INITIAL_DELAY_MS = 40;
const STREAMING_MARKDOWN_DEBOUNCE_MS = 120;
const MATH_SOURCE_ATTRIBUTE = "data-codex-math-source";
const SOURCE_BLOCK_ATTRIBUTE = "data-codex-source-block";

type RenderedTurnRefs = {
  turnId: string;
  wrapper: HTMLElement;
  body: HTMLElement;
  citationsEl: HTMLElement | null;
  role: ChatTurn["role"];
  content: string;
  streaming: boolean;
  sourcePath: string;
  renderMode: "plain" | "markdown";
  citationsKey: string;
  copyButton: HTMLButtonElement | null;
  insertButton: HTMLButtonElement | null;
  replaceButton: HTMLButtonElement | null;
  studyButton: HTMLButtonElement | null;
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
  private composerMenuButtonEl: HTMLButtonElement | null = null;
  private messageRenderVersion = 0;
  private isComposerComposing = false;
  private renderedTurns = new Map<string, RenderedTurnRefs>();
  private emptyStateEl: HTMLElement | null = null;
  private loadingRowEl: HTMLElement | null = null;
  private scrollToLatestOnNextRender = false;
  private followupScrollHandle: number | null = null;
  private recoveryScrollHandles: number[] = [];

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
    this.requestScrollToLatest();
    this.render();
  }

  async onClose(): Promise<void> {
    this.cancelFollowupScroll();
    this.cancelRecoveryScrolls();
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

  requestScrollToLatest(): void {
    this.scrollToLatestOnNextRender = true;
    this.scheduleRecoveryScrolls();
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
      text: "Codex",
      cls: "codex-workbench-composer-label",
    });
    composerTopline.createEl("span", {
      text: "Enter send, Shift+Enter newline, /learning-mode study",
      cls: "codex-workbench-composer-hint",
    });

    this.composerEl = composerWrap.createEl("textarea", {
      cls: "codex-workbench-composer",
      attr: {
        rows: "1",
        placeholder: "Ask Codex to explain, rewrite, plan, or study...",
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
    this.askSelectionButtonEl = this.createIconActionButton(footerActions, "Ask selection", "highlighter", async () => {
      await this.plugin.askSelectionFromActiveEditor();
    }, "codex-workbench-composer-quick-action");
    this.composerMenuButtonEl = this.createIconMenuButton(footerActions, "More actions", "ellipsis", (menu) => {
      const hasLastReply = Boolean(this.plugin.lastAssistantReply);
      const hasActiveEditor = this.hasActiveMarkdownView();
      const hasSelection = this.hasActiveSelection();

      menu.addItem((item) => {
        item
          .setTitle("New session")
          .setIcon("rotate-ccw")
          .setDisabled(this.plugin.isBusy)
          .onClick(() => {
            void this.plugin.resetConversationSession();
          });
      });
      menu.addItem((item) => {
        item
          .setTitle("Copy last")
          .setIcon("copy")
          .setDisabled(!hasLastReply)
          .onClick(() => {
            void this.plugin.copyLastReply();
          });
      });
      menu.addItem((item) => {
        item
          .setTitle("Insert last")
          .setIcon("corner-down-left")
          .setDisabled(!(hasLastReply && hasActiveEditor))
          .onClick(() => {
            void this.plugin.insertLastReply();
          });
      });
      menu.addItem((item) => {
        item
          .setTitle("Replace selection")
          .setIcon("replace")
          .setDisabled(!(hasLastReply && hasSelection))
          .onClick(() => {
            void this.plugin.replaceSelectionWithLastReply();
          });
      });
    }, "codex-workbench-composer-quick-action");

    const submitActions = composerFooter.createDiv({ cls: "codex-workbench-submit-actions" });
    this.sendButtonEl = submitActions.createEl("button", {
      cls: "mod-cta codex-workbench-send-button",
      text: "Send",
      attr: {
        type: "button",
      },
    });
    this.sendButtonEl.addEventListener("click", () => {
      if (this.plugin.isBusy && this.plugin.supportsInterruptCurrentTurn()) {
        void this.plugin.interruptCurrentTurn();
        return;
      }

      void this.submitComposer();
    });

    this.refresh();
  }

  private renderHeaderState(): void {
    const hasDraft = Boolean(this.composerEl?.value.trim());
    const hasLastReply = Boolean(this.plugin.lastAssistantReply);
    const hasSelection = this.hasActiveSelection();
    const canInterrupt = this.plugin.canInterruptCurrentTurn();

    if (this.sendButtonEl) {
      const isBusy = this.plugin.isBusy;
      this.sendButtonEl.disabled = isBusy
        ? !canInterrupt || this.plugin.isInterrupting
        : !hasDraft;
      this.sendButtonEl.toggleClass("mod-cta", !isBusy);
      this.sendButtonEl.toggleClass("mod-warning", isBusy);
      this.sendButtonEl.setText(
        isBusy
          ? (this.plugin.isInterrupting ? "Stopping..." : (canInterrupt ? "Stop" : "Working..."))
          : "Send",
      );
    }

    this.setButtonState(this.askSelectionButtonEl, !this.plugin.isBusy && hasSelection);
    this.setButtonState(this.composerMenuButtonEl, !this.plugin.isBusy || hasLastReply);
  }

  private renderContextCard(): void {
    if (!this.contextCardEl) {
      return;
    }

    this.contextCardEl.empty();
    const context = this.plugin.pendingContext;
    const availableTags = this.plugin.getAvailableTags(context);
    const activeTag = this.plugin.getActiveTag(context);
    const availableRepos = this.plugin.getAvailableRepoPaths();
    const activeRepo = this.plugin.getActiveRepoPath();
    const activePack = this.plugin.getActiveContextPack();

    const rail = this.contextCardEl.createDiv({ cls: "codex-workbench-context-rail" });
    const modeButtons = rail.createDiv({ cls: "codex-workbench-segmented-control codex-workbench-segmented-control--compact" });
    this.createSegmentButton(modeButtons, "default", "Default", this.plugin.workbenchMode === "default", async () => {
      await this.plugin.setWorkbenchMode("default");
    });
    this.createSegmentButton(modeButtons, "learning", "Learning", this.plugin.workbenchMode === "learning", async () => {
      await this.plugin.setWorkbenchMode("learning");
    });

    const scopeButtons = rail.createDiv({ cls: "codex-workbench-segmented-control codex-workbench-segmented-control--compact" });
    this.plugin.getAvailableContextScopes().forEach((scope) => {
      this.createSegmentButton(scopeButtons, scope, titleCase(scope), this.plugin.activeContextScope === scope, async () => {
        await this.plugin.setActiveContextScope(scope);
      });
    });

    const packSelect = rail.createEl("select", { cls: "dropdown codex-workbench-context-select codex-workbench-context-select--pack" });
    packSelect.createEl("option", {
      text: "Current setup",
      value: "",
    });
    this.plugin.getContextPacks().forEach((pack) => {
      packSelect.createEl("option", {
        text: pack.name,
        value: pack.id,
      });
    });
    packSelect.value = activePack?.id ?? "";
    packSelect.addEventListener("change", () => {
      void this.plugin.applyContextPack(packSelect.value || null);
    });

    const packMenuButton = rail.createEl("button", {
      cls: "clickable-icon codex-workbench-inline-button codex-workbench-inline-button--compact codex-workbench-inline-button--icon",
      attr: {
        type: "button",
        "aria-label": activePack ? `Manage ${activePack.name}` : "Save or manage context packs",
        title: activePack ? `Manage ${activePack.name}` : "Save or manage context packs",
      },
    });
    setIcon(packMenuButton, "ellipsis");
    packMenuButton.addEventListener("click", (event) => {
      const menu = new Menu();
      menu.addItem((item) => {
        item
          .setTitle("Save current setup as pack")
          .setIcon("plus")
          .onClick(() => {
            void this.plugin.saveCurrentContextPack();
          });
      });

      if (activePack) {
        menu.addItem((item) => {
          item
            .setTitle(`Edit ${activePack.name}`)
            .setIcon("pencil")
            .onClick(() => {
              void this.plugin.editActiveContextPack();
            });
        });
        menu.addItem((item) => {
          item
            .setTitle(`Delete ${activePack.name}`)
            .setIcon("trash")
            .onClick(() => {
              void this.plugin.deleteActiveContextPack();
            });
        });
      }

      menu.showAtMouseEvent(event);
    });

    if (this.plugin.activeContextScope === "tag" && availableTags.length > 0) {
      const tagSelect = rail.createEl("select", { cls: "dropdown codex-workbench-context-select" });
      availableTags.forEach((tag) => {
        tagSelect.createEl("option", {
          text: tag,
          value: tag,
        });
      });
      tagSelect.value = activeTag ?? availableTags[0] ?? "";
      tagSelect.addEventListener("change", () => {
        void this.plugin.setActiveTag(tagSelect.value);
      });
    }

    if (this.plugin.activeContextScope === "repo" && availableRepos.length > 0) {
      const repoSelect = rail.createEl("select", { cls: "dropdown codex-workbench-context-select" });
      availableRepos.forEach((repoPath) => {
        repoSelect.createEl("option", {
          text: this.getPathLabel(repoPath),
          value: repoPath,
        });
      });
      repoSelect.value = activeRepo ?? availableRepos[0] ?? "";
      repoSelect.addEventListener("change", () => {
        void this.plugin.setActiveRepoPath(repoSelect.value);
      });
    }

    if (context) {
      const noteSummary = rail.createDiv({
        cls: "codex-workbench-context-note-chip",
        attr: { title: context.notePath },
      });
      noteSummary.createEl("span", {
        text: context.noteTitle,
        cls: "codex-workbench-context-note-title",
      });
      noteSummary.createEl("span", {
        text: context.selection ? `· ${context.selectionPreview}` : "· Current note",
        cls: "codex-workbench-context-note-copy",
      });

      const clearButton = rail.createEl("button", {
        cls: "clickable-icon codex-workbench-inline-button codex-workbench-inline-button--compact codex-workbench-inline-button--icon codex-workbench-context-clear-button",
        attr: {
          type: "button",
          "aria-label": "Clear pinned context",
          title: "Clear pinned context",
        },
      });
      setIcon(clearButton, "x");
      clearButton.addEventListener("click", () => {
        this.plugin.clearPendingContext();
      });
    }
  }

  private async renderMessages(): Promise<void> {
    if (!this.messageListEl) {
      return;
    }

    const shouldForceScrollToLatest = this.scrollToLatestOnNextRender;
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
      this.renderMessageCitations(refs, turn);
      if (renderVersion !== this.messageRenderVersion) {
        return;
      }
    }

    this.syncLoadingRow(this.plugin.isBusy && !history.some((turn) => turn.streaming));
    this.refreshMessageActionStates();

    if (shouldForceScrollToLatest || shouldStickToBottom || history.length <= 1) {
      this.scrollMessagesToBottom(true);
      this.scrollToLatestOnNextRender = false;
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

    const citationsEl = turn.role === "assistant"
      ? card.createDiv({ cls: "codex-workbench-message-citations" })
      : null;

    let copyButton: HTMLButtonElement | null = null;
    let insertButton: HTMLButtonElement | null = null;
    let replaceButton: HTMLButtonElement | null = null;
    let studyButton: HTMLButtonElement | null = null;

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
      if (turn.mode === "learning") {
        studyButton = this.createMenuActionButton(footer, "Study", "book-open", (menu) => {
          menu.addItem((item) => {
            item
              .setTitle("Study note")
              .setIcon("file-text")
              .onClick(() => {
                void this.plugin.createLearningArtifactFromTurn(turn.id, "study-note");
              });
          });
          menu.addItem((item) => {
            item
              .setTitle("Term cards")
              .setIcon("library")
              .onClick(() => {
                void this.plugin.createLearningArtifactFromTurn(turn.id, "term-cards");
              });
          });
          menu.addItem((item) => {
            item
              .setTitle("Confusions")
              .setIcon("circle-alert")
              .onClick(() => {
                void this.plugin.createLearningArtifactFromTurn(turn.id, "confusions");
              });
          });
          menu.addItem((item) => {
            item
              .setTitle("Anki Q&A")
              .setIcon("list-checks")
              .onClick(() => {
                void this.plugin.createLearningArtifactFromTurn(turn.id, "qa-cards");
              });
          });
        }, "codex-workbench-message-action");
      }
    }

    const refs: RenderedTurnRefs = {
      turnId: turn.id,
      wrapper,
      body,
      citationsEl,
      role: turn.role,
      content: "",
      streaming: Boolean(turn.streaming),
      sourcePath: this.getSourcePath(turn),
      renderMode: "plain",
      citationsKey: "",
      copyButton,
      insertButton,
      replaceButton,
      studyButton,
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

  private renderMessageCitations(refs: RenderedTurnRefs, turn: ChatTurn): void {
    if (!refs.citationsEl) {
      return;
    }

    const citations = turn.citations ?? [];
    const nextKey = citations
      .map((citation) => `${citation.kind}:${citation.label}:${citation.path ?? ""}:${citation.detail ?? ""}`)
      .join("|");

    if (refs.citationsKey === nextKey) {
      return;
    }

    refs.citationsKey = nextKey;
    refs.citationsEl.empty();
    refs.citationsEl.hidden = citations.length === 0;

    citations.forEach((citation) => {
      const chip = refs.citationsEl?.createEl("button", {
        cls: `codex-workbench-citation codex-workbench-citation--${citation.kind}`,
        text: citation.label,
        attr: {
          type: "button",
        },
      });

      const titleParts = [citation.path, citation.detail].filter(Boolean);
      if (chip && titleParts.length > 0) {
        chip.title = titleParts.join("\n");
      }

      if (!chip) {
        return;
      }

      chip.disabled = !citation.path;
      chip.addEventListener("click", () => {
        void this.plugin.openCitation(citation);
      });
    });
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
    const sourceBlocks = splitMarkdownIntoSourceBlocks(content);

    try {
      for (const sourceBlock of sourceBlocks) {
        const blockEl = fragment.createDiv({ cls: "codex-workbench-source-block" });
        blockEl.setAttribute(SOURCE_BLOCK_ATTRIBUTE, sourceBlock);
        await MarkdownRenderer.render(this.app, sourceBlock, blockEl, refs.sourcePath, this);
      }

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

    const range = selection.getRangeAt(0);
    const source = this.getSelectedSourceBlocks(range, refs.body);
    if (!source) {
      return;
    }

    event.clipboardData?.setData("text/plain", source);
    event.preventDefault();
  }

  private getSelectedSourceBlocks(range: Range, body: HTMLElement): string {
    const sourceBlocks = Array.from(body.querySelectorAll<HTMLElement>(`[${SOURCE_BLOCK_ATTRIBUTE}]`));
    if (sourceBlocks.length === 0) {
      return body.innerText.trim();
    }

    const selectedSources = sourceBlocks
      .filter((block) => {
        try {
          return range.intersectsNode(block);
        } catch {
          return false;
        }
      })
      .map((block) => block.getAttribute(SOURCE_BLOCK_ATTRIBUTE) ?? "")
      .filter((blockSource) => blockSource.trim().length > 0);

    return selectedSources.join("\n\n").trim();
  }

  private getSourcePath(turn: ChatTurn): string {
    return turn.context?.notePath ?? this.plugin.pendingContext?.notePath ?? "";
  }

  private scrollMessagesToBottom(scheduleFollowup = false): void {
    if (!this.messageListEl) {
      return;
    }

    this.messageListEl.scrollTop = this.messageListEl.scrollHeight;
    this.scheduleRecoveryScrolls();

    if (!scheduleFollowup) {
      return;
    }

    this.scheduleFollowupScroll();
  }

  private scheduleFollowupScroll(): void {
    this.cancelFollowupScroll();
    this.followupScrollHandle = window.setTimeout(() => {
      this.followupScrollHandle = null;
      if (!this.messageListEl) {
        return;
      }

      this.messageListEl.scrollTop = this.messageListEl.scrollHeight;
      window.requestAnimationFrame(() => {
        if (!this.messageListEl) {
          return;
        }

        this.messageListEl.scrollTop = this.messageListEl.scrollHeight;
      });
    }, 60);
  }

  private cancelFollowupScroll(): void {
    if (this.followupScrollHandle !== null) {
      window.clearTimeout(this.followupScrollHandle);
      this.followupScrollHandle = null;
    }
  }

  private scheduleRecoveryScrolls(): void {
    this.cancelRecoveryScrolls();
    const delays = [0, 80, 220, 420];
    this.recoveryScrollHandles = delays.map((delay) => window.setTimeout(() => {
      if (!this.messageListEl) {
        return;
      }

      this.messageListEl.scrollTop = this.messageListEl.scrollHeight;
      window.requestAnimationFrame(() => {
        if (!this.messageListEl) {
          return;
        }

        this.messageListEl.scrollTop = this.messageListEl.scrollHeight;
      });
    }, delay));
  }

  private cancelRecoveryScrolls(): void {
    this.recoveryScrollHandles.forEach((handle) => {
      window.clearTimeout(handle);
    });
    this.recoveryScrollHandles = [];
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

  private createIconActionButton(
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
        title: label,
        type: "button",
      },
    });

    const iconContainer = button.createSpan({ cls: "codex-workbench-toolbar-button-icon" });
    setIcon(iconContainer, icon);
    button.addEventListener("click", () => {
      void action();
    });
    return button;
  }

  private createSegmentButton(
    parent: HTMLElement,
    value: string,
    label: string,
    active: boolean,
    action: () => void | Promise<void>,
  ): HTMLButtonElement {
    const button = parent.createEl("button", {
      text: label,
      cls: active
        ? "clickable-icon codex-workbench-segment-button is-active"
        : "clickable-icon codex-workbench-segment-button",
      attr: {
        type: "button",
        "data-value": value,
      },
    });

    button.addEventListener("click", () => {
      void action();
    });

    return button;
  }

  private createMenuActionButton(
    parent: HTMLElement,
    label: string,
    icon: string,
    buildMenu: (menu: Menu) => void,
    extraClass = "",
  ): HTMLButtonElement {
    const button = this.createActionButton(parent, label, icon, () => undefined, extraClass);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const menu = new Menu();
      buildMenu(menu);
      menu.showAtMouseEvent(event);
    });
    return button;
  }

  private createIconMenuButton(
    parent: HTMLElement,
    label: string,
    icon: string,
    buildMenu: (menu: Menu) => void,
    extraClass = "",
  ): HTMLButtonElement {
    const button = this.createIconActionButton(parent, label, icon, () => undefined, extraClass);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const menu = new Menu();
      buildMenu(menu);
      menu.showAtMouseEvent(event);
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

  private setButtonLabel(button: HTMLButtonElement | null, label: string): void {
    if (!button) {
      return;
    }

    button.setAttribute("aria-label", label);
    const labelEl = button.querySelector<HTMLElement>(".codex-workbench-toolbar-button-text");
    if (labelEl) {
      labelEl.setText(label);
    }
  }

  private async submitComposer(): Promise<void> {
    if (!this.composerEl) {
      return;
    }

    const rawValue = this.composerEl.value;
    const interpretedQuestion = await this.plugin.handleComposerCommand(rawValue);
    const question = interpretedQuestion?.trim() ?? "";
    if (interpretedQuestion === null) {
      this.applyComposerValue("", true);
      this.composerEl.focus();
      return;
    }

    if (this.plugin.isBusy) {
      new Notice("Wait for the current Codex turn to finish before sending the next one.");
      return;
    }

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
      this.setButtonLabel(
        refs.studyButton,
        this.plugin.isGeneratingLearningArtifact && this.plugin.activeLearningArtifactTurnId === refs.turnId
          ? "Studying..."
          : "Study",
      );
      this.setButtonState(
        refs.studyButton,
        hasReply && !this.plugin.isBusy && !this.plugin.isGeneratingLearningArtifact && this.plugin.canCreateLearningArtifactForTurn(refs.turnId),
      );
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

function splitMarkdownIntoSourceBlocks(content: string): string[] {
  const normalized = content.replace(/\r\n/g, "\n");
  const blocks: string[] = [];
  const lines = normalized.split("\n");
  let index = 0;

  while (index < lines.length) {
    if (!lines[index]?.trim()) {
      index += 1;
      continue;
    }

    const fenceMatch = lines[index]?.match(/^(```+|~~~+|\$\$)\s*$/);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      const start = index;
      index += 1;
      while (index < lines.length && lines[index]?.trim() !== fence) {
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      blocks.push(lines.slice(start, index).join("\n"));
      continue;
    }

    const start = index;
    while (index < lines.length && lines[index]?.trim()) {
      const nestedFenceMatch = lines[index]?.match(/^(```+|~~~+|\$\$)\s*$/);
      if (index > start && nestedFenceMatch) {
        break;
      }
      index += 1;
    }

    blocks.push(lines.slice(start, index).join("\n"));
  }

  return blocks.filter((block) => block.trim().length > 0);
}

function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((segment) => segment[0]?.toUpperCase() + segment.slice(1))
    .join(" ");
}
