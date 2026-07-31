import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inngest } from "inngest";
import { InngestTestEngine } from "@inngest/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentRunResult } from "../agent/contract.ts";
import type { GitHubPublicationService } from "../github/types.ts";
import type { LinearIssueContext } from "../linear/types.ts";
import type { RepositoryService } from "../repository/types.ts";
import type { ChangeReviewResult } from "../../workflows/change-review.workflow.ts";
import { createImplementationReviewFindingId } from "../implementation/finding-identity.ts";
import type { ImplementationRevisionDecision } from "../implementation/revise-schema.ts";
import {
  createLinearImplementationFunction,
  type ImplementationReviewRunner,
  type LinearImplementationFunctionConfig,
  type LinearImplementationService,
} from "./implementation-consumer.ts";
import {
  ImplementationWorkRequestedEvent,
  type ImplementationWorkRequestData,
  workRequestEventId,
} from "./events/work-events.ts";
import { linearReadinessSnapshotGeneration, type LinearReadinessConfig } from "./readiness.ts";
import {
  implementationSourceFingerprint,
  loadEligibleImplementation,
} from "./implementation-authority.ts";
import {
  beginImplementationFailureRecovery,
  projectImplementationOutcome,
} from "./implementation-projection.ts";

const ISSUE = "FER-326";
const roots: string[] = [];
const readiness: LinearReadinessConfig = {
  teamId: "team-1",
  projectId: "project-1",
  stateIds: {
    backlog: "state-backlog",
    open: "state-open",
    inProgress: "state-in-progress",
    needsInput: "state-needs-input",
    needsReview: "state-needs-review",
    done: "state-done",
    canceled: "state-canceled",
    duplicate: "state-duplicate",
  },
  agentActionLabelIds: { spec: "label-spec", implement: "label-implement" },
  agentReadyLabelId: "label-agent-ready",
  enabledRoutes: { triage: true, spec: false, implement: true },
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function issueContext(_input: { needsInput?: boolean } = {}): LinearIssueContext {
  return {
    id: "issue-326",
    identifier: ISSUE,
    title: "Run Implement issues through a bounded Inngest review cycle",
    description: "Implement the selected work item.",
    url: `https://linear.app/example/${ISSUE}`,
    state: { id: readiness.stateIds.open, name: "Open", type: "unstarted" },
    team: { id: readiness.teamId, key: "FER", name: "ferueda" },
    project: { id: readiness.projectId, name: "Harness", url: "https://linear.app/project" },
    assignee: null,
    creator: null,
    labels: [
      { id: readiness.agentActionLabelIds.implement, name: "Implement" },
      { id: readiness.agentReadyLabelId, name: "Agent Ready" },
    ],
    comments: [],
    parent: null,
    children: [],
    duplicateOf: null,
    blockedBy: [],
    related: [],
    attachments: [],
    createdAt: "2026-07-30T10:00:00.000Z",
    updatedAt: "2026-07-30T10:00:00.000Z",
    completeness: {
      commentsTruncated: false,
      labelsTruncated: false,
      relationsTruncated: false,
      attachmentsTruncated: false,
      childrenTruncated: false,
    },
  };
}

function workEvent(
  context: LinearIssueContext,
): ReturnType<typeof ImplementationWorkRequestedEvent.create> {
  const data: ImplementationWorkRequestData = {
    issueId: context.id,
    issueIdentifier: context.identifier,
    causationEventId: "linear-revision-1",
    snapshotGeneration: linearReadinessSnapshotGeneration(context, readiness),
    sourceFingerprint: implementationSourceFingerprint(context, readiness),
  };
  return ImplementationWorkRequestedEvent.create(data, {
    id: workRequestEventId("implement", data),
  });
}

function fakeLinear(
  initial: LinearIssueContext,
  options: { failStateOnce?: boolean; failLabelsOnce?: boolean } = {},
) {
  const state = { context: initial, comments: new Map<string, string>() };
  const service: LinearImplementationService = {
    getIssueContext: vi.fn<LinearImplementationService["getIssueContext"]>(async () =>
      structuredClone(state.context),
    ),
    updateIssueState: vi.fn<LinearImplementationService["updateIssueState"]>(
      async (input: Parameters<LinearImplementationService["updateIssueState"]>[0]) => {
        if (options.failStateOnce) {
          options.failStateOnce = false;
          throw new Error("state response lost");
        }
        if (
          state.context.state.id !== input.expectedStateId &&
          state.context.state.id !== input.stateId
        ) {
          throw new Error("state conflict");
        }
        state.context = {
          ...state.context,
          state: { ...state.context.state, id: input.stateId },
        };
        return { changed: true, stateId: input.stateId };
      },
    ),
    updateIssueLabels: vi.fn<LinearImplementationService["updateIssueLabels"]>(
      async (input: Parameters<LinearImplementationService["updateIssueLabels"]>[0]) => {
        if (options.failLabelsOnce) {
          options.failLabelsOnce = false;
          throw new Error("label response lost");
        }
        const removed = new Set(input.removeLabelIds);
        const labels = state.context.labels.filter((label) => !removed.has(label.id));
        const current = new Set(labels.map((label) => label.id));
        state.context = {
          ...state.context,
          labels: [
            ...labels,
            ...input.addLabelIds.filter((id) => !current.has(id)).map((id) => ({ id, name: id })),
          ],
        };
        return {
          submitted: true,
          addedLabelIds: input.addLabelIds,
          removedLabelIds: input.removeLabelIds,
        };
      },
    ),
    ensureComment: vi.fn<LinearImplementationService["ensureComment"]>(
      async (input: Parameters<LinearImplementationService["ensureComment"]>[0]) => {
        const created = !state.comments.has(input.marker);
        if (created) state.comments.set(input.marker, input.body);
        return { created, id: `comment-${state.comments.size}` };
      },
    ),
  };
  return { state, service };
}

function fakeRepository(
  workspace: string,
  changes: () => readonly [{ path: string; status: "added" }] | [],
) {
  const run = {
    version: 1 as const,
    id: "run-326",
    workspace,
    remote: "https://github.com/example/project.git",
    baseRef: "main",
    baseSha: "a".repeat(40),
    branch: "harness/implementation/FER-326-test",
  };
  const checkpoint = (id: string, parentRevision = run.baseSha) => ({
    version: 1 as const,
    id,
    runId: run.id,
    baseSha: run.baseSha,
    parentRevision,
    revision: id === "initial" ? "b".repeat(40) : "c".repeat(40),
    branch: run.branch,
    changes: changes(),
  });
  const service: RepositoryService = {
    resolveBase: vi.fn<RepositoryService["resolveBase"]>(async () => ({
      remote: run.remote,
      baseRef: run.baseRef,
      baseSha: run.baseSha,
    })),
    prepareRun: vi.fn<RepositoryService["prepareRun"]>(async () => run),
    recoverRun: vi.fn<RepositoryService["recoverRun"]>(async () => run),
    inspectChanges: vi.fn<RepositoryService["inspectChanges"]>(async () => changes()),
    checkpointRun: vi.fn<RepositoryService["checkpointRun"]>(async (input) =>
      checkpoint(input.id.includes("initial") ? "initial" : input.id, input.expectedParentRevision),
    ),
    openCheckpoint: vi.fn<RepositoryService["openCheckpoint"]>(async () => run),
    cleanupRun: vi.fn<RepositoryService["cleanupRun"]>(async () => ({
      status: "released" as const,
    })),
  };
  return { run, service };
}

function implementationAgent(workspace: string, needsInput: boolean, onChange?: () => void): Agent {
  let calls = 0;
  return {
    name: "codex",
    run: vi.fn<Agent["run"]>(async (): Promise<AgentRunResult> => {
      calls += 1;
      if (!needsInput) {
        writeFileSync(join(workspace, "implementation.txt"), `${calls}\n`, "utf8");
        onChange?.();
      }
      return {
        ok: true,
        structuredOutput: needsInput
          ? {
              outcome: "needs-input",
              summary: "A human decision is required before implementation.",
              proof: [],
              remainingUncertainty: [],
              questions: ["Which behavior should the implementation preserve?"],
            }
          : {
              outcome: "implemented",
              summary: "Implemented the requested behavior.",
              proof: [{ action: "focused test", status: "passed", observedResult: "passed" }],
              remainingUncertainty: [],
              questions: [],
            },
        session: { provider: "codex", id: "session-326" },
        raw: {},
      };
    }),
  };
}

const revisionFinding = {
  title: "The implementation skips a required guard.",
  severity: "High" as const,
  location: "lib/example.ts:10",
  issue: "The selected source can be used without validation.",
  recommendation: "Validate the source before publishing.",
  rationale: "Publishing unvalidated work can produce an unsafe pull request.",
};

function revisionFindingId(): string {
  return createImplementationReviewFindingId({
    reviewedRevision: "b".repeat(40),
    reviewer: "implementation",
    finding: revisionFinding,
  });
}

function reviewNeedsChanges(): Extract<ChangeReviewResult, { status: "completed" }> {
  return {
    status: "completed" as const,
    verdict: "needs_changes" as const,
    reviewOutputs: {
      implementation: {
        verdict: "needs_changes" as const,
        summary: "One implementation guard is missing.",
        findings: [{ ...revisionFinding, must_fix: true }],
      },
      quality: { verdict: "pass" as const, summary: "Looks good.", findings: [] },
    },
    reviewFailures: [] as const,
    runId: "review-326",
    runDir: "/tmp/review-326",
    workspace: "/tmp/workspace",
    scope: { baseRef: "main", headRef: "HEAD", mergeBase: "a".repeat(40), headSha: "b".repeat(40) },
  };
}

function revisionDecision(
  outcome: "updated" | "unchanged" | "needs-input",
): ImplementationRevisionDecision {
  const response = {
    findingId: revisionFindingId(),
    disposition: outcome === "unchanged" ? ("declined" as const) : ("accepted" as const),
    rationale: "The finding was evaluated against the selected source.",
    evidence:
      outcome === "updated"
        ? []
        : [
            {
              source: "repo-state" as const,
              path: null,
              lineStart: null,
              lineEnd: null,
              summary: "The current repository state was inspected.",
            },
          ],
  };
  if (outcome === "needs-input") {
    return {
      outcome,
      rationale: "The finding exposes a project decision that must be resolved first.",
      responses: [response],
      proof: [],
      remainingUncertainty: [],
      questions: ["Which project invariant should this implementation preserve?"],
    };
  }
  return {
    outcome,
    rationale: "The finding was evaluated against the selected source.",
    responses: [response],
    proof: [{ action: "focused test", status: "passed", observedResult: "passed" }],
    remainingUncertainty: [],
    questions: [],
  };
}

function implementationAgentWithRevision(
  workspace: string,
  outcome: "updated" | "unchanged" | "needs-input",
  onInitialChange: () => void,
  onRevisionChange: () => void,
): Agent {
  return {
    name: "codex",
    run: vi.fn<Agent["run"]>(async (input): Promise<AgentRunResult> => {
      if (input.schemaPath?.endsWith("implementation-revision-result.schema.json")) {
        if (outcome === "updated") {
          writeFileSync(join(workspace, "revision.txt"), "revised\n", "utf8");
          onRevisionChange();
        } else {
          onRevisionChange();
        }
        return {
          ok: true,
          structuredOutput: revisionDecision(outcome),
          session: { provider: "codex", id: "session-326-revision" },
          raw: {},
        };
      }
      writeFileSync(join(workspace, "implementation.txt"), "initial\n", "utf8");
      onInitialChange();
      return {
        ok: true,
        structuredOutput: {
          outcome: "implemented",
          summary: "Implemented the requested behavior.",
          proof: [{ action: "focused test", status: "passed", observedResult: "passed" }],
          remainingUncertainty: [],
          questions: [],
        },
        session: { provider: "codex", id: "session-326" },
        raw: {},
      };
    }),
  };
}

function github(): GitHubPublicationService {
  return {
    publishCheckpointPullRequest: vi.fn<GitHubPublicationService["publishCheckpointPullRequest"]>(
      async (input) => ({
        url: "https://github.com/example/project/pull/326",
        number: 326,
        owner: "example",
        repository: "project",
        baseBranch: input.baseBranch,
        headBranch: input.run.branch,
        headSha: input.checkpoint.revision,
        state: "open" as const,
        merged: false,
      }),
    ),
  };
}

function reviewPass(): Extract<ChangeReviewResult, { status: "completed" }> {
  return {
    status: "completed" as const,
    verdict: "pass" as const,
    reviewOutputs: {
      implementation: { verdict: "pass" as const, summary: "Looks good.", findings: [] },
      quality: { verdict: "pass" as const, summary: "Looks good.", findings: [] },
    },
    reviewFailures: [] as const,
    runId: "review-326",
    runDir: "/tmp/review-326",
    workspace: "/tmp/workspace",
    scope: { baseRef: "main", headRef: "HEAD", mergeBase: "a".repeat(40), headSha: "b".repeat(40) },
  };
}

async function execute(input: {
  context: LinearIssueContext;
  agent: Agent;
  repository: RepositoryService;
  linear: LinearImplementationService;
  review: ImplementationReviewRunner;
  github: GitHubPublicationService;
  configOverrides?: Partial<
    Pick<LinearImplementationFunctionConfig, "baseRef" | "githubRepository">
  >;
}) {
  const client = new Inngest({ id: "implementation-test", eventKey: "test" });
  const fn = createLinearImplementationFunction({
    client,
    linear: input.linear,
    implementerAgent: input.agent,
    review: input.review,
    repository: input.repository,
    github: input.github,
    config: {
      readiness,
      baseRef: input.configOverrides?.baseRef ?? "main",
      execution: { model: "gpt-test", modelReasoningEffort: "medium", maxRuntimeMs: 120_000 },
      githubRepository: input.configOverrides?.githubRepository ?? {
        owner: "example",
        repository: "project",
        httpsRemote: "https://github.com/example/project.git",
      },
    },
  });
  return new InngestTestEngine({ function: fn, events: [workEvent(input.context)] }).execute();
}

describe("Linear implementation consumer", () => {
  it("publishes the exact checkpoint and projects Needs Review", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "harness-implementation-"));
    roots.push(workspace);
    const linear = fakeLinear(issueContext());
    let changed = false;
    const repository = fakeRepository(workspace, () =>
      changed ? [{ path: "implementation.txt", status: "added" }] : [],
    );
    const review = vi.fn<ImplementationReviewRunner>(async () => reviewPass());
    const output = await execute({
      context: issueContext(),
      agent: implementationAgent(workspace, false, () => {
        changed = true;
      }),
      repository: repository.service,
      linear: linear.service,
      review,
      github: github(),
    });

    expect(output.result).toMatchObject({
      outcome: "published",
      pullRequestUrl: "https://github.com/example/project/pull/326",
      review: "passed",
    });
    expect(linear.state.context.state.id).toBe(readiness.stateIds.needsReview);
    expect(linear.state.context.labels).toHaveLength(0);
    expect(review).toHaveBeenCalledTimes(1);
    expect(repository.service.cleanupRun).toHaveBeenCalledTimes(1);
  });

  it("uses normalized publication settings", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "harness-implementation-"));
    roots.push(workspace);
    const linear = fakeLinear(issueContext());
    let changed = false;
    const repository = fakeRepository(workspace, () =>
      changed ? [{ path: "implementation.txt", status: "added" }] : [],
    );
    const publication = github();
    const output = await execute({
      context: issueContext(),
      agent: implementationAgent(workspace, false, () => {
        changed = true;
      }),
      repository: repository.service,
      linear: linear.service,
      review: vi.fn<ImplementationReviewRunner>(async () => reviewPass()),
      github: publication,
      configOverrides: {
        baseRef: " main ",
        githubRepository: {
          owner: " example ",
          repository: " project ",
          httpsRemote: "https://github.com/example/project.git",
        },
      },
    });

    expect(output.result).toMatchObject({ outcome: "published" });
    expect(publication.publishCheckpointPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ baseBranch: "main" }),
    );
  });

  it("stops for human input without checkpoint or publication", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "harness-implementation-"));
    roots.push(workspace);
    const linear = fakeLinear(issueContext());
    const repository = fakeRepository(workspace, () => []);
    const review = vi.fn<ImplementationReviewRunner>(async () => reviewPass());
    const output = await execute({
      context: issueContext(),
      agent: implementationAgent(workspace, true),
      repository: repository.service,
      linear: linear.service,
      review,
      github: github(),
    });

    expect(output.result).toMatchObject({ outcome: "needs-input" });
    expect(linear.state.context.state.id).toBe(readiness.stateIds.needsInput);
    expect(repository.service.checkpointRun).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
  });

  it.each([
    ["state", { failStateOnce: true }],
    ["labels", { failLabelsOnce: true }],
  ] as const)(
    "resumes terminal projection after a lost %s response",
    async (_boundary, options) => {
      const context = issueContext();
      const linear = fakeLinear(context, options);
      const event = workEvent(context);
      const loaded = await loadEligibleImplementation(linear.service, event.data, readiness);
      if (loaded.kind !== "eligible") throw new Error("expected an implementation-ready issue");
      linear.state.context = {
        ...linear.state.context,
        state: { ...linear.state.context.state, id: readiness.stateIds.inProgress },
        labels: linear.state.context.labels.filter(
          (label) => label.id !== readiness.agentReadyLabelId,
        ),
      };
      const input = {
        linear: linear.service,
        authority: loaded.authority,
        issueId: context.id,
        marker: "<!-- harness:test-terminal-projection -->",
        comment: "terminal outcome",
        readiness,
        targetStateId: readiness.stateIds.needsReview,
      };

      await expect(projectImplementationOutcome(input)).rejects.toThrow(/response lost/);
      await expect(projectImplementationOutcome(input)).resolves.toEqual({ kind: "projected" });
      expect(linear.state.context.state.id).toBe(readiness.stateIds.needsReview);
      expect(linear.state.context.labels).toHaveLength(0);
      expect(linear.state.comments).toHaveProperty("size", 1);
    },
  );

  it("does not repair a claim after the implementation source changes", async () => {
    const context = issueContext();
    const linear = fakeLinear(context);
    const authority = {
      issueId: context.id,
      issueIdentifier: context.identifier,
      sourceFingerprint: implementationSourceFingerprint(context, readiness),
    };
    linear.state.context = {
      ...context,
      state: { ...context.state, id: readiness.stateIds.inProgress },
      title: "A changed implementation request",
    };

    await expect(
      beginImplementationFailureRecovery({
        linear: linear.service,
        issueId: context.id,
        readiness,
        authority,
      }),
    ).resolves.toEqual({ reopen: false, removeAgentReady: false });
  });

  it("repairs an unchanged claimed issue after an implementation failure", async () => {
    const context = issueContext();
    const linear = fakeLinear(context);
    const authority = {
      issueId: context.id,
      issueIdentifier: context.identifier,
      sourceFingerprint: implementationSourceFingerprint(context, readiness),
    };
    linear.state.context = {
      ...context,
      state: { ...context.state, id: readiness.stateIds.inProgress },
    };

    await expect(
      beginImplementationFailureRecovery({
        linear: linear.service,
        issueId: context.id,
        readiness,
        authority,
      }),
    ).resolves.toEqual({ reopen: true, removeAgentReady: true });
  });

  it("checkpoints updated revisions and publishes the second review revision", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "harness-implementation-"));
    roots.push(workspace);
    const linear = fakeLinear(issueContext());
    let changeSet: "none" | "initial" | "revision" = "none";
    const repository = fakeRepository(workspace, () =>
      changeSet === "none"
        ? []
        : [
            {
              path: changeSet === "initial" ? "implementation.txt" : "revision.txt",
              status: "added",
            },
          ],
    );
    let reviewCount = 0;
    const review = vi.fn<ImplementationReviewRunner>(async () => {
      reviewCount += 1;
      return reviewCount === 1 ? reviewNeedsChanges() : reviewPass();
    });
    const publication = github();
    const output = await execute({
      context: issueContext(),
      agent: implementationAgentWithRevision(
        workspace,
        "updated",
        () => {
          changeSet = "initial";
        },
        () => {
          changeSet = "revision";
        },
      ),
      repository: repository.service,
      linear: linear.service,
      review,
      github: publication,
    });

    expect(output.result).toMatchObject({ outcome: "published", review: "passed" });
    expect(review).toHaveBeenCalledTimes(2);
    expect(repository.service.checkpointRun).toHaveBeenCalledTimes(2);
    expect(publication.publishCheckpointPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpoint: expect.objectContaining({ revision: "c".repeat(40) }),
      }),
    );
  });

  it("keeps the reviewed checkpoint when a revision reports unchanged", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "harness-implementation-"));
    roots.push(workspace);
    const linear = fakeLinear(issueContext());
    let changeSet: "none" | "initial" = "none";
    const repository = fakeRepository(workspace, () =>
      changeSet === "none" ? [] : [{ path: "implementation.txt", status: "added" }],
    );
    let reviewCount = 0;
    const review = vi.fn<ImplementationReviewRunner>(async () => {
      reviewCount += 1;
      return reviewCount === 1 ? reviewNeedsChanges() : reviewPass();
    });
    const output = await execute({
      context: issueContext(),
      agent: implementationAgentWithRevision(
        workspace,
        "unchanged",
        () => {
          changeSet = "initial";
        },
        () => {
          changeSet = "none";
        },
      ),
      repository: repository.service,
      linear: linear.service,
      review,
      github: github(),
    });

    expect(output.result).toMatchObject({ outcome: "published", review: "passed" });
    expect(repository.service.checkpointRun).toHaveBeenCalledTimes(1);
    expect(review).toHaveBeenCalledTimes(2);
  });

  it("projects revision Needs Input with its rationale and cleans the run", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "harness-implementation-"));
    roots.push(workspace);
    const linear = fakeLinear(issueContext());
    let changeSet: "none" | "initial" = "none";
    const repository = fakeRepository(workspace, () =>
      changeSet === "none" ? [] : [{ path: "implementation.txt", status: "added" }],
    );
    const review = vi.fn<ImplementationReviewRunner>(async () => reviewNeedsChanges());
    const output = await execute({
      context: issueContext(),
      agent: implementationAgentWithRevision(
        workspace,
        "needs-input",
        () => {
          changeSet = "initial";
        },
        () => {
          changeSet = "none";
        },
      ),
      repository: repository.service,
      linear: linear.service,
      review,
      github: github(),
    });

    expect(output.result).toMatchObject({ outcome: "needs-input" });
    expect(linear.state.context.state.id).toBe(readiness.stateIds.needsInput);
    expect(linear.state.comments.values().next().value).toContain("project decision");
    expect(repository.service.cleanupRun).toHaveBeenCalledTimes(1);
    expect(review).toHaveBeenCalledTimes(1);
  });

  it("publishes an unapproved PR after the bounded revision is exhausted", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "harness-implementation-"));
    roots.push(workspace);
    const linear = fakeLinear(issueContext());
    let changeSet: "none" | "initial" | "revision" = "none";
    const repository = fakeRepository(workspace, () =>
      changeSet === "none"
        ? []
        : [
            {
              path: changeSet === "initial" ? "implementation.txt" : "revision.txt",
              status: "added",
            },
          ],
    );
    let reviewCount = 0;
    const review = vi.fn<ImplementationReviewRunner>(async () => {
      reviewCount += 1;
      return reviewNeedsChanges();
    });
    const publication = github();
    const output = await execute({
      context: issueContext(),
      agent: implementationAgentWithRevision(
        workspace,
        "updated",
        () => {
          changeSet = "initial";
        },
        () => {
          changeSet = "revision";
        },
      ),
      repository: repository.service,
      linear: linear.service,
      review,
      github: publication,
    });

    expect(output.result).toMatchObject({ outcome: "published", review: "exhausted" });
    expect(publication.publishCheckpointPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpoint: expect.objectContaining({ revision: "c".repeat(40) }),
      }),
    );
    expect(repository.service.checkpointRun).toHaveBeenCalledTimes(2);
    expect(review).toHaveBeenCalledTimes(2);
  });
});
