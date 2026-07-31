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
import {
  createLinearImplementationFunction,
  type ImplementationReviewRunner,
  type LinearImplementationService,
} from "./implementation-consumer.ts";
import {
  ImplementationWorkRequestedEvent,
  workRequestEventId,
  type WorkRequestData,
} from "./events/work-events.ts";
import { linearReadinessSnapshotGeneration, type LinearReadinessConfig } from "./readiness.ts";

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
  const data: WorkRequestData = {
    issueId: context.id,
    issueIdentifier: context.identifier,
    causationEventId: "linear-revision-1",
    snapshotGeneration: linearReadinessSnapshotGeneration(context, readiness),
  };
  return ImplementationWorkRequestedEvent.create(data, {
    id: workRequestEventId("implement", data),
  });
}

function fakeLinear(initial: LinearIssueContext) {
  const state = { context: initial, comments: new Map<string, string>() };
  const service: LinearImplementationService = {
    getIssueContext: vi.fn<LinearImplementationService["getIssueContext"]>(async () =>
      structuredClone(state.context),
    ),
    updateIssueState: vi.fn<LinearImplementationService["updateIssueState"]>(
      async (input: Parameters<LinearImplementationService["updateIssueState"]>[0]) => {
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
      baseRef: "main",
      execution: { model: "gpt-test", modelReasoningEffort: "medium", maxRuntimeMs: 120_000 },
      githubRepository: {
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
});
