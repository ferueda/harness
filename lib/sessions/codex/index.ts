import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { SessionEnvironment } from "../core/env.ts";
import { writeCodexCache } from "../core/cache.ts";
import type { CodexSession, IndexSnapshot, WorkspacePathConfidence } from "../core/types.ts";
import { isCodexAutomation, isCodexSubagent } from "./classify.ts";
import { cleanCodexUserMessage } from "./normalize.ts";
import { codexStateDbPath, resolveCodexRolloutPath, workspaceKeyForCodexPath } from "./paths.ts";
import { CodexRolloutParseError, parseCodexRolloutFile } from "./rollout.ts";

type CodexThreadRow = {
  id: string;
  rollout_path: string;
  created_at: number;
  updated_at: number;
  created_at_ms?: number | null;
  updated_at_ms?: number | null;
  cwd: string;
  title: string;
  source: string;
  thread_source?: string | null;
  first_user_message?: string | null;
  agent_role?: string | null;
  agent_nickname?: string | null;
};

export async function buildCodexIndex(env: SessionEnvironment): Promise<IndexSnapshot> {
  const stateDbPath = codexStateDbPath(env);
  if (!existsSync(stateDbPath)) {
    throw new Error(
      `Codex state database not found at ${stateDbPath}; expected ${env.codexHome}/state_5.sqlite or ${env.codexHome}/sqlite/state_5.sqlite`,
    );
  }
  const db = new DatabaseSync(stateDbPath, { readOnly: true });
  try {
    const rows = readThreadRows(db);
    const parentByChild = readSpawnEdges(db);
    const sessions: CodexSession[] = [];
    let skippedUnparseable = 0;
    let attempted = 0;

    for (const row of rows) {
      if (!row.rollout_path) continue;
      attempted += 1;
      const rolloutPath = resolveCodexRolloutPath(env, row.rollout_path);
      try {
        if (!existsSync(rolloutPath)) throw new CodexRolloutParseError("Missing rollout file");
        const parsed = parseCodexRolloutFile(rolloutPath);
        const workspacePath = row.cwd || env.homeDir;
        const workspacePathConfidence: WorkspacePathConfidence = row.cwd ? "explicit" : "decoded";
        const firstUserQuery =
          cleanCodexUserMessage(row.first_user_message) ??
          cleanCodexUserMessage(parsed.firstUserQuery);
        const rawFirstUserQuery = rawClassificationText(
          row.first_user_message,
          parsed.firstUserQuery,
        );
        const parentThreadId = parentByChild.get(row.id);
        const classification = {
          threadId: row.id,
          title: row.title,
          source: row.source,
          threadSource: row.thread_source ?? undefined,
          firstUserQuery,
          rawFirstUserQuery,
          isSpawnChild: parentThreadId !== undefined,
          parentThreadId,
          agentRole: row.agent_role ?? undefined,
          agentNickname: row.agent_nickname ?? undefined,
        };
        sessions.push({
          schemaVersion: 1,
          provider: "codex",
          sessionId: row.id,
          threadId: row.id,
          rolloutPath,
          stateDbPath,
          source: row.source || undefined,
          threadSource: row.thread_source ?? undefined,
          parentThreadId,
          agentRole: row.agent_role ?? undefined,
          agentNickname: row.agent_nickname ?? undefined,
          workspaceKey: workspaceKeyForCodexPath(workspacePath),
          workspacePath,
          workspacePathConfidence,
          workspacePathSource: "store-db",
          title: row.title || undefined,
          createdAtMs: row.created_at_ms ?? row.created_at * 1000,
          updatedAtMs: row.updated_at_ms ?? row.updated_at * 1000,
          isAutomation: isCodexAutomation(classification),
          isSubagent: isCodexSubagent(classification),
          firstUserQuery,
          turnCount: parsed.turns.length,
          userTurnCount: parsed.turns.filter((turn) => turn.role === "user").length,
        });
      } catch (error) {
        if (!(error instanceof CodexRolloutParseError) && !isNodeErrorCode(error, "ENOENT")) {
          throw error;
        }
        skippedUnparseable += 1;
      }
    }

    const snapshot: IndexSnapshot = {
      provider: "codex",
      schemaVersion: 1,
      lastReindexAt: env.now().toISOString(),
      transcriptsFound: attempted,
      indexedSessions: sessions.length,
      skipped: attempted - sessions.length,
      skippedUnparseable,
      sessions: sessions.toSorted(
        (left, right) =>
          (right.updatedAtMs ?? 0) - (left.updatedAtMs ?? 0) ||
          left.sessionId.localeCompare(right.sessionId),
      ),
    };
    writeCodexCache(env, snapshot);
    return snapshot;
  } finally {
    db.close();
  }
}

function readThreadRows(db: DatabaseSync): CodexThreadRow[] {
  return db
    .prepare(
      `select
        id,
        rollout_path,
        created_at,
        updated_at,
        created_at_ms,
        updated_at_ms,
        cwd,
        title,
        source,
        coalesce(thread_source, '') as thread_source,
        coalesce(first_user_message, '') as first_user_message,
        coalesce(agent_role, '') as agent_role,
        coalesce(agent_nickname, '') as agent_nickname
      from threads
      order by updated_at desc, id desc`,
    )
    .all() as CodexThreadRow[];
}

function readSpawnEdges(db: DatabaseSync): Map<string, string> {
  try {
    const rows = db
      .prepare("select parent_thread_id, child_thread_id from thread_spawn_edges")
      .all() as { parent_thread_id: string; child_thread_id: string }[];
    return new Map(rows.map((row) => [row.child_thread_id, row.parent_thread_id]));
  } catch {
    // Older Codex schemas may not have thread_spawn_edges; subagent source JSON still covers those rows.
    return new Map();
  }
}

function rawClassificationText(...values: (string | null | undefined)[]): string | undefined {
  const text = values
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n");
  return text || undefined;
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
