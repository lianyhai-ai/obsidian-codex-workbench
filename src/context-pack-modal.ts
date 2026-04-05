import { Modal, Notice, Setting, type App } from "obsidian";
import type { ContextPack, ContextScope } from "./types";

export interface ContextPackModalOptions {
  initialPack: ContextPack;
  availableRepos: string[];
  availableTags: string[];
  isEditing: boolean;
}

export async function openContextPackModal(app: App, options: ContextPackModalOptions): Promise<ContextPack | null> {
  return await new Promise<ContextPack | null>((resolve) => {
    const modal = new ContextPackModal(app, options, resolve);
    modal.open();
  });
}

class ContextPackModal extends Modal {
  private readonly options: ContextPackModalOptions;
  private readonly resolve: (pack: ContextPack | null) => void;
  private settled = false;
  private draft: ContextPack;

  constructor(app: App, options: ContextPackModalOptions, resolve: (pack: ContextPack | null) => void) {
    super(app);
    this.options = options;
    this.resolve = resolve;
    this.draft = {
      ...options.initialPack,
      extraNotePaths: [...options.initialPack.extraNotePaths],
      extraRepoFiles: [...options.initialPack.extraRepoFiles],
    };
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("codex-workbench-context-pack-modal");

    contentEl.createEl("h2", {
      text: this.options.isEditing ? "Edit context pack" : "New context pack",
    });

    contentEl.createEl("p", {
      text: "Set the scope and explicit sources this pack should carry into future turns.",
      cls: "codex-workbench-settings-copy",
    });

    new Setting(contentEl)
      .setName("Pack name")
      .setDesc("Shown in the workbench pack selector.")
      .addText((text) =>
        text
          .setPlaceholder("Architecture review pack")
          .setValue(this.draft.name)
          .onChange((value) => {
            this.draft.name = value.trim();
          }),
      );

    new Setting(contentEl)
      .setName("Scope")
      .setDesc("The default context scope to activate when this pack is applied.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("note", "Note")
          .addOption("folder", "Folder")
          .addOption("tag", "Tag")
          .addOption("repo", "Repo")
          .setValue(this.draft.scope)
          .onChange((value) => {
            this.draft.scope = value as ContextScope;
          }),
      );

    new Setting(contentEl)
      .setName("Include current note")
      .setDesc("Also attach the current note when the pack is active.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.draft.includeCurrentNote)
          .onChange((value) => {
            this.draft.includeCurrentNote = value;
          }),
      );

    new Setting(contentEl)
      .setName("Folder path")
      .setDesc("Optional vault-relative folder path. Used when scope is folder.")
      .addText((text) =>
        text
          .setPlaceholder("Projects/architecture")
          .setValue(this.draft.folderPath ?? "")
          .onChange((value) => {
            this.draft.folderPath = value.trim() || null;
          }),
      );

    new Setting(contentEl)
      .setName("Tag")
      .setDesc(this.options.availableTags.length > 0
        ? `Optional tag scope. Known tags: ${this.options.availableTags.slice(0, 8).join(", ")}`
        : "Optional tag scope.")
      .addText((text) =>
        text
          .setPlaceholder("#architecture")
          .setValue(this.draft.tag ?? "")
          .onChange((value) => {
            const nextTag = value.trim();
            this.draft.tag = nextTag ? (nextTag.startsWith("#") ? nextTag : `#${nextTag}`) : null;
          }),
      );

    new Setting(contentEl)
      .setName("Repo path")
      .setDesc(this.options.availableRepos.length > 0
        ? `Optional repo root. Known roots: ${this.options.availableRepos.join(" | ")}`
        : "Optional repo root.")
      .addText((text) =>
        text
          .setPlaceholder("/Users/you/project")
          .setValue(this.draft.repoPath ?? "")
          .onChange((value) => {
            this.draft.repoPath = value.trim() || null;
          }),
      );

    new Setting(contentEl)
      .setName("Extra note paths")
      .setDesc("One vault-relative note path per line. These notes are always included when the pack is active.")
      .addTextArea((text) =>
        text
          .setPlaceholder("Projects/Architecture/README.md\nNotes/System Design.md")
          .setValue(this.draft.extraNotePaths.join("\n"))
          .onChange((value) => {
            this.draft.extraNotePaths = splitTextareaLines(value);
          }),
      );

    new Setting(contentEl)
      .setName("Extra repo files")
      .setDesc("One repo file per line. Use relative paths from the repo root or absolute paths.")
      .addTextArea((text) =>
        text
          .setPlaceholder("README.md\ndocs/overview.md\nsrc/architecture.ts")
          .setValue(this.draft.extraRepoFiles.join("\n"))
          .onChange((value) => {
            this.draft.extraRepoFiles = splitTextareaLines(value);
          }),
      );

    const buttonWrap = contentEl.createDiv({ cls: "codex-workbench-approval-actions" });

    const saveButton = buttonWrap.createEl("button", {
      text: this.options.isEditing ? "Save changes" : "Create pack",
      cls: "mod-cta",
    });
    saveButton.addEventListener("click", () => {
      const nextName = this.draft.name.trim();
      if (!nextName) {
        new Notice("Name the context pack before saving.");
        return;
      }

      this.finish({
        ...this.draft,
        name: nextName,
        folderPath: this.draft.folderPath?.trim() || null,
        repoPath: this.draft.repoPath?.trim() || null,
        tag: this.draft.tag?.trim() || null,
        extraNotePaths: splitTextareaLines(this.draft.extraNotePaths.join("\n")),
        extraRepoFiles: splitTextareaLines(this.draft.extraRepoFiles.join("\n")),
      });
    });

    const cancelButton = buttonWrap.createEl("button", {
      text: "Cancel",
    });
    cancelButton.addEventListener("click", () => {
      this.finish(null);
    });
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) {
      this.resolve(null);
    }
  }

  private finish(pack: ContextPack | null): void {
    if (this.settled) {
      return;
    }

    this.settled = true;
    this.resolve(pack);
    this.close();
  }
}

function splitTextareaLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
