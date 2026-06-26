import { rmSync, writeFileSync } from "node:fs";
import { expect, test } from "vitest";
import { createCodexSessionProvider } from "../../../lib/sessions/codex/provider.ts";
import { buildCodexIndex } from "../../../lib/sessions/codex/index.ts";
import { makeSessionEnv, writeCodexRollout, writeCodexStateDb } from "../helpers.ts";

test("CodexSessionProvider lists, reads transcripts, and iterates user turns", async () => {
  const env = makeSessionEnv();
  writeCodexRollout(env, "sessions/real.jsonl", "codex-real-user.jsonl");
  writeCodexRollout(env, "sessions/child.jsonl", "codex-subagent.jsonl");
  writeCodexStateDb(env, [
    { id: "real", rolloutPath: "sessions/real.jsonl", title: "Real", updatedAt: 20 },
    {
      id: "child",
      rolloutPath: "sessions/child.jsonl",
      title: "Child",
      parentThreadId: "real",
      updatedAt: 10,
    },
  ]);
  await buildCodexIndex(env);
  const provider = createCodexSessionProvider(env);

  expect(provider.list().map((session) => session.sessionId)).toEqual(["real"]);
  expect(provider.list({ excludeSubagent: false }).map((session) => session.sessionId)).toEqual([
    "real",
    "child",
  ]);
  expect(provider.getTranscript("real").turns.map((turn) => turn.role)).toEqual([
    "user",
    "assistant",
    "user",
  ]);

  const turns = [];
  for await (const turn of provider.iterUserTurns()) turns.push(turn);
  expect(turns).toHaveLength(2);
  expect(turns[0]).toMatchObject({ sessionId: "real", turnIndex: 0, isFirstUserTurn: true });
  expect(turns[1]).toMatchObject({ sessionId: "real", turnIndex: 2, isFirstUserTurn: false });
});

test("CodexSessionProvider reports missing rollout guidance", async () => {
  const env = makeSessionEnv();
  writeCodexRollout(env, "sessions/real.jsonl", "codex-real-user.jsonl");
  writeCodexStateDb(env, [{ id: "real", rolloutPath: "sessions/real.jsonl" }]);
  await buildCodexIndex(env);
  const provider = createCodexSessionProvider(env);
  rmSync(`${env.codexHome}/sessions/real.jsonl`);

  expect(() => provider.getTranscript("real")).toThrow(
    /Transcript missing for session real; run sessions codex reindex/,
  );
});

test("CodexSessionProvider normalizes injected first user context for evidence only", async () => {
  const env = makeSessionEnv();
  writeCodexRollout(env, "sessions/real.jsonl", "codex-preamble-user.jsonl");
  writeCodexStateDb(env, [
    {
      id: "real",
      rolloutPath: "sessions/real.jsonl",
      firstUserMessage: "Clean ask from database.",
    },
  ]);
  await buildCodexIndex(env);
  const provider = createCodexSessionProvider(env);

  const transcript = provider.getTranscript("real");
  expect(transcript.turns[0]?.text).toContain("# AGENTS.md instructions");

  const turns = [];
  for await (const turn of provider.iterUserTurns()) turns.push(turn);
  expect(turns[0]).toMatchObject({
    text: "Clean ask from database.",
    rawText: expect.stringContaining("# AGENTS.md instructions"),
  });
  expect(turns[1]).toMatchObject({
    text: "Now verify the cleaned evidence path.",
    rawText: "Now verify the cleaned evidence path.",
  });
});

test("CodexSessionProvider normalizes instructions-only first user context for evidence", async () => {
  const env = makeSessionEnv();
  writeCodexRollout(env, "sessions/real.jsonl", "codex-instructions-user.jsonl");
  writeCodexStateDb(env, [{ id: "real", rolloutPath: "sessions/real.jsonl" }]);
  await buildCodexIndex(env);
  const provider = createCodexSessionProvider(env);

  expect(provider.getTranscript("real").turns[0]?.text).toContain("<INSTRUCTIONS>");

  const turns = [];
  for await (const turn of provider.iterUserTurns()) turns.push(turn);
  expect(turns[0]).toMatchObject({
    text: "Please verify the instructions-only cleanup.",
    rawText: expect.stringContaining("<INSTRUCTIONS>"),
  });
});

test("CodexSessionProvider reports unreadable rollout guidance", async () => {
  const env = makeSessionEnv();
  const path = writeCodexRollout(env, "sessions/real.jsonl", "codex-real-user.jsonl");
  writeCodexStateDb(env, [{ id: "real", rolloutPath: "sessions/real.jsonl" }]);
  await buildCodexIndex(env);
  writeFileSync(path, "{bad\n", "utf8");
  const provider = createCodexSessionProvider(env);

  expect(() => provider.getTranscript("real")).toThrow(
    /Transcript unreadable for session real; run sessions codex reindex/,
  );
});
