import { readCachedSessions } from "../core/cache.ts";
import { defaultSessionEnvironment, type SessionEnvironment } from "../core/env.ts";
import { applySessionFilters } from "../core/filters.ts";
import type { SessionProvider } from "../core/provider.ts";
import type {
  CursorSession,
  IndexSnapshot,
  ReindexOptions,
  SessionFilters,
  SessionRecord,
  Transcript,
  UserTurn,
  WorkspacePathSource,
} from "../core/types.ts";
import { buildCursorIndex } from "./index.ts";
import { CursorTranscriptParseError, parseTranscriptFile } from "./transcript.ts";

export function createCursorSessionProvider(
  overrides: Partial<SessionEnvironment> = {},
): SessionProvider {
  const env = defaultSessionEnvironment(overrides);
  return new CursorSessionProvider(env);
}

class CursorSessionProvider implements SessionProvider {
  readonly id = "cursor" as const;
  private readonly env: SessionEnvironment;

  constructor(env: SessionEnvironment) {
    this.env = env;
  }

  async reindex(_options: ReindexOptions = {}): Promise<IndexSnapshot> {
    return buildCursorIndex(this.env);
  }

  list(filters: SessionFilters = {}): SessionRecord[] {
    return applySessionFilters(this.loadSessions(), filters, this.env.now());
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.loadSessions().find((session) => session.sessionId === sessionId);
  }

  getTranscript(sessionId: string): Transcript {
    const session = this.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return this.readTranscript(session);
  }

  async *iterUserTurns(filters: SessionFilters = {}): AsyncIterable<UserTurn> {
    for (const session of this.list(filters)) {
      const transcript = this.readTranscript(session);
      let userTurnIndex = 0;
      for (const [turnIndex, turn] of transcript.turns.entries()) {
        if (turn.role !== "user") continue;
        yield {
          sessionId: session.sessionId,
          workspacePath: session.workspacePath,
          workspacePathConfidence: session.workspacePathConfidence,
          workspacePathSource: effectiveWorkspacePathSource(session),
          turnIndex,
          isFirstUserTurn: userTurnIndex === 0,
          text: turn.text,
          rawText: turn.rawText,
          session,
        };
        userTurnIndex += 1;
      }
    }
  }

  private loadSessions(): SessionRecord[] {
    return readCachedSessions(this.env);
  }

  private readTranscript(session: SessionRecord): Transcript {
    if (session.provider !== "cursor") throw new Error(`Unsupported provider: ${session.provider}`);
    const parsed = this.parseCursorTranscript(session);
    return { session, turns: parsed.turns };
  }

  private parseCursorTranscript(session: CursorSession): ReturnType<typeof parseTranscriptFile> {
    try {
      return parseTranscriptFile(session.jsonlPath);
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) {
        throw new Error(
          `Transcript missing for session ${session.sessionId}; run sessions cursor reindex`,
        );
      }
      if (error instanceof CursorTranscriptParseError) {
        throw new Error(
          `Transcript unreadable for session ${session.sessionId}; run sessions cursor reindex`,
        );
      }
      throw error;
    }
  }
}

function effectiveWorkspacePathSource(session: SessionRecord): WorkspacePathSource {
  return (
    session.workspacePathSource ??
    (session.workspacePathConfidence === "explicit" ? "transcript" : "project-key")
  );
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
