import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
  RepositoryRun,
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
  LINEAR_SPEC_AGENT_STEP_ID,
  LINEAR_SPEC_BASE_STEP_ID,
  LINEAR_SPEC_CLAIM_STEP_ID,
  LINEAR_SPEC_FUNCTION_ID,
  LINEAR_SPEC_LOAD_STEP_ID,
  LINEAR_SPEC_PREPARE_STEP_ID,
  LINEAR_SPEC_RETRIES,
  specCommentMarker,
  specWorkIdentity,
  type LinearSpecService,
} from "./spec-consumer.ts";

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
  artifactPath: "dev/plans/FER-267.md",
  summary: "The Spec composes the existing primitives.",
  evidence: [
    {
      kind: "code",
      path: "lib/linear-automation/worker.ts",
      summary: "The worker owns runtime composition.",
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

function issueContext(
  input: Partial<{
    stateId: string;
    labels: LinearIssueContext["labels"];
    title: string;
    blockedBy: LinearIssueContext["blockedBy"];
    completeness: Partial<LinearIssueContext["completeness"]>;
  }> = {},
): LinearIssueContext {
  return {
    id: "issue-267",
    identifier: "FER-267",
    title: input.title ?? "Run the independent Spec consumer",
    description: "Compose completed primitives.",
    url: "https://linear.app/example/FER-267",
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
        createdAt: "2026-07-25T10:00:00.000Z",
        updatedAt: "2026-07-25T10:00:00.000Z",
      },
    ],
    parent: null,
    children: [],
    duplicateOf: null,
    blockedBy: input.blockedBy ?? [],
    related: [],
    attachments: [],
    createdAt: "2026-07-25T09:00:00.000Z",
    updatedAt: "2026-07-25T10:00:00.000Z",
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

function workflowState(id: string): LinearWorkflowState {
  return { id, name: id, type: id === readiness.stateIds.inProgress ? "started" : "unstarted" };
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

type LinearState = {
  context: LinearIssueContext;
  comments: Map<string, string>;
  order: string[];
};

function fakeLinear(initial: LinearIssueContext) {
  const state: LinearState = { context: initial, comments: new Map(), order: [] };
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
    state.context = {
      ...state.context,
      state: workflowState(input.stateId),
      updatedAt: "2026-07-25T10:01:00.000Z",
    };
    return { changed: true, stateId: input.stateId };
  });
  const updateIssueLabels = vi.fn<LinearSpecService["updateIssueLabels"]>(async (input) => {
    state.order.push(`labels:${input.removeLabelIds.join(",")}`);
    const removed = new Set(input.removeLabelIds);
    const added = input.addLabelIds.map((id) => ({ id, name: id }));
    state.context = {
      ...state.context,
      labels: [...state.context.labels.filter((label) => !removed.has(label.id)), ...added],
      updatedAt: "2026-07-25T10:02:00.000Z",
    };
    return {
      submitted: true,
      addedLabelIds: input.addLabelIds,
      removedLabelIds: input.removeLabelIds,
    };
  });
  const ensureComment = vi.fn<LinearSpecService["ensureComment"]>(async (input) => {
    state.order.push("comment");
    if (!state.comments.has(input.marker)) state.comments.set(input.marker, input.body);
    state.context = {
      ...state.context,
      updatedAt: "2026-07-25T10:03:00.000Z",
    };
    return { created: true, id: `comment-${state.comments.size}` };
  });
  return {
    state,
    service: { getIssueContext, updateIssueState, updateIssueLabels, ensureComment },
  };
}

function fakeRepository(
  workspace: string,
  changes: readonly RepositoryChange[],
): { service: RepositoryService; order: string[] } {
  const order: string[] = [];
  const base: RepositoryBase = {
    remote: "https://github.com/ferueda/harness.git",
    baseRef: "main",
    baseSha: "a".repeat(40),
  };
  const run: RepositoryRun = {
    version: 1,
    id: "placeholder",
    workspace,
    remote: base.remote,
    baseRef: base.baseRef,
    baseSha: base.baseSha,
    branch: "placeholder",
  };
  return {
    order,
    service: {
      resolveBase: vi.fn<RepositoryService["resolveBase"]>(async () => {
        order.push("base");
        return base;
      }),
      prepareRun: vi.fn<RepositoryService["prepareRun"]>(async (input) => {
        order.push("prepare");
        return { ...run, id: input.id, branch: input.branch };
      }),
      inspectChanges: vi.fn<RepositoryService["inspectChanges"]>(async () => {
        order.push("inspect");
        return changes;
      }),
      checkpointRun: vi.fn<RepositoryService["checkpointRun"]>(async () => {
        throw new Error("Unexpected repository checkpoint call");
      }),
      openCheckpoint: vi.fn<RepositoryService["openCheckpoint"]>(async () => {
        throw new Error("Unexpected repository open checkpoint call");
      }),
      cleanupRun: vi.fn<RepositoryService["cleanupRun"]>(async () => {
        order.push("cleanup");
        return { status: "released" as const };
      }),
    },
  };
}

function fakeGitHub(overrides: Partial<PublishedPullRequest> = {}) {
  const publish = vi.fn<GitHubPublicationService["publishPullRequest"]>(async () => ({
    url: "https://github.com/ferueda/harness/pull/250",
    number: 250,
    owner: "ferueda",
    repository: "harness",
    baseBranch: "main",
    headBranch: "harness/spec/FER-267-abc",
    headSha: "b".repeat(40),
    state: "open" as const,
    merged: false,
    ...overrides,
  }));
  return { service: { publishPullRequest: publish }, publish };
}

function fakeAgent(workspace: string, result: AgentRunResult, hook?: () => void) {
  const run = vi.fn<Agent["run"]>(async () => {
    hook?.();
    if (result.ok && (result.structuredOutput as SpecDecision).outcome === "ready-for-review") {
      mkdirSync(join(workspace, "dev/plans"), { recursive: true });
      writeFileSync(join(workspace, "dev/plans/FER-267.md"), "# FER-267\n", "utf8");
    }
    return result;
  });
  return { agent: { name: "codex", run } satisfies Agent, run };
}

function success(decision: SpecDecision): AgentRunResult {
  return {
    ok: true,
    structuredOutput: decision,
    raw: {},
    session: { provider: "codex", id: "thread-267" },
  };
}

function specFunction(input: {
  linear: LinearSpecService;
  agent: Agent;
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

describe("independent Linear Spec consumer", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "harness-spec-consumer-"));
  });

  it("locks the trigger, retries, and issue-level concurrency", () => {
    const linear = fakeLinear(issueContext());
    const repository = fakeRepository(workspace, []);
    const github = fakeGitHub();
    const agent = fakeAgent(workspace, success(needsInputDecision));
    const fn = specFunction({
      linear: linear.service,
      repository: repository.service,
      github: github.service,
      agent: agent.agent,
    });
    expect(fn.opts).toMatchObject({
      id: LINEAR_SPEC_FUNCTION_ID,
      retries: LINEAR_SPEC_RETRIES,
      concurrency: { key: "event.data.issueId", limit: 1 },
      triggers: [SpecWorkRequestedEvent],
    });
  });

  it("publishes one ready Spec before projecting Needs Review and cleaning", async () => {
    const context = issueContext();
    const linear = fakeLinear(context);
    const repository = fakeRepository(workspace, [
      { path: "dev/plans/FER-267.md", status: "untracked" },
    ]);
    const github = fakeGitHub();
    const agent = fakeAgent(workspace, success(readyDecision));
    const output = await new InngestTestEngine({
      function: specFunction({
        linear: linear.service,
        repository: repository.service,
        github: github.service,
        agent: agent.agent,
      }),
      events: [workEvent(context)],
    }).execute();

    expect(output.error).toBeUndefined();
    expect(output.result).toMatchObject({
      outcome: "ready-for-review",
      pullRequestUrl: "https://github.com/ferueda/harness/pull/250",
    });
    expect(linear.state.context.state.id).toBe(readiness.stateIds.needsReview);
    expect(linear.state.context.labels.map((label) => label.id)).toEqual(["label-unrelated"]);
    expect(linear.state.comments.size).toBe(1);
    expect([...linear.state.comments.values()][0]).toContain("/pull/250");
    expect(github.publish).toHaveBeenCalledOnce();
    expect(repository.order).toEqual(["base", "prepare", "inspect", "cleanup"]);
    expect(linear.state.order).toEqual([
      "load",
      `state:${readiness.stateIds.inProgress}`,
      `labels:${readiness.agentReadyLabelId}`,
      "load",
      "comment",
      `labels:${readiness.agentActionLabelIds.spec}`,
      `state:${readiness.stateIds.needsReview}`,
    ]);
  });

  it("projects Needs Input without a pull request and requires a clean workspace", async () => {
    const context = issueContext();
    const linear = fakeLinear(context);
    const repository = fakeRepository(workspace, []);
    const github = fakeGitHub();
    const agent = fakeAgent(workspace, success(needsInputDecision));
    const output = await new InngestTestEngine({
      function: specFunction({
        linear: linear.service,
        repository: repository.service,
        github: github.service,
        agent: agent.agent,
      }),
      events: [workEvent(context)],
    }).execute();

    expect(output.result).toMatchObject({ outcome: "needs-input" });
    expect(linear.state.context.state.id).toBe(readiness.stateIds.needsInput);
    expect([...linear.state.comments.values()][0]).toContain(needsInputDecision.questions[0]);
    expect(github.publish).not.toHaveBeenCalled();
    expect(repository.order.at(-1)).toBe("cleanup");
  });

  it.each([
    ["commentsTruncated"],
    ["labelsTruncated"],
    ["relationsTruncated"],
    ["attachmentsTruncated"],
    ["childrenTruncated"],
  ] as const)("fails closed before claim when %s is true", async (flag) => {
    const context = issueContext({ completeness: { [flag]: true } });
    const linear = fakeLinear(context);
    const repository = fakeRepository(workspace, []);
    const github = fakeGitHub();
    const agent = fakeAgent(workspace, success(needsInputDecision));
    const output = await new InngestTestEngine({
      function: specFunction({
        linear: linear.service,
        repository: repository.service,
        github: github.service,
        agent: agent.agent,
      }),
      events: [workEvent(context)],
    }).execute();
    expect(output.result).toEqual({ outcome: "ignored", reason: "incomplete-context" });
    expect(agent.run).not.toHaveBeenCalled();
    expect(linear.state.order).toEqual(["load"]);
  });

  it.each([
    [
      "source",
      (linear: ReturnType<typeof fakeLinear>) => {
        linear.state.context = { ...linear.state.context, title: "Changed by a human" };
      },
    ],
    [
      "label",
      (linear: ReturnType<typeof fakeLinear>) => {
        linear.state.context = {
          ...linear.state.context,
          labels: [
            ...linear.state.context.labels,
            { id: readiness.agentActionLabelIds.implement, name: "Implement" },
          ],
        };
      },
    ],
    [
      "blocker",
      (linear: ReturnType<typeof fakeLinear>) => {
        linear.state.context = {
          ...linear.state.context,
          blockedBy: [
            {
              id: "blocker-1",
              identifier: "FER-100",
              title: "Blocking issue",
              url: "https://linear.app/example/FER-100",
              state: workflowState(readiness.stateIds.open),
            },
          ],
        };
      },
    ],
  ] as const)("retains the claimed run when %s authority drifts", async (_name, drift) => {
    const context = issueContext();
    const linear = fakeLinear(context);
    const repository = fakeRepository(workspace, []);
    const github = fakeGitHub();
    const agent = fakeAgent(workspace, success(needsInputDecision), () => drift(linear));
    const output = await new InngestTestEngine({
      function: specFunction({
        linear: linear.service,
        repository: repository.service,
        github: github.service,
        agent: agent.agent,
      }),
      events: [workEvent(context)],
    }).execute();

    expect(output.result).toMatchObject({ outcome: "failed", reason: "stale-authority" });
    expect(linear.state.context.state.id).toBe(readiness.stateIds.inProgress);
    expect(github.publish).not.toHaveBeenCalled();
    expect(repository.order).not.toContain("cleanup");
    expect(linear.state.comments.size).toBe(1);
  });

  it("marks an invalid workspace without publication or cleanup", async () => {
    const context = issueContext();
    const linear = fakeLinear(context);
    const repository = fakeRepository(workspace, [
      { path: "lib/unrelated.ts", status: "modified" },
    ]);
    const github = fakeGitHub();
    const agent = fakeAgent(workspace, success(readyDecision));
    const output = await new InngestTestEngine({
      function: specFunction({
        linear: linear.service,
        repository: repository.service,
        github: github.service,
        agent: agent.agent,
      }),
      events: [workEvent(context)],
    }).execute();
    expect(output.result).toMatchObject({ outcome: "failed", reason: "invalid-workspace" });
    expect(github.publish).not.toHaveBeenCalled();
    expect(repository.order).not.toContain("cleanup");
    expect([...linear.state.comments.keys()][0]).toBe(
      specCommentMarker(workEvent(context).data, "failure"),
    );
  });

  it("preflights an oversized ready comment before publication", async () => {
    const context = issueContext();
    const linear = fakeLinear(context);
    const repository = fakeRepository(workspace, [
      { path: "dev/plans/FER-267.md", status: "untracked" },
    ]);
    const github = fakeGitHub();
    const oversized: typeof readyDecision = {
      ...readyDecision,
      reviewerDecisions: [
        {
          question: "Which option should the reviewer approve?",
          options: [
            { option: "Approve", tradeoffs: "Ships the pilot." },
            { option: "Wait", tradeoffs: "Delays the pilot." },
          ],
          recommendation: "Approve",
          rationale: "r".repeat(9_000),
        },
      ],
    };
    const agent = fakeAgent(workspace, success(oversized));
    const output = await new InngestTestEngine({
      function: specFunction({
        linear: linear.service,
        repository: repository.service,
        github: github.service,
        agent: agent.agent,
      }),
      events: [workEvent(context)],
    }).execute();

    expect(output.result).toMatchObject({ outcome: "failed", reason: "invalid-workspace" });
    expect(github.publish).not.toHaveBeenCalled();
    expect(repository.order).not.toContain("cleanup");
  });

  it("throws retryable provider failures inside the agent step", async () => {
    const context = issueContext();
    const linear = fakeLinear(context);
    const repository = fakeRepository(workspace, []);
    const github = fakeGitHub();
    const agent = fakeAgent(workspace, {
      ok: false,
      error: "provider unavailable",
      exitCode: 1,
    });
    const output = await new InngestTestEngine({
      function: specFunction({
        linear: linear.service,
        repository: repository.service,
        github: github.service,
        agent: agent.agent,
      }),
      events: [workEvent(context)],
    }).execute();
    expect(output.error).toMatchObject({
      message: expect.stringContaining("provider unavailable"),
    });
    expect(output.ctx.step.run).toHaveBeenCalledWith(
      LINEAR_SPEC_AGENT_STEP_ID,
      expect.any(Function),
    );
  });

  it("reuses the durable base SHA when preparation retries after the remote advances", async () => {
    const context = issueContext();
    const linear = fakeLinear(context);
    let resolveCalls = 0;
    const preparedBaseShas: string[] = [];
    const repository = fakeRepository(workspace, []);
    let prepareCalls = 0;
    const repositoryService: RepositoryService = {
      ...repository.service,
      resolveBase: vi.fn<RepositoryService["resolveBase"]>(async () => {
        resolveCalls += 1;
        return {
          remote: "https://github.com/ferueda/harness.git",
          baseRef: "main",
          baseSha: (resolveCalls === 1 ? "a" : "b").repeat(40),
        };
      }),
      prepareRun: vi.fn<RepositoryService["prepareRun"]>(async (input) => {
        prepareCalls += 1;
        preparedBaseShas.push(input.base.baseSha);
        if (prepareCalls === 1) throw new Error("prepare response lost");
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
    };
    const github = fakeGitHub();
    const agent = fakeAgent(workspace, success(needsInputDecision));
    const fn = specFunction({
      linear: linear.service,
      repository: repositoryService,
      github: github.service,
      agent: agent.agent,
    });
    const event = workEvent(context);
    const failed = await new InngestTestEngine({ function: fn, events: [event] }).execute();
    expect(failed.error).toMatchObject({
      message: expect.stringContaining("prepare response lost"),
    });

    const retried = await new InngestTestEngine({
      function: fn,
      events: [event],
      steps: await completedSpecStepsBefore(failed.state, LINEAR_SPEC_PREPARE_STEP_ID),
    }).execute();
    expect(retried.error).toBeUndefined();
    expect(retried.result).toMatchObject({ outcome: "needs-input" });
    expect(resolveCalls).toBe(1);
    expect(preparedBaseShas).toEqual(["a".repeat(40), "a".repeat(40)]);
  });

  it.each([
    [{ state: "closed" as const }, "invalid-publication"],
    [{ merged: true }, "invalid-publication"],
  ])("retains the run for a non-reviewable recovered PR", async (overrides, reason) => {
    const context = issueContext();
    const linear = fakeLinear(context);
    const repository = fakeRepository(workspace, [
      { path: "dev/plans/FER-267.md", status: "untracked" },
    ]);
    const github = fakeGitHub(overrides);
    const agent = fakeAgent(workspace, success(readyDecision));
    const output = await new InngestTestEngine({
      function: specFunction({
        linear: linear.service,
        repository: repository.service,
        github: github.service,
        agent: agent.agent,
      }),
      events: [workEvent(context)],
    }).execute();
    expect(output.result).toMatchObject({ outcome: "failed", reason });
    expect(linear.state.context.state.id).toBe(readiness.stateIds.inProgress);
    expect(repository.order).not.toContain("cleanup");
  });

  it("ignores a repeated completed delivery and keeps stable identities", async () => {
    const context = issueContext();
    const linear = fakeLinear(context);
    const repository = fakeRepository(workspace, []);
    const github = fakeGitHub();
    const agent = fakeAgent(workspace, success(needsInputDecision));
    const fn = specFunction({
      linear: linear.service,
      repository: repository.service,
      github: github.service,
      agent: agent.agent,
    });
    const event = workEvent(context);
    const identity = specWorkIdentity(event.data);
    const first = await new InngestTestEngine({ function: fn, events: [event] }).execute();
    const repeated = await new InngestTestEngine({ function: fn, events: [event] }).execute();

    expect(first.result).toMatchObject({ outcome: "needs-input" });
    expect(repeated.result).toEqual({ outcome: "ignored", reason: "not-spec-ready" });
    expect(agent.run).toHaveBeenCalledOnce();
    expect(identity.workId).toBe(workRequestEventId("spec", event.data));
    expect(identity.branch).toMatch(/^harness\/spec\/FER-267-[0-9a-f]{12}$/);
  });

  it("projects one bounded exhaustion comment and no lifecycle mutation on replay", async () => {
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

  it("claims and consumes Agent Ready in one durable step", async () => {
    const context = issueContext();
    const linear = fakeLinear(context);
    const repository = fakeRepository(workspace, []);
    const github = fakeGitHub();
    const agent = fakeAgent(workspace, success(needsInputDecision));
    const output = await new InngestTestEngine({
      function: specFunction({
        linear: linear.service,
        repository: repository.service,
        github: github.service,
        agent: agent.agent,
      }),
      events: [workEvent(context)],
    }).execute();
    expect(output.error).toBeUndefined();
    expect(
      output.ctx.step.run.mock.calls.filter((call) => call[0] === LINEAR_SPEC_CLAIM_STEP_ID),
    ).toHaveLength(1);
    expect(linear.state.order.slice(1, 3)).toEqual([
      `state:${readiness.stateIds.inProgress}`,
      `labels:${readiness.agentReadyLabelId}`,
    ]);
  });
});

async function completedSpecStepsBefore(
  state: Record<string, Promise<unknown>>,
  failedStepId: string,
) {
  const ids = [
    LINEAR_SPEC_LOAD_STEP_ID,
    LINEAR_SPEC_CLAIM_STEP_ID,
    LINEAR_SPEC_BASE_STEP_ID,
    LINEAR_SPEC_PREPARE_STEP_ID,
  ];
  const completed = ids.slice(0, ids.indexOf(failedStepId));
  const values = Object.values(state);
  return Promise.all(
    completed.map(async (id, index) => {
      const value = await values[index];
      return { id, handler: () => value };
    }),
  );
}
