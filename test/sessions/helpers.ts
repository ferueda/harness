import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SessionEnvironment } from "../../lib/sessions/core/env.ts";
import type { CursorSession, Transcript } from "../../lib/sessions/core/types.ts";

const FIXTURES = join(process.cwd(), "test/fixtures/sessions");

export function makeSessionEnv(): SessionEnvironment {
  const root = mkdtempSync(join(tmpdir(), "harness-sessions-"));
  return {
    cursorHome: join(root, ".cursor"),
    cacheRoot: join(root, ".harness/session-index"),
    homeDir: root,
    harnessRoot: process.cwd(),
    now: () => new Date("2026-06-26T00:00:00.000Z"),
  };
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

export function transcript(overrides: Partial<CursorSession> = {}): Transcript {
  return {
    session: session(overrides),
    turns: [
      { role: "user", text: "Please keep this concise.", rawText: "Please keep this concise." },
      { role: "assistant", text: "Done.", rawText: "Done." },
    ],
  };
}
