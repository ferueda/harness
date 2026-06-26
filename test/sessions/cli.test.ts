import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "vitest";
import { writeCursorCache } from "../../lib/sessions/core/cache.ts";
import { buildCursorIndex } from "../../lib/sessions/cursor/index.ts";
import { makeSessionEnv, session, writeMeta, writeTranscript } from "./helpers.ts";

const SESSIONS_BIN = join(process.cwd(), "bin/sessions.ts");

test("sessions analyze emits JSON for Cursor cache", () => {
  const env = makeSessionEnv();
  writeCursorCache(env, {
    provider: "cursor",
    schemaVersion: 1,
    lastReindexAt: "2026-06-26T00:00:00.000Z",
    transcriptsFound: 2,
    indexedSessions: 2,
    skipped: 0,
    skippedUnparseable: 0,
    sessions: [
      session({
        sessionId: "preference",
        firstUserQuery: "Please prefer concise updates.",
      }),
      session({
        sessionId: "worker",
        firstUserQuery: "You are running as an automated worker.",
        isAutomation: true,
        isSubagent: true,
      }),
    ],
  });

  const result = runSessions(["analyze", "--provider", "cursor", "--format", "json"], env.homeDir);

  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output).toMatchObject({
    provider: "cursor",
    totalSessions: 2,
    workspacePathSource: {
      transcript: 2,
      "store-db": 0,
      "project-key": 0,
    },
    candidatePreferenceMarkers: [{ phrase: "prefer", count: 1 }],
    classBreakdown: {
      all: {
        totalSessions: 2,
        candidatePreferenceMarkers: [{ phrase: "prefer", count: 1 }],
        candidateNoiseMarkers: [{ phrase: "automated worker", count: 1 }],
      },
      realUser: {
        totalSessions: 1,
        candidatePreferenceMarkers: [{ phrase: "prefer", count: 1 }],
      },
      automation: {
        totalSessions: 1,
        candidateNoiseMarkers: [{ phrase: "automated worker", count: 1 }],
      },
      subagent: {
        totalSessions: 1,
        candidateNoiseMarkers: [{ phrase: "automated worker", count: 1 }],
      },
    },
  });
  expect(output.cursor).toMatchObject({
    suspiciousAutomation: { total: 0, samples: [] },
    decodedWorkspacePaths: { total: 0, samples: [] },
    preferenceMarkers: {
      total: 1,
      samples: [
        {
          sessionId: "preference",
          reason: "query contains marker: prefer",
        },
      ],
    },
  });
  expect(output.cursor.missingTitles).toMatchObject({ total: 2 });
  expect(output.cursor.missingTitles.samples).toHaveLength(2);
  expect(output.indexImprovementCandidates).toContainEqual(
    expect.objectContaining({
      id: "missing-title-metadata",
      severity: "medium",
      count: 2,
    }),
  );
  expect(output.candidateNoiseMarkers).toContainEqual({
    phrase: "automated worker",
    count: 1,
  });
});

test("sessions analyze table output uses neutral metadata labels", () => {
  const env = makeSessionEnv();
  writeCursorCache(env, {
    provider: "cursor",
    schemaVersion: 1,
    lastReindexAt: "2026-06-26T00:00:00.000Z",
    transcriptsFound: 1,
    indexedSessions: 1,
    skipped: 0,
    skippedUnparseable: 0,
    sessions: [
      session({ sessionId: "preference", firstUserQuery: "Always prefer concise output." }),
    ],
  });

  const result = runSessions(["analyze", "--provider", "cursor"], env.homeDir);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Lexical marker counts (metadata only)");
  expect(result.stdout).not.toContain("Self-improve marker candidates");
  expect(result.stdout).toContain("Preference-like markers");
  expect(result.stdout).toContain("Class-scoped lexical marker counts");
  expect(result.stdout).toContain("Non-automation sessions (1 session)");
  expect(result.stdout).toContain("Automation sessions (0 sessions)");
  expect(result.stdout).toContain("Subagent sessions (0 sessions)");
  expect(result.stdout).toContain("path sources:     1 transcript / 0 store-db / 0 project-key");
  expect(result.stdout).toContain("Preference marker samples (1 total)");
  expect(result.stdout).toContain("Index quality signals");
  expect(result.stdout).not.toContain("Transcript evidence patterns");
});

test("sessions analyze stays cache-only without include-turns", () => {
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

  const result = runSessions(["analyze", "--provider", "cursor", "--format", "json"], env.homeDir);

  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.evidence).toBeUndefined();
});

test("sessions analyze include-turns emits JSON evidence from transcripts", async () => {
  const env = makeSessionEnv();
  writeTranscript(env, "Users-alice-dev-my-repo", "real-one", "cursor-real-user.jsonl");
  writeTranscript(env, "Users-alice-dev-my-repo", "real-two", "cursor-real-user.jsonl");
  await buildCursorIndex(env);

  const result = runSessions(
    ["analyze", "--provider", "cursor", "--include-turns", "--format", "json"],
    env.homeDir,
  );

  expect(result.status).toBe(0);
  expect(result.stderr).toContain("warning: --include-turns without --days");
  const output = JSON.parse(result.stdout);
  expect(output.evidence).toMatchObject({
    schemaVersion: 1,
    provider: "cursor",
    scannedSessions: 2,
    scannedUserTurns: 2,
    patterns: [
      {
        bucket: "preference",
        support: 2,
      },
    ],
  });
  expect(output.evidence.patterns[0].examples).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        sessionId: "real-one",
        turnIndex: 0,
        isFirstUserTurn: true,
      }),
    ]),
  );
});

test("sessions analyze include-turns suppresses scan warning when narrowed", async () => {
  const env = makeSessionEnv();
  writeTranscript(env, "Users-alice-dev-my-repo", "real-one", "cursor-real-user.jsonl");
  await buildCursorIndex(env);

  const result = runSessions(
    [
      "analyze",
      "--provider",
      "cursor",
      "--include-turns",
      "--format",
      "json",
      "--days",
      "30",
      "--min-support",
      "1",
    ],
    env.homeDir,
  );

  expect(result.status).toBe(0);
  expect(result.stderr).not.toContain("warning: --include-turns without --days");
});

test("sessions analyze include-turns hides one-off patterns by default", async () => {
  const env = makeSessionEnv();
  writeTranscript(env, "Users-alice-dev-my-repo", "real-one", "cursor-real-user.jsonl");
  writeTranscript(env, "Users-alice-dev-my-repo", "real-two", "cursor-real-user.jsonl");
  writeTranscript(env, "Users-alice-dev-my-repo", "debug-one", "cursor-debug-user.jsonl");
  await buildCursorIndex(env);

  const output = runEvidenceJson(
    ["analyze", "--provider", "cursor", "--include-turns", "--format", "json"],
    env.homeDir,
  );

  expect(output.evidence.patterns).toHaveLength(1);
  expect(output.evidence.patterns[0]).toMatchObject({
    bucket: "preference",
    support: 2,
  });
  expect(
    output.evidence.patterns.map((pattern: { bucket: string }) => pattern.bucket),
  ).not.toContain("debugging");
});

test("sessions analyze include-turns table output includes evidence section", async () => {
  const env = makeSessionEnv();
  writeTranscript(env, "Users-alice-dev-my-repo", "real-one", "cursor-real-user.jsonl");
  writeTranscript(env, "Users-alice-dev-my-repo", "real-two", "cursor-real-user.jsonl");
  await buildCursorIndex(env);

  const result = runSessions(["analyze", "--provider", "cursor", "--include-turns"], env.homeDir);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Transcript evidence patterns");
  expect(result.stdout).toContain("scanned sessions: 2");
  expect(result.stdout).toContain("preference");
});

test("sessions analyze include-turns filters scanned sessions", async () => {
  const env = makeSessionEnv();
  const now = Date.now();
  writeTranscript(env, "Users-alice-dev-my-repo", "recent", "cursor-real-user.jsonl");
  writeTranscript(env, "Users-alice-dev-other-repo", "other", "cursor-other-workspace.jsonl");
  writeMeta(env, "recent", { createdAtMs: now - 1_000, updatedAtMs: now - 1_000 });
  writeMeta(env, "other", {
    createdAtMs: now - 60 * 24 * 60 * 60 * 1_000,
    updatedAtMs: now - 60 * 24 * 60 * 60 * 1_000,
  });
  await buildCursorIndex(env);

  const workspace = runEvidenceJson(
    [
      "analyze",
      "--provider",
      "cursor",
      "--include-turns",
      "--format",
      "json",
      "--workspace",
      "/Users/alice/dev/my-repo",
      "--min-support",
      "1",
    ],
    env.homeDir,
  );
  const days = runEvidenceJson(
    [
      "analyze",
      "--provider",
      "cursor",
      "--include-turns",
      "--format",
      "json",
      "--days",
      "30",
      "--min-support",
      "1",
    ],
    env.homeDir,
  );
  const query = runEvidenceJson(
    [
      "analyze",
      "--provider",
      "cursor",
      "--include-turns",
      "--format",
      "json",
      "--query",
      "other-repo",
      "--min-support",
      "1",
    ],
    env.homeDir,
  );

  expect(workspace.evidence.scannedSessions).toBe(1);
  expect(days.evidence.scannedSessions).toBe(1);
  expect(query.evidence.scannedSessions).toBe(1);
  expect(query.evidence.patterns[0].examples[0].sessionId).toBe("other");
});

test("sessions analyze include-turns can include automation sessions", async () => {
  const env = makeSessionEnv();
  writeTranscript(env, "Users-alice-dev-my-repo", "real-one", "cursor-real-user.jsonl");
  writeTranscript(env, "Users-alice-dev-my-repo", "agent-worker", "cursor-automation-worker.jsonl");
  await buildCursorIndex(env);

  const defaultOutput = runEvidenceJson(
    [
      "analyze",
      "--provider",
      "cursor",
      "--include-turns",
      "--format",
      "json",
      "--min-support",
      "1",
    ],
    env.homeDir,
  );
  const withAutomation = runEvidenceJson(
    [
      "analyze",
      "--provider",
      "cursor",
      "--include-turns",
      "--format",
      "json",
      "--include-automation",
      "--min-support",
      "1",
    ],
    env.homeDir,
  );

  expect(defaultOutput.evidence.scannedUserTurns).toBe(1);
  expect(withAutomation.evidence.scannedUserTurns).toBe(2);
  expect(withAutomation.evidence.excludedFragments).toBeGreaterThan(0);
  expect(
    withAutomation.evidence.patterns.map((pattern: { bucket: string }) => pattern.bucket),
  ).not.toContain("noise");
});

test("sessions analyze rejects turn filters without include-turns", () => {
  const env = makeSessionEnv();

  const result = runSessions(["analyze", "--provider", "cursor", "--days", "30"], env.homeDir);

  expect(result.status).toBe(2);
  expect(result.stderr).toContain("transcript evidence options require --include-turns");
});

test("sessions analyze rejects evidence limits without include-turns", () => {
  const env = makeSessionEnv();

  const result = runSessions(
    ["analyze", "--provider", "cursor", "--evidence-limit", "1"],
    env.homeDir,
  );

  expect(result.status).toBe(2);
  expect(result.stderr).toContain("transcript evidence options require --include-turns");
});

test("sessions analyze include-turns reports missing transcript guidance", () => {
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

  const result = runSessions(["analyze", "--provider", "cursor", "--include-turns"], env.homeDir);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    "Transcript missing for session stale; run sessions cursor reindex",
  );
});

test.each(["codex", "all"])("sessions analyze rejects unsupported provider %s", (provider) => {
  const env = makeSessionEnv();
  const result = runSessions(["analyze", "--provider", provider], env.homeDir);

  expect(result.status).toBe(2);
  expect(result.stderr).toContain("must be one of: cursor");
});

function runSessions(args: string[], homeDir: string) {
  return spawnSync(process.execPath, [SESSIONS_BIN, ...args], {
    env: {
      ...process.env,
      HOME: homeDir,
    },
    encoding: "utf8",
  });
}

function runEvidenceJson(args: string[], homeDir: string) {
  const result = runSessions(args, homeDir);
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}
