import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function ensureParentDir(path) {
  await mkdir(dirname(path), { recursive: true });
}

export async function readJsonFile(path, fallback) {
  if (!existsSync(path)) {
    return fallback;
  }

  const raw = await readFile(path, "utf8");
  return JSON.parse(raw);
}

export async function writeJsonFile(path, value) {
  await ensureParentDir(path);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
