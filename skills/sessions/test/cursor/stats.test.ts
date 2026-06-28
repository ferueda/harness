import { expect, test } from "vitest";
import { buildCursorIndex } from "../../lib/cursor/index.ts";
import { getCursorIndexStats } from "../../lib/cursor/stats.ts";
import { makeSessionEnv, writeTranscript } from "../helpers.ts";

test("getCursorIndexStats aggregates cache rows", async () => {
  const env = makeSessionEnv();
  writeTranscript(env, "Users-alice-dev-project", "real-chat", "cursor-real-user.jsonl");
  writeTranscript(env, "Users-alice-dev-project", "agent-worker", "cursor-automation-worker.jsonl");

  await buildCursorIndex(env);
  const stats = getCursorIndexStats(env);

  expect(stats).toMatchObject({
    provider: "cursor",
    schemaVersion: 1,
    transcriptsFound: 2,
    indexedSessions: 2,
    skipped: 0,
    skippedUnparseable: 0,
    withUserQuery: 2,
    automationSessions: 1,
    subagentSessions: 1,
    realUserSessions: 1,
    workspaces: 1,
  });
  expect(stats.lastReindexAt).toBe("2026-06-26T00:00:00.000Z");
  expect(stats.oldestSessionAt).not.toBeNull();
  expect(stats.newestSessionAt).not.toBeNull();
});
