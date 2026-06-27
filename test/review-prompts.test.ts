import { expect, test } from "vitest";
import {
  IMPLEMENTATION_REVIEW_PROMPT,
  QUALITY_REVIEW_PROMPT,
  SIMPLIFY_REVIEW_PROMPT,
} from "../lib/prompts/index.ts";

test("review prompts include scope placeholders and JSON output contract", () => {
  for (const prompt of [
    IMPLEMENTATION_REVIEW_PROMPT,
    QUALITY_REVIEW_PROMPT,
    SIMPLIFY_REVIEW_PROMPT,
  ]) {
    expect(prompt).toContain("{{DIFF_RANGE}}");
    expect(prompt).toContain("{{BASE_REF}}");
    expect(prompt).toContain("{{HEAD_REF}}");
    expect(prompt).toContain("{{DIFF_REF}}");
    expect(prompt).toContain("{{HANDOFF_SECTION}}");
    expect(prompt).toContain("Return JSON matching the provided schema");
    expect(prompt).not.toContain("{{MERGE_BASE}}");
    expect(prompt).not.toContain("{{HEAD_SHA}}");
    expect(prompt).not.toContain("{{SKILL_PATH}}");
    expect(prompt).not.toContain("read and follow this skill file");
  }
});

test("implementation review prompt includes plan context and adversarial guidance", () => {
  expect(IMPLEMENTATION_REVIEW_PROMPT).toContain("{{PLAN_REF}}");
  expect(IMPLEMENTATION_REVIEW_PROMPT).toContain("adversarial code review");
  expect(IMPLEMENTATION_REVIEW_PROMPT).toContain("Subtract before you add");
  expect(QUALITY_REVIEW_PROMPT).not.toContain("{{PLAN_REF}}");
  expect(SIMPLIFY_REVIEW_PROMPT).not.toContain("{{PLAN_REF}}");
});

test("quality and simplify prompts keep reviewer-specific guidance", () => {
  expect(QUALITY_REVIEW_PROMPT).toContain("Audit focus");
  expect(QUALITY_REVIEW_PROMPT).toContain("preserving exact functionality");
  expect(SIMPLIFY_REVIEW_PROMPT).toContain("preserve exact behavior");
  expect(SIMPLIFY_REVIEW_PROMPT).toContain("Prefer explicit, boring code");
});
