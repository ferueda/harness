import { expect, test } from "vitest";
import { analyzeCursorSessions } from "../../../lib/sessions/cursor/analyze.ts";
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
        firstUserQuery: "Use the local project instructions.",
      }),
      session({
        sessionId: "missing-title",
        title: undefined,
        firstUserQuery: "Please prefer concise updates.",
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
  expect(analysis.cursor.missingTitles.samples).toContainEqual(
    expect.objectContaining({
      sessionId: "missing-title",
    }),
  );
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
      firstUserQuery: "I want you to always prefer short updates.",
    }),
    session({
      sessionId: "noise",
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
      id: "workspace-path-decoded-only",
      severity: "high",
      count: 5,
    }),
  );
});
