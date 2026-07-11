import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { emitFactoryImplementationReviewResult } from "../bin/factory-implementation-review-command.ts";
import type { FactoryImplementationReviewResult } from "../lib/factory-implementation-review.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

test("implementation review help exposes the bounded command surface", () => {
  const result = run(["factory", "implementation", "review", "--help"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("harness factory implementation review");
  expect(result.stdout).toContain("--item-file <path>");
  expect(result.stdout).toContain("--linear-issue <issue>");
  expect(result.stdout).not.toContain("--runs-dir");
  expect(result.stdout).not.toContain("--apply");
  expect(result.stdout).not.toContain("--resume");
});

test("implementation review requires exactly one identity source", () => {
  const missing = run(["factory", "implementation", "review"]);
  expect(missing.status).toBe(1);
  expect(missing.stderr).toContain("one of --item-file or --linear-issue is required");

  const conflicting = run([
    "factory",
    "implementation",
    "review",
    "--item-file",
    "item.json",
    "--linear-issue",
    "ENG-123",
  ]);
  expect(conflicting.status).toBe(1);
  expect(conflicting.stderr).toContain("--item-file and --linear-issue are mutually exclusive");
});

const outputCommon = {
  implementationRunId: "implementation-run",
  reviewRunId: "review-run",
  reviewRunDir: "/store/runs/reviews/review-run",
  summaryPath: "/store/runs/reviews/review-run/summary.md",
  metaPath: "/store/runs/reviews/review-run/meta.json",
};

test.each([
  [
    "passing",
    { ...outputCommon, reviewStatus: "completed", outcome: "review-complete", verdict: "pass" },
    undefined,
  ],
  [
    "needs-changes",
    {
      ...outputCommon,
      reviewStatus: "completed",
      outcome: "ready-for-human",
      verdict: "needs_changes",
    },
    1,
  ],
  [
    "blocked",
    {
      ...outputCommon,
      reviewStatus: "completed",
      outcome: "ready-for-human",
      verdict: "blocked",
    },
    1,
  ],
  [
    "failed",
    {
      ...outputCommon,
      reviewStatus: "failed",
      outcome: "ready-for-human",
      failedReviews: [{ key: "quality", stage: "quality", error: "review failed" }],
    },
    1,
  ],
] satisfies [string, FactoryImplementationReviewResult, number | undefined][])(
  "prints stable %s JSON and sets exit status",
  (_label, result, exitCode) => {
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value?: unknown) => output.push(String(value)));

    emitFactoryImplementationReviewResult(result);

    expect(JSON.parse(output[0])).toEqual(result);
    expect(process.exitCode).toBe(exitCode);
  },
);

function run(args: string[]) {
  return spawnSync(process.execPath, ["bin/harness.ts", ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
}
