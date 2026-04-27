import { prepareProxyStartup } from "./cli.js";

try {
  await prepareProxyStartup();
  const { startProxyServer } = await import("./server.js");
  startProxyServer();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
