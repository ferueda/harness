import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
