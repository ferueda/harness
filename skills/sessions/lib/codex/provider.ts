import { readCachedSessions } from "../core/cache.ts";
import { defaultSessionEnvironment, type SessionEnvironment } from "../core/env.ts";
import { applySessionFilters } from "../core/filters.ts";
import type { SessionProvider } from "../core/provider.ts";
import type {
  CodexSession,
  IndexSnapshot,
  ReindexOptions,
  SessionFilters,
  SessionRecord,
  Transcript,
  UserTurn,
  WorkspacePathSource,
} from "../core/types.ts";
import { buildCodexIndex } from "./index.ts";
import { cleanCodexUserMessage } from "./normalize.ts";
import { CodexRolloutParseError, parseCodexRolloutFile } from "./rollout.ts";

export function createCodexSessionProvider(
  overrides: Partial<SessionEnvironment> = {},
): SessionProvider {
  const env = defaultSessionEnvironment(overrides);
  return new CodexSessionProvider(env);
}

class CodexSessionProvider implements SessionProvider {
  readonly id = "codex" as const;
  private readonly env: SessionEnvironment;

  constructor(env: SessionEnvironment) {
    this.env = env;
  }

  async reindex(_options: ReindexOptions = {}): Promise<IndexSnapshot> {
    return buildCodexIndex(this.env);
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
          text: userTurnIndex === 0 ? evidenceFirstUserText(session, turn.text) : turn.text,
          rawText: turn.rawText,
          session,
        };
        userTurnIndex += 1;
      }
    }
  }

  private loadSessions(): SessionRecord[] {
    return readCachedSessions(this.env, "codex");
  }

  private readTranscript(session: SessionRecord): Transcript {
    if (session.provider !== "codex") throw new Error(`Unsupported provider: ${session.provider}`);
    const parsed = this.parseCodexTranscript(session);
    return { session, turns: parsed.turns };
  }

  private parseCodexTranscript(session: CodexSession): ReturnType<typeof parseCodexRolloutFile> {
    try {
      return parseCodexRolloutFile(session.rolloutPath);
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) {
        throw new Error(
          `Transcript missing for session ${session.sessionId}; run sessions codex reindex`,
        );
      }
      if (error instanceof CodexRolloutParseError) {
        throw new Error(
          `Transcript unreadable for session ${session.sessionId}; run sessions codex reindex`,
        );
      }
      throw error;
    }
  }
}

function effectiveWorkspacePathSource(session: SessionRecord): WorkspacePathSource {
  return (
    session.workspacePathSource ??
    (session.workspacePathConfidence === "explicit" ? "store-db" : "project-key")
  );
}

function evidenceFirstUserText(session: SessionRecord, text: string): string {
  return cleanCodexUserMessage(session.firstUserQuery) ?? cleanCodexUserMessage(text) ?? text;
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
