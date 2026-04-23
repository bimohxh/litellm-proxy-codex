启动默认 LiteLLM 服务

```bash
docker compose up -d
```

重启

```bash
docker compose restart litellm
```

启动本地 Codex 代理

```bash
bun run start:codex-proxy
```

默认实现现在参考 `cc-switch`，走 ChatGPT Device Code 登录并缓存 `refresh_token`，对外暴露一个 OpenAI 兼容接口：

```text
http://127.0.0.1:4200/v1
```

首次使用先登录：

```bash
bun run login:codex-proxy
```

它会让你打开：

```text
https://auth.openai.com/codex/device
```

登录成功后，代理会把 OAuth 信息保存在：

```text
~/.codex/litellm-codex-oauth.json
```

如果你仍然想走旧的“直接转发到自定义 responses 上游”模式，也保留了兼容开关：

```bash
CODEX_PROXY_MODE=custom_responses bun run start:codex-proxy
```

```bash
CODEX_PROXY_MODE=custom_responses CODEX_BEARER_TOKEN=你的真实上游令牌 bun run start:codex-proxy
```

LiteLLM 配置示例见 `litellm_codex_config.yaml`，其中上游地址使用：

```text
http://host.docker.internal:4200/v1
```

建议把 LiteLLM 的实际上游模型名写成：

```text
gpt-5.4
```

不要继续沿用像 `opus[1m]` 这类路由占位模型名，否则 ChatGPT Codex 上游会直接返回 400。

如果你想直接在本机验证代理：

```bash
OPENAI_API_KEY=anything \
LITELLM_BASE_URL=http://127.0.0.1:4200/v1 \
LITELLM_TEST_MODEL=gpt-5.4 \
node verify_litellm_proxy.mjs
```

当前这个本地代理先支持非流式文本对话：

- 支持 `GET /v1/models`
- 支持 `POST /v1/chat/completions`
- 支持 `GET /auth/status`
- 支持 `POST /auth/device/start`
- 支持 `POST /auth/device/poll`
- 不支持 `stream=true`
- `chatgpt_oauth` 模式会把 `chat.completions` 请求转换成 ChatGPT Codex 后端的 `responses` 请求
- 默认模式不再依赖 `~/.codex/auth.json`
- `custom_responses` 兼容模式下仍支持 `CODEX_AUTH_TOKEN_FIELD` 和 `CODEX_BEARER_TOKEN`

代码现在已经拆分到 `bin/codex-proxy/`：

- `index.js`：代理启动入口
- `server.js`：HTTP 路由
- `handlers.js`：业务处理
- `upstream.js`：上游请求与 SSE 转换
- `oauth.js`：ChatGPT Device Code 登录与 token 刷新
- `messages.js`：消息格式转换
- `http.js` / `fs.js` / `config.js`：基础工具与配置
