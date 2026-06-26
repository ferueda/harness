import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { readCachedSessions } from "../../../lib/sessions/core/cache.ts";
import { buildCursorIndex } from "../../../lib/sessions/cursor/index.ts";
import { makeSessionEnv, writeMeta, writeStoreDb, writeTranscript } from "../helpers.ts";

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
    workspacePathSource: "transcript",
    updatedAtMs: 2_000,
  });
  expect(readCachedSessions(env).map((session) => session.sessionId)).toEqual(["real-chat"]);
});

test("buildCursorIndex records project-key source for decoded workspace paths", async () => {
  const env = makeSessionEnv();
  writeTranscript(env, "Users-alice-dev-project", "agent-worker", "cursor-automation-worker.jsonl");

  const snapshot = await buildCursorIndex(env);

  expect(snapshot.sessions[0]).toMatchObject({
    workspacePath: "/Users/alice/dev/project",
    workspacePathConfidence: "decoded",
    workspacePathSource: "project-key",
  });
});

test("buildCursorIndex prefers store-db workspace path over project-key decode", async () => {
  const env = makeSessionEnv();
  writeTranscript(env, "Users-alice-dev-my-repo", "agent-worker", "cursor-automation-worker.jsonl");
  writeStoreDb(env, "agent-worker", { workspacePath: "/Users/alice/dev/my-repo" });

  const snapshot = await buildCursorIndex(env);

  expect(snapshot.sessions[0]).toMatchObject({
    workspacePath: "/Users/alice/dev/my-repo",
    workspacePathConfidence: "explicit",
    workspacePathSource: "store-db",
  });
});

test("buildCursorIndex prefers transcript workspace path over store-db path", async () => {
  const env = makeSessionEnv();
  writeTranscript(env, "Users-alice-dev-my-repo", "real-chat", "cursor-hyphenated-workspace.jsonl");
  writeStoreDb(env, "real-chat", { workspacePath: "/Users/alice/dev/other-repo" });

  const snapshot = await buildCursorIndex(env);

  expect(snapshot.sessions[0]).toMatchObject({
    workspacePath: "/Users/alice/dev/my-repo",
    workspacePathConfidence: "explicit",
    workspacePathSource: "transcript",
  });
});

test("buildCursorIndex keeps store-db workspace path when store meta JSON is invalid", async () => {
  const env = makeSessionEnv();
  writeTranscript(env, "Users-alice-dev-my-repo", "agent-worker", "cursor-automation-worker.jsonl");
  writeStoreDb(env, "agent-worker", {
    invalidMeta: true,
    workspacePath: "/Users/alice/dev/my-repo",
  });

  const snapshot = await buildCursorIndex(env);

  expect(snapshot.sessions[0]).toMatchObject({
    title: undefined,
    workspacePath: "/Users/alice/dev/my-repo",
    workspacePathConfidence: "explicit",
    workspacePathSource: "store-db",
  });
});

test("buildCursorIndex uses newest matching store-db workspace path", async () => {
  const env = makeSessionEnv();
  writeTranscript(env, "Users-alice-dev-my-repo", "agent-worker", "cursor-automation-worker.jsonl");
  writeStoreDb(env, "agent-worker", {
    workspacePaths: ["/Users/alice/dev/old-repo", "/Users/alice/dev/new-repo"],
  });

  const snapshot = await buildCursorIndex(env);

  expect(snapshot.sessions[0]).toMatchObject({
    workspacePath: "/Users/alice/dev/new-repo",
    workspacePathConfidence: "explicit",
    workspacePathSource: "store-db",
  });
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
