export type SessionProviderId = "cursor" | "codex";

export type WorkspacePathConfidence = "explicit" | "decoded";
export type WorkspacePathSource = "transcript" | "store-db" | "project-key";

export type SessionRole = "user" | "assistant" | "system" | "tool" | "unknown";

export type SessionBase = {
  schemaVersion: 1;
  provider: SessionProviderId;
  sessionId: string;
  workspaceKey: string;
  workspacePath: string;
  workspacePathConfidence: WorkspacePathConfidence;
  workspacePathSource?: WorkspacePathSource;
  title?: string;
  createdAtMs?: number;
  updatedAtMs?: number;
  isAutomation: boolean;
  isSubagent: boolean;
  firstUserQuery?: string;
  turnCount: number;
  userTurnCount: number;
};

export type CursorSession = SessionBase & {
  provider: "cursor";
  chatId: string;
  jsonlPath: string;
  metaJsonPath?: string;
  storeDbPath?: string;
  mode?: string;
};

export type CodexSession = SessionBase & {
  provider: "codex";
};

export type SessionRecord = CursorSession | CodexSession;

export type Turn = {
  role: SessionRole;
  text: string;
  rawText: string;
};

export type UserTurn = {
  sessionId: string;
  workspacePath: string;
  workspacePathConfidence: WorkspacePathConfidence;
  workspacePathSource?: WorkspacePathSource;
  text: string;
  rawText: string;
  session: SessionRecord;
};

export type Transcript = {
  session: SessionRecord;
  turns: Turn[];
};

export type SessionFilters = {
  limit?: number;
  days?: number;
  workspacePathPrefix?: string;
  workspaceKey?: string;
  query?: string;
  excludeAutomation?: boolean;
  excludeSubagent?: boolean;
};

export type ReindexOptions = {
  force?: boolean;
};

export type IndexSnapshot = {
  provider: SessionProviderId;
  schemaVersion: 1;
  lastReindexAt: string;
  transcriptsFound: number;
  indexedSessions: number;
  skipped: number;
  skippedUnparseable: number;
  sessions: SessionRecord[];
};

export type ExportFormat = "json" | "jsonl" | "md";
