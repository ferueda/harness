import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { WorkItemContext } from "../work-item/schema.ts";
import { renderImplementationPrompt } from "./prompt.ts";
import type { ImplementationSourceAuthority } from "./source.ts";

describe("implementation prompt", () => {
  it("uses only the selected plan as task authority", () => {
    const prompt = renderImplementationPrompt(planAuthority());

    expect(prompt).toContain("PLAN_AUTHORITY_SENTINEL");
    expect(prompt).not.toContain("LINEAR_AUTHORITY_SENTINEL");
    expect(prompt).toContain("do not edit, rename, delete, or replace that plan");
    expect(prompt).toContain('"kind": "plan"');
  });

  it("uses only complete Linear context when no plan is selected", () => {
    const prompt = renderImplementationPrompt(linearAuthority());

    expect(prompt).toContain("LINEAR_AUTHORITY_SENTINEL");
    expect(prompt).not.toContain("PLAN_AUTHORITY_SENTINEL");
    expect(prompt).toContain('"kind": "linear"');
    expect(prompt).toContain('"reference": "FER-323"');
  });

  it("keeps implementation, proof, and external side effects in their owners", () => {
    const prompt = renderImplementationPrompt(linearAuthority());

    expect(prompt).toContain(
      "selected implementation source within host permissions",
    );
    expect(prompt).toContain("make the smallest coherent code change");
    expect(prompt).toContain("highest existing stable behavioral seam");
    expect(prompt).toContain("repository's canonical gate");
    expect(prompt).toContain("Do not create Git commits");
    expect(prompt).toContain("Do not push, publish a pull request");
    expect(prompt).toContain("Do not start reviewers");
    expect(prompt).toContain('For "needs-input"');
    expect(prompt).toContain("Partial workspace edits may exist");
    expect(prompt).toContain("Return only the final JSON object");
  });
});

function planAuthority(): ImplementationSourceAuthority {
  const planContent = "# Plan\n\nPLAN_AUTHORITY_SENTINEL\n";
  return {
    source: {
      kind: "plan",
      issueReference: "FER-323",
      path: "dev/plans/FER-323.md",
    },
    issueReference: "FER-323",
    sourceSha256: sha256(planContent),
    planContent,
  };
}

function linearAuthority(): ImplementationSourceAuthority {
  const workItem = validWorkItem();
  return {
    source: {
      kind: "linear",
      workItem,
    },
    issueReference: workItem.reference,
    sourceSha256: sha256(JSON.stringify(workItem)),
  };
}

function validWorkItem(): WorkItemContext {
  return {
    id: "issue-323",
    reference: "FER-323",
    title: "Build the implementation operation",
    description: "LINEAR_AUTHORITY_SENTINEL",
    url: "https://linear.app/issue/FER-323",
    state: "Open",
    labels: ["Implement"],
    comments: [],
    parent: null,
    children: [],
    duplicateOf: null,
    blockedBy: [],
    related: [],
    links: [],
    createdAt: "2026-07-29T20:00:00.000Z",
    updatedAt: "2026-07-29T21:00:00.000Z",
    completeness: {
      commentsTruncated: false,
      labelsTruncated: false,
      relationsTruncated: false,
      linksTruncated: false,
      childrenTruncated: false,
    },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
