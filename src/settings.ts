import { App, PluginSettingTab, Setting } from "obsidian";
import type CodexWorkbenchPlugin from "./main";
import type { CodexWorkbenchSettings } from "./types";

export const DEFAULT_SETTINGS: CodexWorkbenchSettings = {
  providerMode: "local-codex",
  codexCliPath: "/usr/local/bin/codex",
  codexSandboxMode: "workspace-write",
  codexApprovalMode: "on-request",
  projectContextPaths: "",
  endpointUrl: "",
  apiKey: "",
  model: "gpt-5.4",
  systemPrompt:
    "You are Codex running inside an Obsidian side panel. Use the selected note content as your primary context, answer concisely, and do not execute commands or modify files unless the user explicitly asks.",
  autoOpenView: true,
  showSelectionButton: true,
};

export class CodexWorkbenchSettingTab extends PluginSettingTab {
  plugin: CodexWorkbenchPlugin;

  constructor(app: App, plugin: CodexWorkbenchPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Codex Workbench" });
    containerEl.createEl("p", {
      text: "Configure how the plugin talks to your model endpoint and how aggressively it surfaces selection shortcuts.",
      cls: "codex-workbench-settings-copy",
    });

    new Setting(containerEl)
      .setName("Provider mode")
      .setDesc("Choose the local Codex app-server backend, a mock response, an OpenAI-compatible endpoint, or a generic JSON endpoint.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("local-codex", "Local Codex app-server")
          .addOption("mock", "Mock")
          .addOption("openai-compatible", "OpenAI-compatible")
          .addOption("generic-json", "Generic JSON")
          .setValue(this.plugin.settings.providerMode)
          .onChange(async (value) => {
            this.plugin.settings.providerMode = value as CodexWorkbenchSettings["providerMode"];
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Codex CLI path")
      .setDesc("Used when Provider mode is Local Codex app-server.")
      .addText((text) =>
        text
          .setPlaceholder("/usr/local/bin/codex")
          .setValue(this.plugin.settings.codexCliPath)
          .onChange(async (value) => {
            this.plugin.settings.codexCliPath = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Sandbox mode")
      .setDesc("Controls whether local Codex stays read-only or can work directly in your vault workspace.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("workspace-write", "Workspace write")
          .addOption("read-only", "Read only")
          .setValue(this.plugin.settings.codexSandboxMode)
          .onChange(async (value) => {
            this.plugin.settings.codexSandboxMode = value as CodexWorkbenchSettings["codexSandboxMode"];
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Approval policy")
      .setDesc("Controls when local Codex should stop and ask you before taking riskier actions.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("on-request", "On request")
          .addOption("untrusted", "Untrusted only")
          .addOption("never", "Never ask")
          .setValue(this.plugin.settings.codexApprovalMode)
          .onChange(async (value) => {
            this.plugin.settings.codexApprovalMode = value as CodexWorkbenchSettings["codexApprovalMode"];
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Project context directories")
      .setDesc("One directory per line. These paths are injected into each Codex turn as the baseline engineering context.")
      .addTextArea((text) =>
        text
          .setPlaceholder("/Users/you/project-a\n/Users/you/project-b")
          .setValue(this.plugin.settings.projectContextPaths)
          .onChange(async (value) => {
            this.plugin.settings.projectContextPaths = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Endpoint URL")
      .setDesc("Used for OpenAI-compatible and Generic JSON modes.")
      .addText((text) =>
        text
          .setPlaceholder("https://your-gateway.example.com/v1/chat/completions")
          .setValue(this.plugin.settings.endpointUrl)
          .onChange(async (value) => {
            this.plugin.settings.endpointUrl = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("API key")
      .setDesc("Optional bearer token for your endpoint.")
      .addText((text) => {
        text.inputEl.type = "password";
        return text.setPlaceholder("sk-...")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Model")
      .setDesc("Model name sent to the endpoint.")
      .addText((text) =>
        text
          .setPlaceholder("gpt-4.1-mini")
          .setValue(this.plugin.settings.model)
          .onChange(async (value) => {
            this.plugin.settings.model = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Base instructions")
      .setDesc("Used as the system prompt for HTTP providers and as the Codex thread instructions for the local app-server.")
      .addTextArea((text) =>
        text
          .setPlaceholder("You are Codex inside Obsidian...")
          .setValue(this.plugin.settings.systemPrompt)
          .onChange(async (value) => {
            this.plugin.settings.systemPrompt = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Auto-open right panel")
      .setDesc("Automatically open the workbench when the plugin loads.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoOpenView)
          .onChange(async (value) => {
            this.plugin.settings.autoOpenView = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Show selection button")
      .setDesc("Display a floating Ask Codex button when text is selected inside the editor.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showSelectionButton)
          .onChange(async (value) => {
            this.plugin.settings.showSelectionButton = value;
            await this.plugin.saveSettings();
            this.plugin.refreshSelectionButtonState();
          }),
      );
  }
}
