import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pollDeviceFlow, startDeviceFlow } from "./oauth.js";

const execFileAsync = promisify(execFile);

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  // 直接完成 Device Code 登录并把每个账号保存成独立文件。
  const startData = await startDeviceFlow();

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
  const deadline =
    Date.now() + Math.max(60, Number(startData.expires_in ?? 900)) * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);

    const pollData = await pollDeviceFlow(startData.device_code);

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
      console.log(`Stored at: ${pollData.account_path}`);
      return;
    }
  }

  throw new Error("Timed out waiting for authorization.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
