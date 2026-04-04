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
    this.queueUpdate();
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

    const context = this.plugin.captureContextFromEditor(view.editor, view);
    if (!context) {
      this.hide();
      return;
    }

    this.plugin.setPendingContext(context);
    const rect = this.resolveSelectionRect(view);
    if (!rect) {
      this.hide();
      return;
    }

    const left = Math.min(window.scrollX + rect.right + 10, window.scrollX + window.innerWidth - this.buttonEl.offsetWidth - 14);
    const top = Math.max(window.scrollY + rect.top - 10, window.scrollY + 10);
    this.buttonEl.style.left = `${left}px`;
    this.buttonEl.style.top = `${top}px`;
    this.buttonEl.show();
    this.buttonEl.addClass("is-visible");
  }

  notifyUnavailableSelection(): void {
    new Notice("Select text in the editor first.");
  }

  private resolveSelectionRect(view: MarkdownView): DOMRect | null {
    const domSelection = window.getSelection();
    if (domSelection && domSelection.rangeCount > 0) {
      for (let index = domSelection.rangeCount - 1; index >= 0; index -= 1) {
        const range = domSelection.getRangeAt(index);
        const ancestor = range.commonAncestorContainer;
        const selectionRoot = ancestor instanceof HTMLElement ? ancestor : ancestor.parentElement;
        if (!selectionRoot || !view.containerEl.contains(selectionRoot)) {
          continue;
        }

        const rect = range.getBoundingClientRect();
        if (rect.width > 0 || rect.height > 0) {
          return rect;
        }
      }
    }

    const selectionHighlights = Array.from(
      view.containerEl.querySelectorAll<HTMLElement>(".cm-selectionBackground"),
    );
    for (let index = selectionHighlights.length - 1; index >= 0; index -= 1) {
      const rect = selectionHighlights[index]?.getBoundingClientRect();
      if (rect && (rect.width > 0 || rect.height > 0)) {
        return rect;
      }
    }

    return null;
  }
}
