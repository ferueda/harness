import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { WorkItemContext } from "../work-item/schema.ts";
import {
  renderImplementationRevisionPrompt,
  IMPLEMENTATION_REVISION_POLICY_VERSION,
} from "./revise-prompt.ts";
import type { ImplementationRevisionReview } from "./revise-schema.ts";
import type { ImplementationSourceAuthority } from "./source.ts";

const REVISION = "a".repeat(40);
const FINDING_ID = `implementation-review-finding-${"b".repeat(64)}`;

describe("implementation revision prompt", () => {
  it("renders deterministic plan authority and trusted finding identity", () => {
    const prompt = renderImplementationRevisionPrompt({
      authority: planAuthority(),
      review: review(),
    });

    expect(IMPLEMENTATION_REVISION_POLICY_VERSION).toBe("2");
    expect(prompt).toContain("PLAN_AUTHORITY_SENTINEL");
    expect(prompt).toContain(FINDING_ID);
    expect(prompt).toContain(`"reviewedRevision": "${REVISION}"`);
    expect(prompt).toContain('use path "dev/plans/FER-325.md"');
    expect(
      renderImplementationRevisionPrompt({
        authority: planAuthority(),
        review: review(),
      }),
    ).toBe(prompt);
  });

  it("uses complete Linear context with null selected-source evidence paths", () => {
    const prompt = renderImplementationRevisionPrompt({
      authority: linearAuthority(),
      review: review(),
    });

    expect(prompt).toContain("LINEAR_AUTHORITY_SENTINEL");
    expect(prompt).not.toContain("PLAN_AUTHORITY_SENTINEL");
    expect(prompt).toContain("For selected-source evidence, use path null");
  });

  it("keeps revision decisions with the original author and side effects with callers", () => {
    const prompt = renderImplementationRevisionPrompt({
      authority: linearAuthority(),
      review: review(),
    });

    expect(prompt).toContain("Resume your work as the original implementation author");
    expect(prompt).toContain("resumed session is context, not authority");
    expect(prompt).toContain("original author owns the final disposition");
    expect(prompt).toContain("Return exactly one response for every supplied finding ID");
    expect(prompt).toContain('Return "updated"');
    expect(prompt).toContain('Return "unchanged"');
    expect(prompt).toContain('Return "needs-input"');
    expect(prompt).toContain("Partial edits may remain");
    expect(prompt).toContain("caller, not this operation, inspects Git");
    expect(prompt).toContain("Do not run Git");
    expect(prompt).toContain("invoke reviewers");
    expect(prompt).toContain("mutate Linear");
    expect(prompt).toContain("publish a pull request");
  });
});

function review(): ImplementationRevisionReview {
  return {
    reviewedRevision: REVISION,
    findings: [
      {
        id: FINDING_ID,
        reviewer: "implementation",
        title: "Preserve source integrity",
        severity: "High",
        location: "lib/implementation/revise.ts:180",
        issue: "The selected source might change.",
        recommendation: "Verify it after the provider call.",
        rationale: "The selected source remains task authority.",
      },
    ],
  };
}

function planAuthority(): ImplementationSourceAuthority {
  const planContent = "# Plan\n\nPLAN_AUTHORITY_SENTINEL\n";
  return {
    source: {
      kind: "plan",
      issueReference: "FER-325",
      path: "dev/plans/FER-325.md",
    },
    issueReference: "FER-325",
    sourceSha256: sha256(planContent),
    planContent,
  };
}

function linearAuthority(): ImplementationSourceAuthority {
  const workItem = validWorkItem();
  return {
    source: { kind: "linear", workItem },
    issueReference: workItem.reference,
    sourceSha256: sha256(JSON.stringify(workItem)),
  };
}

function validWorkItem(): WorkItemContext {
  return {
    id: "issue-325",
    reference: "FER-325",
    title: "Build resumable implementation revision",
    description: "LINEAR_AUTHORITY_SENTINEL",
    url: "https://linear.app/issue/FER-325",
    state: "In Progress",
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
