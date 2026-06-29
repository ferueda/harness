import { expect, test } from "vitest";
import { analyzeCursorSessions } from "../../lib/cursor/analyze.ts";
import { session } from "../helpers.ts";

test("analyzeCursorSessions reports Cursor-specific samples", () => {
  const analysis = analyzeCursorSessions(
    [
      session({
        sessionId: "missed-worker",
        title: "Review run",
        firstUserQuery: "you are running as an automated worker invoked by another agent.",
        isAutomation: false,
      }),
      session({
        sessionId: "ordinary-review",
        title: "PR review",
        firstUserQuery: "Please review this PR with my co-worker.",
        isAutomation: false,
      }),
      session({
        sessionId: "decoded-path",
        workspacePathConfidence: "decoded",
        title: "Use the local project instructions.",
        titleSource: "first-query",
        firstUserQuery: "Use the local project instructions.",
      }),
      session({
        sessionId: "missing-title",
        title: undefined,
        firstUserQuery: undefined,
      }),
    ],
    { limit: 5 },
  );

  expect(analysis.cursor.suspiciousAutomation).toMatchObject({
    total: 1,
    samples: [
      expect.objectContaining({
        sessionId: "missed-worker",
        reason: "query contains automation-like phrase: you are running as an automated worker",
      }),
    ],
  });
  expect(analysis.cursor.decodedWorkspacePaths).toMatchObject({
    total: 1,
    samples: [expect.objectContaining({ sessionId: "decoded-path" })],
  });
  expect(analysis.cursor.missingDisplayTitles.samples).toContainEqual(
    expect.objectContaining({
      sessionId: "missing-title",
      reason: "session has no display title",
    }),
  );
  expect(analysis.cursor.missingStoreDbMetadata.total).toBe(4);
  expect(analysis.indexImprovementCandidates).toContainEqual(
    expect.objectContaining({
      id: "suspicious-automation-classification",
      severity: "high",
      count: 1,
    }),
  );
});

test("analyzeCursorSessions separates preference-like and noise markers", () => {
  const analysis = analyzeCursorSessions([
    session({
      sessionId: "preference",
      title: "I want you to always prefer short updates.",
      titleSource: "first-query",
      firstUserQuery: "I want you to always prefer short updates.",
    }),
    session({
      sessionId: "noise",
      title: "You are running as an automated worker. Hard requirements for your FINAL answer.",
      titleSource: "first-query",
      firstUserQuery:
        "You are running as an automated worker. Hard requirements for your FINAL answer.",
      isAutomation: true,
      isSubagent: true,
    }),
  ]);

  expect(analysis.candidatePreferenceMarkers).toContainEqual({ phrase: "prefer", count: 1 });
  expect(analysis.candidatePreferenceMarkers).toContainEqual({
    phrase: "i want you to",
    count: 1,
  });
  expect(analysis.candidateNoiseMarkers).toContainEqual({
    phrase: "automated worker",
    count: 1,
  });
  expect(analysis.candidateNoiseMarkers).toContainEqual({ phrase: "final answer", count: 1 });
  expect(analysis.cursor.preferenceMarkers.samples[0]).toMatchObject({ sessionId: "preference" });
  expect(analysis.cursor.noiseMarkers.samples[0]).toMatchObject({ sessionId: "noise" });
});

test("analyzeCursorSessions reports total counts separately from bounded samples", () => {
  const analysis = analyzeCursorSessions(
    Array.from({ length: 5 }, (_, index) =>
      session({
        sessionId: `decoded-${index}`,
        workspacePathConfidence: "decoded",
        workspacePathSource: "project-key",
        title: `Please prefer concise output ${index}.`,
        titleSource: "first-query",
        firstUserQuery: `Please prefer concise output ${index}.`,
      }),
    ),
    { limit: 2 },
  );

  expect(analysis.cursor.decodedWorkspacePaths.total).toBe(5);
  expect(analysis.cursor.decodedWorkspacePaths.samples).toHaveLength(2);
  expect(analysis.cursor.preferenceMarkers.total).toBe(5);
  expect(analysis.cursor.preferenceMarkers.samples).toHaveLength(2);
  expect(analysis.indexImprovementCandidates).toContainEqual(
    expect.objectContaining({
      id: "workspace-path-project-key-only",
      severity: "high",
      count: 5,
    }),
  );
  expect(analysis.indexImprovementCandidates).toContainEqual(
    expect.objectContaining({
      id: "missing-store-db-metadata",
      severity: "medium",
      count: 5,
    }),
  );
});

test("analyzeCursorSessions reports missing display titles separately from missing store-db metadata", () => {
  const analysis = analyzeCursorSessions([
    session({
      sessionId: "fallback-title",
      title: "Please prefer concise output.",
      titleSource: "first-query",
      firstUserQuery: "Please prefer concise output.",
    }),
    session({
      sessionId: "store-title",
      title: "Stored title",
      titleSource: "store-db",
      storeDbPath: "/tmp/store.db",
      firstUserQuery: "Please prefer concise output.",
    }),
    session({
      sessionId: "missing-display-title",
      title: undefined,
      firstUserQuery: undefined,
    }),
  ]);

  expect(analysis.missing.title).toBe(1);
  expect(analysis.cursor.missingDisplayTitles).toMatchObject({
    total: 1,
    samples: [expect.objectContaining({ sessionId: "missing-display-title" })],
  });
  expect(analysis.cursor.missingStoreDbMetadata).toMatchObject({
    total: 2,
    samples: [
      expect.objectContaining({ sessionId: "fallback-title" }),
      expect.objectContaining({ sessionId: "missing-display-title" }),
    ],
  });
  expect(analysis.indexImprovementCandidates).toContainEqual(
    expect.objectContaining({
      id: "missing-display-title",
      severity: "high",
      count: 1,
    }),
  );
});
