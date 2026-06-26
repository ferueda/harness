import { expect, test } from "vitest";
import { readCachedSessions } from "../../../lib/sessions/core/cache.ts";
import { buildCodexIndex } from "../../../lib/sessions/codex/index.ts";
import { makeSessionEnv, writeCodexRollout, writeCodexStateDb } from "../helpers.ts";

test("buildCodexIndex indexes threads from state db and rollout files", async () => {
  const env = makeSessionEnv();
  writeCodexRollout(env, "sessions/real.jsonl", "codex-real-user.jsonl");
  writeCodexRollout(env, "archived_sessions/subagent.jsonl", "codex-subagent.jsonl");
  writeCodexStateDb(env, [
    {
      id: "real",
      rolloutPath: "sessions/real.jsonl",
      cwd: "/Users/example/dev/my repo",
      title: "Real thread",
      updatedAt: 20,
    },
    {
      id: "child",
      rolloutPath: "archived_sessions/subagent.jsonl",
      title: "Child thread",
      parentThreadId: "parent",
      updatedAt: 10,
    },
    {
      id: "missing",
      rolloutPath: "sessions/missing.jsonl",
      title: "Missing thread",
      updatedAt: 30,
    },
  ]);

  const snapshot = await buildCodexIndex(env);

  expect(snapshot).toMatchObject({
    provider: "codex",
    transcriptsFound: 3,
    indexedSessions: 2,
    skipped: 1,
    skippedUnparseable: 1,
  });
  expect(snapshot.sessions.map((session) => session.sessionId)).toEqual(["real", "child"]);
  expect(snapshot.sessions[0]).toMatchObject({
    provider: "codex",
    workspaceKey: "Users-example-dev-my-repo",
    workspacePathConfidence: "explicit",
    workspacePathSource: "store-db",
    firstUserQuery: "Please verify the Codex provider works.",
    turnCount: 3,
    userTurnCount: 2,
  });
  expect(snapshot.sessions[1]?.isSubagent).toBe(true);
  expect(readCachedSessions(env, "codex")).toHaveLength(2);
});

test("buildCodexIndex marks empty cwd fallback as decoded", async () => {
  const env = makeSessionEnv();
  writeCodexRollout(env, "sessions/real.jsonl", "codex-real-user.jsonl");
  writeCodexStateDb(env, [{ id: "real", rolloutPath: "sessions/real.jsonl", cwd: "" }]);

  const snapshot = await buildCodexIndex(env);

  expect(snapshot.sessions[0]).toMatchObject({
    workspacePath: env.homeDir,
    workspacePathConfidence: "decoded",
  });
});

test("buildCodexIndex reports a friendly missing database error", async () => {
  const env = makeSessionEnv();

  await expect(buildCodexIndex(env)).rejects.toThrow(/Codex state database not found/);
});
