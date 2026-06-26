import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { readCachedSessions } from "../../../lib/sessions/core/cache.ts";
import { buildCursorIndex } from "../../../lib/sessions/cursor/index.ts";
import { makeSessionEnv, writeMeta, writeTranscript } from "../helpers.ts";

test("buildCursorIndex indexes synthetic Cursor tree and prefers explicit workspace path", async () => {
  const env = makeSessionEnv();
  writeTranscript(env, "Users-alice-dev-my-repo", "real-chat", "cursor-hyphenated-workspace.jsonl");
  writeMeta(env, "real-chat", { createdAtMs: 1_000, updatedAtMs: 2_000 });

  const snapshot = await buildCursorIndex(env);

  expect(snapshot.transcriptsFound).toBe(1);
  expect(snapshot.indexedSessions).toBe(1);
  expect(snapshot.skippedUnparseable).toBe(0);
  expect(snapshot.sessions[0]).toMatchObject({
    sessionId: "real-chat",
    workspaceKey: "Users-alice-dev-my-repo",
    workspacePath: "/Users/alice/dev/my-repo",
    workspacePathConfidence: "explicit",
    updatedAtMs: 2_000,
  });
  expect(readCachedSessions(env).map((session) => session.sessionId)).toEqual(["real-chat"]);
});

test("buildCursorIndex tracks unparseable transcripts without throwing", async () => {
  const env = makeSessionEnv();
  const transcriptDir = join(
    env.cursorHome,
    "projects/Users-alice-dev-project/agent-transcripts/bad-chat",
  );
  mkdirSync(transcriptDir, { recursive: true });
  writeFileSync(join(transcriptDir, "bad-chat.jsonl"), "{bad json}\n", "utf8");

  const snapshot = await buildCursorIndex(env);

  expect(snapshot.transcriptsFound).toBe(1);
  expect(snapshot.indexedSessions).toBe(0);
  expect(snapshot.skipped).toBe(1);
  expect(snapshot.skippedUnparseable).toBe(1);
});
