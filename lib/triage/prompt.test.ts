import { describe, expect, it } from "vitest";
import { renderTriagePrompt, TRIAGE_POLICY_VERSION } from "./prompt.ts";
import type { TriageWorkItemContext } from "./schema.ts";

describe("triage prompt", () => {
  it("renders deterministic work-item context and completeness signals", () => {
    const context = validContext();
    const prompt = renderTriagePrompt(context);

    expect(TRIAGE_POLICY_VERSION).toBe("5");
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
      "one stale-issue automation with an undecided age threshold and close behavior is bounded and can route to Spec",
    );
    expect(prompt).toContain(
      "Webhook ingress, triage, specification, implementation, and a dashboard are independent outcomes",
    );
    expect(prompt).toContain('decision "needs-input", scope "too-broad"');
    expect(prompt).toContain("recommend the smallest useful first slice");
    expect(prompt).toContain("ask exactly one question");
  });

  it("grounds bounded work in current repository intent without creating a ceremonial gate", () => {
    const prompt = renderTriagePrompt(validContext());

    expect(prompt).toContain("2. Ground bounded work in current repository intent.");
    expect(prompt).toContain(
      "Start with repository guidance such as AGENTS.md and README.md, then follow its links",
    );
    expect(prompt).toContain(
      "docs/project-intent.md, root VISION.md, PRODUCT.md, and decision docs are common examples, not required paths",
    );
    expect(prompt).toContain(
      "documented audience and goals, non-goals, hard invariants, ownership and source-of-truth boundaries",
    );
    expect(prompt).toContain(
      "Treat roadmaps, plans, proposals, and archived docs as context unless repository guidance marks them as current authority.",
    );
    expect(prompt).toContain(
      "When an accepted issue explicitly proposes changing current intent, treat that as a direction change",
    );
    expect(prompt).toContain(
      "Do not require an intent citation for narrow work where intent is not material.",
    );
    expect(prompt).toContain("Missing intent alone does not require human input.");
  });

  it("teaches intent-alignment close calls", () => {
    const prompt = renderTriagePrompt(validContext());

    expect(prompt).toContain("Intent close calls:");
    expect(prompt).toContain(
      "links a nonstandard intent source that supports a bounded change, use and cite it",
    );
    expect(prompt).toContain(
      "current intent rules out the proposed mechanism but permits compliant alternatives",
    );
    expect(prompt).toContain(
      "two current authoritative sources materially conflict and no useful investigation can begin",
    );
    expect(prompt).toContain(
      "no intent source exists for a narrow, well-specified local fix, choose Implement",
    );
    expect(prompt).toContain(
      "an archived roadmap or old plan conflicts with current intent, current intent wins",
    );
  });

  it("distinguishes agent work from prerequisite human input", () => {
    const prompt = renderTriagePrompt(validContext());

    expect(prompt).toContain(
      "Repository inspection, reproduction, diagnosis, technical research, intent-aligned option discovery, and technical specification are agent work.",
    );
    expect(prompt).toContain(
      "A later human choice or approval does not make input a prerequisite.",
    );
    expect(prompt).toContain(
      "For bounded work, choose Needs Input only when at least one prerequisite blocks all useful agent work, including Spec",
    );
    expect(prompt).toContain(
      "The desired outcome or success boundary is unknown or contradictory.",
    );
    expect(prompt).toContain(
      "A human must establish, reconcile, or explicitly override project direction before useful work can begin.",
    );
    expect(prompt).toContain('decision "ready-for-agent" and agentAction "implement"');
    expect(prompt).toContain('decision "ready-for-agent" and agentAction "spec"');
    expect(prompt).toContain(
      "Normal repository inspection to locate files, follow existing patterns, and write tests is part of implementation.",
    );
    expect(prompt).toContain(
      "Technical uncertainty that current code or tests can resolve within one normal implementation pass remains Implement.",
    );
    expect(prompt).toContain(
      "Choose Spec only when investigation or risk reduction must be completed before editing can safely begin.",
    );
    expect(prompt).toContain(
      "only when the next useful deliverable should be a diagnosis, design, migration strategy, or risk-reduction specification",
    );
    expect(prompt).toContain(
      "A useful Spec may research options, recommend one, and leave explicit decisions for later human review.",
    );
    expect(prompt).toContain(
      'prefer agentAction "implement" if repository and intent evidence support a straightforward safe change',
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
      "For Implement, explain why the outcome, acceptance boundary, and any material intent constraints support one safe implementation pass.",
    );
    expect(prompt).toContain(
      "For Spec, explain what useful artifact should be produced, how it reduces risk, and which material intent constraints or later reviewer decisions it should address.",
    );
    expect(prompt).toContain(
      "For Needs Input, explain which exact human prerequisite blocks all useful Implement and Spec work.",
    );
    expect(prompt).toContain(
      "For Duplicate, explain why the referenced work item represents the same outcome.",
    );
    expect(prompt).toContain(
      "When intent materially affects the route, name the source and constraint in the rationale",
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
