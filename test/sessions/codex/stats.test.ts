import { expect, test } from "vitest";
import { buildCodexIndex } from "../../../lib/sessions/codex/index.ts";
import { getCodexIndexStats } from "../../../lib/sessions/codex/stats.ts";
import { makeSessionEnv, writeCodexRollout, writeCodexStateDb } from "../helpers.ts";

test("getCodexIndexStats aggregates cache rows", async () => {
  const env = makeSessionEnv();
  writeCodexRollout(env, "sessions/real.jsonl", "codex-real-user.jsonl");
  writeCodexRollout(env, "sessions/worker.jsonl", "codex-automation-worker.jsonl");
  writeCodexStateDb(env, [
    { id: "real", rolloutPath: "sessions/real.jsonl" },
    { id: "worker", rolloutPath: "sessions/worker.jsonl" },
  ]);

  await buildCodexIndex(env);
  const stats = getCodexIndexStats(env);

  expect(stats).toMatchObject({
    provider: "codex",
    schemaVersion: 1,
    transcriptsFound: 2,
    indexedSessions: 2,
    skipped: 0,
    skippedUnparseable: 0,
    withUserQuery: 2,
    automationSessions: 1,
    subagentSessions: 0,
    realUserSessions: 1,
    workspaces: 1,
  });
  expect(stats.lastReindexAt).toBe("2026-06-26T00:00:00.000Z");
  expect(stats.oldestSessionAt).not.toBeNull();
  expect(stats.newestSessionAt).not.toBeNull();
});
