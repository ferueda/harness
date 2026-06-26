import { expect, test } from "vitest";
import { writeCursorCache } from "../../../lib/sessions/core/cache.ts";
import { createCursorSessionProvider } from "../../../lib/sessions/cursor/provider.ts";
import { buildCursorIndex } from "../../../lib/sessions/cursor/index.ts";
import { makeSessionEnv, session, writeTranscript } from "../helpers.ts";

test("getTranscript reports stale cache entries with reindex guidance", () => {
  const env = makeSessionEnv();
  writeCursorCache(env, {
    provider: "cursor",
    schemaVersion: 1,
    lastReindexAt: "2026-06-26T00:00:00.000Z",
    transcriptsFound: 1,
    indexedSessions: 1,
    skipped: 0,
    skippedUnparseable: 0,
    sessions: [session({ sessionId: "stale", jsonlPath: "/no/such/transcript.jsonl" })],
  });

  expect(() => createCursorSessionProvider(env).getTranscript("stale")).toThrow(
    /Transcript missing for session stale; run sessions cursor reindex/,
  );
});

test("iterUserTurns yields user turns from filtered real sessions", async () => {
  const env = makeSessionEnv();
  writeTranscript(env, "Users-alice-dev-project", "real-chat", "cursor-real-user.jsonl");
  writeTranscript(env, "Users-alice-dev-project", "agent-worker", "cursor-automation-worker.jsonl");
  await buildCursorIndex(env);

  const turns = [];
  for await (const turn of createCursorSessionProvider(env).iterUserTurns()) {
    turns.push(turn);
  }

  expect(turns).toHaveLength(1);
  expect(turns[0]).toMatchObject({
    sessionId: "real-chat",
    workspacePath: "/Users/alice/dev/my-repo",
    workspacePathConfidence: "explicit",
    text: "Please prefer concise status updates in this repo.",
    session: {
      isAutomation: false,
      isSubagent: false,
    },
  });
  expect(turns[0]?.rawText).toContain("<user_query>");
});

test("list can include automation workers that are also subagents", async () => {
  const env = makeSessionEnv();
  writeTranscript(env, "Users-alice-dev-project", "agent-worker", "cursor-automation-worker.jsonl");
  await buildCursorIndex(env);

  const sessions = createCursorSessionProvider(env).list({
    excludeAutomation: false,
    excludeSubagent: false,
  });

  expect(sessions.map((item) => item.sessionId)).toEqual(["agent-worker"]);
  expect(sessions[0]).toMatchObject({ isAutomation: true, isSubagent: true });
});
