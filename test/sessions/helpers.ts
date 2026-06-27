import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importNodeSqlite } from "../../lib/node-warnings.ts";
import type { SessionEnvironment } from "../../lib/sessions/core/env.ts";
import type { CodexSession, CursorSession, Transcript } from "../../lib/sessions/core/types.ts";

const FIXTURES = join(process.cwd(), "test/fixtures/sessions");
const { DatabaseSync } = await importNodeSqlite();

export function makeSessionEnv(): SessionEnvironment {
  const root = mkdtempSync(join(tmpdir(), "harness-sessions-"));
  return {
    cursorHome: join(root, ".cursor"),
    codexHome: join(root, ".codex"),
    cacheRoot: join(root, ".harness/session-index"),
    homeDir: root,
    harnessRoot: process.cwd(),
    now: () => new Date("2026-06-26T00:00:00.000Z"),
  };
}

export type CodexThreadFixture = {
  id: string;
  rolloutPath: string;
  cwd?: string;
  title?: string;
  source?: string;
  threadSource?: string;
  firstUserMessage?: string;
  agentRole?: string;
  agentNickname?: string;
  createdAt?: number;
  updatedAt?: number;
  parentThreadId?: string;
};

export function writeCodexStateDb(
  env: SessionEnvironment,
  threads: CodexThreadFixture[],
  options: { fallbackOnly?: boolean } = {},
): string {
  const dbPath = options.fallbackOnly
    ? join(env.codexHome, "sqlite", "state_5.sqlite")
    : join(env.codexHome, "state_5.sqlite");
  mkdirSync(join(dbPath, ".."), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      create table threads (
        id text primary key,
        rollout_path text not null,
        created_at integer not null,
        updated_at integer not null,
        created_at_ms integer,
        updated_at_ms integer,
        cwd text not null,
        title text not null,
        source text not null,
        thread_source text,
        first_user_message text,
        agent_role text,
        agent_nickname text,
        archived integer not null default 0
      );
      create table thread_spawn_edges (
        parent_thread_id text not null,
        child_thread_id text not null primary key,
        status text not null
      );
    `);
    const insertThread = db.prepare(`
      insert into threads (
        id, rollout_path, created_at, updated_at, created_at_ms, updated_at_ms, cwd, title, source,
        thread_source, first_user_message, agent_role, agent_nickname, archived
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `);
    const insertEdge = db.prepare(
      "insert into thread_spawn_edges (parent_thread_id, child_thread_id, status) values (?, ?, ?)",
    );
    for (const thread of threads) {
      const createdAt = thread.createdAt ?? 1_782_432_000;
      const updatedAt = thread.updatedAt ?? createdAt;
      insertThread.run(
        thread.id,
        thread.rolloutPath,
        createdAt,
        updatedAt,
        createdAt * 1000,
        updatedAt * 1000,
        thread.cwd ?? "/Users/example/dev/repo",
        thread.title ?? thread.id,
        thread.source ?? "cli",
        thread.threadSource ?? "",
        thread.firstUserMessage ?? "",
        thread.agentRole ?? "",
        thread.agentNickname ?? "",
      );
      if (thread.parentThreadId) insertEdge.run(thread.parentThreadId, thread.id, "completed");
    }
  } finally {
    db.close();
  }
  return dbPath;
}

export function writeCodexRollout(
  env: SessionEnvironment,
  rolloutPath: string,
  fixtureName: string,
): string {
  const path = rolloutPath.startsWith("/") ? rolloutPath : join(env.codexHome, rolloutPath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, readFileSync(join(FIXTURES, fixtureName), "utf8"), "utf8");
  return path;
}

export function writeTranscript(
  env: SessionEnvironment,
  workspaceKey: string,
  chatId: string,
  fixtureName: string,
): void {
  const transcriptDir = join(env.cursorHome, "projects", workspaceKey, "agent-transcripts", chatId);
  mkdirSync(transcriptDir, { recursive: true });
  writeFileSync(
    join(transcriptDir, `${chatId}.jsonl`),
    readFileSync(join(FIXTURES, fixtureName), "utf8"),
    "utf8",
  );
}

export function writeMeta(
  env: SessionEnvironment,
  chatId: string,
  meta: { createdAtMs: number; updatedAtMs: number },
): void {
  const chatDir = join(env.cursorHome, "chats/hash", chatId);
  mkdirSync(chatDir, { recursive: true });
  writeFileSync(join(chatDir, "meta.json"), JSON.stringify({ schemaVersion: 1, ...meta }), "utf8");
}

export function writeStoreDb(
  env: SessionEnvironment,
  chatId: string,
  options: {
    workspacePath?: string;
    workspacePaths?: string[];
    title?: string;
    invalidMeta?: boolean;
  } = {},
): void {
  const chatDir = join(env.cursorHome, "chats/hash", chatId);
  mkdirSync(chatDir, { recursive: true });
  const db = new DatabaseSync(join(chatDir, "store.db"));
  try {
    db.exec("create table meta (key text primary key, value text)");
    db.exec("create table blobs (id text primary key, data blob)");
    const meta = {
      name: options.title ?? "Stored title",
      mode: "agent",
      createdAt: 123,
    };
    const metaValue = options.invalidMeta
      ? Buffer.from("{bad", "utf8").toString("hex")
      : Buffer.from(JSON.stringify(meta), "utf8").toString("hex");
    db.prepare("insert into meta (key, value) values (?, ?)").run("0", metaValue);
    for (const [index, workspacePath] of [
      ...(options.workspacePaths ?? []),
      ...(options.workspacePath ? [options.workspacePath] : []),
    ].entries()) {
      const blob = {
        role: "user",
        content: `<user_info>\nWorkspace Path: ${workspacePath}\n</user_info>`,
      };
      db.prepare("insert into blobs (id, data) values (?, ?)").run(
        `workspace-${index}`,
        Buffer.from(JSON.stringify(blob), "utf8"),
      );
    }
  } finally {
    db.close();
  }
}

export function session(overrides: Partial<CursorSession> = {}): CursorSession {
  const sessionId = overrides.sessionId ?? "session";
  return {
    schemaVersion: 1,
    provider: "cursor",
    sessionId,
    chatId: overrides.chatId ?? sessionId,
    jsonlPath: overrides.jsonlPath ?? `/tmp/${sessionId}.jsonl`,
    workspaceKey: "Users-example-dev-repo",
    workspacePath: "/Users/example/dev/repo",
    workspacePathConfidence: "explicit",
    workspacePathSource: "transcript",
    updatedAtMs: 1,
    isAutomation: false,
    isSubagent: false,
    turnCount: 1,
    userTurnCount: 1,
    ...overrides,
  };
}

export function codexSession(overrides: Partial<CodexSession> = {}): CodexSession {
  const sessionId = overrides.sessionId ?? "codex-session";
  return {
    schemaVersion: 1,
    provider: "codex",
    sessionId,
    threadId: overrides.threadId ?? sessionId,
    rolloutPath: overrides.rolloutPath ?? `/tmp/${sessionId}.jsonl`,
    workspaceKey: "Users-example-dev-repo",
    workspacePath: "/Users/example/dev/repo",
    workspacePathConfidence: "explicit",
    workspacePathSource: "store-db",
    updatedAtMs: 1,
    isAutomation: false,
    isSubagent: false,
    turnCount: 1,
    userTurnCount: 1,
    ...overrides,
  };
}

export function transcript(overrides: Partial<CursorSession> = {}): Transcript {
  return {
    session: session(overrides),
    turns: [
      { role: "user", text: "Please keep this concise.", rawText: "Please keep this concise." },
      { role: "assistant", text: "Done.", rawText: "Done." },
    ],
  };
}
