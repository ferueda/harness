import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { formatZodError } from "../../schemas.ts";
import type { SessionEnvironment } from "./env.ts";
import type {
  CodexSession,
  CursorSession,
  IndexSnapshot,
  SessionProviderId,
  SessionRecord,
} from "./types.ts";

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
  threadId: z.string(),
  rolloutPath: z.string(),
  stateDbPath: z.string().optional(),
  source: z.string().optional(),
  threadSource: z.string().optional(),
  parentThreadId: z.string().optional(),
  agentRole: z.string().optional(),
  agentNickname: z.string().optional(),
}).strict();

const SessionRecordSchema = z.discriminatedUnion("provider", [
  CursorSessionRecordSchema,
  CodexSessionRecordSchema,
]);

const CacheMetaSchema = z
  .object({
    schemaVersion: z.literal(1),
    provider: z.enum(["cursor", "codex"]),
    lastReindexAt: z.string(),
    counts: z.object({
      transcriptsFound: z.number().int().nonnegative(),
      indexedSessions: z.number().int().nonnegative(),
      skippedUnparseable: z.number().int().nonnegative(),
    }),
  })
  .strict();

export type CacheMeta = z.infer<typeof CacheMetaSchema>;

export function readCachedSessions(
  env: SessionEnvironment,
  provider: SessionProviderId = "cursor",
): SessionRecord[] {
  const path = providerCachePath(env, provider);
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
  writeProviderCache(env, snapshot, "cursor");
  writeFileSync(
    legacyMetaPath(env),
    JSON.stringify(toCacheMeta(snapshot, "cursor"), null, 2) + "\n",
    "utf8",
  );
}

export function writeCodexCache(env: SessionEnvironment, snapshot: IndexSnapshot): void {
  writeProviderCache(env, snapshot, "codex");
}

export function readCacheMeta(
  env: SessionEnvironment,
  provider: SessionProviderId = "cursor",
): CacheMeta | undefined {
  const path = metaPath(env, provider);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (provider === "cursor" && isNodeErrorCode(error, "ENOENT")) {
      return readLegacyCursorCacheMeta(env);
    }
    if (isNodeErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
  return parseCacheMeta(text);
}

export function cursorCachePath(env: SessionEnvironment): string {
  return providerCachePath(env, "cursor");
}

export function codexCachePath(env: SessionEnvironment): string {
  return providerCachePath(env, "codex");
}

export function metaPath(env: SessionEnvironment, provider: SessionProviderId = "cursor"): string {
  return join(env.cacheRoot, `meta-${provider}.json`);
}

function writeProviderCache(
  env: SessionEnvironment,
  snapshot: IndexSnapshot,
  provider: SessionProviderId,
): void {
  mkdirSync(env.cacheRoot, { recursive: true });
  const providerRows = snapshot.sessions.filter((session) => session.provider === provider);
  const rows = providerRows.map((session) => JSON.stringify(session)).join("\n");
  writeFileSync(providerCachePath(env, provider), rows ? `${rows}\n` : "", "utf8");
  writeFileSync(
    metaPath(env, provider),
    JSON.stringify(toCacheMeta(snapshot, provider), null, 2) + "\n",
    "utf8",
  );
}

function readLegacyCursorCacheMeta(env: SessionEnvironment): CacheMeta | undefined {
  let text: string;
  try {
    text = readFileSync(legacyMetaPath(env), "utf8");
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
  return parseCacheMeta(text);
}

function parseCacheMeta(text: string): CacheMeta {
  const parsed = CacheMetaSchema.safeParse(JSON.parse(text) as unknown);
  if (!parsed.success) {
    throw new Error(`Invalid session cache meta: ${formatZodError(parsed.error)}`);
  }
  return parsed.data;
}

function providerCachePath(env: SessionEnvironment, provider: SessionProviderId): string {
  return join(env.cacheRoot, `${provider}.jsonl`);
}

function legacyMetaPath(env: SessionEnvironment): string {
  return join(env.cacheRoot, "meta.json");
}

function toCacheMeta(snapshot: IndexSnapshot, provider: SessionProviderId): CacheMeta {
  return {
    schemaVersion: 1,
    provider,
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
