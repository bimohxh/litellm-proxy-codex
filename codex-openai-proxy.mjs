import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const PORT = Number.parseInt(process.env.PORT ?? "4200", 10);
const CODEX_PROXY_MODE = process.env.CODEX_PROXY_MODE ?? "chatgpt_oauth";
const CODEX_AUTH_PATH =
  process.env.CODEX_AUTH_PATH ?? join(homedir(), ".codex", "auth.json");
const CODEX_BASE_URL =
  (process.env.CODEX_BASE_URL ?? "https://codex.ysaikeji.cn/v1").replace(
    /\/$/,
    "",
  );
const DEFAULT_MODEL = process.env.CODEX_MODEL ?? "gpt-5.4";
const CODEX_AUTH_TOKEN_FIELD = process.env.CODEX_AUTH_TOKEN_FIELD ?? "access_token";
const CODEX_BEARER_TOKEN = process.env.CODEX_BEARER_TOKEN ?? "";
const OAUTH_STORE_PATH =
  process.env.CODEX_OAUTH_STORE_PATH ??
  join(homedir(), ".codex", "litellm-codex-oauth.json");

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEVICE_AUTH_USERCODE_URL =
  "https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_AUTH_TOKEN_URL =
  "https://auth.openai.com/api/accounts/deviceauth/token";
const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const DEVICE_VERIFICATION_URL = "https://auth.openai.com/codex/device";
const DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";
const CHATGPT_CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
const TOKEN_REFRESH_BUFFER_MS = 60_000;
const MODEL_ALIASES = new Map([
  ["openai/gpt-5.4", "gpt-5.4"],
  ["gpt-5", "gpt-5.4"],
  ["gpt-5.4", "gpt-5.4"],
  ["gpt-5.2", "gpt-5.4"],
  ["gpt-5.2-codex", "gpt-5.4"],
]);

const pendingDeviceCodes = new Map();
const tokenCache = new Map();

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function nowMs() {
  return Date.now();
}

function computeExpiresAtMs(expiresInSeconds) {
  return nowMs() + Math.max(60, Number(expiresInSeconds ?? 3600)) * 1000;
}

function parseJwtClaims(token) {
  if (!token || typeof token !== "string") {
    return {};
  }

  const parts = token.split(".");
  if (parts.length < 2) {
    return {};
  }

  try {
    const payload = parts[1]
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(parts[1].length / 4) * 4, "=");
    return JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
  } catch {
    return {};
  }
}

function extractIdentityFromTokens(tokens) {
  const claims = parseJwtClaims(tokens.id_token);
  const openAiAuth = claims["https://api.openai.com/auth"] ?? {};

  return {
    accountId:
      openAiAuth.chatgpt_account_id ??
      claims.chatgpt_account_id ??
      openAiAuth.chatgpt_account_id ??
      null,
    email: claims.email ?? null,
  };
}

async function ensureParentDir(path) {
  await mkdir(dirname(path), { recursive: true });
}

async function readJsonFile(path, fallback) {
  if (!existsSync(path)) {
    return fallback;
  }

  const raw = await readFile(path, "utf8");
  return JSON.parse(raw);
}

async function writeJsonFile(path, value) {
  await ensureParentDir(path);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function loadOauthStore() {
  const store = await readJsonFile(OAUTH_STORE_PATH, {
    version: 1,
    default_account_id: null,
    accounts: {},
  });

  if (!store.accounts || typeof store.accounts !== "object") {
    store.accounts = {};
  }

  return store;
}

async function saveOauthStore(store) {
  await writeJsonFile(OAUTH_STORE_PATH, {
    version: 1,
    default_account_id: store.default_account_id ?? null,
    accounts: store.accounts ?? {},
  });
}

async function getDefaultAccount() {
  const store = await loadOauthStore();
  const accountId =
    store.default_account_id ?? Object.keys(store.accounts ?? {})[0] ?? null;

  if (!accountId || !store.accounts[accountId]) {
    return null;
  }

  return {
    accountId,
    ...store.accounts[accountId],
  };
}

async function addOauthAccount(tokens) {
  const { accountId, email } = extractIdentityFromTokens(tokens);

  if (!accountId) {
    throw new Error("Unable to extract chatgpt_account_id from id_token");
  }

  if (!tokens.refresh_token) {
    throw new Error("OAuth token response is missing refresh_token");
  }

  const store = await loadOauthStore();
  store.accounts[accountId] = {
    account_id: accountId,
    email,
    refresh_token: tokens.refresh_token,
    authenticated_at: Math.floor(Date.now() / 1000),
  };
  store.default_account_id ??= accountId;
  await saveOauthStore(store);

  tokenCache.set(accountId, {
    accessToken: tokens.access_token,
    expiresAtMs: computeExpiresAtMs(tokens.expires_in),
  });

  return {
    accountId,
    email,
  };
}

async function refreshAccessToken(refreshToken) {
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "litellm-codex-proxy",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CODEX_CLIENT_ID,
      scope: "openid profile email",
    }),
  });

  const text = await response.text();
  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`OAuth refresh returned non-JSON: ${text}`);
  }

  if (!response.ok) {
    throw new Error(data.error_description || data.error || `OAuth refresh failed (${response.status})`);
  }

  return data;
}

async function getCodexOauthAccessToken() {
  const account = await getDefaultAccount();

  if (!account) {
    throw new Error(
      "No ChatGPT OAuth account found. Run `npm run login:codex-proxy` first.",
    );
  }

  const cached = tokenCache.get(account.accountId);
  if (cached && cached.expiresAtMs - nowMs() > TOKEN_REFRESH_BUFFER_MS) {
    return {
      accessToken: cached.accessToken,
      accountId: account.accountId,
      email: account.email ?? null,
    };
  }

  const refreshed = await refreshAccessToken(account.refresh_token);

  const store = await loadOauthStore();
  if (refreshed.refresh_token && store.accounts[account.accountId]) {
    store.accounts[account.accountId].refresh_token = refreshed.refresh_token;
    await saveOauthStore(store);
  }

  tokenCache.set(account.accountId, {
    accessToken: refreshed.access_token,
    expiresAtMs: computeExpiresAtMs(refreshed.expires_in),
  });

  return {
    accessToken: refreshed.access_token,
    accountId: account.accountId,
    email: account.email ?? null,
  };
}

function textContentToString(content) {
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

function normalizeMessages(messages = []) {
  return messages
    .filter((message) => message && typeof message === "object")
    .map((message) => ({
      role: message.role ?? "user",
      content: textContentToString(message.content),
    }))
    .filter((message) => message.content);
}

function messagesToResponsesInput(messages = []) {
  return normalizeMessages(messages).map((message) => ({
    role: message.role === "system" ? "user" : message.role,
    content: [
      message.role === "assistant"
        ? { type: "output_text", text: message.content }
        : { type: "input_text", text: message.content },
    ],
  }));
}

function usageFromResponse(response) {
  const usage = response?.usage ?? {};
  return {
    prompt_tokens: usage.input_tokens ?? 0,
    completion_tokens: usage.output_tokens ?? 0,
    total_tokens:
      usage.total_tokens ??
      (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
  };
}

function extractTextPartsFromItem(item) {
  if (!item || typeof item !== "object") {
    return [];
  }

  if (!Array.isArray(item.content)) {
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

function resolveUpstreamModel(model) {
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
    const leaf = trimmed.split("/").pop()?.trim();
    if (leaf) {
      return MODEL_ALIASES.get(leaf) ?? leaf;
    }
  }

  // LiteLLM / other routers may send synthetic model names like opus[1m].
  // Those are not valid ChatGPT Codex model IDs, so fall back to a known-safe default.
  if (/[\[\]]/.test(trimmed)) {
    return DEFAULT_MODEL;
  }

  return trimmed;
}

function buildChatCompletionResponse({
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

function writeSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function writeSseDone(res) {
  res.write("data: [DONE]\n\n");
}

function buildChatCompletionChunk({ requestBody, responseId, model, delta, finishReason }) {
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

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function callCustomResponsesApi(body) {
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

function extractOutputText(response) {
  if (typeof response?.output_text === "string" && response.output_text) {
    return response.output_text;
  }

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

async function callChatgptCodex(body) {
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
    let data;

    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: { message: text || "Invalid upstream response" } };
    }

    const message =
      data?.error?.message ||
      data?.detail ||
      data?.message ||
      text ||
      `ChatGPT Codex upstream failed with status ${response.status}`;
    throw new Error(
      `ChatGPT Codex upstream failed with status ${response.status}: ${message}`,
    );
  }

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
      const lines = taken.block.split(/\r?\n/);
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
        continue;
      }

      const dataText = dataParts.join("\n");
      if (dataText === "[DONE]") {
        continue;
      }

      let data;
      try {
        data = JSON.parse(dataText);
      } catch {
        continue;
      }

      if (!eventName && typeof data?.type === "string") {
        eventName = data.type;
      }

      if (eventName === "response.created") {
        responseId = data?.response?.id ?? responseId;
        model = data?.response?.model ?? model;
      } else if (eventName === "response.output_text.delta") {
        content += data?.delta ?? "";
      } else if (eventName === "response.content_part.added") {
        const partText =
          data?.part?.text ?? data?.part?.output_text ?? "";
        if (typeof partText === "string" && partText) {
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

async function streamChatgptCodex(body, requestBody, res) {
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
    let data;

    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: { message: text || "Invalid upstream response" } };
    }

    const message =
      data?.error?.message ||
      data?.detail ||
      data?.message ||
      text ||
      `ChatGPT Codex upstream failed with status ${response.status}`;
    throw new Error(
      `ChatGPT Codex upstream failed with status ${response.status}: ${message}`,
    );
  }

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
      const lines = taken.block.split(/\r?\n/);
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
        continue;
      }

      const dataText = dataParts.join("\n");
      if (dataText === "[DONE]") {
        continue;
      }

      let data;
      try {
        data = JSON.parse(dataText);
      } catch {
        continue;
      }

      if (!eventName && typeof data?.type === "string") {
        eventName = data.type;
      }

      if (eventName === "response.created") {
        responseId = data?.response?.id ?? responseId;
        model = data?.response?.model ?? model;
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

async function handleChatCompletions(req, res) {
  const body = await readJsonBody(req);

  const normalizedMessages = normalizeMessages(body.messages);
  if (!normalizedMessages.length) {
    json(res, 400, {
      error: {
        message: "messages must contain at least one text item",
        type: "invalid_request_error",
      },
    });
    return;
  }

  if (CODEX_PROXY_MODE === "custom_responses") {
    const upstreamModel = resolveUpstreamModel(body.model);
    const upstreamBody = {
      model: upstreamModel,
      input: normalizedMessages
        .map((message) => `${message.role}: ${message.content}`)
        .join("\n\n"),
    };

    if (typeof body.temperature === "number") {
      upstreamBody.temperature = body.temperature;
    }

    if (typeof body.max_tokens === "number") {
      upstreamBody.max_output_tokens = body.max_tokens;
    }

    const responseBody = await callCustomResponsesApi(upstreamBody);
    json(
      res,
      200,
      buildChatCompletionResponse({
        requestBody: body,
        responseId: responseBody.id,
        model: responseBody.model ?? upstreamModel,
        content: extractOutputText(responseBody),
        usage: usageFromResponse(responseBody),
      }),
    );
    return;
  }

  const upstreamModel = resolveUpstreamModel(body.model);
  const instructions = normalizedMessages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");

  const upstreamBody = {
    model: upstreamModel,
    input: messagesToResponsesInput(
      normalizedMessages.filter((message) => message.role !== "system"),
    ),
    instructions,
    tools: [],
    parallel_tool_calls: false,
    store: false,
    include: ["reasoning.encrypted_content"],
    stream: true,
  };

  if (body.stream) {
    await streamChatgptCodex(upstreamBody, body, res);
    return;
  }

  const responseBody = await callChatgptCodex(upstreamBody);
  json(
    res,
    200,
    buildChatCompletionResponse({
      requestBody: body,
      responseId: responseBody.id,
      model: responseBody.model ?? upstreamModel,
      content: responseBody.content,
      usage: responseBody.usage,
    }),
  );
}

async function startDeviceFlow() {
  const response = await fetch(DEVICE_AUTH_USERCODE_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "litellm-codex-proxy",
    },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || "Failed to start device flow");
  }

  pendingDeviceCodes.set(data.device_auth_id, {
    user_code: data.user_code,
    expires_at_ms: nowMs() + (Number(data.expires_in ?? 900) * 1000),
  });

  return {
    device_code: data.device_auth_id,
    user_code: data.user_code,
    verification_uri: DEVICE_VERIFICATION_URL,
    expires_in: Number(data.expires_in ?? 900),
    interval: Number(data.interval ?? 5),
  };
}

async function pollDeviceFlow(deviceCode) {
  const pending = pendingDeviceCodes.get(deviceCode);
  if (!pending) {
    throw new Error("Unknown device_code. Start the login flow again.");
  }

  const response = await fetch(DEVICE_AUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "litellm-codex-proxy",
    },
    body: JSON.stringify({
      device_auth_id: deviceCode,
      user_code: pending.user_code,
    }),
  });

  if (response.status === 403 || response.status === 404) {
    return { status: "pending" };
  }

  if (response.status === 410) {
    pendingDeviceCodes.delete(deviceCode);
    return { status: "expired" };
  }

  const pollData = await response.json();
  if (!response.ok) {
    throw new Error(pollData?.error?.message || "Device flow poll failed");
  }

  const tokenResponse = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "litellm-codex-proxy",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: pollData.authorization_code,
      redirect_uri: DEVICE_REDIRECT_URI,
      client_id: CODEX_CLIENT_ID,
      code_verifier: pollData.code_verifier,
    }),
  });

  const tokenData = await tokenResponse.json();
  if (!tokenResponse.ok) {
    throw new Error(
      tokenData?.error_description ||
        tokenData?.error ||
        "OAuth token exchange failed",
    );
  }

  pendingDeviceCodes.delete(deviceCode);
  const account = await addOauthAccount(tokenData);
  return {
    status: "authorized",
    account_id: account.accountId,
    email: account.email,
  };
}

async function handleAuthStatus(res) {
  const account = await getDefaultAccount();
  json(res, 200, {
    mode: CODEX_PROXY_MODE,
    logged_in: Boolean(account),
    account_id: account?.accountId ?? null,
    email: account?.email ?? null,
    oauth_store_path: OAUTH_STORE_PATH,
  });
}

const server = createServer(async (req, res) => {
  try {
    if (!req.url || !req.method) {
      json(res, 400, { error: { message: "Bad request" } });
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);

    if (req.method === "GET" && ["/health", "/v1/health"].includes(url.pathname)) {
      json(res, 200, { ok: true, mode: CODEX_PROXY_MODE });
      return;
    }

    if (req.method === "GET" && ["/models", "/v1/models"].includes(url.pathname)) {
      json(res, 200, {
        object: "list",
        data: [
          {
            id: DEFAULT_MODEL,
            object: "model",
            owned_by: "codex-local-proxy",
          },
        ],
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/auth/status") {
      await handleAuthStatus(res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/auth/device/start") {
      json(res, 200, await startDeviceFlow());
      return;
    }

    if (req.method === "POST" && url.pathname === "/auth/device/poll") {
      const body = await readJsonBody(req);
      if (!body.device_code) {
        json(res, 400, { error: { message: "device_code is required" } });
        return;
      }
      json(res, 200, await pollDeviceFlow(body.device_code));
      return;
    }

    if (req.method === "POST" && ["/chat/completions", "/v1/chat/completions"].includes(url.pathname)) {
      await handleChatCompletions(req, res);
      return;
    }

    json(res, 404, {
      error: { message: `Route not found: ${req.method} ${url.pathname}` },
    });
  } catch (error) {
    json(res, 500, {
      error: {
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Codex OpenAI proxy listening on http://0.0.0.0:${PORT} in ${CODEX_PROXY_MODE} mode`,
  );
  if (CODEX_PROXY_MODE === "chatgpt_oauth") {
    console.log(`OAuth store: ${OAUTH_STORE_PATH}`);
  }
});
