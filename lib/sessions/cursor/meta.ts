import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SessionEnvironment } from "../core/env.ts";
import { extractWorkspacePathFromUserInfo, type WorkspacePathResult } from "./paths.ts";

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
  workspacePath?: WorkspacePathResult;
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

type StoreDbData = {
  meta: StoreMeta;
  workspacePath?: WorkspacePathResult;
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
  const storeDb = paths.storeDbPath ? await readStoreDbData(paths.storeDbPath) : { meta: {} };
  return {
    ...paths,
    createdAtMs: numberValue(storeDb.meta.createdAt) ?? metaJson.createdAtMs,
    updatedAtMs: metaJson.updatedAtMs,
    title: stringValue(storeDb.meta.name),
    mode: stringValue(storeDb.meta.mode),
    workspacePath: storeDb.workspacePath,
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

async function readStoreDbData(path: string): Promise<StoreDbData> {
  try {
    const sqlite = await import("node:sqlite");
    const db = new sqlite.DatabaseSync(path, { readOnly: true });
    try {
      const row = db.prepare("select value from meta where key = ?").get("0") as
        | { value?: unknown }
        | undefined;
      return {
        meta:
          typeof row?.value === "string"
            ? (JSON.parse(Buffer.from(row.value, "hex").toString("utf8")) as StoreMeta)
            : {},
        workspacePath: tryReadStoreDbWorkspacePath(db),
      };
    } finally {
      db.close();
    }
  } catch {
    // store.db is best-effort; missing SQLite support or unreadable DBs fall back to meta.json/jsonl data.
    return { meta: {} };
  }
}

function tryReadStoreDbWorkspacePath(db: DatabaseLike): WorkspacePathResult | undefined {
  try {
    return readStoreDbWorkspacePath(db);
  } catch {
    return undefined;
  }
}

function readStoreDbWorkspacePath(db: DatabaseLike): WorkspacePathResult | undefined {
  const row = db
    .prepare("select data from blobs where instr(cast(data as text), ?) > 0 limit 1")
    .get("Workspace Path:") as { data?: unknown } | undefined;
  const text = storeBlobText(row?.data);
  if (!text) return undefined;
  return extractWorkspacePathFromUserInfo(text, "store-db") ?? undefined;
}

type DatabaseLike = {
  prepare(sql: string): {
    get(...values: unknown[]): unknown;
  };
};

function storeBlobText(value: unknown): string | undefined {
  const text =
    value instanceof Uint8Array
      ? Buffer.from(value).toString("utf8")
      : typeof value === "string"
        ? value
        : undefined;
  if (!text) return undefined;

  try {
    const parsed = JSON.parse(text) as { content?: unknown };
    return contentText(parsed.content);
  } catch {
    return text;
  }
}

function contentText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((item) => {
      if (!item || typeof item !== "object" || !("text" in item)) return "";
      return typeof item.text === "string" ? item.text : "";
    })
    .filter(Boolean)
    .join("\n");
  return text || undefined;
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
