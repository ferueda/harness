import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  IMPLEMENTATION_REVIEW_PROMPT,
  QUALITY_REVIEW_PROMPT,
  SPEC_REVIEW_PROMPT,
} from "../lib/review/prompts/index.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reviewers = [
  ["review-implementation", IMPLEMENTATION_REVIEW_PROMPT],
  ["code-quality-review", QUALITY_REVIEW_PROMPT],
  ["review-spec", SPEC_REVIEW_PROMPT],
] as const;

function placeholders(prompt: string): string[] {
  return [...prompt.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((match) => match[1]).sort();
}

test("review templates preserve only the supported scope placeholders", () => {
  const diff = ["BASE_REF", "DIFF_RANGE", "DIFF_REF", "HANDOFF_SECTION", "HEAD_REF"];
  expect(placeholders(QUALITY_REVIEW_PROMPT)).toEqual(diff);
  expect(placeholders(IMPLEMENTATION_REVIEW_PROMPT)).toEqual([...diff, "PLAN_REF"]);
  expect(placeholders(SPEC_REVIEW_PROMPT)).toEqual(["HANDOFF_SECTION", "PLAN_REF"]);
});

test.each(reviewers)("%s preserves read-only and structured-result contracts", (name, prompt) => {
  const skill = readFileSync(resolve(ROOT, "skills", name, "SKILL.md"), "utf8");
  for (const source of [prompt, skill]) {
    expect(source).toContain("read-only");
    expect(source).toContain("must_fix");
    for (const verdict of ["pass", "needs_changes", "blocked"]) {
      expect(source).toContain(verdict);
    }
    expect(source).toContain("JSON");
    expect(source.toLowerCase()).toContain("host permissions");
  }
  for (const field of [
    "title",
    "severity",
    "location",
    "issue",
    "recommendation",
    "rationale",
    "must_fix",
  ]) {
    expect(prompt).toContain(field);
  }
  expect(prompt).not.toContain("{{SKILL_PATH}}");
});

test("follow-up review permits new evidence without reopening settled preferences", () => {
  for (const prompt of [IMPLEMENTATION_REVIEW_PROMPT, QUALITY_REVIEW_PROMPT]) {
    expect(prompt).toContain("New evidence of a material defect");
    expect(prompt).toContain("Do not reopen settled choices without new evidence");
    expect(prompt).not.toContain("only when the remediation introduced it");
  }
});

test("spec review preserves outcome proof without a filename gate", () => {
  expect(SPEC_REVIEW_PROMPT).toContain("terminal state or downstream evidence");
  expect(SPEC_REVIEW_PROMPT).toContain("explicit authority");
  expect(SPEC_REVIEW_PROMPT).toContain("cleanup");
  expect(SPEC_REVIEW_PROMPT).toContain("No filename inventory is a prerequisite");
  expect(SPEC_REVIEW_PROMPT).toContain("unsupported material scope");
});

// These sentinels protect wiring, not model behavior. Forward evaluation lives
// in test/fixtures/skill-routing-eval.json and is not executed by this suite.
