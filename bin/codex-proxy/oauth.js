import {
  CODEX_CLIENT_ID,
  DEVICE_AUTH_TOKEN_URL,
  DEVICE_AUTH_USERCODE_URL,
  DEVICE_REDIRECT_URI,
  DEVICE_VERIFICATION_URL,
  OAUTH_STORE_PATH,
  OAUTH_TOKEN_URL,
  TOKEN_REFRESH_BUFFER_MS,
  CODEX_PROXY_MODE,
} from "./config.js";
import { readJsonFile, writeJsonFile } from "./fs.js";

const pendingDeviceCodes = new Map();
const tokenCache = new Map();

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
  // 代理长期可用的关键就在这里：本地只持久化 refresh_token，
  // 每次真正发请求前再刷新成短期 access_token。
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
    throw new Error(
      data.error_description || data.error || `OAuth refresh failed (${response.status})`,
    );
  }

  return data;
}

export async function getCodexOauthAccessToken() {
  const account = await getDefaultAccount();

  if (!account) {
    throw new Error(
      "No ChatGPT OAuth account found. Run `bun run login:codex-proxy` first.",
    );
  }

  const cached = tokenCache.get(account.accountId);
  if (cached && cached.expiresAtMs - nowMs() > TOKEN_REFRESH_BUFFER_MS) {
    // 热路径优先走内存缓存，避免每个请求都打 OAuth 刷新接口。
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

export async function startDeviceFlow() {
  // Device Code 流程适合 CLI/本地代理：程序拿 user_code，用户去浏览器确认登录。
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
    expires_at_ms: nowMs() + Number(data.expires_in ?? 900) * 1000,
  });

  return {
    device_code: data.device_auth_id,
    user_code: data.user_code,
    verification_uri: DEVICE_VERIFICATION_URL,
    expires_in: Number(data.expires_in ?? 900),
    interval: Number(data.interval ?? 5),
  };
}

export async function pollDeviceFlow(deviceCode) {
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
  // 登录成功后保存 refresh_token，后续由代理自己续期，不依赖桌面端登录态。
  const account = await addOauthAccount(tokenData);
  return {
    status: "authorized",
    account_id: account.accountId,
    email: account.email,
  };
}

export async function getAuthStatus() {
  const account = await getDefaultAccount();

  return {
    mode: CODEX_PROXY_MODE,
    logged_in: Boolean(account),
    account_id: account?.accountId ?? null,
    email: account?.email ?? null,
    oauth_store_path: OAUTH_STORE_PATH,
  };
}
