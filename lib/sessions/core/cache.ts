import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { formatZodError } from "../../schemas.ts";
import type { SessionEnvironment } from "./env.ts";
import type { CursorSession, IndexSnapshot, SessionRecord } from "./types.ts";

const SessionRecordBaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: z.string(),
    workspaceKey: z.string(),
    workspacePath: z.string(),
    workspacePathConfidence: z.enum(["explicit", "decoded"]),
    workspacePathSource: z.enum(["transcript", "store-db", "project-key"]).optional(),
    title: z.string().optional(),
    createdAtMs: z.number().optional(),
    updatedAtMs: z.number().optional(),
    isAutomation: z.boolean(),
    isSubagent: z.boolean(),
    firstUserQuery: z.string().optional(),
    turnCount: z.number().int().nonnegative(),
    userTurnCount: z.number().int().nonnegative(),
  })
  .strict();

const CursorSessionRecordSchema = SessionRecordBaseSchema.extend({
  provider: z.literal("cursor"),
  chatId: z.string(),
  jsonlPath: z.string(),
  metaJsonPath: z.string().optional(),
  storeDbPath: z.string().optional(),
  mode: z.string().optional(),
}).strict();

const CodexSessionRecordSchema = SessionRecordBaseSchema.extend({
  provider: z.literal("codex"),
}).strict();

const SessionRecordSchema = z.discriminatedUnion("provider", [
  CursorSessionRecordSchema,
  CodexSessionRecordSchema,
]);

const CacheMetaSchema = z
  .object({
    schemaVersion: z.literal(1),
    provider: z.literal("cursor"),
    lastReindexAt: z.string(),
    counts: z.object({
      transcriptsFound: z.number().int().nonnegative(),
      indexedSessions: z.number().int().nonnegative(),
      skippedUnparseable: z.number().int().nonnegative(),
    }),
  })
  .strict();

export type CacheMeta = z.infer<typeof CacheMetaSchema>;

export function readCachedSessions(env: SessionEnvironment): SessionRecord[] {
  const path = cursorCachePath(env);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return [];
    throw error;
  }

  const sessions: SessionRecord[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const parsedJson = parseJsonLine(line, path, index + 1);
    const parsed = SessionRecordSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new Error(
        `Invalid session cache row ${path}:${index + 1}: ${formatZodError(parsed.error)}`,
      );
    }
    sessions.push(parsed.data as SessionRecord);
  }
  return sessions;
}

export function writeCursorCache(env: SessionEnvironment, snapshot: IndexSnapshot): void {
  mkdirSync(env.cacheRoot, { recursive: true });
  const cursorRows = snapshot.sessions.filter(
    (session): session is CursorSession => session.provider === "cursor",
  );
  const rows = cursorRows.map((session) => JSON.stringify(session)).join("\n");
  writeFileSync(cursorCachePath(env), rows ? `${rows}\n` : "", "utf8");
  writeFileSync(metaPath(env), JSON.stringify(toCacheMeta(snapshot), null, 2) + "\n", "utf8");
}

export function readCacheMeta(env: SessionEnvironment): CacheMeta | undefined {
  let text: string;
  try {
    text = readFileSync(metaPath(env), "utf8");
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
  const parsed = CacheMetaSchema.safeParse(JSON.parse(text) as unknown);
  if (!parsed.success) {
    throw new Error(`Invalid session cache meta: ${formatZodError(parsed.error)}`);
  }
  return parsed.data;
}

export function cursorCachePath(env: SessionEnvironment): string {
  return join(env.cacheRoot, "cursor.jsonl");
}

export function metaPath(env: SessionEnvironment): string {
  return join(env.cacheRoot, "meta.json");
}

function toCacheMeta(snapshot: IndexSnapshot): CacheMeta {
  return {
    schemaVersion: 1,
    provider: "cursor",
    lastReindexAt: snapshot.lastReindexAt,
    counts: {
      transcriptsFound: snapshot.transcriptsFound,
      indexedSessions: snapshot.indexedSessions,
      skippedUnparseable: snapshot.skippedUnparseable,
    },
  };
}

function parseJsonLine(line: string, path: string, lineNumber: number): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSON in session cache row ${path}:${lineNumber}: ${String(error)}`);
  }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
