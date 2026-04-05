import { Modal, Notice, type App } from "obsidian";

export type ApprovalKind = "command" | "file-change" | "permissions";

export type ApprovalRequest =
  | {
      kind: "command";
      reason: string;
      command: string;
      cwd: string;
      canApproveForSession: boolean;
    }
  | {
      kind: "file-change";
      reason: string;
      summary: string;
      canApproveForSession: boolean;
    }
  | {
      kind: "permissions";
      reason: string;
      summary: string;
      permissions: {
        network?: unknown;
        fileSystem?: unknown;
      };
    };

export type ApprovalResult =
  | {
      kind: "command";
      decision: "accept" | "acceptForSession" | "decline" | "cancel";
    }
  | {
      kind: "file-change";
      decision: "accept" | "acceptForSession" | "decline" | "cancel";
    }
  | {
      kind: "permissions";
      decision: "grant-once" | "grant-session" | "decline";
    };

export async function promptForApproval(app: App, request: ApprovalRequest): Promise<ApprovalResult> {
  return await new Promise<ApprovalResult>((resolve) => {
    const modal = new ApprovalModal(app, request, resolve);
    modal.open();
  });
}

class ApprovalModal extends Modal {
  private readonly request: ApprovalRequest;
  private readonly resolve: (result: ApprovalResult) => void;
  private settled = false;

  constructor(app: App, request: ApprovalRequest, resolve: (result: ApprovalResult) => void) {
    super(app);
    this.request = request;
    this.resolve = resolve;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("codex-workbench-approval-modal");

    contentEl.createEl("h2", {
      text: getTitle(this.request.kind),
    });

    contentEl.createEl("p", {
      text: this.request.reason,
      cls: "codex-workbench-approval-copy",
    });

    if (this.request.kind === "command") {
      contentEl.createEl("div", {
        text: `Working directory: ${this.request.cwd}`,
        cls: "codex-workbench-approval-meta",
      });
      contentEl.createEl("pre", {
        text: this.request.command,
        cls: "codex-workbench-approval-code",
      });
    } else {
      contentEl.createEl("pre", {
        text: this.request.summary,
        cls: "codex-workbench-approval-code",
      });
    }

    const buttonWrap = contentEl.createDiv({ cls: "codex-workbench-approval-actions" });

    if (this.request.kind === "permissions") {
      this.createButton(buttonWrap, "Grant once", () => {
        this.finish({ kind: "permissions", decision: "grant-once" });
      }, true);

      this.createButton(buttonWrap, "Grant for session", () => {
        this.finish({ kind: "permissions", decision: "grant-session" });
      });

      this.createButton(buttonWrap, "Decline", () => {
        this.finish({ kind: "permissions", decision: "decline" });
      });

      return;
    }

    const kind = this.request.kind;

    this.createButton(buttonWrap, "Allow once", () => {
      this.finish({ kind, decision: "accept" });
    }, true);

    if (this.request.canApproveForSession) {
      this.createButton(buttonWrap, "Allow for session", () => {
        this.finish({ kind, decision: "acceptForSession" });
      });
    }

    this.createButton(buttonWrap, "Deny", () => {
      this.finish({ kind, decision: "decline" });
    });

    this.createButton(buttonWrap, "Cancel turn", () => {
      this.finish({ kind, decision: "cancel" });
    });
  }

  onClose(): void {
    this.contentEl.empty();
    if (this.settled) {
      return;
    }

    new Notice("Approval dismissed. Codex will treat it as denied.");
    if (this.request.kind === "permissions") {
      this.finish({ kind: "permissions", decision: "decline" });
      return;
    }

    this.finish({ kind: this.request.kind, decision: "decline" });
  }

  private finish(result: ApprovalResult): void {
    if (this.settled) {
      return;
    }

    this.settled = true;
    this.resolve(result);
    this.close();
  }

  private createButton(parent: HTMLElement, label: string, action: () => void, cta = false): void {
    const button = parent.createEl("button", {
      text: label,
      cls: cta ? "mod-cta" : "",
    });
    button.addEventListener("click", action);
  }
}

function getTitle(kind: ApprovalKind): string {
  switch (kind) {
    case "command":
      return "Allow Codex to run this command?";
    case "file-change":
      return "Allow Codex to apply this file change?";
    case "permissions":
      return "Grant additional permissions to Codex?";
  }
}
