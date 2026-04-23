import { DEFAULT_MODEL, MODEL_ALIASES } from "./config.js";

export function textContentToString(content) {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      if (!part || typeof part !== "object") {
        return "";
      }

      if (typeof part.text === "string") {
        return part.text;
      }

      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function normalizeMessages(messages = []) {
  return messages
    .filter((message) => message && typeof message === "object")
    .map((message) => ({
      role: message.role ?? "user",
      content: textContentToString(message.content),
    }))
    .filter((message) => message.content);
}

export function messagesToResponsesInput(messages = []) {
  // ChatGPT Codex 的 Responses 输入对历史消息类型要求更严格：
  // user 用 input_text，assistant 历史内容必须用 output_text。
  return normalizeMessages(messages).map((message) => ({
    role: message.role === "system" ? "user" : message.role,
    content: [
      message.role === "assistant"
        ? { type: "output_text", text: message.content }
        : { type: "input_text", text: message.content },
    ],
  }));
}

export function usageFromResponse(response) {
  const usage = response?.usage ?? {};
  return {
    prompt_tokens: usage.input_tokens ?? 0,
    completion_tokens: usage.output_tokens ?? 0,
    total_tokens:
      usage.total_tokens ??
      (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
  };
}

export function extractTextPartsFromItem(item) {
  if (!item || typeof item !== "object" || !Array.isArray(item.content)) {
    return [];
  }

  return item.content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }

      if (typeof part.text === "string") {
        return part.text;
      }

      if (typeof part.output_text === "string") {
        return part.output_text;
      }

      return "";
    })
    .filter(Boolean);
}

export function resolveUpstreamModel(model) {
  if (!model || typeof model !== "string") {
    return DEFAULT_MODEL;
  }

  const trimmed = model.trim();
  if (!trimmed) {
    return DEFAULT_MODEL;
  }

  const alias = MODEL_ALIASES.get(trimmed);
  if (alias) {
    return alias;
  }

  if (trimmed.includes("/")) {
    // 兼容 LiteLLM 常见的 provider/model 形式，例如 openai/gpt-5.4。
    const leaf = trimmed.split("/").pop()?.trim();
    if (leaf) {
      return MODEL_ALIASES.get(leaf) ?? leaf;
    }
  }

  if (/[\[\]]/.test(trimmed)) {
    // 像 opus[1m] 这类路由占位模型名不是上游真实模型，统一回退到默认值。
    return DEFAULT_MODEL;
  }

  return trimmed;
}

export function extractOutputText(response) {
  if (typeof response?.output_text === "string" && response.output_text) {
    return response.output_text;
  }

  // 某些完成事件不会直接给 output_text，需要从 output[].content[] 兜底提取。
  if (!Array.isArray(response?.output)) {
    return "";
  }

  return response.output
    .flatMap((item) => {
      if (!Array.isArray(item?.content)) {
        return [];
      }

      return item.content
        .map((part) => part?.text ?? part?.output_text ?? "")
        .filter(Boolean);
    })
    .join("\n");
}

export function buildChatCompletionResponse({
  requestBody,
  responseId,
  model,
  content,
  usage,
}) {
  return {
    id: responseId ?? `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model ?? requestBody.model ?? DEFAULT_MODEL,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
        },
        finish_reason: "stop",
      },
    ],
    usage,
  };
}

export function buildChatCompletionChunk({
  requestBody,
  responseId,
  model,
  delta,
  finishReason,
}) {
  return {
    id: responseId ?? `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: model ?? requestBody.model ?? DEFAULT_MODEL,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason ?? null,
      },
    ],
  };
}

export function writeSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function writeSseDone(res) {
  res.write("data: [DONE]\n\n");
}
