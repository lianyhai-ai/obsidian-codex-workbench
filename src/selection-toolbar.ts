import { MarkdownView, Notice } from "obsidian";
import type CodexWorkbenchPlugin from "./main";

export class SelectionToolbarController {
  private plugin: CodexWorkbenchPlugin;
  private buttonEl: HTMLButtonElement;
  private debounceHandle: number | null = null;

  constructor(plugin: CodexWorkbenchPlugin) {
    this.plugin = plugin;
    this.buttonEl = document.body.createEl("button", {
      cls: "codex-workbench-selection-button",
      text: "Ask Codex",
    });
    this.buttonEl.hide();
    this.buttonEl.addEventListener("click", () => {
      void this.plugin.askSelectionFromActiveEditor();
    });
  }

  enable(): void {
    this.hide();
  }

  disable(): void {
    this.hide();
  }

  destroy(): void {
    this.buttonEl.remove();
  }

  hide(): void {
    this.buttonEl.hide();
    this.buttonEl.removeClass("is-visible");
  }

  queueUpdate(): void {
    if (this.debounceHandle !== null) {
      window.clearTimeout(this.debounceHandle);
    }

    this.debounceHandle = window.setTimeout(() => {
      this.update();
    }, 120);
  }

  update(): void {
    if (!this.plugin.settings.showSelectionButton) {
      this.hide();
      return;
    }

    const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      this.hide();
      return;
    }

    const selectionText = view.editor.getSelection().trim();
    if (!selectionText) {
      this.hide();
      return;
    }

    const domSelection = window.getSelection();
    if (!domSelection || domSelection.rangeCount === 0) {
      this.hide();
      return;
    }

    const range = domSelection.getRangeAt(0);
    const ancestor = range.commonAncestorContainer;
    const selectionRoot = ancestor instanceof HTMLElement ? ancestor : ancestor.parentElement;
    if (!selectionRoot || !view.containerEl.contains(selectionRoot)) {
      this.hide();
      return;
    }

    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      this.hide();
      return;
    }

    const context = this.plugin.captureContextFromEditor(view.editor, view);
    if (!context) {
      this.hide();
      return;
    }

    this.plugin.setPendingContext(context);
    this.buttonEl.style.left = `${window.scrollX + rect.right + 8}px`;
    this.buttonEl.style.top = `${window.scrollY + rect.top - 8}px`;
    this.buttonEl.show();
    this.buttonEl.addClass("is-visible");
  }

  notifyUnavailableSelection(): void {
    new Notice("Select text in the editor first.");
  }
}
