import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SessionEnvironment } from "../core/env.ts";

export type CursorMetaIndex = Map<string, CursorMetaPaths>;

export type CursorMetaPaths = {
  metaJsonPath?: string;
  storeDbPath?: string;
};

export type CursorSessionMeta = CursorMetaPaths & {
  createdAtMs?: number;
  updatedAtMs?: number;
  title?: string;
  mode?: string;
};

type MetaJson = {
  createdAtMs?: unknown;
  updatedAtMs?: unknown;
};

type StoreMeta = {
  name?: unknown;
  mode?: unknown;
  createdAt?: unknown;
};

export function buildCursorMetaIndex(env: SessionEnvironment): CursorMetaIndex {
  const chatsRoot = join(env.cursorHome, "chats");
  const index: CursorMetaIndex = new Map();
  if (!existsSync(chatsRoot)) return index;

  for (const workspaceDir of readdirSync(chatsRoot, { withFileTypes: true })) {
    if (!workspaceDir.isDirectory()) continue;
    const workspacePath = join(chatsRoot, workspaceDir.name);
    for (const chatDir of readdirSync(workspacePath, { withFileTypes: true })) {
      if (!chatDir.isDirectory()) continue;
      const chatPath = join(workspacePath, chatDir.name);
      index.set(chatDir.name, {
        metaJsonPath: existingPath(join(chatPath, "meta.json")),
        storeDbPath: existingPath(join(chatPath, "store.db")),
      });
    }
  }
  return index;
}

export async function readCursorSessionMeta(
  paths: CursorMetaPaths | undefined,
): Promise<CursorSessionMeta> {
  if (!paths) return {};
  const metaJson = paths.metaJsonPath ? tryReadMetaJson(paths.metaJsonPath) : {};
  const storeMeta = paths.storeDbPath ? await readStoreDbMeta(paths.storeDbPath) : {};
  return {
    ...paths,
    createdAtMs: numberValue(storeMeta.createdAt) ?? metaJson.createdAtMs,
    updatedAtMs: metaJson.updatedAtMs,
    title: stringValue(storeMeta.name),
    mode: stringValue(storeMeta.mode),
  };
}

function tryReadMetaJson(path: string): { createdAtMs?: number; updatedAtMs?: number } {
  try {
    return readMetaJson(path);
  } catch {
    return {};
  }
}

function readMetaJson(path: string): { createdAtMs?: number; updatedAtMs?: number } {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as MetaJson;
  return {
    createdAtMs: numberValue(parsed.createdAtMs),
    updatedAtMs: numberValue(parsed.updatedAtMs),
  };
}

async function readStoreDbMeta(path: string): Promise<StoreMeta> {
  try {
    const sqlite = await import("node:sqlite");
    const db = new sqlite.DatabaseSync(path, { readOnly: true });
    try {
      const row = db.prepare("select value from meta where key = ?").get("0") as
        | { value?: unknown }
        | undefined;
      if (typeof row?.value !== "string") return {};
      return JSON.parse(Buffer.from(row.value, "hex").toString("utf8")) as StoreMeta;
    } finally {
      db.close();
    }
  } catch {
    // store.db is best-effort; missing SQLite support or unreadable DBs fall back to meta.json/jsonl data.
    return {};
  }
}

function existingPath(path: string): string | undefined {
  return existsSync(path) ? path : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
