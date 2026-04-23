import OpenAI from "openai";

const baseURL = process.env.LITELLM_BASE_URL || "http://0.0.0.0:4000";
const model = process.env.LITELLM_TEST_MODEL || "codex-local";
const prompt =
  process.env.LITELLM_TEST_PROMPT ||
  "你好啊，你是谁呢";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "sk-5aYWXI3l7oE-qLMJqnRZLg",
  baseURL,
});

try {
  const response = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: prompt }],
  });

  console.log("Request succeeded.");
  console.log(`base_url: ${baseURL}`);
  console.log(`model: ${model}`);
  console.log("");
  console.log("Assistant response:");
  console.log(response.choices?.[0]?.message?.content ?? "<empty>");
  console.log("");
  console.log("Raw response:");
  console.log(JSON.stringify(response, null, 2));
} catch (error) {
  console.error("Request failed.");
  console.error(`base_url: ${baseURL}`);
  console.error(`model: ${model}`);
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
