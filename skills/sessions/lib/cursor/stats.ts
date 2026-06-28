import { readCachedSessions, readCacheMeta } from "../core/cache.ts";
import type { SessionEnvironment } from "../core/env.ts";
import { globTranscriptFiles } from "./paths.ts";

export type IndexStats = {
  provider: "cursor";
  schemaVersion: 1;
  lastReindexAt: string | null;
  transcriptsFound: number;
  indexedSessions: number;
  skipped: number;
  skippedUnparseable: number;
  withUserQuery: number;
  automationSessions: number;
  subagentSessions: number;
  realUserSessions: number;
  workspaces: number;
  oldestSessionAt: string | null;
  newestSessionAt: string | null;
};

export function getCursorIndexStats(env: SessionEnvironment): IndexStats {
  const sessions = readCachedSessions(env, "cursor");
  const meta = readCacheMeta(env, "cursor");
  const transcriptsFound = globTranscriptFiles(env).length || meta?.counts.transcriptsFound || 0;
  const times = sessions
    .map((session) => session.updatedAtMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return {
    provider: "cursor",
    schemaVersion: 1,
    lastReindexAt: meta?.lastReindexAt ?? null,
    transcriptsFound,
    indexedSessions: sessions.length,
    skipped: Math.max(0, transcriptsFound - sessions.length),
    skippedUnparseable: meta?.counts.skippedUnparseable ?? 0,
    withUserQuery: sessions.filter((session) => Boolean(session.firstUserQuery)).length,
    automationSessions: sessions.filter((session) => session.isAutomation).length,
    subagentSessions: sessions.filter((session) => session.isSubagent).length,
    realUserSessions: sessions.filter((session) => !session.isAutomation).length,
    workspaces: new Set(sessions.map((session) => session.workspaceKey)).size,
    oldestSessionAt: times.length ? new Date(Math.min(...times)).toISOString() : null,
    newestSessionAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
  };
}
