import { createServer } from "node:http";
import {
  CODEX_PROXY_MODE,
  DEFAULT_MODEL,
  OAUTH_ACCOUNT_DIR,
  getPort,
} from "./config.js";
import { handleAuthStatus, handleChatCompletions, handleDevicePoll, handleDeviceStart } from "./handlers.js";
import { json } from "./http.js";

export function createProxyServer() {
  return createServer(async (req, res) => {
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
        await handleDeviceStart(res);
        return;
      }

      if (req.method === "POST" && url.pathname === "/auth/device/poll") {
        await handleDevicePoll(req, res);
        return;
      }

      if (
        req.method === "POST" &&
        ["/chat/completions", "/v1/chat/completions"].includes(url.pathname)
      ) {
        // 只暴露最小必需的 OpenAI 兼容入口，避免代理表面看起来支持更多未实现接口。
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
}

export function startProxyServer() {
  const server = createProxyServer();
  const port = getPort();
  server.listen(port, "0.0.0.0", () => {
    console.log(
      `Codex OpenAI proxy listening on http://0.0.0.0:${port} in ${CODEX_PROXY_MODE} mode`,
    );
    if (CODEX_PROXY_MODE === "chatgpt_oauth") {
      console.log(`OAuth account dir: ${OAUTH_ACCOUNT_DIR}`);
      console.log(`OAuth account file: ${process.env.CODEX_OAUTH_ACCOUNT_PATH}`);
    }
  });
  return server;
}
