import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { z } from "zod";
import {
  IMPLEMENTATION_REVIEW_PROMPT,
  QUALITY_REVIEW_PROMPT,
  SPEC_REVIEW_PROMPT,
} from "../lib/review/prompts/index.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const reviewers = [
  ["review-implementation", IMPLEMENTATION_REVIEW_PROMPT],
  ["code-quality-review", QUALITY_REVIEW_PROMPT],
  ["review-spec", SPEC_REVIEW_PROMPT],
] as const;

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

test("the coordinator permits proportional selection without blanket reruns", () => {
  const source = read("skills/change-review-workflow/SKILL.md");
  for (const choice of ["Skip", "Implementation", "Quality", "Both"]) {
    expect(source).toContain(`**${choice}**`);
  }
  expect(source).toContain("--steps implementation");
  expect(source).toContain("partial");
  expect(source).toContain("reviewed revision");
  expect(source).not.toContain("After any code edit, always rerun");
  expect(source).not.toContain("By default run both");
});

test.each(reviewers)("%s keeps consequential finding rules", (name, prompt) => {
  const skill = read(`skills/${name}/SKILL.md`);
  for (const source of [prompt, skill]) {
    expect(source).toContain("concrete consequence");
    expect(source).toContain("Omit nitpicks");
    expect(source).toContain("safe acceptance");
    expect(source).toContain("must_fix");
  }
});

test("the handoff does not suppress newly evidenced material defects", () => {
  const handoff = read("skills/change-review-workflow/references/review-handoff.md");
  expect(handoff).toContain("New evidence of a material defect");
  expect(handoff).toContain("reviewed revision");
  expect(handoff).not.toContain("only for a regression introduced");
});

test("review evaluation cases have valid, distinct grading expectations", () => {
  const caseSchema = z
    .object({
      id: z.string().min(1),
      phase: z.enum(["selection", "follow-up", "review"]),
      prompt: z.string().min(1),
      context: z.string().min(1),
      roles: z.enum(["skip", "implementation", "quality", "both", "caller-owned"]).nullable(),
      verdict: z.enum(["pass", "needs_changes", "blocked"]).nullable(),
      expected: z.string().min(1),
      forbidden: z.string().min(1),
    })
    .strict();
  const data: unknown = JSON.parse(read("test/fixtures/review-policy-eval.json"));
  const fixture = z.array(caseSchema).parse(data);

  expect(new Set(fixture.map((entry) => entry.id)).size).toBe(fixture.length);
  for (const entry of fixture) {
    if (entry.phase === "review") {
      expect(entry.roles).toBeNull();
      expect(entry.verdict).not.toBeNull();
    } else {
      expect(entry.roles).not.toBeNull();
      expect(entry.verdict).toBeNull();
    }
  }
  for (const id of [
    "test-name",
    "weakened-proof",
    "one-line-auth",
    "structural-only",
    "contract-and-owner",
    "complete-change",
    "mechanical-follow-up",
    "behavioral-follow-up",
    "explicit-both",
    "worker-boundary",
    "sufficient-spec",
    "unsafe-spec",
    "quality-nit",
    "new-defect",
  ]) {
    expect(fixture.some((entry) => entry.id === id), id).toBe(true);
  }
});

// These are static package/contract checks, not executions of the model scenarios.
// Grade fresh-session behavior separately; expected answers stay out of prompts.
