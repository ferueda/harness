import { expect, test } from "vitest";
import {
  IMPLEMENTATION_REVIEW_PROMPT,
  QUALITY_REVIEW_PROMPT,
  SIMPLIFY_REVIEW_PROMPT,
} from "../lib/review-prompts.ts";

const DIRECT_ARTIFACT_INSTRUCTION =
  "Read the artifact files directly. Do not rely on summaries or previews.";

test("review prompts preserve common reviewer instructions", () => {
  for (const prompt of [
    IMPLEMENTATION_REVIEW_PROMPT,
    QUALITY_REVIEW_PROMPT,
    SIMPLIFY_REVIEW_PROMPT,
  ]) {
    expect(prompt).toContain("{{SKILL_PATH}}");
    expect(prompt).toContain("{{BASE_REF}}");
    expect(prompt).toContain("{{HEAD_REF}}");
    expect(prompt).toContain("{{MERGE_BASE}}");
    expect(prompt).toContain("{{HEAD_SHA}}");
    expect(prompt).toContain("{{DIFF_SECTION}}");
    expect(prompt).toContain("{{HANDOFF_SECTION}}");
    expect(prompt).toContain(DIRECT_ARTIFACT_INSTRUCTION);
    expect(prompt).toContain("Return JSON matching the provided schema");
  }
});

test("implementation review prompt includes plan context", () => {
  expect(IMPLEMENTATION_REVIEW_PROMPT).toContain("{{PLAN_SECTION}}");
  expect(QUALITY_REVIEW_PROMPT).not.toContain("{{PLAN_SECTION}}");
  expect(SIMPLIFY_REVIEW_PROMPT).not.toContain("{{PLAN_SECTION}}");
});

test("simplify review prompt keeps simplify-specific guidance", () => {
  expect(SIMPLIFY_REVIEW_PROMPT).toContain("Use the simplify-review skill");
});
