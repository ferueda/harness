import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "vitest";
import { writeCursorCache } from "../../lib/sessions/core/cache.ts";
import { makeSessionEnv, session } from "./helpers.ts";

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

test("sessions analyze table output includes self-improve marker section", () => {
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
  expect(result.stdout).toContain(
    "Self-improve marker candidates (all sessions; informational only)",
  );
  expect(result.stdout).toContain("Preference-like markers");
  expect(result.stdout).toContain("Class-scoped marker candidates");
  expect(result.stdout).toContain("Non-automation sessions (1 session)");
  expect(result.stdout).toContain("Automation sessions (0 sessions)");
  expect(result.stdout).toContain("Subagent sessions (0 sessions)");
  expect(result.stdout).toContain("Preference marker samples (1 total)");
  expect(result.stdout).toContain("Index improvement candidates");
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
