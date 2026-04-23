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
      dataParts.push(line.slice(5).trim());
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
  let responseId = null;
  let model = null;
  let content = "";
  let usage = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
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

      const { eventName, data } = parsed;
      if (eventName === "response.created") {
        responseId = data?.response?.id ?? responseId;
        model = data?.response?.model ?? model;
      } else if (eventName === "response.output_text.delta") {
        // 主文本增量事件。
        content += data?.delta ?? "";
      } else if (eventName === "response.content_part.added") {
        // 某些响应会在 added 事件里直接带文本，不能只盯着 delta。
        const partText = data?.part?.text ?? data?.part?.output_text ?? "";
        if (partText) {
          content += partText;
        }
      } else if (eventName === "response.output_item.added") {
        content += extractTextPartsFromItem(data?.item).join("");
      } else if (eventName === "response.completed") {
        const responseObj = data?.response ?? {};
        usage = usageFromResponse(responseObj);
        responseId = responseObj.id ?? responseId;
        model = responseObj.model ?? model;
        if (!content) {
          // 如果前面没有收到文本增量，这里再从完整响应兜底提取一次。
          content = extractOutputText(responseObj);
        }
      }
    }
  }

  buffer += decoder.decode();

  if (!content && !responseId) {
    throw new Error(
      "ChatGPT Codex upstream returned no SSE content. You may need to re-login.",
    );
  }

  return {
    id: responseId,
    model,
    content,
    usage,
  };
}

export async function streamChatgptCodex(body, requestBody, res) {
  // 流式模式下，把上游 Responses SSE 边读边转成 OpenAI chat.completion.chunk SSE。
  const response = await fetchChatgptCodex(body);
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });

  const decoder = new TextDecoder();
  let buffer = "";
  let responseId = `chatcmpl-${Date.now()}`;
  let model = body.model ?? requestBody.model ?? DEFAULT_MODEL;
  let opened = false;
  let sentAnyText = false;

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

      const { eventName, data } = parsed;

      if (eventName === "response.created") {
        responseId = data?.response?.id ?? responseId;
        model = data?.response?.model ?? model;
        if (!opened) {
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
        }
        continue;
      }

      if (eventName === "response.output_text.delta") {
        const deltaText = data?.delta ?? "";
        if (!opened) {
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
        }
        if (deltaText) {
          writeSse(
            res,
            buildChatCompletionChunk({
              requestBody,
              responseId,
              model,
              delta: { content: deltaText },
            }),
          );
          sentAnyText = true;
        }
        continue;
      }

      if (eventName === "response.content_part.added") {
        const partText = data?.part?.text ?? data?.part?.output_text ?? "";
        if (partText) {
          if (!opened) {
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
          }
          writeSse(
            res,
            buildChatCompletionChunk({
              requestBody,
              responseId,
              model,
              delta: { content: partText },
            }),
          );
          sentAnyText = true;
        }
        continue;
      }

      if (eventName === "response.output_item.added") {
        const itemText = extractTextPartsFromItem(data?.item).join("");
        if (itemText) {
          if (!opened) {
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
          }
          writeSse(
            res,
            buildChatCompletionChunk({
              requestBody,
              responseId,
              model,
              delta: { content: itemText },
            }),
          );
          sentAnyText = true;
        }
        continue;
      }

      if (eventName === "response.completed") {
        const responseObj = data?.response ?? {};
        responseId = responseObj.id ?? responseId;
        model = responseObj.model ?? model;

        if (!opened) {
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
        }

        if (!sentAnyText) {
          const fallbackText = extractOutputText(responseObj);
          if (fallbackText) {
            writeSse(
              res,
              buildChatCompletionChunk({
                requestBody,
                responseId,
                model,
                delta: { content: fallbackText },
              }),
            );
          }
        }

        writeSse(
          res,
          buildChatCompletionChunk({
            requestBody,
            responseId,
            model,
            delta: {},
            finishReason: "stop",
          }),
        );
        // 明确输出 [DONE]，兼容 OpenAI SDK / LiteLLM 的流式结束判断。
        writeSseDone(res);
        res.end();
        return;
      }
    }
  }

  if (!opened) {
    writeSse(
      res,
      buildChatCompletionChunk({
        requestBody,
        responseId,
        model,
        delta: { role: "assistant", content: "" },
      }),
    );
  }

  writeSse(
    res,
    buildChatCompletionChunk({
      requestBody,
      responseId,
      model,
      delta: {},
      finishReason: "stop",
    }),
  );
  writeSseDone(res);
  res.end();
}
