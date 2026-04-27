import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  OAUTH_ACCOUNT_DIR,
  OAUTH_ACCOUNT_INDEX_PATH,
  OAUTH_STORE_PATH,
} from "./config.js";
import { readJsonFile, writeJsonFile } from "./fs.js";

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function accountFilename(accountId) {
  return `${String(accountId).replace(/[^a-zA-Z0-9._-]/g, "_")}.json`;
}

export function accountPathForId(accountId) {
  return join(OAUTH_ACCOUNT_DIR, accountFilename(accountId));
}

async function loadIndex() {
  return readJsonFile(OAUTH_ACCOUNT_INDEX_PATH, {
    version: 2,
    accounts: {},
  });
}

async function saveIndex(index) {
  await writeJsonFile(OAUTH_ACCOUNT_INDEX_PATH, {
    version: 2,
    accounts: index.accounts ?? {},
  });
}

function normalizeAccount(record, accountPath) {
  const accountId = record?.account_id ?? record?.accountId ?? null;
  if (!accountId || !record?.refresh_token) {
    return null;
  }

  return {
    version: 2,
    account_id: accountId,
    email: record.email ?? null,
    refresh_token: record.refresh_token,
    authenticated_at: record.authenticated_at ?? nowSeconds(),
    updated_at: record.updated_at ?? nowSeconds(),
    account_path: accountPath,
  };
}

async function upsertIndexEntry(account) {
  const index = await loadIndex();
  index.accounts[account.account_id] = {
    account_id: account.account_id,
    email: account.email ?? null,
    account_path: account.account_path,
    authenticated_at: account.authenticated_at ?? null,
    updated_at: account.updated_at ?? null,
  };
  await saveIndex(index);
}

export async function saveOauthAccount(account) {
  const accountPath = account.account_path ?? accountPathForId(account.account_id);
  const value = {
    version: 2,
    account_id: account.account_id,
    email: account.email ?? null,
    refresh_token: account.refresh_token,
    authenticated_at: account.authenticated_at ?? nowSeconds(),
    updated_at: nowSeconds(),
  };

  await writeJsonFile(accountPath, value);
  const normalized = normalizeAccount(value, accountPath);
  await upsertIndexEntry(normalized);
  return normalized;
}

export async function readOauthAccount(accountPath) {
  const record = await readJsonFile(accountPath, null);
  const account = normalizeAccount(record, accountPath);
  if (!account) {
    throw new Error(`Invalid OAuth account file: ${accountPath}`);
  }
  return account;
}

export async function migrateLegacyOauthStore() {
  if (!existsSync(OAUTH_STORE_PATH)) {
    return [];
  }

  const legacy = await readJsonFile(OAUTH_STORE_PATH, null);
  const legacyAccounts = legacy?.accounts ?? {};
  const migrated = [];

  for (const [accountId, record] of Object.entries(legacyAccounts)) {
    const account = normalizeAccount(
      {
        ...record,
        account_id: record?.account_id ?? accountId,
      },
      accountPathForId(record?.account_id ?? accountId),
    );

    if (!account) {
      continue;
    }

    if (!existsSync(account.account_path)) {
      await saveOauthAccount(account);
    } else {
      await upsertIndexEntry(await readOauthAccount(account.account_path));
    }
    migrated.push(account);
  }

  return migrated;
}

export async function listOauthAccounts() {
  await migrateLegacyOauthStore();
  await mkdir(OAUTH_ACCOUNT_DIR, { recursive: true });

  const accounts = new Map();
  const index = await loadIndex();

  for (const entry of Object.values(index.accounts ?? {})) {
    if (entry?.account_path && existsSync(entry.account_path)) {
      const account = await readOauthAccount(entry.account_path);
      accounts.set(account.account_id, account);
    }
  }

  for (const name of await readdir(OAUTH_ACCOUNT_DIR)) {
    if (!name.endsWith(".json") || name === basename(OAUTH_ACCOUNT_INDEX_PATH)) {
      continue;
    }

    const accountPath = join(OAUTH_ACCOUNT_DIR, name);
    const account = await readOauthAccount(accountPath);
    accounts.set(account.account_id, account);
    await upsertIndexEntry(account);
  }

  return [...accounts.values()].sort((left, right) => {
    const leftLabel = left.email || left.account_id;
    const rightLabel = right.email || right.account_id;
    return leftLabel.localeCompare(rightLabel);
  });
}

export async function resolveOauthAccount({ accountPath, selector } = {}) {
  if (accountPath) {
    return readOauthAccount(accountPath);
  }

  const accounts = await listOauthAccounts();
  if (!selector) {
    if (accounts.length === 1) {
      return accounts[0];
    }
    return null;
  }

  const exact = accounts.find(
    (account) =>
      account.account_id === selector ||
      account.email === selector ||
      basename(account.account_path) === selector,
  );
  if (exact) {
    return exact;
  }

  const prefixMatches = accounts.filter((account) =>
    account.account_id.startsWith(selector),
  );
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }

  return null;
}

export async function updateOauthAccountRefreshToken(account, refreshToken) {
  return saveOauthAccount({
    ...account,
    refresh_token: refreshToken,
    authenticated_at: account.authenticated_at,
    account_path: account.account_path,
  });
}

export function formatAccountLabel(account) {
  return account.email || account.account_id;
}
