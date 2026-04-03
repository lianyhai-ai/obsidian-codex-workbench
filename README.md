# Codex Workbench

`Codex Workbench` 是一个 Obsidian 插件 MVP，目标是把“右侧 AI 工作台 + 选中文本提问”做成一套顺手的编辑流。

当前版本包含：

- 右侧聊天面板
- 面向选中文本的 `Ask Codex` 操作
- 右键菜单入口
- 插入到光标 / 替换选区 / 复制最近回答
- 基于本地 `codex app-server` 的会话型后端
- 持久化当前 Codex thread，并在下次打开 Obsidian 时恢复
- `workspace-write` / `read-only` 沙箱切换
- 本地审批弹窗，用于在需要时允许命令、改动或额外权限
- 可配置的 HTTP 接口和 `Mock` 模式作为后备

## 设计方向

这版刻意做成“编辑工作台”而不是通用聊天产品：

- 面板强调上下文和回写动作
- 当你划线时，会优先围绕选区提问
- 面板保留最近上下文卡片，减少“当前到底在问哪段”的迷失感
- 当你重开 Obsidian 时，会优先把上一次本地 Codex session 接回来

更完整的设计说明见 [docs/mvp-design.md](docs/mvp-design.md)。

## 本地开发

1. 进入目录：

```bash
cd /Users/bytedance/Documents/Playground/obsidian-codex-workbench
```

2. 安装依赖：

```bash
npm install
```

3. 构建：

```bash
npm run build
```

4. 确认本机 `codex` CLI 可用并已登录：

```bash
codex --version
```

5. 将这个目录拷贝到你的 vault：

```text
<你的 Vault>/.obsidian/plugins/codex-workbench
```

6. 在 Obsidian 中启用插件。

## 设置项

- `Provider mode`
  - `Local Codex app-server`: 默认模式。插件会本地拉起 `codex app-server`，并把右侧聊天保持为一个真正的 Codex thread/session
  - `Mock`: 不请求远端，直接返回演示型回答
  - `OpenAI-compatible`: 兼容常见 `chat/completions` 结构
  - `Generic JSON`: 发送通用 JSON，并从 `answer` 字段取值
- `Codex CLI path`: 本地 `codex` 可执行文件路径，默认 `/usr/local/bin/codex`
- `Sandbox mode`: `Workspace write` 或 `Read only`
- `Approval policy`: `On request` / `Untrusted only` / `Never ask`
- `Endpoint URL`: 你的网关或代理接口
- `API key`: 可选
- `Model`: 模型名
- `Base instructions`: 本地 Codex thread 的基础指令，也用于 HTTP 模式的 system prompt

## Local Codex 模式

这版 MVP 优先接本地 `codex app-server`，特点是：

- 右侧会话不是插件自己伪造历史，而是绑定到一个真实 Codex thread
- 每次提问都会继续在同一个本地 session 上做 `turn/start`
- 返回内容按流式 delta 逐步显示
- 当前 thread id 会持久化，插件下次启动时会自动做 `thread/resume`
- 可切换到 `workspace-write`，把只读对话升级成本地开发工作台
- 当 Codex 需要额外批准时，会弹出本地确认框

当前边界：

- 是否把命令执行、文件改动和工具调用也可视化到侧栏里，这版还没展开做
- 如果你中途修改了 sandbox 模式，最稳妥的做法仍然是点一次 `New session`

## 接口约定

### OpenAI-compatible

请求体会类似：

```json
{
  "model": "your-model",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." }
  ]
}
```

插件会优先尝试解析以下响应：

- `choices[0].message.content`
- `output_text`
- `answer`

### Generic JSON

请求体：

```json
{
  "model": "your-model",
  "systemPrompt": "...",
  "question": "...",
  "context": {},
  "history": []
}
```

响应体：

```json
{
  "answer": "..."
}
```

## 下一步建议

- 把命令输出和文件改动也渲染进侧栏，做成更完整的 agent timeline
- 给审批弹窗补充“记住此规则”这类更细的长期授权能力
- 为回答增加引用块和来源标注
- 把上下文范围扩展到当前标题或整篇笔记
- 增加“继续写”“缩写”“提炼行动项”等快捷模式
