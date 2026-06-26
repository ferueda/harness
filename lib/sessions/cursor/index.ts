import { statSync } from "node:fs";
import type { SessionEnvironment } from "../core/env.ts";
import { writeCursorCache } from "../core/cache.ts";
import type { CursorSession, IndexSnapshot, WorkspacePathConfidence } from "../core/types.ts";
import { isAutomationSession, isSubagentSession } from "./classify.ts";
import { buildCursorMetaIndex, readCursorSessionMeta } from "./meta.ts";
import { globTranscriptFiles, type TranscriptFile } from "./paths.ts";
import { CursorTranscriptParseError, parseTranscriptFile } from "./transcript.ts";

export async function buildCursorIndex(env: SessionEnvironment): Promise<IndexSnapshot> {
  const files = globTranscriptFiles(env);
  const metaIndex = buildCursorMetaIndex(env);
  const sessions: CursorSession[] = [];
  let skippedUnparseable = 0;

  for (const file of files) {
    try {
      const parsed = parseTranscriptFile(file.jsonlPath);
      const meta = await readCursorSessionMeta(metaIndex.get(file.chatId));
      const workspace = resolveWorkspace(file, parsed.workspacePath);
      const firstUserQuery = parsed.firstUserQuery;
      const updatedAtMs = meta.updatedAtMs ?? statSync(file.jsonlPath).mtimeMs;
      sessions.push({
        schemaVersion: 1,
        provider: "cursor",
        sessionId: file.chatId,
        chatId: file.chatId,
        workspaceKey: file.workspaceKey,
        workspacePath: workspace.path,
        workspacePathConfidence: workspace.confidence,
        title: meta.title,
        createdAtMs: meta.createdAtMs,
        updatedAtMs,
        isAutomation: isAutomationSession(firstUserQuery),
        isSubagent: isSubagentSession(file.chatId, firstUserQuery),
        firstUserQuery,
        turnCount: parsed.turns.length,
        userTurnCount: parsed.turns.filter((turn) => turn.role === "user").length,
        jsonlPath: file.jsonlPath,
        metaJsonPath: meta.metaJsonPath,
        storeDbPath: meta.storeDbPath,
        mode: meta.mode,
      });
    } catch (error) {
      if (!(error instanceof CursorTranscriptParseError)) throw error;
      skippedUnparseable += 1;
    }
  }

  const snapshot: IndexSnapshot = {
    provider: "cursor",
    schemaVersion: 1,
    lastReindexAt: env.now().toISOString(),
    transcriptsFound: files.length,
    indexedSessions: sessions.length,
    skipped: files.length - sessions.length,
    skippedUnparseable,
    sessions: sessions.toSorted(
      (left, right) => (right.updatedAtMs ?? 0) - (left.updatedAtMs ?? 0),
    ),
  };
  writeCursorCache(env, snapshot);
  return snapshot;
}

function resolveWorkspace(
  file: TranscriptFile,
  explicit: { path: string; confidence: WorkspacePathConfidence } | undefined,
): { path: string; confidence: WorkspacePathConfidence } {
  return explicit ?? { path: file.workspacePath, confidence: file.workspacePathConfidence };
}
