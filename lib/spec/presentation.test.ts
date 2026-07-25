import { describe, expect, it } from "vitest";
import {
  renderSpecFailureComment,
  renderSpecOutcomeComment,
  renderSpecPullRequest,
  reservedPullRequestUrl,
  SPEC_LINEAR_COMMENT_LIMIT,
  SPEC_PULL_REQUEST_BODY_LIMIT,
  SPEC_PULL_REQUEST_TITLE_LIMIT,
  type SpecRepositoryIdentity,
  type SpecWorkspaceChange,
  SpecPresentationError,
  validateSpecWorkspaceChanges,
} from "./presentation.ts";
import type { SpecDecision, SpecWorkItemContext } from "./schema.ts";
import type { SpecProvenance } from "./spec.ts";

const workItem: SpecWorkItemContext = {
  id: "issue-267",
  reference: "FER-267",
  title: "Run the independent Spec consumer",
  description: "Compose the existing primitives.",
  url: "https://linear.app/example/FER-267",
  state: "Open",
  labels: ["Spec"],
  comments: [],
  parent: null,
  children: [],
  duplicateOf: null,
  blockedBy: [],
  related: [],
  links: [],
  createdAt: "2026-07-25T10:00:00.000Z",
  updatedAt: "2026-07-25T10:00:00.000Z",
  completeness: {
    commentsTruncated: false,
    labelsTruncated: false,
    relationsTruncated: false,
    linksTruncated: false,
    childrenTruncated: false,
  },
};

const provenance: SpecProvenance = {
  provider: "codex",
  model: "gpt-5.6-sol",
  modelReasoningEffort: "high",
  policyVersion: "2",
  resultSchemaVersion: "1",
  promptSha256: "a".repeat(64),
  schemaSha256: "b".repeat(64),
  session: { provider: "codex", id: "thread-267" },
};

const ready: Extract<SpecDecision, { outcome: "ready-for-review" }> = {
  outcome: "ready-for-review",
  artifactPath: "dev/plans/FER-267.md",
  summary: "A small durable consumer composes the existing primitives.",
  evidence: [{ kind: "code", path: "lib/spec/spec.ts", summary: "Spec operation exists." }],
  reviewerDecisions: [
    {
      question: "Should the route be enabled?",
      options: [
        { option: "Enable", tradeoffs: "Starts the pilot." },
        { option: "Wait", tradeoffs: "Delays the pilot." },
      ],
      recommendation: "Enable",
      rationale: "The required primitives are complete.",
    },
  ],
  questions: [],
};

const needsInput: Extract<SpecDecision, { outcome: "needs-input" }> = {
  outcome: "needs-input",
  artifactPath: null,
  summary: "A product decision is required.",
  evidence: [{ kind: "tracker", path: null, summary: "The issue has conflicting goals." }],
  reviewerDecisions: [],
  questions: ["Which product boundary should own the behavior?"],
};

const repository: SpecRepositoryIdentity = {
  owner: "ferueda",
  repository: "harness",
};

describe("Spec workspace validation", () => {
  it("accepts one new issue artifact and the optional plan index", () => {
    const changes: SpecWorkspaceChange[] = [
      { path: "dev/plans/FER-267.md", status: "untracked" },
      { path: "dev/plans/README.md", status: "modified" },
    ];
    expect(
      validateSpecWorkspaceChanges({ reference: "FER-267", decision: ready, changes }),
    ).toEqual(changes);
  });

  it.each([
    [[{ path: "dev/plans/FER-267.md", status: "modified" }]],
    [[{ path: "lib/worker.ts", status: "modified" }]],
    [[{ path: "dev/plans/FER-267.md", status: "deleted" }]],
    [
      [
        { path: "dev/plans/FER-267.md", status: "untracked" },
        { path: "dev/plans/OTHER.md", status: "untracked" },
      ],
    ],
  ] satisfies readonly [SpecWorkspaceChange[]][])(
    "rejects an invalid ready-for-review change set",
    (changes) => {
      expect(() =>
        validateSpecWorkspaceChanges({ reference: "FER-267", decision: ready, changes }),
      ).toThrow(SpecPresentationError);
    },
  );

  it("requires Needs Input to leave a clean workspace", () => {
    expect(
      validateSpecWorkspaceChanges({ reference: "FER-267", decision: needsInput, changes: [] }),
    ).toEqual([]);
    expect(() =>
      validateSpecWorkspaceChanges({
        reference: "FER-267",
        decision: needsInput,
        changes: [{ path: "dev/plans/FER-267.md", status: "untracked" }],
      }),
    ).toThrow(/workspace clean/);
  });
});

describe("Spec presentation", () => {
  it("renders the locked PR and comment contracts within their bounds", () => {
    const pullRequest = renderSpecPullRequest({ workItem, decision: ready, provenance });
    const marker = "<!-- harness:linear-spec:work-1:ready-for-review -->";
    const comment = renderSpecOutcomeComment({
      marker,
      decision: ready,
      provenance,
      pullRequestUrl: "https://github.com/ferueda/harness/pull/250",
    });

    expect(pullRequest.title).toBe("FER-267: Spec for Run the independent Spec consumer");
    expect(pullRequest.title.length).toBeLessThanOrEqual(SPEC_PULL_REQUEST_TITLE_LIMIT);
    expect(pullRequest.body).toContain("## Decisions for review");
    expect(pullRequest.body).toContain("Recommendation: Enable");
    expect(pullRequest.body.length).toBeLessThanOrEqual(SPEC_PULL_REQUEST_BODY_LIMIT);
    expect(comment).toContain(marker);
    expect(comment).toContain("https://github.com/ferueda/harness/pull/250");
    expect(comment.length).toBeLessThanOrEqual(SPEC_LINEAR_COMMENT_LIMIT);
  });

  it("preserves every Needs Input question and the marker", () => {
    const marker = "<!-- harness:linear-spec:work-1:needs-input -->";
    const comment = renderSpecOutcomeComment({
      marker,
      decision: needsInput,
      provenance,
    });
    expect(comment).toContain(marker);
    expect(comment).toContain(needsInput.questions[0]);
    expect(comment).toContain("**Outcome:** Needs input");
  });

  it("fails closed when required content cannot fit after descriptive truncation", () => {
    const oversized: typeof needsInput = {
      ...needsInput,
      questions: Array.from({ length: 20 }, (_, index) => `${index}-${"q".repeat(500)}`),
    };
    expect(() =>
      renderSpecOutcomeComment({
        marker: "<!-- harness:linear-spec:work-1:needs-input -->",
        decision: oversized,
        provenance,
      }),
    ).toThrow(/8000-character limit/);
  });

  it("bounds failure prose and reserves the canonical maximum PR URL", () => {
    const marker = "<!-- harness:linear-spec:work-1:failure -->";
    const comment = renderSpecFailureComment({ marker, error: "x".repeat(20_000) });
    expect(comment).toContain(marker);
    expect(comment.length).toBeLessThan(SPEC_LINEAR_COMMENT_LIMIT);
    expect(reservedPullRequestUrl(repository)).toBe(
      "https://github.com/ferueda/harness/pull/99999999999999999999",
    );
  });
});
