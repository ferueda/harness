import { expect, test } from "vitest";
import {
  extractSessionEvidence,
  type EvidenceBucket,
} from "../../../lib/sessions/core/evidence.ts";
import type { UserTurn } from "../../../lib/sessions/core/types.ts";
import { session } from "../helpers.ts";

test("extractSessionEvidence keeps dotted paths intact while fragmenting", async () => {
  const report = await extractSessionEvidence(
    [
      turn("one", "Please test lib/sessions/core/evidence.test.ts before shipping."),
      turn("two", "Please test lib/sessions/core/evidence.test.ts before shipping."),
    ],
    { provider: "cursor" },
  );

  expect(report.patterns).toHaveLength(1);
  expect(report.patterns[0]).toMatchObject({
    bucket: "testing",
    support: 2,
  });
  expect(report.patterns[0]?.examples[0]?.text).toContain("evidence.test.ts");
  expect(report.artifacts.path).toContainEqual({
    type: "path",
    value: "lib/sessions/core/evidence.test.ts",
    sessionId: "one",
  });
});

test("extractSessionEvidence counts distinct sessions for repeated patterns", async () => {
  const report = await extractSessionEvidence(
    [
      turn("one", "Please run vitest for the sessions analyzer."),
      turn("one", "Please run vitest for the sessions analyzer.", { turnIndex: 2 }),
      turn("two", "Please run vitest for the sessions analyzer."),
    ],
    { provider: "cursor" },
  );

  expect(report.patterns).toHaveLength(1);
  expect(report.patterns[0]?.support).toBe(2);
  expect(report.patterns[0]?.examples).toHaveLength(3);
});

test("extractSessionEvidence assigns neutral buckets from lexical signals", async () => {
  const report = await extractSessionEvidence(
    [
      turn("planning", "Plan the next scoped phase."),
      turn("implementation", "Implement the evidence extractor."),
      turn("testing", "Run vitest coverage checks."),
      turn("debugging", "Debug the failed transcript scan."),
      turn("git", "Merge the pull request after checks pass."),
      turn("research", "Compare the current analyzer with the previous script."),
      turn("preference", "Always prefer concise evidence summaries."),
      turn("review", "Review this change before release."),
    ],
    { provider: "cursor", minSupport: 1 },
  );

  expect(buckets(report.patterns)).toEqual([
    "debugging",
    "git-pr",
    "implementation",
    "planning",
    "preference",
    "research",
    "review",
    "testing",
  ]);
});

test("extractSessionEvidence excludes noise before review or testing signals", async () => {
  const report = await extractSessionEvidence(
    [
      turn("worker", "Automated worker final answer: review the test output.", {
        isAutomation: true,
        isSubagent: true,
      }),
      turn("review", "Run the code-quality audit before merging."),
    ],
    { provider: "cursor", minSupport: 1 },
  );

  expect(report.excludedFragments).toBeGreaterThanOrEqual(1);
  expect(report.patterns).toHaveLength(1);
  expect(report.patterns[0]?.bucket).toBe("review");
});

test("extractSessionEvidence extracts bounded artifacts", async () => {
  const report = await extractSessionEvidence(
    [
      turn(
        "one",
        "Plan dev/plans/260626-session-evidence-extraction.md, inspect https://github.com/acme/repo/pull/42, checkout branch `codex/session-evidence`, run `pnpm test`, and patch lib/sessions/core/evidence.ts.",
      ),
      turn("two", "Plan dev/plans/260626-other-plan.md and run `pnpm typecheck`."),
    ],
    { provider: "cursor", evidenceLimit: 1, minSupport: 1 },
  );

  expect(report.artifacts["plan-file"]).toHaveLength(1);
  expect(report.artifacts["pull-request"]).toEqual([
    {
      type: "pull-request",
      value: "https://github.com/acme/repo/pull/42",
      sessionId: "one",
    },
  ]);
  expect(report.artifacts.branch).toEqual([
    {
      type: "branch",
      value: "codex/session-evidence",
      sessionId: "one",
    },
  ]);
  expect(report.artifacts.command).toEqual([
    {
      type: "command",
      value: "pnpm test",
      sessionId: "one",
    },
  ]);
  expect(report.artifacts.path).toHaveLength(1);
  expect(report.patterns[0]?.artifacts.length).toBeLessThanOrEqual(1);
});

test("extractSessionEvidence hides one-off patterns unless requested", async () => {
  const turns = [
    turn("one", "Run vitest for the sessions analyzer."),
    turn("two", "Run vitest for the sessions analyzer."),
    turn("three", "Debug the broken transcript parser."),
  ];

  const defaultReport = await extractSessionEvidence(turns, { provider: "cursor" });
  const exploratoryReport = await extractSessionEvidence(turns, {
    provider: "cursor",
    minSupport: 1,
  });

  expect(defaultReport.patterns).toHaveLength(1);
  expect(defaultReport.patterns[0]?.bucket).toBe("testing");
  expect(exploratoryReport.patterns.map((pattern) => pattern.bucket)).toContain("debugging");
});

test("extractSessionEvidence truncates examples and sorts output deterministically", async () => {
  const longText = `Always prefer ${"concise ".repeat(50)}evidence summaries.`;
  const report = await extractSessionEvidence(
    [
      turn("b", "Run vitest for the sessions analyzer."),
      turn("a", "Run vitest for the sessions analyzer."),
      turn("c", longText),
    ],
    { provider: "cursor", minSupport: 1, snippetLength: 40 },
  );

  expect(report.patterns.map((pattern) => pattern.bucket)).toEqual(["testing", "preference"]);
  const preference = report.patterns.find((pattern) => pattern.bucket === "preference");
  expect(preference?.examples[0]?.text).toHaveLength(40);
  expect(preference?.examples[0]?.text.endsWith("...")).toBe(true);
});

function buckets(patterns: { bucket: EvidenceBucket }[]): EvidenceBucket[] {
  return patterns.map((pattern) => pattern.bucket).toSorted();
}

function turn(
  sessionId: string,
  text: string,
  overrides: Partial<UserTurn["session"] & UserTurn> = {},
): UserTurn {
  const record = session({
    sessionId,
    isAutomation: overrides.isAutomation,
    isSubagent: overrides.isSubagent,
  });
  return {
    sessionId,
    workspacePath: "/Users/example/dev/repo",
    workspacePathConfidence: "explicit",
    workspacePathSource: "transcript",
    turnIndex: overrides.turnIndex ?? 0,
    isFirstUserTurn: overrides.isFirstUserTurn ?? true,
    text,
    rawText: text,
    session: record,
    ...overrides,
  };
}
