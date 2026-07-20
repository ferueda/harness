import { describe, expect, it } from "vitest";
import { renderTriagePrompt, TRIAGE_POLICY_VERSION } from "./prompt.ts";
import type { TriageWorkItemContext } from "./schema.ts";

describe("triage prompt", () => {
  it("renders deterministic work-item context and completeness signals", () => {
    const context = validContext();
    const prompt = renderTriagePrompt(context);

    expect(TRIAGE_POLICY_VERSION).toBe("3");
    expect(prompt).toContain(JSON.stringify(context, null, 2));
    expect(prompt).toContain('"commentsTruncated": true');
    expect(prompt).toContain('"childrenTruncated": false');
    expect(renderTriagePrompt(context)).toBe(prompt);
  });

  it("teaches the scope-first decision and smallest-slice rule", () => {
    const prompt = renderTriagePrompt(validContext());

    expect(prompt).toContain("Apply this rubric in order");
    expect(prompt).toContain("1. Check scope first.");
    expect(prompt).toContain(
      "outcomes that could be accepted, shipped, deferred, or rolled back independently",
    );
    expect(prompt).toContain(
      "Count independent outcomes, not unanswered questions or implementation steps.",
    );
    expect(prompt).toContain(
      "Several human decisions about one observable outcome do not make the item too broad",
    );
    expect(prompt).toContain(
      "one stale-issue automation with an undecided age threshold and close behavior is bounded",
    );
    expect(prompt).toContain(
      "Webhook ingress, triage, planning, implementation, and a dashboard are independent outcomes",
    );
    expect(prompt).toContain('decision "needs-input", scope "too-broad"');
    expect(prompt).toContain("recommend the smallest useful first slice");
    expect(prompt).toContain("ask exactly one question");
  });

  it("distinguishes agent work from human-only uncertainty", () => {
    const prompt = renderTriagePrompt(validContext());

    expect(prompt).toContain(
      "Repository inspection, reproduction, diagnosis, technical research, and technical planning are agent work.",
    );
    expect(prompt).toContain(
      "Product behavior, UX intent, scope authority, credentials, inaccessible facts",
    );
    expect(prompt).toContain('decision "ready-for-agent" and agentAction "implement"');
    expect(prompt).toContain('decision "ready-for-agent" and agentAction "plan"');
    expect(prompt).toContain(
      "Normal repository inspection to locate files, follow existing patterns, and write tests is part of implementation.",
    );
    expect(prompt).toContain(
      "only when the next useful deliverable should be a diagnosis, design, migration strategy, or risk-reduction plan",
    );
    expect(prompt).toContain(
      'prefer agentAction "implement" if repository evidence supports a straightforward safe change',
    );
    expect(prompt).toContain("agentAction is a recommendation, not a tracker phase");
  });

  it("keeps blockers orthogonal and requires grounded evidence", () => {
    const prompt = renderTriagePrompt(validContext());

    expect(prompt).toContain("A blocker does not create another decision");
    expect(prompt).toContain(
      "the outcome is already shipped but no duplicate work item represents it",
    );
    expect(prompt).toContain("Closing remains a human decision");
    expect(prompt).toContain("Tracker evidence uses path null");
    expect(prompt).toContain("portable repository-relative file path");
    expect(prompt).toContain(
      "When a collection is truncated, do not treat an absent item as proof that it does not exist.",
    );
    expect(prompt).toContain("not self-reported confidence");
  });

  it("requires route-specific rationale instead of an issue restatement", () => {
    const prompt = renderTriagePrompt(validContext());

    expect(prompt).toContain("Explain why the exact decision and agentAction are appropriate.");
    expect(prompt).toContain("Do not merely restate the issue or list the evidence.");
    expect(prompt).toContain(
      "For Implement, explain why the outcome and acceptance boundary support one safe implementation pass.",
    );
    expect(prompt).toContain(
      "For Plan, explain what makes editing premature or unsafe and how the next planning deliverable reduces that risk.",
    );
    expect(prompt).toContain(
      "For Needs Input, explain which human-only decision or scope boundary blocks useful agent work.",
    );
    expect(prompt).toContain(
      "For Duplicate, explain why the referenced work item represents the same outcome.",
    );
  });

  it("requires read-only structured output", () => {
    const prompt = renderTriagePrompt(validContext());

    expect(prompt).toContain("Remain read-only.");
    expect(prompt).toContain(
      "Return only the final JSON object matching the supplied structured-output schema.",
    );
    expect(prompt).toContain("Do not mutate files, work items, comments, labels, states");
  });

  it("rejects incomplete context before rendering", () => {
    const context = validContext();
    const invalid = { ...context, completeness: { ...context.completeness } } as Record<
      string,
      unknown
    >;
    delete (invalid.completeness as Record<string, unknown>).relationsTruncated;

    expect(() => renderTriagePrompt(invalid as TriageWorkItemContext)).toThrow(
      /relationsTruncated/,
    );
  });
});

function validContext(): TriageWorkItemContext {
  return {
    id: "issue-216",
    reference: "FER-216",
    title: "Define standalone triage",
    description: "Create a provider-independent triage policy.",
    url: "https://linear.app/issue/FER-216",
    state: "Backlog",
    labels: ["automation"],
    comments: [
      {
        author: "Felipe",
        body: "Keep planning out of the tracker workflow.",
        createdAt: "2026-07-19T12:00:00.000Z",
      },
    ],
    parent: null,
    children: [],
    duplicateOf: null,
    blockedBy: [],
    related: [],
    links: [{ title: "Triage example", url: "https://example.com/triage" }],
    createdAt: "2026-07-19T10:00:00.000Z",
    updatedAt: "2026-07-19T12:00:00.000Z",
    completeness: {
      commentsTruncated: true,
      labelsTruncated: false,
      relationsTruncated: false,
      linksTruncated: false,
      childrenTruncated: false,
    },
  };
}
