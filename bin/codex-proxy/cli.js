import { stdin as input } from "node:process";
import { input as promptInput, select } from "@inquirer/prompts";
import {
  formatAccountLabel,
  listOauthAccounts,
  resolveOauthAccount,
} from "./account-store.js";

function readArgValue(args, index, name) {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

export function parseStartArgs(args = process.argv.slice(2)) {
  const options = {
    account: process.env.CODEX_OAUTH_ACCOUNT_ID ?? process.env.CODEX_ACCOUNT_ID ?? "",
    accountPath: process.env.CODEX_OAUTH_ACCOUNT_PATH ?? "",
    port: process.env.PORT ?? "",
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--") {
      continue;
    }

    if (arg === "--port" || arg === "-p") {
      options.port = readArgValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--port=")) {
      options.port = arg.slice("--port=".length);
      continue;
    }

    if (arg === "--account" || arg === "--account-id" || arg === "-a") {
      options.account = readArgValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--account=")) {
      options.account = arg.slice("--account=".length);
      continue;
    }

    if (arg.startsWith("--account-id=")) {
      options.account = arg.slice("--account-id=".length);
      continue;
    }

    if (arg === "--account-path") {
      options.accountPath = readArgValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--account-path=")) {
      options.accountPath = arg.slice("--account-path=".length);
      continue;
    }

    if (/^\d+$/.test(arg) && !options.port) {
      options.port = arg;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

async function promptForAccount(accounts) {
  return select({
    message: "Choose the ChatGPT account for this proxy instance",
    choices: accounts.map((account) => ({
      name: formatAccountLabel(account),
      value: account,
    })),
  });
}

async function promptForPort(defaultPort = "4200") {
  const port = await promptInput({
    message: "Proxy port",
    default: defaultPort,
    validate(value) {
      const port = String(value || defaultPort).trim();
      const numericPort = Number.parseInt(port, 10);

      if (
        String(numericPort) === port &&
        numericPort >= 1 &&
        numericPort <= 65535
      ) {
        return true;
      }

      return "Please enter a port number from 1 to 65535.";
    },
  });

  return String(port || defaultPort).trim();
}

export async function prepareProxyStartup() {
  const options = parseStartArgs();

  if ((process.env.CODEX_PROXY_MODE ?? "chatgpt_oauth") === "custom_responses") {
    process.env.PORT = options.port || "4200";
    return;
  }

  const accounts = await listOauthAccounts();
  if (accounts.length === 0) {
    throw new Error("No OAuth accounts found. Run `bun run login:codex-proxy` first.");
  }

  let account;
  let port;

  if (input.isTTY) {
    account = await promptForAccount(accounts);
    port = await promptForPort(options.port || "4200");
  } else {
    port = options.port || "4200";
    account = await resolveOauthAccount({
      accountPath: options.accountPath,
      selector: options.account,
    });

    if (!account) {
      if (accounts.length === 1) {
        account = accounts[0];
      } else {
        throw new Error(
          "Multiple OAuth accounts found in non-interactive mode. Pass --account <email|account_id> or CODEX_OAUTH_ACCOUNT_ID.",
        );
      }
    }
  }

  process.env.PORT = port;
  process.env.CODEX_OAUTH_ACCOUNT_PATH = account.account_path;
  process.env.CODEX_OAUTH_ACCOUNT_ID = account.account_id;

  console.log(`Selected account: ${formatAccountLabel(account)}`);
  console.log(`Proxy port: ${port}`);
}
