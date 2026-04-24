import {
  CHATGPT_CODEX_URL,
  CODEX_AUTH_PATH,
  CODEX_AUTH_TOKEN_FIELD,
  CODEX_BASE_URL,
  CODEX_BEARER_TOKEN,
  DEFAULT_MODEL,
} from "./config.js";
import { readJsonFile } from "./fs.js";
import {
  buildChatCompletionChunk,
  extractFunctionCallFromItem,
  extractFunctionCallsFromResponse,
  extractOutputText,
  extractTextPartsFromItem,
  usageFromResponse,
  writeSse,
  writeSseDone,
} from "./messages.js";
import { getCodexOauthAccessToken } from "./oauth.js";

function takeSseBlock(buffer) {
  const delimiters = ["\r\n\r\n", "\n\n"];
  let bestIndex = -1;
  let bestLen = 0;

  for (const delimiter of delimiters) {
    const index = buffer.indexOf(delimiter);
    if (index !== -1 && (bestIndex === -1 || index < bestIndex)) {
      bestIndex = index;
      bestLen = delimiter.length;
    }
  }

  if (bestIndex === -1) {
    return null;
  }

  return {
    block: buffer.slice(0, bestIndex),
    rest: buffer.slice(bestIndex + bestLen),
  };
}

async function loadCustomAccessToken() {
  if (CODEX_BEARER_TOKEN) {
    return CODEX_BEARER_TOKEN;
  }

  const auth = await readJsonFile(CODEX_AUTH_PATH, null);
  const accessToken = auth?.tokens?.[CODEX_AUTH_TOKEN_FIELD];

  if (!accessToken) {
    throw new Error(
      `No ${CODEX_AUTH_TOKEN_FIELD} found in ${CODEX_AUTH_PATH}. You can also set CODEX_BEARER_TOKEN explicitly.`,
    );
  }

  return accessToken;
}

function parseUpstreamErrorText(text) {
  try {
    const data = text ? JSON.parse(text) : {};
    return data?.error?.message || data?.detail || data?.message || text;
  } catch {
    return text || "Invalid upstream response";
  }
}

function parseSseEvent(block) {
  const lines = block.split(/\r?\n/);
  let eventName = "";
  const dataParts = [];

  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataParts.push(line.slice(5).replace(/^ /, ""));
    }
  }

  if (!dataParts.length) {
    return null;
  }

  const dataText = dataParts.join("\n");
  if (dataText === "[DONE]") {
    return null;
  }

  let data;
  try {
    data = JSON.parse(dataText);
  } catch {
    return null;
  }

  // 有些上游块没有 event: 行，只在 JSON 的 type 字段里表达事件类型。
  return {
    eventName: eventName || data?.type || "",
    data,
  };
}

function mergeFullText(existing, fullText) {
  if (!fullText) {
    return existing;
  }

  if (!existing) {
    return fullText;
  }

  if (fullText.startsWith(existing)) {
    return `${existing}${fullText.slice(existing.length)}`;
  }

  if (existing.endsWith(fullText)) {
    return existing;
  }

  return `${existing}${fullText}`;
}

function textFromContentPart(part) {
  return part?.text ?? part?.output_text ?? "";
}

function upsertToolCall(state, toolCall) {
  if (!toolCall) {
    return;
  }

  const existing = state.toolCalls.find((item) => item.id === toolCall.id);
  if (existing) {
    existing.name = toolCall.name ?? existing.name;
    existing.arguments = mergeFullText(existing.arguments ?? "", toolCall.arguments ?? "");
    return;
  }

  state.toolCalls.push({
    id: toolCall.id,
    name: toolCall.name,
    arguments: toolCall.arguments ?? "",
  });
}

function fullTextFromEvent(eventName, data) {
  if (eventName === "response.output_text.done") {
    return data?.text ?? "";
  }

  if (
    eventName === "response.content_part.added" ||
    eventName === "response.content_part.done"
  ) {
    return textFromContentPart(data?.part);
  }

  if (
    eventName === "response.output_item.added" ||
    eventName === "response.output_item.done"
  ) {
    return extractTextPartsFromItem(data?.item).join("");
  }

  return "";
}

function applyAggregateEvent(state, eventName, data) {
  if (eventName === "response.created") {
    state.responseId = data?.response?.id ?? state.responseId;
    state.model = data?.response?.model ?? state.model;
    return;
  }

  if (eventName === "response.output_text.delta") {
    state.content += data?.delta ?? "";
    return;
  }

  if (
    eventName === "response.output_item.added" ||
    eventName === "response.output_item.done"
  ) {
    const toolCall = extractFunctionCallFromItem(data?.item);
    if (toolCall) {
      upsertToolCall(state, toolCall);
      state.lastToolCallId = toolCall.id;
      return;
    }
  }

  if (eventName === "response.function_call_arguments.delta") {
    const callId = data?.call_id ?? data?.item_id;
    const toolCall =
      state.toolCalls.find((item) => item.id === callId) ??
      state.toolCalls.find((item) => item.id === state.lastToolCallId);
    if (toolCall) {
      toolCall.arguments += data?.delta ?? "";
    }
    return;
  }

  if (eventName === "response.function_call_arguments.done") {
    const callId = data?.call_id ?? data?.item_id;
    const toolCall =
      state.toolCalls.find((item) => item.id === callId) ??
      state.toolCalls.find((item) => item.id === state.lastToolCallId);
    if (toolCall && typeof data?.arguments === "string") {
      toolCall.arguments = data.arguments;
    }
    return;
  }

  const fullText = fullTextFromEvent(eventName, data);
  if (fullText) {
    state.content = mergeFullText(state.content, fullText);
    return;
  }

  if (eventName === "response.completed") {
    const responseObj = data?.response ?? {};
    state.usage = usageFromResponse(responseObj);
    state.responseId = responseObj.id ?? state.responseId;
    state.model = responseObj.model ?? state.model;
    state.content = mergeFullText(state.content, extractOutputText(responseObj));
    for (const toolCall of extractFunctionCallsFromResponse(responseObj)) {
      upsertToolCall(state, toolCall);
    }
  }
}

async function fetchChatgptCodex(body) {
  const { accessToken, accountId } = await getCodexOauthAccessToken();
  const response = await fetch(CHATGPT_CODEX_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "chatgpt-account-id": accountId,
      originator: "cc-switch",
      accept: "text/event-stream",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok || !response.body) {
    const text = await response.text();
    throw new Error(
      `ChatGPT Codex upstream failed with status ${response.status}: ${parseUpstreamErrorText(text)}`,
    );
  }

  return response;
}

export async function callCustomResponsesApi(body) {
  const accessToken = await loadCustomAccessToken();
  const upstreamResponse = await fetch(`${CODEX_BASE_URL}/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await upstreamResponse.text();
  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: { message: text || "Invalid upstream response" } };
  }

  if (!upstreamResponse.ok) {
    throw new Error(
      data?.error?.message ??
        `Upstream request failed with status ${upstreamResponse.status}`,
    );
  }

  return data;
}

export async function callChatgptCodex(body) {
  // 非流式模式下，我们仍然请求上游 SSE，然后在本地聚合成一次性 JSON 返回给下游。
  const response = await fetchChatgptCodex(body);
  const decoder = new TextDecoder();
  let buffer = "";
  const state = {
    responseId: null,
    model: null,
    content: "",
    toolCalls: [],
    lastToolCallId: null,
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });

    while (true) {
      const taken = takeSseBlock(buffer);
      if (!taken) {
        break;
      }

      buffer = taken.rest;
      const parsed = parseSseEvent(taken.block);
      if (!parsed) {
        continue;
      }

      applyAggregateEvent(state, parsed.eventName, parsed.data);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    const parsed = parseSseEvent(buffer.trimEnd());
    if (parsed) {
      applyAggregateEvent(state, parsed.eventName, parsed.data);
    }
  }

  if (!state.content && !state.responseId) {
    throw new Error(
      "ChatGPT Codex upstream returned no SSE content. You may need to re-login.",
    );
  }

  return {
    id: state.responseId,
    model: state.model,
    content: state.content,
    toolCalls: state.toolCalls,
    finishReason: state.toolCalls.length ? "tool_calls" : "stop",
    usage: state.usage,
  };
}

export async function streamChatgptCodex(body, requestBody, res) {
  // 流式模式下，把上游 Responses SSE 边读边转成 OpenAI chat.completion.chunk SSE。
  const response = await fetchChatgptCodex(body);
  res.socket?.setNoDelay?.(true);
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.flushHeaders?.();

  const decoder = new TextDecoder();
  let buffer = "";
  let responseId = `chatcmpl-${Date.now()}`;
  let model = body.model ?? requestBody.model ?? DEFAULT_MODEL;
  let opened = false;
  let emittedText = "";
  let finished = false;
  let lastToolCallId = null;
  const toolCallIndexes = new Map();
  const emittedToolCallArgs = new Map();

  const openAssistantMessage = () => {
    if (opened) {
      return;
    }

    // OpenAI 风格流式通常先发一个带 role 的空 chunk，便于客户端建立 assistant 消息。
    writeSse(
      res,
      buildChatCompletionChunk({
        requestBody,
        responseId,
        model,
        delta: { role: "assistant", content: "" },
      }),
    );
    opened = true;
  };

  const writeTextDelta = (deltaText) => {
    if (!deltaText) {
      return;
    }

    openAssistantMessage();
    writeSse(
      res,
      buildChatCompletionChunk({
        requestBody,
        responseId,
        model,
        delta: { content: deltaText },
      }),
    );
    emittedText += deltaText;
  };

  const writeFullTextRemainder = (fullText) => {
    if (!fullText) {
      return;
    }

    if (!emittedText) {
      writeTextDelta(fullText);
      return;
    }

    if (fullText.startsWith(emittedText)) {
      writeTextDelta(fullText.slice(emittedText.length));
    }
  };

  const ensureToolCall = (toolCall) => {
    if (!toolCall) {
      return null;
    }

    openAssistantMessage();

    if (!toolCallIndexes.has(toolCall.id)) {
      const index = toolCallIndexes.size;
      toolCallIndexes.set(toolCall.id, index);
      emittedToolCallArgs.set(toolCall.id, "");
      writeSse(
        res,
        buildChatCompletionChunk({
          requestBody,
          responseId,
          model,
          delta: {
            tool_calls: [
              {
                index,
                id: toolCall.id,
                type: "function",
                function: {
                  name: toolCall.name,
                  arguments: "",
                },
              },
            ],
          },
        }),
      );
    }

    return toolCallIndexes.get(toolCall.id);
  };

  const writeToolCallArguments = (toolCall, argumentDelta) => {
    if (!argumentDelta) {
      return;
    }

    const index = ensureToolCall(toolCall);
    if (index == null) {
      return;
    }

    writeSse(
      res,
      buildChatCompletionChunk({
        requestBody,
        responseId,
        model,
        delta: {
          tool_calls: [
            {
              index,
              function: {
                arguments: argumentDelta,
              },
            },
          ],
        },
      }),
    );
    emittedToolCallArgs.set(
      toolCall.id,
      `${emittedToolCallArgs.get(toolCall.id) ?? ""}${argumentDelta}`,
    );
  };

  const writeToolCallRemainder = (toolCall) => {
    if (!toolCall) {
      return;
    }

    ensureToolCall(toolCall);
    const emittedArgs = emittedToolCallArgs.get(toolCall.id) ?? "";
    const fullArgs = toolCall.arguments ?? "";
    if (!emittedArgs) {
      writeToolCallArguments(toolCall, fullArgs);
    } else if (fullArgs.startsWith(emittedArgs)) {
      writeToolCallArguments(toolCall, fullArgs.slice(emittedArgs.length));
    }
  };

  const resolveToolCallId = (data) => {
    const callId = data?.call_id ?? data?.item_id;
    if (toolCallIndexes.has(callId)) {
      return callId;
    }

    return lastToolCallId;
  };

  const finishStream = () => {
    if (finished) {
      return;
    }

    openAssistantMessage();
    writeSse(
      res,
      buildChatCompletionChunk({
        requestBody,
        responseId,
        model,
        delta: {},
        finishReason: toolCallIndexes.size ? "tool_calls" : "stop",
      }),
    );
    // 明确输出 [DONE]，兼容 OpenAI SDK / LiteLLM 的流式结束判断。
    writeSseDone(res);
    res.end();
    finished = true;
  };

  const handleParsedEvent = ({ eventName, data }) => {
    if (eventName === "response.created") {
      responseId = data?.response?.id ?? responseId;
      model = data?.response?.model ?? model;
      openAssistantMessage();
      return;
    }

    if (eventName === "response.output_text.delta") {
      writeTextDelta(data?.delta ?? "");
      return;
    }

    if (
      eventName === "response.output_item.added" ||
      eventName === "response.output_item.done"
    ) {
      const toolCall = extractFunctionCallFromItem(data?.item);
      if (toolCall) {
        lastToolCallId = toolCall.id;
        ensureToolCall(toolCall);
        writeToolCallRemainder(toolCall);
        return;
      }
    }

    if (eventName === "response.function_call_arguments.delta") {
      const callId = resolveToolCallId(data);
      const index = toolCallIndexes.get(callId);
      if (index == null) {
        return;
      }

      const toolCall = {
        id: callId,
        name: "",
        arguments: "",
      };
      writeToolCallArguments(toolCall, data?.delta ?? "");
      return;
    }

    if (eventName === "response.function_call_arguments.done") {
      const callId = resolveToolCallId(data);
      const index = toolCallIndexes.get(callId);
      if (index == null || typeof data?.arguments !== "string") {
        return;
      }

      const emittedArgs = emittedToolCallArgs.get(callId) ?? "";
      if (data.arguments.startsWith(emittedArgs)) {
        writeToolCallArguments(
          {
            id: callId,
            name: "",
            arguments: "",
          },
          data.arguments.slice(emittedArgs.length),
        );
      }
      return;
    }

    const fullText = fullTextFromEvent(eventName, data);
    if (fullText) {
      writeFullTextRemainder(fullText);
      return;
    }

    if (eventName === "response.completed") {
      const responseObj = data?.response ?? {};
      responseId = responseObj.id ?? responseId;
      model = responseObj.model ?? model;
      writeFullTextRemainder(extractOutputText(responseObj));
      for (const toolCall of extractFunctionCallsFromResponse(responseObj)) {
        writeToolCallRemainder(toolCall);
      }
      finishStream();
    }
  };

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });

    while (true) {
      const taken = takeSseBlock(buffer);
      if (!taken) {
        break;
      }

      buffer = taken.rest;
      const parsed = parseSseEvent(taken.block);
      if (!parsed) {
        continue;
      }

      handleParsedEvent(parsed);
      if (finished) {
        return;
      }
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    const parsed = parseSseEvent(buffer.trimEnd());
    if (parsed) {
      handleParsedEvent(parsed);
    }
  }

  finishStream();
}
