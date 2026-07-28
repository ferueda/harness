import { describe, expect, it } from "vitest";
import {
  renderSpecReviewPrompt,
  SPEC_REVIEW_PROMPT_VERSION,
  SPEC_REVIEW_RUBRIC_VERSION,
} from "./prompt.ts";
import type { SpecReviewWorkItemContext } from "./schema.ts";

describe("Spec review prompt", () => {
  it("renders deterministic complete context and exact trusted artifact identity", () => {
    const workItem = validWorkItem();
    const artifact = { path: "dev/plans/FER-282.md", revision: "a".repeat(40) };
    const prompt = renderSpecReviewPrompt({ workItem, artifact });

    expect(SPEC_REVIEW_RUBRIC_VERSION).toBe("1");
    expect(SPEC_REVIEW_PROMPT_VERSION).toBe("1");
    expect(prompt).toContain(JSON.stringify(workItem, null, 2));
    expect(prompt).toContain(`Review exactly ${artifact.path}`);
    expect(prompt).toContain(`trusted revision ${artifact.revision}`);
    expect(renderSpecReviewPrompt({ workItem, artifact })).toBe(prompt);
  });

  it("grounds review in authority and a proportional versioned rubric", () => {
    const prompt = render();

    expect(prompt).toContain(
      "repository invariants and current project intent; explicit requirements and accepted decisions; verified codebase facts",
    );
    expect(prompt).toContain("Review the Spec as a decision record");
    expect(prompt).toContain("Do not demand template sections");
    expect(prompt).toContain("resolves planning-time choices");
    expect(prompt).toContain("smallest coherent change");
    expect(prompt).toContain("vertical, independently useful units");
    expect(prompt).toContain("highest stable credible proof seam");
    expect(prompt).toContain("speculative hardening, generic frameworks");
  });

  it("keeps findings material, cited, and outcome-focused", () => {
    const prompt = render();

    expect(prompt).toContain("Request changes only for a material");
    expect(prompt).toContain("artifactLocation identifies where the Spec is deficient");
    expect(prompt).toContain("An artifact citation path must be exactly");
    expect(prompt).toContain("Do not write replacement Spec text");
    expect(prompt).toContain("Keep findings distinct");
  });

  it("keeps the reviewer independent, read-only, and outside trusted identity", () => {
    const prompt = render();

    expect(prompt).toContain("fresh review");
    expect(prompt).toContain("do not have the Spec author's session");
    expect(prompt).toContain("Work only in read-only mode");
    expect(prompt).toContain("do not run Git");
    expect(prompt).toContain("Do not add finding IDs, artifact identity, revision");
    expect(prompt).toContain("Trusted code adds those after validation");
  });
});

function render(): string {
  return renderSpecReviewPrompt({
    workItem: validWorkItem(),
    artifact: { path: "dev/plans/FER-282.md", revision: "a".repeat(40) },
  });
}

function validWorkItem(): SpecReviewWorkItemContext {
  return {
    id: "issue-282",
    reference: "FER-282",
    title: "Build an independent read-only Spec review operation",
    description: "Review one exact generated Spec.",
    url: "https://linear.app/issue/FER-282",
    state: "Open",
    labels: ["Implement"],
    comments: [],
    parent: null,
    children: [],
    duplicateOf: null,
    blockedBy: [],
    related: [],
    links: [],
    createdAt: "2026-07-23T02:45:33.277Z",
    updatedAt: "2026-07-28T17:34:14.392Z",
    completeness: {
      commentsTruncated: false,
      labelsTruncated: false,
      relationsTruncated: false,
      linksTruncated: false,
      childrenTruncated: false,
    },
  };
}
