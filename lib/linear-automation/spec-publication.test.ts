import { describe, expect, it, vi } from "vitest";
import type { GitHubPublicationService } from "../github/types.ts";
import type { LinearIssueContext } from "../linear/types.ts";
import type { RepositoryCheckpoint, RepositoryRun } from "../repository/types.ts";
import type { SpecReviewProvenance } from "../spec-review/review.ts";
import type { SpecReviewDecision } from "../spec-review/schema.ts";
import type { SpecDecision } from "../spec/schema.ts";
import type { SpecProvenance } from "../spec/spec.ts";
import type { WorkRequestData } from "./events/work-events.ts";
import { linearReadinessSnapshotGeneration, type LinearReadinessConfig } from "./readiness.ts";
import { loadEligibleSpec } from "./spec-authority.ts";
import { publishReviewedSpecCheckpoint } from "./spec-publication.ts";

const readiness: LinearReadinessConfig = {
  teamId: "team-1",
  projectId: "project-1",
  stateIds: {
    backlog: "backlog",
    open: "open",
    inProgress: "in-progress",
    needsInput: "needs-input",
    needsReview: "needs-review",
    done: "done",
    canceled: "canceled",
    duplicate: "duplicate",
  },
  agentActionLabelIds: { spec: "spec", implement: "implement" },
  agentReadyLabelId: "agent-ready",
  enabledRoutes: { triage: true, spec: true, implement: false },
};

describe("reviewed Spec publication", () => {
  it("rejects an oversized permanent presentation before calling GitHub", async () => {
    let context = issueContext();
    const linear = { getIssueContext: async () => structuredClone(context) };
    const event: WorkRequestData = {
      issueId: context.id,
      issueIdentifier: context.identifier,
      causationEventId: "cause-1",
      snapshotGeneration: linearReadinessSnapshotGeneration(context, readiness),
    };
    const loaded = await loadEligibleSpec(linear, event, readiness);
    if (loaded.kind !== "eligible") throw new Error("expected eligible Spec");
    context = {
      ...context,
      state: { id: readiness.stateIds.inProgress, name: "In Progress", type: "started" },
      labels: [{ id: readiness.agentActionLabelIds.spec, name: "Spec" }],
    };
    const publish = vi.fn<GitHubPublicationService["publishCheckpointPullRequest"]>();

    const result = await publishReviewedSpecCheckpoint({
      linear,
      authority: loaded.authority,
      readiness,
      github: { publishCheckpointPullRequest: publish },
      repository: {
        owner: "ferueda",
        repository: "harness",
        httpsRemote: "https://github.com/ferueda/harness.git",
      },
      run,
      checkpoint,
      baseRef: "main",
      commentIdentity: "cycle-1",
      specDecision: oversizedSpecDecision(),
      specProvenance,
      reviewDecision,
      reviewProvenance,
      approved: true,
    });

    expect(result).toMatchObject({ kind: "invalid" });
    expect(publish).not.toHaveBeenCalled();
  });
});

const run: RepositoryRun = {
  version: 1,
  id: "run-1",
  workspace: "/tmp/harness-spec-publication",
  remote: "https://github.com/ferueda/harness.git",
  baseRef: "main",
  baseSha: "a".repeat(40),
  branch: "harness/spec/FER-320",
};

const checkpoint: RepositoryCheckpoint = {
  version: 1,
  id: "checkpoint-1",
  runId: run.id,
  baseSha: run.baseSha,
  parentRevision: run.baseSha,
  revision: "b".repeat(40),
  branch: run.branch,
  changes: [{ path: "dev/plans/FER-320.md", status: "added" }],
};

const specProvenance: SpecProvenance = {
  provider: "codex",
  model: "gpt-5.6-sol",
  modelReasoningEffort: "high",
  policyVersion: "2",
  resultSchemaVersion: "1",
  promptSha256: "c".repeat(64),
  schemaSha256: "d".repeat(64),
  session: { provider: "codex", id: "author-1" },
};

const reviewDecision: SpecReviewDecision = {
  outcome: "approved",
  rationale: "The Spec is executable.",
  evidence: [
    {
      source: "artifact",
      path: "dev/plans/FER-320.md",
      lineStart: 1,
      lineEnd: 1,
      summary: "The Spec is scoped.",
    },
  ],
  findings: [],
};

const reviewProvenance: SpecReviewProvenance = {
  provider: "codex",
  model: "gpt-5.6-sol",
  modelReasoningEffort: "high",
  rubricVersion: "2",
  promptVersion: "2",
  resultSchemaVersion: "2",
  promptSha256: "e".repeat(64),
  schemaSha256: "f".repeat(64),
  artifactSha256: "1".repeat(64),
};

function oversizedSpecDecision(): Extract<SpecDecision, { outcome: "ready-for-review" }> {
  const huge = "x".repeat(4_000);
  return {
    outcome: "ready-for-review",
    artifactPath: "dev/plans/FER-320.md",
    summary: "Bounded Spec cycle.",
    evidence: [
      {
        kind: "code",
        path: "lib/linear-automation/spec-consumer.ts",
        summary: "The consumer coordinates the cycle.",
      },
    ],
    reviewerDecisions: Array.from({ length: 20 }, (_, index) => ({
      question: `${index}: ${huge}`,
      options: [
        { option: "A", tradeoffs: huge },
        { option: "B", tradeoffs: huge },
      ],
      recommendation: "A",
      rationale: huge,
    })),
    questions: [],
  };
}

function issueContext(): LinearIssueContext {
  return {
    id: "issue-320",
    identifier: "FER-320",
    title: "Run a bounded Spec cycle",
    description: "Compose existing primitives.",
    url: "https://linear.app/example/FER-320",
    state: { id: readiness.stateIds.open, name: "Open", type: "unstarted" },
    team: { id: readiness.teamId, key: "FER", name: "ferueda" },
    project: { id: readiness.projectId, name: "Harness", url: null },
    assignee: null,
    creator: null,
    labels: [
      { id: readiness.agentActionLabelIds.spec, name: "Spec" },
      { id: readiness.agentReadyLabelId, name: "Agent Ready" },
    ],
    comments: [],
    parent: null,
    children: [],
    duplicateOf: null,
    blockedBy: [],
    related: [],
    attachments: [],
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T01:00:00.000Z",
    completeness: {
      commentsTruncated: false,
      labelsTruncated: false,
      relationsTruncated: false,
      attachmentsTruncated: false,
      childrenTruncated: false,
    },
  };
}
