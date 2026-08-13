import { describe, expect, it } from "vitest";
import type { SpecReviewProvenance } from "../spec-review/review.ts";
import type { SpecReviewDecision, SpecReviewFinding } from "../spec-review/schema.ts";
import {
  renderSpecFailureComment,
  renderSpecOutcomeComment,
  renderSpecPullRequest,
  renderSpecRevisionNeedsInputComment,
  renderReviewedSpecOutcomeComment,
  renderReviewedSpecPullRequest,
  reservedPullRequestUrl,
  SPEC_LINEAR_COMMENT_LIMIT,
  SPEC_PULL_REQUEST_BODY_LIMIT,
  SPEC_PULL_REQUEST_TITLE_LIMIT,
  type SpecRepositoryIdentity,
  type SpecWorkspaceChange,
  SpecPresentationError,
  validateSpecRevisionWorkspaceChanges,
  validateSpecWorkspaceChanges,
} from "./presentation.ts";
import type { SpecRevisionProvenance } from "./revise.ts";
import type { SpecRevisionDecision } from "./revise-schema.ts";
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

const finding: SpecReviewFinding = {
  id: `spec-review-finding-${"c".repeat(64)}`,
  criterion: "architecture",
  artifactLocation: {
    section: "Changes",
    lineStart: 14,
    lineEnd: 18,
  },
  evidence: [
    {
      source: "code",
      path: "lib/spec/presentation.ts",
      lineStart: 1,
      lineEnd: 4,
      summary: "The renderer owns the handoff contract.",
    },
  ],
  problem: "The plan does not yet define the final publication boundary.",
  requiredOutcome: "Name the exact checkpoint publication operation.",
};

const approvedReview: SpecReviewDecision = {
  outcome: "approved",
  rationale: "The Spec is scoped, grounded, and executable.",
  evidence: finding.evidence,
  findings: [],
};

const changesRequestedReview: SpecReviewDecision = {
  outcome: "changes-requested",
  rationale: "One required boundary remains unresolved.",
  findings: [finding],
};

const reviewProvenance: SpecReviewProvenance = {
  provider: "codex",
  model: "gpt-5.6-sol",
  modelReasoningEffort: "high",
  rubricVersion: "2",
  promptVersion: "2",
  resultSchemaVersion: "2",
  promptSha256: "c".repeat(64),
  schemaSha256: "d".repeat(64),
  artifactSha256: "e".repeat(64),
};

const revisionProvenance: SpecRevisionProvenance = {
  provider: "codex",
  model: "gpt-5.6-sol",
  modelReasoningEffort: "high",
  policyVersion: "1",
  resultSchemaVersion: "1",
  reviewRubricVersion: "2",
  promptSha256: "f".repeat(64),
  schemaSha256: "a".repeat(64),
  artifactBeforeSha256: "b".repeat(64),
  artifactAfterSha256: "b".repeat(64),
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

describe("Spec revision workspace validation", () => {
  it("accepts only one modified existing issue artifact for an updated revision", () => {
    const changes: SpecWorkspaceChange[] = [{ path: "dev/plans/FER-267.md", status: "modified" }];

    expect(
      validateSpecRevisionWorkspaceChanges({
        reference: "FER-267",
        outcome: "updated",
        changes,
      }),
    ).toEqual(changes);
  });

  it.each([
    [[]],
    [[{ path: "dev/plans/FER-267.md", status: "untracked" }]],
    [[{ path: "dev/plans/OTHER.md", status: "modified" }]],
    [
      [
        { path: "dev/plans/FER-267.md", status: "modified" },
        { path: "dev/plans/README.md", status: "modified" },
      ],
    ],
  ] satisfies readonly [SpecWorkspaceChange[]][])(
    "rejects an unsupported updated revision change set",
    (changes) => {
      expect(() =>
        validateSpecRevisionWorkspaceChanges({
          reference: "FER-267",
          outcome: "updated",
          changes,
        }),
      ).toThrow(/modify only the existing/);
    },
  );

  it.each(["unchanged", "needs-input"] as const)(
    "requires %s revisions to leave a clean workspace",
    (outcome) => {
      expect(
        validateSpecRevisionWorkspaceChanges({
          reference: "FER-267",
          outcome,
          changes: [],
        }),
      ).toEqual([]);
      expect(() =>
        validateSpecRevisionWorkspaceChanges({
          reference: "FER-267",
          outcome,
          changes: [{ path: "dev/plans/FER-267.md", status: "modified" }],
        }),
      ).toThrow(/workspace clean/);
    },
  );
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
    expect(comment).toContain("No workspace is retained automatically");
    expect(comment).toContain("manually requeue");
    expect(comment.length).toBeLessThan(SPEC_LINEAR_COMMENT_LIMIT);
    expect(reservedPullRequestUrl(repository)).toBe(
      "https://github.com/ferueda/harness/pull/99999999999999999999",
    );
  });

  it("renders an approved reviewed Spec for the PR and Linear handoff", () => {
    const pullRequest = renderReviewedSpecPullRequest({
      workItem,
      specDecision: ready,
      specProvenance: provenance,
      reviewDecision: approvedReview,
      reviewProvenance,
      approved: true,
    });
    const comment = renderReviewedSpecOutcomeComment({
      marker: "<!-- harness:linear-spec:work-1:approved -->",
      workItem,
      specDecision: ready,
      specProvenance: provenance,
      reviewDecision: approvedReview,
      reviewProvenance,
      approved: true,
      pullRequestUrl: "https://github.com/ferueda/harness/pull/320",
    });

    expect(pullRequest.title).toBe("FER-267: Spec for Run the independent Spec consumer");
    expect(pullRequest.body).toContain("**Approved by automated Spec review.**");
    expect(pullRequest.body).toContain("- Review rubric: 2");
    expect(comment).toContain("**Outcome:** Approved and ready for human review");
    expect(comment).not.toContain("Unresolved findings");
  });

  it("marks an exhausted Spec unapproved and preserves every bounded finding ID", () => {
    const findings = Array.from({ length: 12 }, (_, index): SpecReviewFinding => ({
      ...finding,
      id: `spec-review-finding-${index.toString(16).padStart(64, "0")}`,
      problem: `${index}: ${"p".repeat(2_000)}`,
    }));
    const decision: SpecReviewDecision = {
      ...changesRequestedReview,
      findings,
    };
    const pullRequest = renderReviewedSpecPullRequest({
      workItem,
      specDecision: ready,
      specProvenance: provenance,
      reviewDecision: decision,
      reviewProvenance,
      approved: false,
    });
    const comment = renderReviewedSpecOutcomeComment({
      marker: "<!-- harness:linear-spec:work-1:exhausted -->",
      workItem,
      specDecision: ready,
      specProvenance: provenance,
      reviewDecision: decision,
      reviewProvenance,
      approved: false,
      pullRequestUrl: "https://github.com/ferueda/harness/pull/320",
    });

    expect(pullRequest.title).toMatch(/^\[UNAPPROVED\]/);
    expect(pullRequest.body).toContain("bounded automated review cycle was exhausted");
    expect(comment).toContain("**Outcome:** Automated review exhausted — unapproved");
    for (const unresolved of findings) {
      expect(pullRequest.body).toContain(unresolved.id);
      expect(comment).toContain(unresolved.id);
    }
    expect(pullRequest.body.length).toBeLessThanOrEqual(SPEC_PULL_REQUEST_BODY_LIMIT);
    expect(comment.length).toBeLessThanOrEqual(SPEC_LINEAR_COMMENT_LIMIT);
  });

  it("rejects a reviewed presentation whose approval flag contradicts its decision", () => {
    expect(() =>
      renderReviewedSpecPullRequest({
        workItem,
        specDecision: ready,
        specProvenance: provenance,
        reviewDecision: changesRequestedReview,
        reviewProvenance,
        approved: true,
      }),
    ).toThrow(/requires an approved review decision/);
  });

  it("renders a bounded revision Needs Input handoff with finding responses", () => {
    const decision: SpecRevisionDecision = {
      outcome: "needs-input",
      rationale: "The reviewer exposed a choice that changes the public contract.",
      responses: [
        {
          findingId: finding.id,
          disposition: "accepted",
          rationale: "The finding is valid, but the required outcome depends on the owner.",
          evidence: finding.evidence,
        },
      ],
      questions: ["Should publication expose the draft artifact before approval?"],
    };
    const comment = renderSpecRevisionNeedsInputComment({
      marker: "<!-- harness:linear-spec:work-1:revision-needs-input -->",
      decision,
      provenance: revisionProvenance,
    });

    expect(comment).toContain("**Outcome:** Needs input");
    expect(comment).toContain(decision.questions[0]);
    expect(comment).toContain(finding.id);
    expect(comment).toContain("**accepted**");
    expect(comment.length).toBeLessThanOrEqual(SPEC_LINEAR_COMMENT_LIMIT);
  });

  it("rejects a revision Needs Input comment for a non-needs-input decision", () => {
    expect(() =>
      renderSpecRevisionNeedsInputComment({
        marker: "<!-- harness:linear-spec:work-1:revision-needs-input -->",
        decision: {
          outcome: "unchanged",
          rationale: "The author declined the findings with evidence.",
          responses: [
            {
              findingId: finding.id,
              disposition: "declined",
              rationale: "The cited code already enforces this boundary.",
              evidence: finding.evidence,
            },
          ],
          questions: [],
        },
        provenance: revisionProvenance,
      }),
    ).toThrow(/requires a needs-input decision/);
  });
});
