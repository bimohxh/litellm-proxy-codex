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

      if (part.type === "refusal" && typeof part.refusal === "string") {
        return part.refusal;
      }

      if (typeof part.input === "string") {
        return part.input;
      }

      if (typeof part.content === "string") {
        return part.content;
      }

      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function hasContentPayload(content) {
  if (typeof content === "string") {
    return content.trim().length > 0;
  }

  return Array.isArray(content) && content.length > 0;
}

export function normalizeMessages(messages = []) {
  return messages
    .filter((message) => message && typeof message === "object")
    .map((message) => ({
      role: message.role ?? "user",
      content: message.content,
      text: textContentToString(message.content),
    }))
    .filter((message) => hasContentPayload(message.content));
}

function hasAssistantToolCalls(message) {
  return (
    message?.role === "assistant" &&
    Array.isArray(message.tool_calls) &&
    message.tool_calls.length > 0
  );
}

function stringifyToolOutput(content) {
  const text = textContentToString(content);
  if (text) {
    return text;
  }

  if (content == null) {
    return "";
  }

  if (typeof content === "object") {
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }

  return String(content);
}

function mapStringContentByRole(role, text) {
  if (!text) {
    return [];
  }

  if (role === "assistant") {
    return [{ type: "output_text", text }];
  }

  return [{ type: "input_text", text }];
}

function mapImagePart(part) {
  const image = part?.image_url;
  if (typeof image === "string" && image) {
    return {
      type: "input_image",
      image_url: image,
      detail: "auto",
    };
  }

  if (image && typeof image === "object" && typeof image.url === "string") {
    return {
      type: "input_image",
      image_url: image.url,
      detail: image.detail ?? "auto",
    };
  }

  return null;
}

function mapFilePart(part) {
  const file = part?.file;
  if (!file || typeof file !== "object") {
    return null;
  }

  const mapped = {
    type: "input_file",
  };

  if (typeof file.file_data === "string" && file.file_data) {
    mapped.file_data = file.file_data;
  }

  if (typeof file.file_id === "string" && file.file_id) {
    mapped.file_id = file.file_id;
  }

  if (typeof file.file_url === "string" && file.file_url) {
    mapped.file_url = file.file_url;
  }

  if (typeof file.filename === "string" && file.filename) {
    mapped.filename = file.filename;
  }

  return Object.keys(mapped).length > 1 ? mapped : null;
}

function mapArrayContentByRole(role, content) {
  // 目前优先支持最常见的 OpenAI Chat message parts：
  // text / image_url / file / refusal。
  // 其它更少见的 part（例如 input_audio）暂未在这个代理里实现。
  return content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return null;
      }

      if (part.type === "text" && typeof part.text === "string") {
        return role === "assistant"
          ? { type: "output_text", text: part.text }
          : { type: "input_text", text: part.text };
      }

      if (part.type === "refusal" && role === "assistant") {
        if (typeof part.refusal === "string" && part.refusal) {
          return { type: "refusal", refusal: part.refusal };
        }
        return null;
      }

      if (part.type === "image_url" && role !== "assistant") {
        return mapImagePart(part);
      }

      if (part.type === "file" && role !== "assistant") {
        return mapFilePart(part);
      }

      return null;
    })
    .filter(Boolean);
}

function mapMessageContentByRole(role, content) {
  if (typeof content === "string") {
    return mapStringContentByRole(role, content);
  }

  if (Array.isArray(content)) {
    return mapArrayContentByRole(role, content);
  }

  return [];
}

export function messagesToResponsesInput(messages = []) {
  // ChatGPT Codex 的 Responses 输入对历史消息类型要求更严格：
  // user 用 input_text，assistant 历史内容必须用 output_text。
  return messages
    .filter((message) => message && typeof message === "object")
    .flatMap((message) => {
      if (message.role === "tool") {
        const callId = message.tool_call_id ?? message.id;
        if (!callId) {
          return [];
        }

        return [
          {
            type: "function_call_output",
            call_id: callId,
            output: stringifyToolOutput(message.content),
          },
        ];
      }

      const items = [];
      const content = mapMessageContentByRole(message.role, message.content);
      if (content.length > 0) {
        items.push({
          role: message.role === "system" ? "user" : message.role,
          content,
        });
      }

      if (hasAssistantToolCalls(message)) {
        for (const toolCall of message.tool_calls) {
          if (toolCall?.type && toolCall.type !== "function") {
            continue;
          }

          const name = toolCall?.function?.name;
          if (!name) {
            continue;
          }

          items.push({
            type: "function_call",
            call_id: toolCall.id,
            name,
            arguments: toolCall.function?.arguments ?? "",
          });
        }
      }

      return items;
    });
}

export function chatToolsToResponsesTools(tools = []) {
  if (!Array.isArray(tools)) {
    return [];
  }

  return tools
    .map((tool) => {
      if (!tool || typeof tool !== "object") {
        return null;
      }

      if (tool.type !== "function") {
        return null;
      }

      const fn = tool.function;
      if (!fn?.name) {
        return null;
      }

      const mapped = {
        type: "function",
        name: fn.name,
        description: fn.description ?? "",
        parameters: fn.parameters ?? { type: "object", properties: {} },
      };

      if (typeof fn.strict === "boolean") {
        mapped.strict = fn.strict;
      }

      return mapped;
    })
    .filter(Boolean);
}

export function chatToolChoiceToResponsesToolChoice(toolChoice) {
  if (!toolChoice) {
    return undefined;
  }

  if (typeof toolChoice === "string") {
    return toolChoice;
  }

  if (toolChoice?.type === "function" && toolChoice.function?.name) {
    return {
      type: "function",
      name: toolChoice.function.name,
    };
  }

  return toolChoice;
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

export function extractFunctionCallFromItem(item) {
  if (!item || typeof item !== "object" || item.type !== "function_call") {
    return null;
  }

  const name = item.name ?? item.function?.name;
  if (!name) {
    return null;
  }

  return {
    id: item.call_id ?? item.id ?? `call_${Date.now()}`,
    name,
    arguments: item.arguments ?? item.function?.arguments ?? "",
  };
}

export function extractFunctionCallsFromResponse(response) {
  if (!Array.isArray(response?.output)) {
    return [];
  }

  return response.output.map(extractFunctionCallFromItem).filter(Boolean);
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
  toolCalls = [],
  finishReason,
}) {
  const hasToolCalls = toolCalls.length > 0;
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
          content: hasToolCalls ? content || null : content,
          ...(hasToolCalls
            ? {
                tool_calls: toolCalls.map((toolCall) => ({
                  id: toolCall.id,
                  type: "function",
                  function: {
                    name: toolCall.name,
                    arguments: toolCall.arguments ?? "",
                  },
                })),
              }
            : {}),
        },
        finish_reason: finishReason ?? (hasToolCalls ? "tool_calls" : "stop"),
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
