import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const baseURL = process.env.CODEX_PROXY_BASE_URL ?? "http://127.0.0.1:4200";

async function openBrowser(url) {
  if (process.env.CODEX_PROXY_NO_OPEN === "1") {
    return false;
  }

  try {
    if (process.platform === "darwin") {
      await execFileAsync("open", [url]);
      return true;
    }

    if (process.platform === "win32") {
      await execFileAsync("cmd", ["/c", "start", "", url]);
      return true;
    }

    await execFileAsync("xdg-open", [url]);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const startResponse = await fetch(`${baseURL}/auth/device/start`, {
    method: "POST",
  });
  const startData = await startResponse.json();

  if (!startResponse.ok) {
    throw new Error(startData?.error?.message || "Failed to start device flow");
  }

  const opened = await openBrowser(startData.verification_uri);

  console.log(`Open: ${startData.verification_uri}`);
  console.log(`User code: ${startData.user_code}`);
  console.log("");
  if (opened) {
    console.log("The browser login page has been opened automatically.");
  } else {
    console.log("The browser was not opened automatically. Please open the URL above manually.");
  }
  console.log("");
  console.log("After you finish ChatGPT login in the browser, this script will continue automatically.");

  const intervalMs = Math.max(3, Number(startData.interval ?? 5)) * 1000;
  const deadline = Date.now() + Math.max(60, Number(startData.expires_in ?? 900)) * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);

    const pollResponse = await fetch(`${baseURL}/auth/device/poll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: startData.device_code }),
    });
    const pollData = await pollResponse.json();

    if (!pollResponse.ok) {
      throw new Error(pollData?.error?.message || "Polling failed");
    }

    if (pollData.status === "pending") {
      process.stdout.write(".");
      continue;
    }

    if (pollData.status === "expired") {
      throw new Error("Device code expired. Please run the login script again.");
    }

    if (pollData.status === "authorized") {
      console.log("");
      console.log(`Authorized account: ${pollData.email || pollData.account_id}`);
      return;
    }
  }

  throw new Error("Timed out waiting for authorization.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
