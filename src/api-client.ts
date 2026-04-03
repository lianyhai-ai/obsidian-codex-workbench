import { Notice, requestUrl } from "obsidian";
import type { CompletionRequest, CompletionResult, CodexWorkbenchSettings } from "./types";

export async function requestCompletion(
  settings: CodexWorkbenchSettings,
  payload: CompletionRequest,
): Promise<CompletionResult> {
  if (settings.providerMode === "mock") {
    return {
      mode: "mock",
      answer: buildMockAnswer(payload),
    };
  }

  if (!settings.endpointUrl) {
    throw new Error("Endpoint URL is required for non-mock providers.");
  }

  if (settings.providerMode === "openai-compatible") {
    const response = await requestUrl({
      url: settings.endpointUrl,
      method: "POST",
      headers: buildHeaders(settings),
      body: JSON.stringify({
        model: settings.model,
        messages: buildOpenAiCompatibleMessages(settings.systemPrompt, payload),
      }),
    });

    const answer = extractAnswer(response.json);
    if (!answer) {
      throw new Error("The endpoint responded successfully, but no answer text could be found.");
    }

    return {
      mode: "openai-compatible",
      answer,
      raw: response.json,
    };
  }

  const response = await requestUrl({
    url: settings.endpointUrl,
    method: "POST",
    headers: buildHeaders(settings),
    body: JSON.stringify({
      model: settings.model,
      systemPrompt: settings.systemPrompt,
      question: payload.question,
      context: payload.context ?? null,
      history: payload.history,
    }),
  });

  const answer = extractAnswer(response.json);
  if (!answer) {
    throw new Error("The Generic JSON endpoint must respond with an answer-like field.");
  }

  return {
    mode: "generic-json",
    answer,
    raw: response.json,
  };
}

function buildHeaders(settings: CodexWorkbenchSettings): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (settings.apiKey) {
    headers.Authorization = `Bearer ${settings.apiKey}`;
  }

  return headers;
}

function buildOpenAiCompatibleMessages(systemPrompt: string, payload: CompletionRequest) {
  const contextBlock = payload.context
    ? [
        `Note: ${payload.context.noteTitle} (${payload.context.notePath})`,
        `Selected text:`,
        payload.context.selection,
        "",
        `Nearby context:`,
        payload.context.surroundingText || "(none)",
      ].join("\n")
    : "No explicit editor selection was attached.";

  const historyMessages = payload.history.slice(-8).flatMap((turn) => {
    return {
      role: turn.role,
      content: turn.content,
    };
  });

  return [
    {
      role: "system",
      content: systemPrompt,
    },
    ...historyMessages,
    {
      role: "user",
      content: `Question:\n${payload.question}\n\nContext:\n${contextBlock}`,
    },
  ];
}

function extractAnswer(json: unknown): string | null {
  if (typeof json === "string") {
    return json;
  }

  if (!json || typeof json !== "object") {
    return null;
  }

  const data = json as Record<string, unknown>;

  if (typeof data.answer === "string" && data.answer.trim()) {
    return data.answer.trim();
  }

  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const choices = data.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const firstChoice = choices[0] as Record<string, unknown>;
    const message = firstChoice.message as Record<string, unknown> | undefined;
    if (message && typeof message.content === "string" && message.content.trim()) {
      return message.content.trim();
    }
  }

  const output = data.output;
  if (Array.isArray(output)) {
    const textParts = output.flatMap((item) => {
      if (!item || typeof item !== "object") {
        return [];
      }

      const content = (item as Record<string, unknown>).content;
      if (!Array.isArray(content)) {
        return [];
      }

      return content.flatMap((part) => {
        if (!part || typeof part !== "object") {
          return [];
        }

        const text = (part as Record<string, unknown>).text;
        return typeof text === "string" ? [text] : [];
      });
    });

    if (textParts.length > 0) {
      return textParts.join("\n").trim();
    }
  }

  return null;
}

function buildMockAnswer(payload: CompletionRequest): string {
  const intro = payload.context
    ? `我已经围绕你在《${payload.context.noteTitle}》里选中的这段内容做了一次聚焦分析。`
    : "我先按你当前的问题给出一版编辑型回答。";

  const selectedText = payload.context?.selectionPreview
    ? `选区摘要：${payload.context.selectionPreview}`
    : "当前没有附带选区。";

  return [
    intro,
    selectedText,
    `你的问题：${payload.question}`,
    "这条回复来自 Mock 模式，所以现在还没有请求真实模型接口。",
    "如果你要把它接成可用版本，下一步最直接的是把设置里的 Provider mode 切到 OpenAI-compatible，并填上你的网关地址。",
    "就交互层面来说，这个 MVP 已经具备了右侧会话、选区提问和回写动作，足够继续往流式输出、标题级上下文和模板命令扩展。",
  ].join("\n\n");
}

export function showRequestFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : "Unknown request error";
  new Notice(`Codex Workbench request failed: ${message}`);
}
