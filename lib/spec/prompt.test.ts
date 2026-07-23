import { describe, expect, it } from "vitest";
import { renderSpecPrompt, SPEC_POLICY_VERSION } from "./prompt.ts";
import type { SpecWorkItemContext } from "./schema.ts";

describe("Spec prompt", () => {
  it("renders deterministic complete context and the exact issue-key artifact path", () => {
    const workItem = validContext();
    const artifactPath = "dev/plans/FER-273.md";
    const prompt = renderSpecPrompt({ workItem, artifactPath });

    expect(SPEC_POLICY_VERSION).toBe("2");
    expect(prompt).toContain(JSON.stringify(workItem, null, 2));
    expect(prompt).toContain(`Write the complete Spec at exactly ${artifactPath}`);
    expect(prompt).toContain(`artifactPath must be exactly "${artifactPath}"`);
    expect(prompt).toContain("Do not use a date or title slug.");
    expect(renderSpecPrompt({ workItem, artifactPath })).toBe(prompt);
  });

  it("grounds and reconciles the Spec in authority order before structuring it", () => {
    const prompt = renderSpecPrompt({
      workItem: validContext(),
      artifactPath: "dev/plans/FER-273.md",
    });

    expect(prompt).toContain("Read repository guidance such as AGENTS.md and README.md");
    expect(prompt).toContain("authoritative project intent or vision source");
    expect(prompt).toContain(
      "repository invariants and current project intent; explicit requirements and accepted decisions; verified codebase facts",
    );
    expect(prompt).toContain("Separate current behavior from requested behavior");
    expect(prompt).toContain("Research first");
    expect(prompt).toContain("Prefer one coherent recommended direction");
    expect(prompt).toContain("Mention a verified skill or aid beside a concrete change only");
    expect(prompt).toContain("A ready Spec requires repository evidence");
  });

  it("separates reviewer decisions from prerequisite human input", () => {
    const prompt = renderSpecPrompt({
      workItem: validContext(),
      artifactPath: "dev/plans/FER-273.md",
    });

    expect(prompt).toContain("Reserve Needs Input for a true prerequisite");
    expect(prompt).toContain("missing decision materially changes scope or architecture");
    expect(prompt).toContain("A later approval or human-authority product choice");
    expect(prompt).toContain("do not leave raw alternatives or unresolved implementation choices");
    expect(prompt).toContain("at least two unique options with tradeoffs");
    expect(prompt).toContain("recommendation that exactly matches an option");
    expect(prompt).toContain("must not be asked to resolve a reviewer decision");
    expect(prompt).toContain("reviewerDecisions must be []");
  });

  it("keeps the artifact decision-focused, right-sized, and portable", () => {
    const prompt = renderSpecPrompt({
      workItem: validContext(),
      artifactPath: "dev/plans/FER-273.md",
    });

    expect(prompt).toContain("Right-size the artifact");
    expect(prompt).toContain("Capture decisions, not code");
    expect(prompt).toContain("Do not pre-write implementation code or shell-command choreography");
    expect(prompt).toContain("label it as directional rather than an implementation specification");
    expect(prompt).toContain(
      "Do not embed provider-specific or tool-specific executor instructions",
    );
    expect(prompt).toContain("Explicitly defer ordinary execution-time discovery");
  });

  it("shapes multi-unit work vertically and explains necessary horizontal units", () => {
    const prompt = renderSpecPrompt({
      workItem: validContext(),
      artifactPath: "dev/plans/FER-273.md",
    });

    expect(prompt).toContain("Prefer vertical slices");
    expect(prompt).toContain("separate agents can own with limited overlap");
    expect(prompt).toContain("Do not divide work mechanically by repository layer");
    expect(prompt).toContain("vertical delivery is impractical or unsafe");
  });

  it("selects the highest stable proof seam", () => {
    const prompt = renderSpecPrompt({
      workItem: validContext(),
      artifactPath: "dev/plans/FER-273.md",
    });

    expect(prompt).toContain("highest existing stable test seam that proves acceptance");
    expect(prompt).toContain("distinct invariant or failure mode");
    expect(prompt).toContain("repository's canonical gate");
  });

  it("keeps the agent inside the operation boundary", () => {
    const prompt = renderSpecPrompt({
      workItem: validContext(),
      artifactPath: "dev/plans/FER-273.md",
    });

    expect(prompt).toContain("Do not edit product code.");
    expect(prompt).toContain("Do not create branches, commits, or pull requests.");
    expect(prompt).toContain(
      "Reconcile dev/plans/README.md only when repository guidance explicitly requires it.",
    );
    expect(prompt).toContain("Return only the final JSON object matching the supplied schema.");
  });

  it("rejects incomplete work-item context before rendering", () => {
    const context = validContext();
    const invalid = { ...context, completeness: { ...context.completeness } } as Record<
      string,
      unknown
    >;
    delete (invalid.completeness as Record<string, unknown>).relationsTruncated;

    expect(() =>
      renderSpecPrompt({
        workItem: invalid as SpecWorkItemContext,
        artifactPath: "dev/plans/FER-273.md",
      }),
    ).toThrow(/relationsTruncated/);
  });
});

function validContext(): SpecWorkItemContext {
  return {
    id: "issue-273",
    reference: "FER-273",
    title: "Build a provider-neutral Spec operation",
    description: "Write one code-grounded implementation Spec.",
    url: "https://linear.app/issue/FER-273",
    state: "Open",
    labels: ["Spec"],
    comments: [
      {
        author: "Felipe",
        body: "Use the Linear identifier as the filename.",
        createdAt: "2026-07-22T20:00:00.000Z",
      },
    ],
    parent: {
      id: "issue-211",
      reference: "FER-211",
      title: "Build modular Linear automation",
      url: "https://linear.app/issue/FER-211",
      state: "In Progress",
    },
    children: [],
    duplicateOf: null,
    blockedBy: [],
    related: [
      {
        id: "issue-280",
        reference: "FER-280",
        title: "Decompose oversized modules",
        url: "https://linear.app/issue/FER-280",
        state: "Done",
      },
    ],
    links: [{ title: "Design reference", url: "https://example.com/design" }],
    createdAt: "2026-07-21T22:12:57.641Z",
    updatedAt: "2026-07-22T20:00:00.000Z",
    completeness: {
      commentsTruncated: true,
      labelsTruncated: false,
      relationsTruncated: false,
      linksTruncated: false,
      childrenTruncated: false,
    },
  };
}
