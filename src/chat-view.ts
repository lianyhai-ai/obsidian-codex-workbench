import { ItemView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type CodexWorkbenchPlugin from "./main";
import type { ChatTurn } from "./types";

export const VIEW_TYPE_CODEX_WORKBENCH = "codex-workbench-view";

export class CodexWorkbenchView extends ItemView {
  plugin: CodexWorkbenchPlugin;
  private messageListEl: HTMLElement | null = null;
  private composerEl: HTMLTextAreaElement | null = null;
  private contextCardEl: HTMLElement | null = null;
  private emptyStateEl: HTMLElement | null = null;
  private sendButtonEl: HTMLButtonElement | null = null;

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
    this.contentEl.empty();
  }

  refresh(): void {
    this.renderMessages();
    this.renderContextCard();
    this.renderHeaderState();
  }

  setComposerValue(value: string): void {
    if (this.composerEl) {
      this.composerEl.value = value;
      this.composerEl.focus();
    }
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("codex-workbench-view");

    const shell = contentEl.createDiv({ cls: "codex-workbench-shell" });

    const header = shell.createDiv({ cls: "codex-workbench-header" });
    header.createDiv({ cls: "codex-workbench-brand-bar" });

    const headingRow = header.createDiv({ cls: "codex-workbench-heading-row" });
    const titleGroup = headingRow.createDiv({ cls: "codex-workbench-title-group" });
    titleGroup.createEl("div", {
      text: "Codex Workbench",
      cls: "codex-workbench-title",
    });
    titleGroup.createEl("div", {
      text: "Selection-first editing copilot",
      cls: "codex-workbench-subtitle",
    });

    const statusPills = headingRow.createDiv({ cls: "codex-workbench-status-pills" });
    statusPills.createEl("span", {
      text: this.plugin.settings.providerMode,
      cls: "codex-workbench-pill codex-workbench-pill--provider",
    });
    statusPills.createEl("span", {
      text: this.plugin.settings.codexSandboxMode,
      cls: "codex-workbench-pill codex-workbench-pill--sandbox",
    });
    statusPills.createEl("span", {
      text: this.plugin.settings.codexApprovalMode,
      cls: "codex-workbench-pill codex-workbench-pill--approval",
    });
    statusPills.createEl("span", {
      text: "MVP",
      cls: "codex-workbench-pill codex-workbench-pill--stage",
    });

    const actionRow = header.createDiv({ cls: "codex-workbench-action-row" });

    this.createActionButton(actionRow, "Ask selection", "highlighter", async () => {
      await this.plugin.askSelectionFromActiveEditor();
    });

    this.createActionButton(actionRow, "New session", "rotate-ccw", () => {
      void this.plugin.resetConversationSession();
    });

    this.createActionButton(actionRow, "Insert last", "corner-down-left", () => {
      void this.plugin.insertLastReply();
    });

    this.createActionButton(actionRow, "Replace selection", "replace", () => {
      void this.plugin.replaceSelectionWithLastReply();
    });

    this.createActionButton(actionRow, "Copy last", "copy", () => {
      void this.plugin.copyLastReply();
    });

    this.contextCardEl = shell.createDiv({ cls: "codex-workbench-context-card" });

    this.messageListEl = shell.createDiv({ cls: "codex-workbench-message-list" });
    this.emptyStateEl = this.messageListEl.createDiv({ cls: "codex-workbench-empty-state" });
    this.emptyStateEl.createEl("div", {
      text: "Select a sentence, ask a question, then push the answer back into the note.",
      cls: "codex-workbench-empty-title",
    });
    this.emptyStateEl.createEl("div", {
      text: "You can start from the sidebar, a floating Ask Codex button, or the editor context menu.",
      cls: "codex-workbench-empty-copy",
    });

    const composerWrap = shell.createDiv({ cls: "codex-workbench-composer-wrap" });
    this.composerEl = composerWrap.createEl("textarea", {
      cls: "codex-workbench-composer",
      attr: {
        rows: "4",
        placeholder: "Ask about the current selection, rewrite a paragraph, or outline the next section...",
      },
    });

    this.composerEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void this.submitComposer();
      }
    });

    const composerFooter = composerWrap.createDiv({ cls: "codex-workbench-composer-footer" });
    composerFooter.createEl("span", {
      text: "Enter to send, Shift+Enter for newline",
      cls: "codex-workbench-composer-hint",
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
    const providerPill = this.contentEl.querySelector(".codex-workbench-pill--provider");
    if (providerPill instanceof HTMLElement) {
      providerPill.setText(this.plugin.settings.providerMode);
    }
    const sandboxPill = this.contentEl.querySelector(".codex-workbench-pill--sandbox");
    if (sandboxPill instanceof HTMLElement) {
      sandboxPill.setText(this.plugin.settings.codexSandboxMode);
    }
    const approvalPill = this.contentEl.querySelector(".codex-workbench-pill--approval");
    if (approvalPill instanceof HTMLElement) {
      approvalPill.setText(this.plugin.settings.codexApprovalMode);
    }

    if (this.sendButtonEl) {
      this.sendButtonEl.disabled = this.plugin.isBusy;
      this.sendButtonEl.setText(this.plugin.isBusy ? "Working..." : "Send");
    }

    if (this.composerEl) {
      this.composerEl.disabled = this.plugin.isBusy;
    }
  }

  private renderContextCard(): void {
    if (!this.contextCardEl) {
      return;
    }

    this.contextCardEl.empty();
    const context = this.plugin.pendingContext;

    if (!context) {
      this.contextCardEl.addClass("is-empty");
      this.contextCardEl.createEl("div", {
        text: "No pinned selection context",
        cls: "codex-workbench-context-title",
      });
      this.contextCardEl.createEl("div", {
        text: "Select text in the editor to attach focused context to the next question.",
        cls: "codex-workbench-context-copy",
      });
      return;
    }

    this.contextCardEl.removeClass("is-empty");

    const metaRow = this.contextCardEl.createDiv({ cls: "codex-workbench-context-meta" });
    metaRow.createEl("span", {
      text: context.noteTitle,
      cls: "codex-workbench-context-title",
    });
    const clearButton = metaRow.createEl("button", {
      text: "Clear",
      cls: "clickable-icon codex-workbench-inline-button",
    });
    clearButton.addEventListener("click", () => {
      this.plugin.clearPendingContext();
    });

    this.contextCardEl.createEl("div", {
      text: context.notePath,
      cls: "codex-workbench-context-path",
    });
    this.contextCardEl.createEl("div", {
      text: context.selectionPreview,
      cls: "codex-workbench-context-selection",
    });
  }

  private renderMessages(): void {
    if (!this.messageListEl || !this.emptyStateEl) {
      return;
    }

    const history = this.plugin.history;
    this.messageListEl.empty();

    if (history.length === 0) {
      this.emptyStateEl = this.messageListEl.createDiv({ cls: "codex-workbench-empty-state" });
      this.emptyStateEl.createEl("div", {
        text: "Select a sentence, ask a question, then push the answer back into the note.",
        cls: "codex-workbench-empty-title",
      });
      this.emptyStateEl.createEl("div", {
        text: "You can start from the sidebar, a floating Ask Codex button, or the editor context menu.",
        cls: "codex-workbench-empty-copy",
      });
      return;
    }

    history.forEach((turn) => {
      this.messageListEl?.appendChild(this.buildMessage(turn));
    });

    if (this.plugin.isBusy && !history.some((turn) => turn.streaming)) {
      const loading = this.messageListEl.createDiv({
        cls: "codex-workbench-bubble codex-workbench-bubble--assistant codex-workbench-bubble--loading",
      });
      loading.setText("Thinking...");
    }

    this.messageListEl.scrollTop = this.messageListEl.scrollHeight;
  }

  private buildMessage(turn: ChatTurn): HTMLElement {
    const wrapper = createDiv({ cls: `codex-workbench-turn codex-workbench-turn--${turn.role}` });
    const bubble = wrapper.createDiv({
      cls: `codex-workbench-bubble codex-workbench-bubble--${turn.role}`,
    });

    const meta = bubble.createDiv({ cls: "codex-workbench-bubble-meta" });
    meta.createEl("span", {
      text: turn.role === "assistant" ? "Codex" : "You",
      cls: "codex-workbench-bubble-role",
    });
    meta.createEl("span", {
      text: new Date(turn.createdAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
      cls: "codex-workbench-bubble-time",
    });

    bubble.createEl("div", {
      text: turn.content || (turn.streaming ? "Thinking..." : ""),
      cls: "codex-workbench-bubble-content",
    });

    if (turn.context?.selectionPreview) {
      bubble.createEl("div", {
        text: `Context: ${turn.context.selectionPreview}`,
        cls: "codex-workbench-bubble-context",
      });
    }

    return wrapper;
  }

  private createActionButton(parent: HTMLElement, label: string, icon: string, action: () => void | Promise<void>): void {
    const button = parent.createEl("button", {
      cls: "clickable-icon codex-workbench-toolbar-button",
      attr: {
        "aria-label": label,
      },
    });

    button.createSpan({ text: label, cls: "codex-workbench-toolbar-button-text" });
    button.addEventListener("click", () => {
      void action();
    });

    const iconContainer = button.createSpan({ cls: "codex-workbench-toolbar-button-icon" });
    setIcon(iconContainer, icon);
  }

  private async submitComposer(): Promise<void> {
    if (!this.composerEl) {
      return;
    }

    const question = this.composerEl.value.trim();
    if (!question) {
      new Notice("Type a question before sending.");
      return;
    }

    this.composerEl.value = "";
    await this.plugin.submitQuestion(question);
  }
}
