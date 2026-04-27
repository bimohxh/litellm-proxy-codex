import { homedir } from "node:os";
import { join } from "node:path";

export function getPort() {
  return Number.parseInt(process.env.PORT ?? "4200", 10);
}

export const CODEX_PROXY_MODE = process.env.CODEX_PROXY_MODE ?? "chatgpt_oauth";
export const CODEX_AUTH_PATH =
  process.env.CODEX_AUTH_PATH ?? join(homedir(), ".codex", "auth.json");
export const CODEX_BASE_URL =
  (process.env.CODEX_BASE_URL ?? "https://codex.ysaikeji.cn/v1").replace(
    /\/$/,
    "",
  );
export const REAL_MODEL = "gpt-5.5";
export const DEFAULT_MODEL = process.env.CODEX_MODEL ?? REAL_MODEL;
export const CODEX_AUTH_TOKEN_FIELD =
  process.env.CODEX_AUTH_TOKEN_FIELD ?? "access_token";
export const CODEX_BEARER_TOKEN = process.env.CODEX_BEARER_TOKEN ?? "";
export const OAUTH_STORE_PATH =
  process.env.CODEX_OAUTH_STORE_PATH ??
  join(homedir(), ".codex", "litellm-codex-oauth.json");
export const OAUTH_ACCOUNT_DIR =
  process.env.CODEX_OAUTH_ACCOUNT_DIR ??
  join(homedir(), ".codex", "litellm-codex-oauth-accounts");
export const OAUTH_ACCOUNT_INDEX_PATH =
  process.env.CODEX_OAUTH_ACCOUNT_INDEX_PATH ??
  join(OAUTH_ACCOUNT_DIR, "index.json");

export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const DEVICE_AUTH_USERCODE_URL =
  "https://auth.openai.com/api/accounts/deviceauth/usercode";
export const DEVICE_AUTH_TOKEN_URL =
  "https://auth.openai.com/api/accounts/deviceauth/token";
export const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const DEVICE_VERIFICATION_URL = "https://auth.openai.com/codex/device";
export const DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";
export const CHATGPT_CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
export const TOKEN_REFRESH_BUFFER_MS = 60_000;

export const MODEL_ALIASES = new Map([
  ["openai/gpt-5.4", REAL_MODEL],
  ["gpt-5", REAL_MODEL],
  ["gpt-5.4", REAL_MODEL],
  ["gpt-5.5", REAL_MODEL],
  ["gpt-5.2", REAL_MODEL],
  ["gpt-5.2-codex", REAL_MODEL],
]);
