import { statSync } from "node:fs";
import type { SessionEnvironment } from "../core/env.ts";
import { hasText } from "../core/analyze.ts";
import { writeCursorCache } from "../core/cache.ts";
import type { CursorSession, IndexSnapshot, SessionTitleSource } from "../core/types.ts";
import { isAutomationSession, isSubagentSession } from "./classify.ts";
import { buildCursorMetaIndex, readCursorSessionMeta } from "./meta.ts";
import { globTranscriptFiles, type TranscriptFile, type WorkspacePathResult } from "./paths.ts";
import {
  CursorTranscriptParseError,
  parseTranscriptFile,
  stripInjectedBlocks,
} from "./transcript.ts";

type DisplayTitle = {
  title?: string;
  titleSource?: SessionTitleSource;
};

const DISPLAY_TITLE_MAX_LENGTH = 80;

export async function buildCursorIndex(env: SessionEnvironment): Promise<IndexSnapshot> {
  const files = globTranscriptFiles(env);
  const metaIndex = buildCursorMetaIndex(env);
  const sessions: CursorSession[] = [];
  let skippedUnparseable = 0;

  for (const file of files) {
    try {
      const parsed = parseTranscriptFile(file.jsonlPath);
      const meta = await readCursorSessionMeta(metaIndex.get(file.chatId));
      const workspace = resolveWorkspace(file, parsed.workspacePath, meta.workspacePath);
      const firstUserQuery = parsed.firstUserQuery;
      const displayTitle = deriveDisplayTitle(meta.title, firstUserQuery);
      const updatedAtMs = meta.updatedAtMs ?? statSync(file.jsonlPath).mtimeMs;
      sessions.push({
        schemaVersion: 1,
        provider: "cursor",
        sessionId: file.chatId,
        chatId: file.chatId,
        workspaceKey: file.workspaceKey,
        workspacePath: workspace.path,
        workspacePathConfidence: workspace.confidence,
        workspacePathSource: workspace.source,
        title: displayTitle.title,
        titleSource: displayTitle.titleSource,
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

function deriveDisplayTitle(
  storeTitle: string | undefined,
  firstUserQuery: string | undefined,
): DisplayTitle {
  if (hasText(storeTitle)) return { title: storeTitle, titleSource: "store-db" };

  const title = firstQueryDisplayTitle(firstUserQuery);
  return hasText(title) ? { title, titleSource: "first-query" } : {};
}

function firstQueryDisplayTitle(value: string | undefined): string | undefined {
  if (!hasText(value)) return undefined;
  const normalized = stripInjectedBlocks(value).replace(/\s+/g, " ").trim();
  if (!hasText(normalized)) return undefined;
  return normalized.length <= DISPLAY_TITLE_MAX_LENGTH
    ? normalized
    : `${normalized.slice(0, DISPLAY_TITLE_MAX_LENGTH - 3)}...`;
}

function resolveWorkspace(
  file: TranscriptFile,
  explicit: WorkspacePathResult | undefined,
  storeDb: WorkspacePathResult | undefined,
): WorkspacePathResult {
  return (
    explicit ??
    storeDb ?? {
      path: file.workspacePath,
      confidence: file.workspacePathConfidence,
      source: file.workspacePathSource,
    }
  );
}
