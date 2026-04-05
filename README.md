# Codex Workbench

A local-first Obsidian workbench for Codex sessions, note context, guided learning, and selection-based asking.

- English: [Overview](#english) | [Disclosures](#disclosures) | [Development](#development)
- 中文: [概览](#中文) | [披露说明](#披露说明) | [开发与发布](#开发与发布)

## English

### Overview

Codex Workbench turns the right sidebar into a focused workspace for:

- asking about selected text
- switching context by note, folder, tag, or repo
- saving reusable context packs
- showing citations for attached note, file, and selection context
- running persistent Local Codex sessions through `codex app-server`
- generating learning artifacts such as study notes, term cards, confusion lists, and Q/A cards

This plugin is currently desktop-only.

### Features

- Local Codex mode with a real resumable thread
- Selection-first asking with inline `Ask Codex`
- Context modes: note, folder, tag, repo
- Context packs for reusable working sets
- Clickable citations that open source notes or files
- Learning mode with study artifact generation
- File write approvals for local Codex sessions

### Installation

#### Community plugins

After the plugin is approved by Obsidian, install it from `Settings -> Community plugins -> Browse`.

#### GitHub releases

1. Download `manifest.json`, `main.js`, and `styles.css` from the latest GitHub release.
2. Create a folder named `codex-workbench` under your vault plugin directory:

```text
<vault>/.obsidian/plugins/codex-workbench
```

3. Place the three files in that folder.
4. Restart Obsidian and enable `Codex Workbench`.

### Requirements

- Obsidian desktop `>= 1.5.0`
- For `Local Codex` mode:
  - a working `codex` CLI installation
  - an authenticated local Codex session if required by your setup
- For `OpenAI-compatible` or `Generic JSON` modes:
  - a reachable HTTP endpoint

### Disclosures

Please read this section before using the plugin:

- Desktop only: the plugin uses desktop-only capabilities and is not intended for mobile.
- Local process: `Local Codex` mode starts a local `codex app-server` process on your machine.
- Network access:
  - `Local Codex` mode uses a local loopback WebSocket connection to the local Codex process.
  - `OpenAI-compatible` and `Generic JSON` modes send your request payload to the configured remote endpoint.
- Data access:
  - the plugin can read the active note, selected text, nearby note context, context-pack notes, and configured repo snippets used for prompting and citations.
- File writes:
  - `workspace-write` mode may request permission for file changes through local Codex approvals.
  - learning artifacts create or update Markdown files next to the current note.
- External files:
  - repo context can read files from user-configured local directories outside the vault.
- Telemetry:
  - the plugin does not include analytics, ads, or client-side telemetry.
- Closed services:
  - if you point the plugin at a remote API, that service may be proprietary and have its own privacy terms.

### Development

```bash
npm install
npm run build
```

Build output is written to:

```text
build/main.js
```

To prepare release assets locally:

```bash
npm run release:bundle
```

Release-ready files are written to:

```text
build/release/
```

### Release process

1. Update `manifest.json` version.
2. Run `npm run version`.
3. Run `npm run release:check`.
4. Create a Git tag matching the release version, for example `0.1.2`.
5. Push the tag to GitHub.
6. Upload or let GitHub Actions publish `manifest.json`, `main.js`, and `styles.css` from `build/release/`.
7. Submit the initial plugin entry to `obsidianmd/obsidian-releases`.

Additional release notes are in [docs/release-checklist.md](docs/release-checklist.md).

### Repository docs

- [CHANGELOG.md](CHANGELOG.md)
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [SECURITY.md](SECURITY.md)
- [docs/mvp-design.md](docs/mvp-design.md)
- [docs/release-checklist.md](docs/release-checklist.md)

## 中文

### 概览

`Codex Workbench` 是一个偏本地优先的 Obsidian 工作台插件，目标是把 `Codex 会话 + 笔记上下文 + 学习引导` 合到右侧边栏里。

它现在主要支持：

- 基于划线的 `Ask Codex`
- 按 `笔记 / 文件夹 / tag / repo` 切换上下文
- 复用型 `Context Packs`
- 引用来源展示与点击打开
- 基于 `codex app-server` 的本地持久会话
- `Learning mode` 下的学习产物回写

### 主要功能

- 本地 Codex thread 恢复与续接
- 围绕选中文本提问
- 多种上下文范围切换
- 可保存的上下文包
- 学习模式和学习收录
- 本地审批与 `workspace-write`

### 安装方式

#### Obsidian 社区插件

等插件通过官方审核后，可以直接在：

```text
设置 -> 第三方插件 -> 浏览
```

里安装。

#### GitHub Release 手动安装

1. 从最新 GitHub Release 下载 `manifest.json`、`main.js`、`styles.css`
2. 在 vault 中创建：

```text
<你的 Vault>/.obsidian/plugins/codex-workbench
```

3. 把这三个文件放进去
4. 重启 Obsidian 并启用插件

### 使用前说明

- 仅支持桌面端，不支持移动端
- `Local Codex` 模式会在本机启动 `codex app-server`
- `OpenAI-compatible` / `Generic JSON` 模式会把请求内容发送到你配置的远端接口
- 插件可能会读取：
  - 当前笔记
  - 选中文本
  - 周边段落上下文
  - context pack 中指定的笔记
  - 配置的 repo 目录中的片段文件
- `workspace-write` 模式下，本地 Codex 可能请求写文件审批
- 学习产物会在当前笔记同目录下创建或更新 Markdown 文件
- 插件本身不带遥测、埋点或广告

### 本地开发

```bash
npm install
npm run build
```

构建产物会输出到：

```text
build/main.js
```

如果要本地打发布包：

```bash
npm run release:bundle
```

发布资产会输出到：

```text
build/release/
```

### 开发与发布

推荐流程：

1. 修改代码并运行 `npm run build`
2. 更新 `manifest.json` 版本号
3. 执行 `npm run version`
4. 执行 `npm run release:check`
5. 打 Git tag，例如 `0.1.2`
6. 通过 GitHub Release 发布 `manifest.json`、`main.js`、`styles.css`
7. 首次版本再提交到 `obsidianmd/obsidian-releases`

更完整的检查清单见 [docs/release-checklist.md](docs/release-checklist.md)。

### 相关文档

- [CHANGELOG.md](CHANGELOG.md)
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [SECURITY.md](SECURITY.md)
- [docs/mvp-design.md](docs/mvp-design.md)
- [docs/release-checklist.md](docs/release-checklist.md)
