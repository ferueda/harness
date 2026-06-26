import type {
  IndexSnapshot,
  ReindexOptions,
  SessionFilters,
  SessionProviderId,
  SessionRecord,
  Transcript,
  UserTurn,
} from "./types.ts";

export interface SessionProvider {
  readonly id: SessionProviderId;
  reindex(options?: ReindexOptions): Promise<IndexSnapshot>;
  list(filters?: SessionFilters): SessionRecord[];
  get(sessionId: string): SessionRecord | undefined;
  getTranscript(sessionId: string): Transcript;
  iterUserTurns(filters?: SessionFilters): AsyncIterable<UserTurn>;
}
