import { describe, expect, it } from "vitest";
import { renderSpecRevisionPrompt, SPEC_REVISION_POLICY_VERSION } from "./revise-prompt.ts";
import type { SpecRevisionReview } from "./revise-schema.ts";
import type { SpecWorkItemContext } from "./schema.ts";

const REVISION = "a".repeat(40);

describe("Spec revision prompt", () => {
  it("renders deterministic current context and exact review identity", () => {
    const workItem = validWorkItem();
    const review = validReview();
    const artifact = { path: "dev/plans/FER-283.md", revision: REVISION };
    const prompt = renderSpecRevisionPrompt({ workItem, artifact, review });

    expect(SPEC_REVISION_POLICY_VERSION).toBe("2");
    expect(prompt).toContain(JSON.stringify(workItem, null, 2));
    expect(prompt).toContain(`"reviewedRevision": "${REVISION}"`);
    expect(prompt).toContain(`"rubricVersion": "2"`);
    expect(prompt).toContain(review.findings[0]!.id);
    expect(prompt).toContain(`Update only ${artifact.path}`);
    expect(renderSpecRevisionPrompt({ workItem, artifact, review })).toBe(prompt);
  });

  it("keeps the original author authoritative but evidence-bound", () => {
    const prompt = render();

    expect(prompt).toContain("Resume your work as the original author");
    expect(prompt).toContain(
      "resumed session is useful context, but it is not the source of truth",
    );
    expect(prompt).toContain(
      "repository invariants and current project intent; explicit requirements and accepted decisions; verified codebase facts",
    );
    expect(prompt).toContain("Treat reviewer findings as advisory evidence, not authority");
    expect(prompt).toContain("Research and resolve inspectable questions yourself");
    expect(prompt).toContain("smallest coherent change");
    expect(prompt).toContain("decisions rather than prewritten implementation");
    expect(prompt).toContain("every material outcome tied to an observable result");
    expect(prompt).toContain("exact proof action, and expected evidence");
    expect(prompt).toContain("terminal-state proof for asynchronous work");
    expect(prompt).toContain("safe live-proof requirements");
    expect(prompt).toContain("without adding redundant layers");
  });

  it("defines bounded artifact and finding behavior", () => {
    const prompt = render();

    expect(prompt).toContain("Do not run Git");
    expect(prompt).toContain("Do not edit product code");
    expect(prompt).toContain("Return exactly one response for every supplied finding ID");
    expect(prompt).toContain('"accepted"');
    expect(prompt).toContain('"adapted"');
    expect(prompt).toContain('"declined"');
    expect(prompt).toContain('Return "updated"');
    expect(prompt).toContain('Return "unchanged"');
    expect(prompt).toContain('Return "needs-input"');
    expect(prompt).toContain("do not change the artifact");
    expect(prompt).toContain("Do not include artifact markdown or session data in JSON");
  });
});

function render(): string {
  return renderSpecRevisionPrompt({
    workItem: validWorkItem(),
    artifact: { path: "dev/plans/FER-283.md", revision: REVISION },
    review: validReview(),
  });
}

function validReview(): SpecRevisionReview {
  return {
    reviewedRevision: REVISION,
    rubricVersion: "2",
    findings: [
      {
        id: `spec-review-finding-${"b".repeat(64)}`,
        criterion: "architecture",
        artifactLocation: {
          section: "Changes",
          lineStart: 8,
          lineEnd: 10,
        },
        evidence: [
          {
            source: "code",
            path: "lib/spec/spec.ts",
            lineStart: 84,
            lineEnd: 156,
            summary: "The existing operation owns only initial Spec generation.",
          },
        ],
        problem: "The Spec assigns publication to the domain operation.",
        requiredOutcome: "Keep publication in the workflow consumer.",
      },
    ],
  };
}

function validWorkItem(): SpecWorkItemContext {
  return {
    id: "issue-283",
    reference: "FER-283",
    title: "Build a resumable Spec revision operation",
    description: "Resume the original author to evaluate trusted review findings.",
    url: "https://linear.app/issue/FER-283",
    state: "In Progress",
    labels: ["Implement"],
    comments: [],
    parent: null,
    children: [],
    duplicateOf: null,
    blockedBy: [],
    related: [],
    links: [],
    createdAt: "2026-07-28T18:00:00.000Z",
    updatedAt: "2026-07-28T19:00:00.000Z",
    completeness: {
      commentsTruncated: false,
      labelsTruncated: false,
      relationsTruncated: false,
      linksTruncated: false,
      childrenTruncated: false,
    },
  };
}
