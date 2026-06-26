import { expect, test } from "vitest";
import { analyzeSessions } from "../../../lib/sessions/core/analyze.ts";
import { session } from "../helpers.ts";

test("analyzeSessions counts missing fields and classifications", () => {
  const analysis = analyzeSessions([
    session({
      sessionId: "real",
      title: "Real session",
      firstUserQuery: "Please prefer concise updates.",
      workspacePathConfidence: "explicit",
      isAutomation: false,
      isSubagent: false,
    }),
    session({
      sessionId: "automation",
      title: undefined,
      firstUserQuery: undefined,
      updatedAtMs: undefined,
      workspacePathConfidence: "decoded",
      isAutomation: true,
      isSubagent: true,
    }),
  ]);

  expect(analysis).toMatchObject({
    provider: "all",
    totalSessions: 2,
    missing: {
      title: 1,
      firstUserQuery: 1,
      updatedAtMs: 1,
    },
    classifications: {
      automation: 1,
      subagent: 1,
      realUser: 1,
    },
    workspacePathConfidence: {
      explicit: 1,
      decoded: 1,
    },
  });
});

test("analyzeSessions returns stable top words, prefixes, and marker candidates", () => {
  const analysis = analyzeSessions(
    [
      session({
        sessionId: "one",
        firstUserQuery: "Please prefer concise updates for review.",
      }),
      session({
        sessionId: "two",
        firstUserQuery: "Please prefer concise updates for workflow review.",
      }),
      session({
        sessionId: "three",
        firstUserQuery: "Always make sure final answer is short.",
      }),
    ],
    { provider: "cursor", limit: 5 },
  );

  expect(analysis.provider).toBe("cursor");
  expect(analysis.topFirstQueryWords).toContainEqual({ phrase: "prefer", count: 2 });
  expect(analysis.topFirstQueryWords).toContainEqual({ phrase: "concise", count: 2 });
  expect(analysis.topFirstQueryPrefixes[0]).toEqual({
    phrase: "always make sure final answer is short.",
    count: 1,
  });
  expect(analysis.candidatePreferenceMarkers).toEqual([
    { phrase: "prefer", count: 2 },
    { phrase: "always", count: 1 },
    { phrase: "make sure", count: 1 },
  ]);
  expect(analysis.candidateNoiseMarkers).toContainEqual({ phrase: "review", count: 2 });
  expect(analysis.candidateNoiseMarkers).toContainEqual({ phrase: "workflow", count: 1 });
});

test("analyzeSessions does not count marker substrings inside larger words", () => {
  const analysis = analyzeSessions([
    session({
      firstUserQuery: "Preview the preferred changes before shipping.",
    }),
  ]);

  expect(analysis.candidatePreferenceMarkers).not.toContainEqual({
    phrase: "prefer",
    count: 1,
  });
  expect(analysis.candidateNoiseMarkers).not.toContainEqual({ phrase: "review", count: 1 });
});
