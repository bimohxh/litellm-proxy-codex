import { CODEX_PROXY_MODE } from "./config.js";
import { json, readJsonBody } from "./http.js";
import {
  buildChatCompletionResponse,
  buildResponsesResponse,
  chatToolChoiceToResponsesToolChoice,
  chatToolsToResponsesTools,
  extractOutputText,
  messagesToResponsesInput,
  normalizeMessages,
  resolveUpstreamModel,
  usageFromResponse,
} from "./messages.js";
import { getAuthStatus, pollDeviceFlow, startDeviceFlow } from "./oauth.js";
import {
  callChatgptCodex,
  callCustomResponsesApi,
  callResponsesApi,
  streamChatgptCodex,
  streamResponsesApi,
} from "./upstream.js";

export async function handleChatCompletions(req, res) {
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
    // 兼容旧模式：直接把请求转发到自定义 Responses 上游。
    const upstreamModel = resolveUpstreamModel(body.model);
    const upstreamBody = {
      model: upstreamModel,
      input: normalizedMessages
        .map((message) => `${message.role}: ${message.text}`)
        .filter((line) => !line.endsWith(": "))
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
    .map((message) => message.text)
    .filter(Boolean)
    .join("\n\n");

  const upstreamBody = {
    model: upstreamModel,
    input: messagesToResponsesInput(
      (body.messages ?? []).filter((message) => message?.role !== "system"),
    ),
    // system 提示在 Responses API 里应该走 instructions，而不是混到 message 列表里。
    instructions,
    tools: chatToolsToResponsesTools(body.tools),
    parallel_tool_calls: body.parallel_tool_calls ?? false,
    store: false,
    include: ["reasoning.encrypted_content"],
    stream: true,
  };

  if (body.tool_choice) {
    upstreamBody.tool_choice = chatToolChoiceToResponsesToolChoice(body.tool_choice);
  }

  if (body.stream) {
    // 下游要求流式时，直接走 SSE 转发路径。
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
      toolCalls: responseBody.toolCalls,
      finishReason: responseBody.finishReason,
    }),
  );
}

export async function handleResponses(req, res) {
  const body = await readJsonBody(req);

  if (body.input == null) {
    json(res, 400, {
      error: {
        message: "input is required",
        type: "invalid_request_error",
      },
    });
    return;
  }

  const upstreamModel = resolveUpstreamModel(body.model);
  const upstreamBody = {
    ...body,
    model: upstreamModel,
    store: body.store ?? false,
    include: body.include ?? ["reasoning.encrypted_content"],
  };

  if (CODEX_PROXY_MODE === "custom_responses") {
    const responseBody = await callCustomResponsesApi(upstreamBody);
    json(res, 200, responseBody);
    return;
  }

  if (body.stream) {
    await streamResponsesApi(upstreamBody, res);
    return;
  }

  const responseBody = await callResponsesApi(upstreamBody);
  json(
    res,
    200,
    buildResponsesResponse({
      requestBody: body,
      responseId: responseBody.id,
      model: responseBody.model ?? upstreamModel,
      content: responseBody.content,
      usage: responseBody.usage,
      toolCalls: responseBody.toolCalls,
    }),
  );
}

export async function handleAuthStatus(res) {
  json(res, 200, await getAuthStatus());
}

export async function handleDeviceStart(res) {
  json(res, 200, await startDeviceFlow());
}

export async function handleDevicePoll(req, res) {
  const body = await readJsonBody(req);
  if (!body.device_code) {
    json(res, 400, { error: { message: "device_code is required" } });
    return;
  }

  json(res, 200, await pollDeviceFlow(body.device_code));
}
