import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inngest } from "inngest";
import { InngestTestEngine } from "@inngest/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentRunResult } from "../agent/contract.ts";
import type { GitHubPublicationService, PublishedPullRequest } from "../github/types.ts";
import type { LinearIssueContext, LinearWorkflowState } from "../linear/types.ts";
import type {
  RepositoryBase,
  RepositoryChange,
  RepositoryCheckpoint,
  RepositoryService,
} from "../repository/types.ts";
import type { SpecDecision } from "../spec/schema.ts";
import {
  SpecWorkRequestedEvent,
  workRequestEventId,
  type WorkRequestData,
} from "./events/work-events.ts";
import { linearReadinessSnapshotGeneration, type LinearReadinessConfig } from "./readiness.ts";
import {
  createLinearSpecFunction,
  ensureSpecFailureComment,
  LINEAR_SPEC_FUNCTION_ID,
  LINEAR_SPEC_RETRIES,
  specCommentMarker,
  specWorkIdentity,
  type LinearSpecService,
} from "./spec-consumer.ts";

const ISSUE = "FER-320";
const ARTIFACT = `dev/plans/${ISSUE}.md`;
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
  agentActionLabelIds: {
    spec: "label-spec",
    implement: "label-implement",
  },
  agentReadyLabelId: "label-agent-ready",
  enabledRoutes: { triage: true, spec: true, implement: false },
};

const readyDecision: Extract<SpecDecision, { outcome: "ready-for-review" }> = {
  outcome: "ready-for-review",
  artifactPath: ARTIFACT,
  summary: "The Spec composes the existing primitives.",
  evidence: [
    {
      kind: "code",
      path: "lib/linear-automation/spec-consumer.ts",
      summary: "The consumer owns durable coordination.",
    },
  ],
  reviewerDecisions: [],
  questions: [],
};

const needsInputDecision: Extract<SpecDecision, { outcome: "needs-input" }> = {
  outcome: "needs-input",
  artifactPath: null,
  summary: "One product boundary is contradictory.",
  evidence: [{ kind: "tracker", path: null, summary: "The issue states both boundaries." }],
  reviewerDecisions: [],
  questions: ["Which boundary should own this behavior?"],
};

function client() {
  return new Inngest({ id: "linear-spec-test", eventKey: "test" });
}

function workflowState(id: string): LinearWorkflowState {
  return { id, name: id, type: id === readiness.stateIds.inProgress ? "started" : "unstarted" };
}

function issueContext(
  input: Partial<{
    stateId: string;
    labels: LinearIssueContext["labels"];
    title: string;
    completeness: Partial<LinearIssueContext["completeness"]>;
  }> = {},
): LinearIssueContext {
  return {
    id: "issue-320",
    identifier: ISSUE,
    title: input.title ?? "Run the bounded Spec review cycle",
    description: "Compose the existing Spec primitives into one bounded durable cycle.",
    url: `https://linear.app/example/${ISSUE}`,
    state: workflowState(input.stateId ?? readiness.stateIds.open),
    team: { id: readiness.teamId, key: "FER", name: "ferueda" },
    project: {
      id: readiness.projectId,
      name: "Harness",
      url: "https://linear.app/example/project",
    },
    assignee: null,
    creator: null,
    labels: input.labels ?? [
      { id: "label-unrelated", name: "Improvement" },
      { id: readiness.agentActionLabelIds.spec, name: "Spec" },
      { id: readiness.agentReadyLabelId, name: "Agent Ready" },
    ],
    comments: [
      {
        id: "comment-1",
        body: "Keep the consumer small.",
        author: {
          kind: "user",
          id: "user-1",
          name: "Felipe Rueda",
          displayName: "Felipe",
        },
        parentId: null,
        quotedText: null,
        createdAt: "2026-07-28T10:00:00.000Z",
        updatedAt: "2026-07-28T10:00:00.000Z",
      },
    ],
    parent: null,
    children: [],
    duplicateOf: null,
    blockedBy: [],
    related: [],
    attachments: [],
    createdAt: "2026-07-28T09:00:00.000Z",
    updatedAt: "2026-07-28T10:00:00.000Z",
    completeness: {
      commentsTruncated: false,
      labelsTruncated: false,
      relationsTruncated: false,
      attachmentsTruncated: false,
      childrenTruncated: false,
      ...input.completeness,
    },
  };
}

function workEvent(context: LinearIssueContext, overrides: Partial<WorkRequestData> = {}) {
  const data: WorkRequestData = {
    issueId: context.id,
    issueIdentifier: context.identifier,
    causationEventId: "linear-revision-1",
    snapshotGeneration: linearReadinessSnapshotGeneration(context, readiness),
    ...overrides,
  };
  return SpecWorkRequestedEvent.create(data, { id: workRequestEventId("spec", data) });
}

function fakeLinear(initial: LinearIssueContext) {
  const state = {
    context: initial,
    comments: new Map<string, string>(),
    order: [] as string[],
  };
  const getIssueContext = vi.fn<LinearSpecService["getIssueContext"]>(async () => {
    state.order.push("load");
    return structuredClone(state.context);
  });
  const updateIssueState = vi.fn<LinearSpecService["updateIssueState"]>(async (input) => {
    state.order.push(`state:${input.stateId}`);
    if (
      state.context.state.id !== input.expectedStateId &&
      state.context.state.id !== input.stateId
    ) {
      throw new Error("state conflict");
    }
    const changed = state.context.state.id !== input.stateId;
    state.context = { ...state.context, state: workflowState(input.stateId) };
    return { changed, stateId: input.stateId };
  });
  const updateIssueLabels = vi.fn<LinearSpecService["updateIssueLabels"]>(async (input) => {
    state.order.push(`labels:${input.removeLabelIds.join(",")}`);
    const removed = new Set(input.removeLabelIds);
    const remaining = state.context.labels.filter((label) => !removed.has(label.id));
    const current = new Set(remaining.map((label) => label.id));
    const added = input.addLabelIds
      .filter((id) => !current.has(id))
      .map((id) => ({ id, name: id }));
    state.context = { ...state.context, labels: [...remaining, ...added] };
    return {
      submitted: added.length > 0 || remaining.length !== state.context.labels.length,
      addedLabelIds: input.addLabelIds,
      removedLabelIds: input.removeLabelIds,
    };
  });
  const ensureComment = vi.fn<LinearSpecService["ensureComment"]>(async (input) => {
    state.order.push("comment");
    const created = !state.comments.has(input.marker);
    if (created) state.comments.set(input.marker, input.body);
    return { created, id: `comment-${state.comments.size}` };
  });
  return {
    state,
    service: { getIssueContext, updateIssueState, updateIssueLabels, ensureComment },
  };
}

type RepositoryFixture = ReturnType<typeof fakeRepository>;

function fakeRepository(workspace: string) {
  const base: RepositoryBase = {
    remote: "https://github.com/ferueda/harness.git",
    baseRef: "main",
    baseSha: "a".repeat(40),
  };
  const state = {
    pendingChanges: [] as RepositoryChange[],
    checkpoints: [] as RepositoryCheckpoint[],
    order: [] as string[],
  };
  const service: RepositoryService = {
    resolveBase: vi.fn<RepositoryService["resolveBase"]>(async () => {
      state.order.push("base");
      return base;
    }),
    prepareRun: vi.fn<RepositoryService["prepareRun"]>(async (input) => {
      state.order.push("prepare");
      return {
        version: 1,
        id: input.id,
        workspace,
        remote: input.base.remote,
        baseRef: input.base.baseRef,
        baseSha: input.base.baseSha,
        branch: input.branch,
      };
    }),
    recoverRun: vi.fn<RepositoryService["recoverRun"]>(async () => null),
    inspectChanges: vi.fn<RepositoryService["inspectChanges"]>(async () => {
      state.order.push("inspect");
      return structuredClone(state.pendingChanges);
    }),
    checkpointRun: vi.fn<RepositoryService["checkpointRun"]>(async (input) => {
      state.order.push(`checkpoint:${input.expectedParentRevision.slice(0, 4)}`);
      expect(input.expectedChanges).toEqual(state.pendingChanges);
      const revision = String.fromCharCode(98 + state.checkpoints.length).repeat(40);
      const checkpoint: RepositoryCheckpoint = {
        version: 1,
        id: input.id,
        runId: input.run.id,
        baseSha: input.run.baseSha,
        parentRevision: input.expectedParentRevision,
        revision,
        branch: input.run.branch,
        changes: structuredClone(input.expectedChanges),
      };
      state.checkpoints.push(checkpoint);
      state.pendingChanges = [];
      return checkpoint;
    }),
    openCheckpoint: vi.fn<RepositoryService["openCheckpoint"]>(async (input) => {
      state.order.push(`open:${input.checkpoint.revision.slice(0, 4)}`);
      if (state.pendingChanges.length > 0) throw new Error("checkpoint workspace is dirty");
      return {
        version: 1,
        id: input.checkpoint.runId,
        workspace,
        remote: base.remote,
        baseRef: input.baseRef,
        baseSha: input.checkpoint.baseSha,
        branch: input.checkpoint.branch,
      };
    }),
    cleanupRun: vi.fn<RepositoryService["cleanupRun"]>(async () => {
      state.order.push("cleanup");
      return { status: "released" };
    }),
  };
  return { state, service };
}

function approvedReview(): AgentRunResult {
  return {
    ok: true,
    structuredOutput: {
      outcome: "approved",
      rationale: "The Spec is scoped and executable.",
      evidence: [
        {
          source: "artifact",
          path: ARTIFACT,
          lineStart: 1,
          lineEnd: 1,
          summary: "The plan defines a bounded delivery.",
        },
      ],
      findings: [],
    },
    raw: {},
  };
}

function changesReview(problem = "Clarify the verification boundary."): AgentRunResult {
  return {
    ok: true,
    structuredOutput: {
      outcome: "changes-requested",
      rationale: "One material gap remains.",
      evidence: [],
      findings: [
        {
          criterion: "verification",
          artifactLocation: { section: "Verify", lineStart: 20, lineEnd: 22 },
          evidence: [
            {
              source: "artifact",
              path: ARTIFACT,
              lineStart: 20,
              lineEnd: 22,
              summary: "The current verification is too broad.",
            },
          ],
          problem,
          requiredOutcome: "Name the focused behavioral proof.",
        },
      ],
    },
    raw: {},
  };
}

function fakeAgents(input: {
  workspace: string;
  repository: RepositoryFixture;
  reviews: AgentRunResult[];
  revisions?: Array<"updated" | "unchanged" | "needs-input">;
  authorDecision?: SpecDecision;
  reviewHook?: (index: number) => void;
}) {
  let reviewIndex = 0;
  let revisionIndex = 0;
  const authorRun = vi.fn<Agent["run"]>(async (runInput) => {
    if (!runInput.session) {
      const decision = input.authorDecision ?? readyDecision;
      if (decision.outcome === "ready-for-review") {
        mkdirSync(join(input.workspace, "dev/plans"), { recursive: true });
        writeFileSync(join(input.workspace, decision.artifactPath), "# Initial Spec\n", "utf8");
        input.repository.state.pendingChanges = [
          { path: decision.artifactPath, status: "untracked" },
        ];
      }
      return {
        ok: true,
        structuredOutput: decision,
        raw: {},
        session: { provider: "codex", id: "author-session-0" },
      };
    }

    const outcome = input.revisions?.[revisionIndex++] ?? "updated";
    const findingIds = [
      ...new Set(runInput.prompt.match(/spec-review-finding-[0-9a-f]{64}/g) ?? []),
    ];
    if (outcome === "updated") {
      writeFileSync(
        join(input.workspace, ARTIFACT),
        `${readFileSync(join(input.workspace, ARTIFACT), "utf8")}\n## Revised\n`,
        "utf8",
      );
      input.repository.state.pendingChanges = [{ path: ARTIFACT, status: "modified" }];
    }
    return {
      ok: true,
      structuredOutput: {
        outcome,
        rationale:
          outcome === "needs-input"
            ? "A product choice is required."
            : "The author resolved the review.",
        responses: findingIds.map((findingId) => ({
          findingId,
          disposition: outcome === "updated" ? "accepted" : "declined",
          rationale:
            outcome === "updated"
              ? "Updated the verification section."
              : "Repository evidence supports the current choice.",
          evidence:
            outcome === "updated"
              ? []
              : [
                  {
                    source: "code",
                    path: "lib/linear-automation/spec-consumer.ts",
                    lineStart: 1,
                    lineEnd: 1,
                    summary: "The existing boundary supports the decision.",
                  },
                ],
        })),
        questions: outcome === "needs-input" ? ["Which product boundary should win?"] : [],
      },
      raw: {},
      session: { provider: "codex", id: `author-session-${revisionIndex}` },
    };
  });
  const reviewRun = vi.fn<Agent["run"]>(async () => {
    input.reviewHook?.(reviewIndex);
    return input.reviews[reviewIndex++] ?? approvedReview();
  });
  return {
    authorAgent: { name: "codex", run: authorRun } satisfies Agent,
    reviewAgent: { name: "codex", run: reviewRun } satisfies Agent,
    authorRun,
    reviewRun,
  };
}

function fakeGitHub(overrides: Partial<PublishedPullRequest> = {}) {
  const calls: Array<{ title: string; body: string; checkpoint: RepositoryCheckpoint }> = [];
  const publishCheckpointPullRequest = vi.fn<
    GitHubPublicationService["publishCheckpointPullRequest"]
  >(async (input) => {
    calls.push({ title: input.title, body: input.body, checkpoint: input.checkpoint });
    return {
      url: "https://github.com/ferueda/harness/pull/320",
      number: 320,
      owner: "ferueda",
      repository: "harness",
      baseBranch: input.baseBranch,
      headBranch: input.run.branch,
      headSha: input.checkpoint.revision,
      state: "open",
      merged: false,
      ...overrides,
    };
  });
  return {
    service: { publishCheckpointPullRequest },
    publish: publishCheckpointPullRequest,
    calls,
  };
}

function specFunction(input: {
  linear: LinearSpecService;
  authorAgent: Agent;
  reviewAgent: Agent;
  repository: RepositoryService;
  github: GitHubPublicationService;
}) {
  return createLinearSpecFunction({
    client: client(),
    ...input,
    config: {
      readiness,
      baseRef: "main",
      execution: {
        model: "gpt-5.6-sol",
        modelReasoningEffort: "high",
        maxRuntimeMs: 1_800_000,
      },
      githubRepository: {
        owner: "ferueda",
        repository: "harness",
        httpsRemote: "https://github.com/ferueda/harness.git",
      },
    },
  });
}

async function execute(input: {
  context: LinearIssueContext;
  linear: ReturnType<typeof fakeLinear>;
  agents: ReturnType<typeof fakeAgents>;
  repository: RepositoryFixture;
  github: ReturnType<typeof fakeGitHub>;
}) {
  return new InngestTestEngine({
    function: specFunction({
      linear: input.linear.service,
      authorAgent: input.agents.authorAgent,
      reviewAgent: input.agents.reviewAgent,
      repository: input.repository.service,
      github: input.github.service,
    }),
    events: [workEvent(input.context)],
  }).execute();
}

describe("bounded Linear Spec consumer", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "harness-spec-cycle-"));
  });

  it("locks trigger, retries, and issue-level concurrency", () => {
    const context = issueContext();
    const linear = fakeLinear(context);
    const repository = fakeRepository(workspace);
    const agents = fakeAgents({ workspace, repository, reviews: [approvedReview()] });
    const fn = specFunction({
      linear: linear.service,
      authorAgent: agents.authorAgent,
      reviewAgent: agents.reviewAgent,
      repository: repository.service,
      github: fakeGitHub().service,
    });
    expect(fn.opts).toMatchObject({
      id: LINEAR_SPEC_FUNCTION_ID,
      retries: LINEAR_SPEC_RETRIES,
      concurrency: { key: "event.data.issueId", limit: 1 },
      triggers: [SpecWorkRequestedEvent],
    });
  });

  it("authors, checkpoints, independently approves, publishes, projects, and cleans", async () => {
    const context = issueContext();
    const linear = fakeLinear(context);
    const repository = fakeRepository(workspace);
    const agents = fakeAgents({ workspace, repository, reviews: [approvedReview()] });
    const github = fakeGitHub();
    const output = await execute({ context, linear, agents, repository, github });

    expect(output.error).toBeUndefined();
    expect(output.result).toMatchObject({
      outcome: "ready-for-review",
      reviewOutcome: "approved",
      pullRequestUrl: "https://github.com/ferueda/harness/pull/320",
      cleanup: "cleaned",
    });
    expect(agents.authorRun).toHaveBeenCalledOnce();
    expect(agents.reviewRun).toHaveBeenCalledOnce();
    expect(repository.state.checkpoints).toHaveLength(1);
    expect(github.calls[0]?.checkpoint.revision).toBe(repository.state.checkpoints[0]?.revision);
    expect(linear.state.context.state.id).toBe(readiness.stateIds.needsReview);
    expect(linear.state.context.labels.map((label) => label.id)).toEqual(["label-unrelated"]);
    expect(linear.state.order.indexOf(`state:${readiness.stateIds.needsReview}`)).toBeLessThan(
      linear.state.order.lastIndexOf(`labels:${readiness.agentActionLabelIds.spec}`),
    );
  });

  it("keeps complete Linear context inside agent steps, not durable load output", async () => {
    const context = issueContext();
    const linear = fakeLinear(context);
    const repository = fakeRepository(workspace);
    const agents = fakeAgents({ workspace, repository, reviews: [approvedReview()] });
    const output = await execute({
      context,
      linear,
      agents,
      repository,
      github: fakeGitHub(),
    });
    const firstStep = await Object.values(output.state)[0];
    const serialized = JSON.stringify(firstStep);
    expect(serialized).toContain("sourceFingerprint");
    expect(serialized).not.toContain(context.description);
    expect(serialized).not.toContain("comments");
    expect(agents.authorRun.mock.calls[0]?.[0].prompt).toContain(context.title);
    expect(agents.reviewRun.mock.calls[0]?.[0].prompt).toContain(context.title);
  });

  it("projects initial Needs Input before creating a checkpoint", async () => {
    const context = issueContext();
    const linear = fakeLinear(context);
    const repository = fakeRepository(workspace);
    const agents = fakeAgents({
      workspace,
      repository,
      reviews: [],
      authorDecision: needsInputDecision,
    });
    const github = fakeGitHub();
    const output = await execute({ context, linear, agents, repository, github });

    expect(output.result).toMatchObject({ outcome: "needs-input", cleanup: "cleaned" });
    expect(repository.state.checkpoints).toHaveLength(0);
    expect(agents.reviewRun).not.toHaveBeenCalled();
    expect(github.publish).not.toHaveBeenCalled();
    expect(linear.state.context.state.id).toBe(readiness.stateIds.needsInput);
  });

  it("creates one exact child checkpoint after an updated revision", async () => {
    const context = issueContext();
    const linear = fakeLinear(context);
    const repository = fakeRepository(workspace);
    const agents = fakeAgents({
      workspace,
      repository,
      reviews: [changesReview(), approvedReview()],
      revisions: ["updated"],
    });
    const github = fakeGitHub();
    const output = await execute({ context, linear, agents, repository, github });

    expect(output.result).toMatchObject({ reviewOutcome: "approved" });
    expect(repository.state.checkpoints).toHaveLength(2);
    expect(repository.state.checkpoints[1]?.parentRevision).toBe(
      repository.state.checkpoints[0]?.revision,
    );
    expect(agents.authorRun.mock.calls[1]?.[0].session).toMatchObject({
      provider: "codex",
      id: "author-session-0",
    });
    expect(github.calls[0]?.checkpoint.revision).toBe(repository.state.checkpoints[1]?.revision);
  });

  it("supports two updated revisions before the final approval", async () => {
    const context = issueContext();
    const linear = fakeLinear(context);
    const repository = fakeRepository(workspace);
    const agents = fakeAgents({
      workspace,
      repository,
      reviews: [changesReview("Gap one."), changesReview("Gap two."), approvedReview()],
      revisions: ["updated", "updated"],
    });
    const github = fakeGitHub();
    const output = await execute({ context, linear, agents, repository, github });

    expect(output.result).toMatchObject({ reviewOutcome: "approved" });
    expect(repository.state.checkpoints).toHaveLength(3);
    expect(agents.reviewRun).toHaveBeenCalledTimes(3);
    expect(agents.authorRun).toHaveBeenCalledTimes(3);
    expect(github.calls[0]?.checkpoint.revision).toBe(repository.state.checkpoints[2]?.revision);
  });

  it("counts an unchanged revision without creating an empty checkpoint", async () => {
    const context = issueContext();
    const linear = fakeLinear(context);
    const repository = fakeRepository(workspace);
    const agents = fakeAgents({
      workspace,
      repository,
      reviews: [changesReview(), approvedReview()],
      revisions: ["unchanged"],
    });
    const output = await execute({
      context,
      linear,
      agents,
      repository,
      github: fakeGitHub(),
    });

    expect(output.result).toMatchObject({ reviewOutcome: "approved" });
    expect(repository.state.checkpoints).toHaveLength(1);
    expect(agents.reviewRun).toHaveBeenCalledTimes(2);
    expect(agents.authorRun).toHaveBeenCalledTimes(2);
  });

  it("stops a revision at Needs Input without publication", async () => {
    const context = issueContext();
    const linear = fakeLinear(context);
    const repository = fakeRepository(workspace);
    const agents = fakeAgents({
      workspace,
      repository,
      reviews: [changesReview()],
      revisions: ["needs-input"],
    });
    const github = fakeGitHub();
    const output = await execute({ context, linear, agents, repository, github });

    expect(output.result).toMatchObject({ outcome: "needs-input", cleanup: "cleaned" });
    expect(linear.state.context.state.id).toBe(readiness.stateIds.needsInput);
    expect(github.publish).not.toHaveBeenCalled();
    expect([...linear.state.comments.values()][0]).toContain("Which product boundary should win?");
  });

  it("publishes the latest checkpoint as explicitly unapproved after three reviews", async () => {
    const context = issueContext();
    const linear = fakeLinear(context);
    const repository = fakeRepository(workspace);
    const agents = fakeAgents({
      workspace,
      repository,
      reviews: [changesReview("Gap one."), changesReview("Gap two."), changesReview("Gap three.")],
      revisions: ["updated", "unchanged"],
    });
    const github = fakeGitHub();
    const output = await execute({ context, linear, agents, repository, github });

    expect(output.result).toMatchObject({
      outcome: "ready-for-review",
      reviewOutcome: "exhausted",
    });
    expect(agents.reviewRun).toHaveBeenCalledTimes(3);
    expect(agents.authorRun).toHaveBeenCalledTimes(3);
    expect(github.calls[0]?.title).toContain("[UNAPPROVED]");
    expect(github.calls[0]?.body).toContain("Gap three.");
    expect([...linear.state.comments.values()][0]).toContain("spec-review-finding-");
    expect(linear.state.context.state.id).toBe(readiness.stateIds.needsReview);
  });

  it("reopens and cleans when Linear authority changes during review", async () => {
    const context = issueContext();
    const linear = fakeLinear(context);
    const repository = fakeRepository(workspace);
    const agents = fakeAgents({
      workspace,
      repository,
      reviews: [approvedReview()],
      reviewHook: () => {
        linear.state.context = { ...linear.state.context, title: "Changed by a human" };
      },
    });
    const github = fakeGitHub();
    const output = await execute({ context, linear, agents, repository, github });

    expect(output.result).toMatchObject({
      outcome: "failed",
      reason: "stale-authority",
      cleanup: "cleaned",
    });
    expect(linear.state.context.state.id).toBe(readiness.stateIds.open);
    expect(linear.state.context.labels.map((label) => label.id)).toContain(
      readiness.agentActionLabelIds.spec,
    );
    expect(github.publish).not.toHaveBeenCalled();
    expect(repository.state.order).toContain("cleanup");
  });

  it("preserves a newer human lifecycle change during recovery", async () => {
    const context = issueContext();
    const linear = fakeLinear(context);
    const repository = fakeRepository(workspace);
    const humanLabels = [{ id: "label-human", name: "Human owned" }];
    const agents = fakeAgents({
      workspace,
      repository,
      reviews: [approvedReview()],
      reviewHook: () => {
        linear.state.context = {
          ...linear.state.context,
          state: workflowState(readiness.stateIds.needsReview),
          labels: humanLabels,
        };
      },
    });
    const output = await execute({
      context,
      linear,
      agents,
      repository,
      github: fakeGitHub(),
    });

    expect(output.result).toMatchObject({
      outcome: "failed",
      reason: "stale-authority",
      cleanup: "cleaned",
    });
    expect(linear.state.context.state.id).toBe(readiness.stateIds.needsReview);
    expect(linear.state.context.labels).toEqual(humanLabels);
  });

  it("rejects a publication that does not match the reviewed checkpoint", async () => {
    const context = issueContext();
    const linear = fakeLinear(context);
    const repository = fakeRepository(workspace);
    const agents = fakeAgents({ workspace, repository, reviews: [approvedReview()] });
    const github = fakeGitHub({ headSha: "f".repeat(40) });
    const output = await execute({ context, linear, agents, repository, github });

    expect(output.result).toMatchObject({
      outcome: "failed",
      reason: "invalid-publication",
      cleanup: "cleaned",
    });
    expect(linear.state.context.state.id).toBe(readiness.stateIds.open);
    expect(linear.state.context.labels.map((label) => label.id)).toContain(
      readiness.agentActionLabelIds.spec,
    );
  });

  it("ignores a repeated completed delivery and keeps stable root identities", async () => {
    const context = issueContext();
    const linear = fakeLinear(context);
    const repository = fakeRepository(workspace);
    const agents = fakeAgents({ workspace, repository, reviews: [approvedReview()] });
    const github = fakeGitHub();
    const fn = specFunction({
      linear: linear.service,
      authorAgent: agents.authorAgent,
      reviewAgent: agents.reviewAgent,
      repository: repository.service,
      github: github.service,
    });
    const event = workEvent(context);
    const identity = specWorkIdentity(event.data);
    const first = await new InngestTestEngine({ function: fn, events: [event] }).execute();
    const repeated = await new InngestTestEngine({ function: fn, events: [event] }).execute();

    expect(first.result).toMatchObject({ reviewOutcome: "approved" });
    expect(repeated.result).toEqual({ outcome: "ignored", reason: "not-spec-ready" });
    expect(agents.authorRun).toHaveBeenCalledOnce();
    expect(identity.workId).toBe(workRequestEventId("spec", event.data));
    expect(identity.branch).toMatch(/^harness\/spec\/FER-320-[0-9a-f]{12}$/);
  });

  it("keeps failure comments bounded and idempotent", async () => {
    const context = issueContext({ stateId: readiness.stateIds.inProgress });
    const linear = fakeLinear(context);
    const event = workEvent(issueContext()).data;
    await ensureSpecFailureComment({
      linear: linear.service,
      event,
      error: "provider retries exhausted",
      bestEffort: true,
    });
    await ensureSpecFailureComment({
      linear: linear.service,
      event,
      error: "provider retries exhausted",
      bestEffort: true,
    });

    expect(linear.state.comments.size).toBe(1);
    expect(linear.service.updateIssueState).not.toHaveBeenCalled();
    expect(linear.service.updateIssueLabels).not.toHaveBeenCalled();
    expect([...linear.state.comments.keys()][0]).toBe(specCommentMarker(event, "failure"));
  });
});
