import OpenAI from "openai";

const baseURL = process.env.LITELLM_BASE_URL || "http://10.17.0.98:4000";
const model = process.env.LITELLM_TEST_MODEL || "codex-local";
const prompt =
  process.env.LITELLM_TEST_PROMPT ||
  "你好啊，你是谁呢";
const shouldStream = ["1", "true", "yes"].includes(
  (process.env.LITELLM_TEST_STREAM || "").toLowerCase(),
);

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "sk-ieAnNyJSmNxh1MyrXj_OJg",
  baseURL,
});

try {
  const request = {
    model,
    messages: [{ role: "user", content: prompt }],
  };

  console.log("Request succeeded.");
  console.log(`base_url: ${baseURL}`);
  console.log(`model: ${model}`);
  console.log(`stream: ${shouldStream}`);
  console.log("");
  console.log("Assistant response:");

  if (shouldStream) {
    const stream = await client.chat.completions.create({
      ...request,
      stream: true,
    });
    let content = "";

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content ?? "";
      if (delta) {
        content += delta;
        process.stdout.write(delta);
      }
    }

    console.log(content ? "\n" : "<empty>");
  } else {
    const response = await client.chat.completions.create(request);
    console.log(response.choices?.[0]?.message?.content ?? "<empty>");
    console.log("");
    console.log("Raw response:");
    console.log(JSON.stringify(response, null, 2));
  }
} catch (error) {
  console.error("Request failed.");
  console.error(`base_url: ${baseURL}`);
  console.error(`model: ${model}`);
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
