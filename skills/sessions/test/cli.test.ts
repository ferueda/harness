import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { writeCodexCache, writeCursorCache } from "../lib/core/cache.ts";
import { buildCodexIndex } from "../lib/codex/index.ts";
import { buildCursorIndex } from "../lib/cursor/index.ts";
import {
  codexSession,
  makeSessionEnv,
  session,
  writeCodexRollout,
  writeCodexStateDb,
  writeMeta,
  writeTranscript,
} from "./helpers.ts";

const SESSIONS_BIN = join(dirname(fileURLToPath(import.meta.url)), "../scripts/sessions.ts");
const SESSIONS_SKILL_ROOT = join(dirname(SESSIONS_BIN), "..");

test("installed sessions skill bootstraps dependencies without harness checkout", () => {
  const store = spawnSync("pnpm", ["store", "path", "--silent"], { encoding: "utf8" });
  expect({ status: store.status, stderr: store.stderr }).toMatchObject({ status: 0 });
  const storeDir = store.stdout.trim();
  expect(storeDir).not.toBe("");

  const installRoot = mkdtempSync(join(tmpdir(), "harness-sessions-install-"));
  try {
    const installedSkillRoot = join(installRoot, "sessions");
    const binDir = join(installRoot, "bin");
    cpSync(SESSIONS_SKILL_ROOT, installedSkillRoot, {
      recursive: true,
      filter: (source) => !source.split(/[\\/]/).includes("node_modules"),
    });

    const install = spawnSync("bash", [join(installedSkillRoot, "scripts/install.sh")], {
      env: {
        ...process.env,
        HOME: installRoot,
        PNPM_CONFIG_OFFLINE: "true",
        PNPM_CONFIG_STORE_DIR: storeDir,
        SESSIONS_INSTALL_BIN: binDir,
      },
      encoding: "utf8",
    });

    expect({ status: install.status, stderr: install.stderr }).toMatchObject({ status: 0 });
    expect(existsSync(join(installedSkillRoot, "node_modules/commander"))).toBe(true);
    expect(existsSync(join(installedSkillRoot, "node_modules/zod"))).toBe(true);
    expect(existsSync(join(installedSkillRoot, "node_modules/vitest"))).toBe(false);
    expect(existsSync(join(binDir, "sessions"))).toBe(true);

    const help = spawnSync("sessions", ["--help"], {
      env: {
        ...process.env,
        HOME: installRoot,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
    });

    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Browse local agent sessions");
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
  }
});

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
        title: "Please prefer concise updates.",
        titleSource: "first-query",
        firstUserQuery: "Please prefer concise updates.",
      }),
      session({
        sessionId: "worker",
        title: "You are running as an automated worker.",
        titleSource: "first-query",
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
    missingDisplayTitles: { total: 0, samples: [] },
    missingStoreDbMetadata: { total: 2 },
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
  expect(output.indexImprovementCandidates).toContainEqual(
    expect.objectContaining({
      id: "missing-store-db-metadata",
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
      session({
        sessionId: "preference",
        title: "Always prefer concise output.",
        titleSource: "first-query",
        firstUserQuery: "Always prefer concise output.",
      }),
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
  expect(result.stdout).toContain("missing display title: 0");
  expect(result.stdout).toContain("missing store-db metadata: 1");
  expect(result.stdout).toContain("Missing display titles (0 total)");
  expect(result.stdout).toContain("Missing store-db metadata (1 total)");
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

test("sessions analyze turn-query searches transcript text without changing query semantics", async () => {
  const env = makeSessionEnv();
  writeTranscript(env, "Users-alice-dev-my-repo", "multi", "cursor-multi-user.jsonl");
  await buildCursorIndex(env);

  const metadataQuery = runEvidenceJson(
    [
      "analyze",
      "--provider",
      "cursor",
      "--include-turns",
      "--format",
      "json",
      "--query",
      "handoff",
      "--min-support",
      "1",
    ],
    env.homeDir,
  );
  const turnQuery = runEvidenceJson(
    [
      "analyze",
      "--provider",
      "cursor",
      "--include-turns",
      "--format",
      "json",
      "--turn-query",
      "handoff",
    ],
    env.homeDir,
  );

  expect(metadataQuery.evidence.scannedSessions).toBe(0);
  expect(metadataQuery.evidence.matches).toEqual([]);
  expect(turnQuery.evidence.scannedSessions).toBe(1);
  expect(turnQuery.evidence.matches).toEqual([
    expect.objectContaining({
      sessionId: "multi",
      turnIndex: 3,
      isFirstUserTurn: false,
      text: "Review this handoff before continuing.",
      query: "handoff",
      matchedQueries: ["handoff"],
    }),
  ]);
});

test("sessions analyze extract-only emits slim JSON evidence without index analysis", async () => {
  const env = makeSessionEnv();
  writeTranscript(env, "Users-alice-dev-my-repo", "multi", "cursor-multi-user.jsonl");
  await buildCursorIndex(env);

  const output = runEvidenceJson(
    [
      "analyze",
      "--provider",
      "cursor",
      "--include-turns",
      "--extract-only",
      "--format",
      "json",
      "--turn-query",
      "handoff",
    ],
    env.homeDir,
  );

  expect(output).toEqual({
    provider: "cursor",
    evidence: expect.objectContaining({
      provider: "cursor",
      scannedSessions: 1,
      scannedUserTurns: 2,
      patterns: [],
      matches: [
        expect.objectContaining({
          sessionId: "multi",
          matchedQueries: ["handoff"],
        }),
      ],
    }),
  });
  expect(output).not.toHaveProperty("topFirstQueryPrefixes");
  expect(output).not.toHaveProperty("indexImprovementCandidates");
  expect(output).not.toHaveProperty("classBreakdown");
});

test("sessions analyze extract-only broad scan keeps patterns without index analysis", async () => {
  const env = makeSessionEnv();
  writeTranscript(env, "Users-alice-dev-my-repo", "real-one", "cursor-real-user.jsonl");
  writeTranscript(env, "Users-alice-dev-my-repo", "real-two", "cursor-real-user.jsonl");
  await buildCursorIndex(env);

  const output = runEvidenceJson(
    [
      "analyze",
      "--provider",
      "cursor",
      "--include-turns",
      "--extract-only",
      "--format",
      "json",
      "--days",
      "30",
    ],
    env.homeDir,
  );

  expect(output).not.toHaveProperty("indexImprovementCandidates");
  expect(output.evidence.patterns).toEqual([
    expect.objectContaining({
      bucket: "preference",
      support: 2,
    }),
  ]);
});

test("sessions analyze supports repeatable turn-query OR matching", async () => {
  const env = makeSessionEnv();
  writeTranscript(env, "Users-alice-dev-my-repo", "multi", "cursor-multi-user.jsonl");
  await buildCursorIndex(env);

  const output = runEvidenceJson(
    [
      "analyze",
      "--provider",
      "cursor",
      "--include-turns",
      "--extract-only",
      "--format",
      "json",
      "--turn-query",
      "prefer",
      "--turn-query",
      "handoff",
    ],
    env.homeDir,
  );

  expect(output.evidence.matches).toEqual([
    expect.objectContaining({
      turnIndex: 0,
      matchedQueries: ["prefer"],
    }),
    expect.objectContaining({
      turnIndex: 3,
      matchedQueries: ["handoff"],
    }),
  ]);
});

test("sessions analyze match table honors evidence-limit", async () => {
  const env = makeSessionEnv();
  writeTranscript(env, "Users-alice-dev-my-repo", "multi", "cursor-multi-user.jsonl");
  await buildCursorIndex(env);

  const result = runSessions(
    [
      "analyze",
      "--provider",
      "cursor",
      "--include-turns",
      "--extract-only",
      "--turn-query",
      "prefer",
      "--turn-query",
      "handoff",
      "--evidence-limit",
      "1",
    ],
    env.homeDir,
  );

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("showing 1 of 2");
  expect(result.stdout).toContain("Please prefer concise status updates.");
  expect(result.stdout).not.toContain("Review this handoff before continuing.");
});

test("sessions analyze turn-query suppresses broad scan warning and renders table matches", async () => {
  const env = makeSessionEnv();
  writeTranscript(env, "Users-alice-dev-my-repo", "multi", "cursor-multi-user.jsonl");
  await buildCursorIndex(env);

  const result = runSessions(
    ["analyze", "--provider", "cursor", "--include-turns", "--turn-query", "handoff"],
    env.homeDir,
  );

  expect(result.status).toBe(0);
  expect(result.stderr).not.toContain("warning: --include-turns");
  expect(result.stdout).toContain("Transcript matches");
  expect(result.stdout).toContain("multi");
  expect(result.stdout).toContain("Review this handoff before continuing.");
});

test("sessions analyze extract-only table compacts match artifact display", async () => {
  const env = makeSessionEnv();
  writeTranscript(env, "Users-alice-dev-my-repo", "artifact", "cursor-artifact-user.jsonl");
  await buildCursorIndex(env);

  const result = runSessions(
    [
      "analyze",
      "--provider",
      "cursor",
      "--include-turns",
      "--extract-only",
      "--turn-query",
      "review",
    ],
    env.homeDir,
  );

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Transcript evidence");
  expect(result.stdout).not.toContain("Session index analysis");
  expect(result.stdout).toContain("Transcript matches");
  expect(result.stdout).toContain("artifacts");
  expect(result.stdout).toContain("+");
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
  const withAutomationAndSubagents = runEvidenceJson(
    [
      "analyze",
      "--provider",
      "cursor",
      "--include-turns",
      "--format",
      "json",
      "--include-automation",
      "--include-subagents",
      "--min-support",
      "1",
    ],
    env.homeDir,
  );

  expect(defaultOutput.evidence.scannedUserTurns).toBe(1);
  expect(withAutomation.evidence.scannedUserTurns).toBe(1);
  expect(withAutomationAndSubagents.evidence.scannedUserTurns).toBe(2);
  expect(withAutomationAndSubagents.evidence.excludedFragments).toBeGreaterThan(0);
  expect(
    withAutomationAndSubagents.evidence.patterns.map(
      (pattern: { bucket: string }) => pattern.bucket,
    ),
  ).not.toContain("noise");
});

test("sessions list supports exact session ids and independent inclusion flags", () => {
  const env = makeSessionEnv();
  writeCursorCache(env, {
    provider: "cursor",
    schemaVersion: 1,
    lastReindexAt: "2026-06-26T00:00:00.000Z",
    transcriptsFound: 4,
    indexedSessions: 4,
    skipped: 0,
    skippedUnparseable: 0,
    sessions: [
      session({ sessionId: "real" }),
      session({ sessionId: "automation", isAutomation: true }),
      session({ sessionId: "subagent", isSubagent: true }),
      session({ sessionId: "both", isAutomation: true, isSubagent: true }),
    ],
  });

  const exact = runSessions(["cursor", "list", "--session-id", "real"], env.homeDir);
  const partial = runSessions(["cursor", "list", "--session-id", "rea"], env.homeDir);
  const automation = runSessions(["cursor", "list", "--include-automation"], env.homeDir);
  const subagents = runSessions(["cursor", "list", "--include-subagents"], env.homeDir);

  expect(exact.stdout).toContain("real");
  expect(partial.stdout).toContain("No sessions found");
  expect(automation.stdout).toMatch(/automation\s+yes/);
  expect(automation.stdout).not.toContain("subagent");
  expect(subagents.stdout).toContain("subagent");
  expect(subagents.stdout).not.toMatch(/automation\s+yes/);
});

test("sessions analyze filters transcript evidence by exact session id", async () => {
  const env = makeSessionEnv();
  writeTranscript(env, "Users-alice-dev-my-repo", "multi", "cursor-multi-user.jsonl");
  await buildCursorIndex(env);

  const exact = runEvidenceJson(
    [
      "analyze",
      "--provider",
      "cursor",
      "--include-turns",
      "--extract-only",
      "--format",
      "json",
      "--session-id",
      "multi",
      "--workspace",
      "/Users/alice/dev/my-repo",
      "--days",
      "30",
      "--turn-query",
      "handoff",
    ],
    env.homeDir,
  );
  const partial = runEvidenceJson(
    [
      "analyze",
      "--provider",
      "cursor",
      "--include-turns",
      "--extract-only",
      "--format",
      "json",
      "--session-id",
      "mul",
      "--turn-query",
      "handoff",
    ],
    env.homeDir,
  );

  expect(exact.evidence.scannedSessions).toBe(1);
  expect(exact.evidence.matches).toHaveLength(1);
  expect(partial.evidence.scannedSessions).toBe(0);
  expect(partial.evidence.matches).toEqual([]);
});

test("sessions analyze rejects turn filters without include-turns", () => {
  const env = makeSessionEnv();

  const result = runSessions(["analyze", "--provider", "cursor", "--days", "30"], env.homeDir);

  expect(result.status).toBe(2);
  expect(result.stderr).toContain("transcript evidence options require --include-turns");
});

test("sessions analyze rejects turn-query without include-turns", () => {
  const env = makeSessionEnv();

  const result = runSessions(
    ["analyze", "--provider", "cursor", "--turn-query", "verify"],
    env.homeDir,
  );

  expect(result.status).toBe(2);
  expect(result.stderr).toContain("transcript evidence options require --include-turns");
});

test("sessions analyze rejects subagent inclusion without include-turns", () => {
  const env = makeSessionEnv();

  const result = runSessions(
    ["analyze", "--provider", "cursor", "--include-subagents"],
    env.homeDir,
  );

  expect(result.status).toBe(2);
  expect(result.stderr).toContain("transcript evidence options require --include-turns");
});

test("sessions analyze rejects extract-only without include-turns", () => {
  const env = makeSessionEnv();

  const result = runSessions(["analyze", "--provider", "cursor", "--extract-only"], env.homeDir);

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

test("sessions codex commands browse indexed Codex sessions", () => {
  const env = makeSessionEnv();
  writeCodexRollout(env, "sessions/real.jsonl", "codex-real-user.jsonl");
  writeCodexStateDb(env, [{ id: "real", rolloutPath: "sessions/real.jsonl", title: "Real" }]);

  const reindex = runSessions(["codex", "reindex"], env.homeDir);
  expect(reindex.status).toBe(0);
  expect(JSON.parse(reindex.stdout)).toMatchObject({
    provider: "codex",
    transcriptsFound: 1,
    indexedSessions: 1,
  });

  const list = runSessions(["codex", "list"], env.homeDir);
  expect(list.status).toBe(0);
  expect(list.stdout).toContain("real");
  expect(list.stdout).toContain("Real");

  const show = runSessions(["codex", "show", "real"], env.homeDir);
  expect(show.status).toBe(0);
  expect(show.stdout).toContain("Please verify the Codex provider works.");
  expect(show.stdout).not.toContain("## turn ");

  const boundedShow = runSessions(
    ["codex", "show", "real", "--turn", "1", "--context", "1"],
    env.homeDir,
  );
  expect(boundedShow.status).toBe(0);
  expect(boundedShow.stdout).toContain("## turn 0: user");
  expect(boundedShow.stdout).toContain("## turn 1: assistant");
  expect(boundedShow.stdout).toContain("## turn 2: user");

  const missingTurn = runSessions(["codex", "show", "real", "--context", "1"], env.homeDir);
  expect(missingTurn.status).toBe(2);
  expect(missingTurn.stderr).toContain("--context requires --turn");

  const outOfRange = runSessions(["codex", "show", "real", "--turn", "3"], env.homeDir);
  expect(outOfRange.status).toBe(1);
  expect(outOfRange.stderr).toContain("Turn 3 is out of range for session real");

  const exported = runSessions(["codex", "export", "real", "--format", "json"], env.homeDir);
  expect(exported.status).toBe(0);
  expect(JSON.parse(exported.stdout)).toMatchObject({
    session: { provider: "codex", sessionId: "real" },
  });

  const stats = runSessions(["codex", "stats", "--format", "json"], env.homeDir);
  expect(stats.status).toBe(0);
  expect(JSON.parse(stats.stdout)).toMatchObject({
    provider: "codex",
    transcriptsFound: 1,
    indexedSessions: 1,
  });
});

test("sessions analyze supports Codex provider in JSON and table modes", async () => {
  const env = makeSessionEnv();
  writeCodexRollout(env, "sessions/real.jsonl", "codex-real-user.jsonl");
  writeCodexStateDb(env, [{ id: "real", rolloutPath: "sessions/real.jsonl", title: "Real" }]);
  await buildCodexIndex(env);

  const json = runSessions(["analyze", "--provider", "codex", "--format", "json"], env.homeDir);
  expect(json.status).toBe(0);
  expect(JSON.parse(json.stdout)).toMatchObject({
    provider: "codex",
    totalSessions: 1,
    workspacePathSource: {
      transcript: 0,
      "store-db": 1,
      "project-key": 0,
    },
  });

  const table = runSessions(["analyze", "--provider", "codex"], env.homeDir);
  expect(table.status).toBe(0);
  expect(table.stdout).toContain("provider:         codex");
  expect(table.stdout).toContain("Lexical marker counts");
  expect(table.stdout).not.toContain("Cursor samples");
});

test("sessions analyze Codex uses clean database first message for metadata", async () => {
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

  const result = runSessions(["analyze", "--provider", "codex", "--format", "json"], env.homeDir);

  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.topFirstQueryPrefixes[0]).toEqual({
    phrase: "clean ask from database.",
    count: 1,
  });
  expect(JSON.stringify(output.topFirstQueryPrefixes)).not.toContain("agents.md instructions");
});

test("sessions analyze Codex evidence searches cleaned first turn and leaves raw show output", async () => {
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

  const raw = runSessions(["codex", "show", "real"], env.homeDir);
  expect(raw.status).toBe(0);
  expect(raw.stdout).toContain("# AGENTS.md instructions");

  const cleanMatches = runEvidenceJson(
    [
      "analyze",
      "--provider",
      "codex",
      "--include-turns",
      "--extract-only",
      "--format",
      "json",
      "--turn-query",
      "clean ask",
    ],
    env.homeDir,
  );
  expect(cleanMatches.evidence.matches).toEqual([
    expect.objectContaining({
      sessionId: "real",
      turnIndex: 0,
      text: "Clean ask from database.",
    }),
  ]);

  const preambleMatches = runEvidenceJson(
    [
      "analyze",
      "--provider",
      "codex",
      "--include-turns",
      "--extract-only",
      "--format",
      "json",
      "--turn-query",
      "agents.md instructions",
    ],
    env.homeDir,
  );
  expect(preambleMatches.evidence.matches).toEqual([]);
});

test("sessions analyze Codex extract-only searches user turns", async () => {
  const env = makeSessionEnv();
  writeCodexRollout(env, "sessions/real.jsonl", "codex-real-user.jsonl");
  writeCodexStateDb(env, [{ id: "real", rolloutPath: "sessions/real.jsonl", title: "Real" }]);
  await buildCodexIndex(env);

  const output = runEvidenceJson(
    [
      "analyze",
      "--provider",
      "codex",
      "--include-turns",
      "--extract-only",
      "--format",
      "json",
      "--turn-query",
      "verify",
    ],
    env.homeDir,
  );

  expect(output).toEqual({
    provider: "codex",
    evidence: expect.objectContaining({
      provider: "codex",
      scannedSessions: 1,
      scannedUserTurns: 2,
      patterns: [],
      matches: [
        expect.objectContaining({
          sessionId: "real",
          matchedQueries: ["verify"],
        }),
      ],
    }),
  });
});

test("sessions analyze Codex include-turns reports missing transcript guidance", () => {
  const env = makeSessionEnv();
  writeCodexCache(env, {
    provider: "codex",
    schemaVersion: 1,
    lastReindexAt: "2026-06-26T00:00:00.000Z",
    transcriptsFound: 1,
    indexedSessions: 1,
    skipped: 0,
    skippedUnparseable: 0,
    sessions: [codexSession({ sessionId: "stale", rolloutPath: "/no/such/rollout.jsonl" })],
  });

  const result = runSessions(["analyze", "--provider", "codex", "--include-turns"], env.homeDir);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    "Transcript missing for session stale; run sessions codex reindex",
  );
});

test("sessions analyze rejects unsupported provider all", () => {
  const env = makeSessionEnv();
  const result = runSessions(["analyze", "--provider", "all"], env.homeDir);

  expect(result.status).toBe(2);
  expect(result.stderr).toContain("must be one of: cursor, codex");
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
