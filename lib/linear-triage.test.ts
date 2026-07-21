import { Inngest } from "inngest";
import { InngestTestEngine } from "@inngest/test";
import { describe, expect, it, vi } from "vitest";
import type { Agent, AgentRunInput, AgentRunResult } from "./agents.ts";
import {
  TriageWorkRequestedEvent,
  workRequestEventId,
  type WorkRequestData,
} from "./inngest/work-events.ts";
import {
  linearReadinessSnapshotGeneration,
  type LinearReadinessConfig,
} from "./linear-readiness.ts";
import {
  createLinearTriageFunction,
  LINEAR_TRIAGE_AGENT_STEP_ID,
  LINEAR_TRIAGE_COMMENT_STEP_ID,
  LINEAR_TRIAGE_CONFIRM_STEP_ID,
  LINEAR_TRIAGE_FUNCTION_ID,
  LINEAR_TRIAGE_LABELS_STEP_ID,
  LINEAR_TRIAGE_LOAD_STEP_ID,
  LINEAR_TRIAGE_RELATIONS_STEP_ID,
  LINEAR_TRIAGE_RESOLVE_STEP_ID,
  LINEAR_TRIAGE_RETRIES,
  LINEAR_TRIAGE_STATE_STEP_ID,
  type LinearTriageService,
} from "./linear-triage.ts";
import type { LinearIssueContext, LinearIssueReference } from "./linear/read.ts";
import type { TriageDecision } from "./triage/schema.ts";
import {
  completedStepsBefore,
  fakeLinear,
  projectionState,
  statefulLinear,
} from "../test/linear-triage-test-fixtures.ts";

const readiness: LinearReadinessConfig = {
  teamId: "team-1",
  projectId: "project-1",
  stateIds: {
    backlog: "state-backlog",
    open: "state-open",
    inProgress: "state-in-progress",
    inReview: "state-in-review",
    done: "state-done",
    canceled: "state-canceled",
    duplicate: "state-duplicate",
  },
  nextActionLabelIds: {
    plan: "label-plan",
    implement: "label-implement",
    needsInput: "label-needs-input",
  },
  enabledRoutes: {
    triage: true,
    plan: false,
    implement: false,
  },
};

const READY_TO_IMPLEMENT = {
  decision: "ready-for-agent",
  scope: "bounded",
  agentAction: "implement",
  rationale: "The issue has one bounded implementation outcome.",
  evidence: [{ kind: "tracker", path: null, summary: "The acceptance boundary is explicit." }],
  questions: [],
  inputReason: null,
  duplicateOf: null,
  blockedBy: [],
} satisfies TriageDecision;

const READY_TO_PLAN = {
  ...READY_TO_IMPLEMENT,
  agentAction: "plan",
  rationale: "The next useful deliverable is a technical plan.",
} satisfies TriageDecision;

const NEEDS_INPUT = {
  ...READY_TO_IMPLEMENT,
  decision: "needs-input",
  agentAction: null,
  rationale: "One product decision blocks useful agent work.",
  questions: ["Should this include archived records?"],
  inputReason: "product-decision",
} satisfies TriageDecision;

const DUPLICATE = {
  ...READY_TO_IMPLEMENT,
  decision: "duplicate",
  agentAction: null,
  rationale: "FER-400 already owns this outcome.",
  duplicateOf: "FER-400",
} satisfies TriageDecision;

function client() {
  return new Inngest({
    id: "harness-linear-triage",
    eventKey: "test",
    fetch: async () => Response.json({ ids: ["sent-event"], status: 200 }),
  });
}

function triageFunction(
  linear: LinearTriageService,
  agent: Agent,
  configOverrides: Partial<{
    readiness: LinearReadinessConfig;
    workspace: string;
    model: string;
    maxRuntimeMs: number;
  }> = {},
) {
  return createLinearTriageFunction({
    client: client(),
    linear,
    agent,
    config: {
      readiness: configOverrides.readiness ?? readiness,
      workspace: configOverrides.workspace ?? "/workspace/harness",
      execution: {
        model: configOverrides.model ?? "gpt-5.6-sol",
        modelReasoningEffort: "high",
        maxRuntimeMs: configOverrides.maxRuntimeMs ?? 120_000,
      },
    },
  });
}

function issueContext(
  input: {
    id?: string;
    identifier?: string;
    stateId?: string;
    teamId?: string;
    projectId?: string | null;
    actionLabelId?: string;
    completeness?: Partial<LinearIssueContext["completeness"]>;
  } = {},
): LinearIssueContext {
  return {
    id: input.id ?? "issue-1",
    identifier: input.identifier ?? "FER-218",
    title: "Triage Linear issues independently",
    description: "Project one triage decision.",
    url: "https://linear.app/example/FER-218",
    state: workflowState(input.stateId ?? readiness.stateIds.backlog),
    team: { id: input.teamId ?? readiness.teamId, key: "FER", name: "ferueda" },
    project:
      input.projectId === null
        ? null
        : {
            id: input.projectId ?? readiness.projectId,
            name: "Harness",
            url: "https://linear.app/example/project",
          },
    assignee: null,
    creator: null,
    labels: [
      { id: "label-unrelated", name: "Improvement" },
      ...(input.actionLabelId
        ? [{ id: input.actionLabelId, name: `Action ${input.actionLabelId}` }]
        : []),
    ],
    comments: [
      {
        id: "comment-1",
        body: "Please keep the implementation small.",
        author: {
          kind: "user",
          id: "user-1",
          name: "Felipe Rueda",
          displayName: "Felipe",
        },
        parentId: null,
        quotedText: null,
        createdAt: "2026-07-20T10:00:00.000Z",
        updatedAt: "2026-07-20T10:00:00.000Z",
      },
    ],
    parent: reference("parent-1", "FER-211"),
    children: [reference("child-1", "FER-219")],
    duplicateOf: null,
    blockedBy: [],
    related: [reference("related-1", "FER-225")],
    attachments: [
      {
        id: "attachment-1",
        title: "Design reference",
        subtitle: null,
        url: "https://example.com/design",
        sourceType: "url",
        createdAt: "2026-07-20T10:00:00.000Z",
        updatedAt: "2026-07-20T10:00:00.000Z",
      },
    ],
    createdAt: "2026-07-20T09:00:00.000Z",
    updatedAt: "2026-07-20T10:00:00.000Z",
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

function reference(id: string, identifier: string): LinearIssueReference {
  return {
    id,
    identifier,
    title: `Issue ${identifier}`,
    url: `https://linear.app/example/${identifier}`,
    state: workflowState(readiness.stateIds.open),
  };
}

function workflowState(id: string) {
  return { id, name: `State ${id}`, type: "unstarted" };
}

function workEvent(context: LinearIssueContext, overrides: Partial<WorkRequestData> = {}) {
  const data: WorkRequestData = {
    issueId: context.id,
    issueIdentifier: context.identifier,
    causationEventId: "harness-linear-webhook-v1-delivery-1",
    snapshotGeneration: linearReadinessSnapshotGeneration(context, readiness),
    ...overrides,
  };
  return TriageWorkRequestedEvent.create(data, { id: workRequestEventId("triage", data) });
}

function fakeAgent(result: AgentRunResult) {
  const run = vi.fn<Agent["run"]>(async () => result);
  return { agent: { name: "codex", run } satisfies Agent, run };
}

describe("independent Linear triage function", () => {
  it("locks the typed trigger, retry count, and per-issue concurrency", () => {
    const context = issueContext();
    const linear = fakeLinear({ roots: [context] });
    const agent = fakeAgent(success(READY_TO_IMPLEMENT));

    const fn = triageFunction(linear.service, agent.agent);

    expect(fn.opts).toMatchObject({
      id: LINEAR_TRIAGE_FUNCTION_ID,
      concurrency: { key: "event.data.issueId", limit: 1 },
      retries: LINEAR_TRIAGE_RETRIES,
      triggers: [TriageWorkRequestedEvent],
    });
  });

  it("adapts rich context and projects Implement with blockers in durable order", async () => {
    const context = issueContext();
    const blocker = issueContext({ id: "blocker-1", identifier: "FER-300" });
    const linear = fakeLinear({
      roots: [context, context],
      targets: { "FER-300": blocker },
    });
    const agent = fakeAgent(success({ ...READY_TO_IMPLEMENT, blockedBy: ["FER-300", "FER-300"] }));
    const output = await new InngestTestEngine({
      function: triageFunction(linear.service, agent.agent),
      events: [workEvent(context)],
    }).execute();

    expect(output.error).toBeUndefined();
    expect(output.result).toEqual({
      outcome: "projected",
      decision: "ready-for-agent",
      agentAction: "implement",
      issueId: context.id,
    });
    expect(linear.order).toEqual([
      "read:issue-1",
      "read:issue-1",
      "read:FER-300",
      "comment",
      "blocker",
      "labels",
      "state",
    ]);
    expect(agent.run).toHaveBeenCalledOnce();
    const agentInput = agent.run.mock.calls[0]?.[0] as AgentRunInput;
    expect(agentInput).toMatchObject({
      workspace: "/workspace/harness",
      model: "gpt-5.6-sol",
      modelReasoningEffort: "high",
      sandboxMode: "read-only",
    });
    expect(agentInput.prompt).toContain('"labels": [\n    "Improvement"');
    expect(agentInput.prompt).toContain('"author": "Felipe"');
    expect(agentInput.prompt).toContain('"reference": "FER-211"');
    expect(agentInput.prompt).toContain('"title": "Design reference"');
    expect(linear.ensureBlockedByRelation).toHaveBeenCalledExactlyOnceWith({
      issueId: context.id,
      blockerIssueId: blocker.id,
    });
    expect(linear.updateIssueLabels).toHaveBeenCalledWith({
      issueId: context.id,
      addLabelIds: [readiness.nextActionLabelIds.implement],
      removeLabelIds: [readiness.nextActionLabelIds.plan, readiness.nextActionLabelIds.needsInput],
    });
    expect(linear.updateIssueState).toHaveBeenCalledWith({
      issueId: context.id,
      expectedStateId: readiness.stateIds.backlog,
      stateId: readiness.stateIds.open,
    });
    const comment = linear.ensureComment.mock.calls[0]?.[0];
    const expectedEventId = workRequestEventId("triage", workEvent(context).data);
    expect(comment?.marker).toBe(`<!-- harness:linear-triage:${expectedEventId} -->`);
    expect(comment?.body).toContain("Ready for agent — Implement");
    expect(comment?.body).toContain(
      "**Why Implement:** The issue has one bounded implementation outcome.",
    );
    expect(comment?.body).toContain("**Blocked by:** FER-300, FER-300");
    expect(comment?.body).toContain("codex / gpt-5.6-sol / high");
    expect(comment?.body).not.toContain("causationEventId");
    expect(output.ctx.step.sendEvent).not.toHaveBeenCalled();
  });

  it.each([
    [
      "Plan",
      READY_TO_PLAN,
      readiness.nextActionLabelIds.plan,
      [readiness.nextActionLabelIds.implement, readiness.nextActionLabelIds.needsInput],
      "Ready for agent — Plan",
      "The next useful deliverable is a technical plan.",
    ],
    [
      "Needs Input",
      NEEDS_INPUT,
      readiness.nextActionLabelIds.needsInput,
      [readiness.nextActionLabelIds.plan, readiness.nextActionLabelIds.implement],
      "Should this include archived records?",
      "**Input reason:** product-decision",
    ],
  ] as const)(
    "projects %s as one action label followed by Open",
    async (_name, decision, add, remove, firstCommentSnippet, secondCommentSnippet) => {
      const context = issueContext();
      const linear = fakeLinear({ roots: [context, context] });
      const agent = fakeAgent(success(decision));
      const output = await new InngestTestEngine({
        function: triageFunction(linear.service, agent.agent),
        events: [workEvent(context)],
      }).execute();

      expect(output.error).toBeUndefined();
      expect(linear.order).toEqual(["read:issue-1", "read:issue-1", "comment", "labels", "state"]);
      expect(linear.updateIssueLabels).toHaveBeenCalledWith({
        issueId: context.id,
        addLabelIds: [add],
        removeLabelIds: remove,
      });
      expect(linear.ensureComment.mock.calls[0]?.[0].body).toContain(firstCommentSnippet);
      expect(linear.ensureComment.mock.calls[0]?.[0].body).toContain(secondCommentSnippet);
      expect(linear.ensureComment.mock.calls[0]?.[0].body).toContain(
        _name === "Plan"
          ? "**Why Plan:** The next useful deliverable is a technical plan."
          : "**Why Needs Input:** One product decision blocks useful agent work.",
      );
    },
  );

  it("clears action labels before creating a duplicate relation and never moves to Open", async () => {
    const context = issueContext();
    const duplicate = issueContext({ id: "duplicate-1", identifier: "FER-400" });
    const linear = fakeLinear({
      roots: [context, context],
      targets: { "FER-400": duplicate },
    });
    const agent = fakeAgent(success(DUPLICATE));
    const output = await new InngestTestEngine({
      function: triageFunction(linear.service, agent.agent),
      events: [workEvent(context)],
    }).execute();

    expect(output.result).toEqual({
      outcome: "projected",
      decision: "duplicate",
      issueId: context.id,
    });
    expect(linear.order).toEqual([
      "read:issue-1",
      "read:issue-1",
      "read:FER-400",
      "comment",
      "labels",
      "duplicate",
    ]);
    expect(linear.updateIssueLabels).toHaveBeenCalledWith({
      issueId: context.id,
      addLabelIds: [],
      removeLabelIds: Object.values(readiness.nextActionLabelIds),
    });
    expect(linear.ensureDuplicateRelation).toHaveBeenCalledWith({
      issueId: context.id,
      duplicateOfIssueId: duplicate.id,
    });
    expect(linear.ensureComment.mock.calls[0]?.[0].body).toContain(
      "**Why Duplicate:** FER-400 already owns this outcome.",
    );
    expect(linear.updateIssueState).not.toHaveBeenCalled();
  });

  it.each([
    ["commentsTruncated"],
    ["labelsTruncated"],
    ["relationsTruncated"],
    ["attachmentsTruncated"],
    ["childrenTruncated"],
  ] as const)("fails closed before the agent when %s is true", async (flag) => {
    const context = issueContext({ completeness: { [flag]: true } });
    const linear = fakeLinear({ roots: [context] });
    const agent = fakeAgent(success(READY_TO_IMPLEMENT));
    const output = await new InngestTestEngine({
      function: triageFunction(linear.service, agent.agent),
      events: [workEvent(context)],
    }).execute();

    expect(output.result).toEqual({ outcome: "ignored", reason: "incomplete-context" });
    expect(agent.run).not.toHaveBeenCalled();
    expect(linear.ensureComment).not.toHaveBeenCalled();
  });

  it.each([
    [
      "issue identity mismatch",
      issueContext({ identifier: "FER-999" }),
      { issueIdentifier: "FER-218" },
      "issue-mismatch",
    ],
    ["out-of-scope project", issueContext({ projectId: "project-other" }), {}, "not-triage-ready"],
    [
      "no longer Backlog",
      issueContext({
        stateId: readiness.stateIds.open,
        actionLabelId: readiness.nextActionLabelIds.plan,
      }),
      {},
      "not-triage-ready",
    ],
    ["stale generation", issueContext(), { snapshotGeneration: "f".repeat(64) }, "stale-snapshot"],
  ] as const)("ignores %s before running the agent", async (_name, context, overrides, reason) => {
    const linear = fakeLinear({ roots: [context] });
    const agent = fakeAgent(success(READY_TO_IMPLEMENT));
    const output = await new InngestTestEngine({
      function: triageFunction(linear.service, agent.agent),
      events: [workEvent(context, overrides)],
    }).execute();

    expect(output.result).toEqual({ outcome: "ignored", reason });
    expect(agent.run).not.toHaveBeenCalled();
    expect(linear.ensureComment).not.toHaveBeenCalled();
  });

  it("stops after the single confirmation read when readiness changed during triage", async () => {
    const initial = issueContext();
    const changed = issueContext({
      stateId: readiness.stateIds.open,
      actionLabelId: readiness.nextActionLabelIds.implement,
    });
    const linear = fakeLinear({ roots: [initial, changed] });
    const agent = fakeAgent(success(READY_TO_IMPLEMENT));
    const output = await new InngestTestEngine({
      function: triageFunction(linear.service, agent.agent),
      events: [workEvent(initial)],
    }).execute();

    expect(output.result).toEqual({
      outcome: "stale",
      reason: "not-triage-ready",
      issueId: initial.id,
    });
    expect(agent.run).toHaveBeenCalledOnce();
    expect(linear.ensureComment).not.toHaveBeenCalled();
    expect(linear.updateIssueLabels).not.toHaveBeenCalled();
  });

  it.each([
    [
      "invalid-output",
      { ok: true, structuredOutput: { ...READY_TO_IMPLEMENT, agentAction: null }, raw: {} },
    ],
    ["cancelled", { ok: false, error: "aborted", exitCode: 130, aborted: true }],
    [
      "workspace-guard",
      { ok: false, error: "workspace changed", exitCode: 1, failureKind: "workspace-guard" },
    ],
  ] satisfies ReadonlyArray<[string, AgentRunResult]>)(
    "ends a terminal %s agent failure without projection",
    async (failureKind, agentResult) => {
      const context = issueContext();
      const linear = fakeLinear({ roots: [context] });
      const agent = fakeAgent(agentResult);
      const output = await new InngestTestEngine({
        function: triageFunction(linear.service, agent.agent),
        events: [workEvent(context)],
      }).execute();

      expect(output.error).toBeUndefined();
      expect(output.result).toMatchObject({ outcome: "failed", reason: failureKind });
      expect(linear.getIssueContext).toHaveBeenCalledOnce();
      expect(linear.ensureComment).not.toHaveBeenCalled();
    },
  );

  it("throws provider failure inside the durable agent step so Inngest can retry it", async () => {
    const context = issueContext();
    const linear = fakeLinear({ roots: [context] });
    const agent = fakeAgent({ ok: false, error: "provider unavailable", exitCode: 1 });
    const output = await new InngestTestEngine({
      function: triageFunction(linear.service, agent.agent),
      events: [workEvent(context)],
    }).execute();

    expect(output.error).toMatchObject({
      message: expect.stringContaining("provider unavailable"),
    });
    expect(output.ctx.step.run).toHaveBeenCalledWith(
      LINEAR_TRIAGE_AGENT_STEP_ID,
      expect.any(Function),
    );
    expect(linear.ensureComment).not.toHaveBeenCalled();
  });

  it("rejects self-referencing relations before the first mutation", async () => {
    const context = issueContext();
    const linear = fakeLinear({
      roots: [context, context],
      targets: { "FER-218": context },
    });
    const agent = fakeAgent(success({ ...READY_TO_IMPLEMENT, blockedBy: ["FER-218"] }));
    const output = await new InngestTestEngine({
      function: triageFunction(linear.service, agent.agent),
      events: [workEvent(context)],
    }).execute();

    expect(output.error).toMatchObject({
      message: expect.stringContaining("cannot reference"),
    });
    expect(linear.ensureComment).not.toHaveBeenCalled();
    expect(linear.updateIssueLabels).not.toHaveBeenCalled();
  });

  it.each([
    ["comment", LINEAR_TRIAGE_COMMENT_STEP_ID],
    ["blocker", LINEAR_TRIAGE_RELATIONS_STEP_ID],
    ["labels", LINEAR_TRIAGE_LABELS_STEP_ID],
    ["state", LINEAR_TRIAGE_STATE_STEP_ID],
  ] as const)(
    "converges after a lost %s response and durable replay",
    async (boundary, failedStepId) => {
      const context = issueContext();
      const blocker = issueContext({ id: "blocker-1", identifier: "FER-300" });
      const state = projectionState(context, boundary);
      const linear = statefulLinear(context, blocker, state);
      const agent = fakeAgent(success({ ...READY_TO_IMPLEMENT, blockedBy: [" FER-300 "] }));
      const fn = triageFunction(linear.service, agent.agent);
      const event = workEvent(context);
      const failed = await new InngestTestEngine({
        function: fn,
        events: [event],
      }).execute();

      expect(failed.error).toMatchObject({
        message: expect.stringContaining(`${boundary} response lost`),
      });
      const retry = await new InngestTestEngine({
        function: fn,
        events: [event],
        steps: await completedStepsBefore(failed.state, failedStepId),
      }).execute();

      expect(retry.error).toBeUndefined();
      expect(retry.result).toMatchObject({
        outcome: "projected",
        decision: "ready-for-agent",
        agentAction: "implement",
      });
      expect(state.applied).toEqual({ comment: 1, blocker: 1, labels: 1, state: 1 });
      expect(state.commentMarkers).toHaveLength(1);
      expect(state.blockerIssueIds).toEqual(new Set([blocker.id]));
      expect(state.labelIds).toEqual(
        new Set(["label-unrelated", readiness.nextActionLabelIds.implement]),
      );
      expect(state.stateId).toBe(readiness.stateIds.open);
      expect(agent.run).toHaveBeenCalledOnce();
      expect(linear.getIssueContext).toHaveBeenCalledWith("FER-300");
      expect(retry.ctx.step.sendEvent).not.toHaveBeenCalled();
    },
  );

  it("ignores a repeated completed delivery after the first projection", async () => {
    const context = issueContext();
    const blocker = issueContext({ id: "blocker-1", identifier: "FER-300" });
    const state = projectionState(context, null);
    const linear = statefulLinear(context, blocker, state);
    const agent = fakeAgent(success({ ...READY_TO_IMPLEMENT, blockedBy: ["FER-300"] }));
    const fn = triageFunction(linear.service, agent.agent);
    const event = workEvent(context);
    const first = await new InngestTestEngine({
      function: fn,
      events: [workEvent(context)],
    }).execute();
    const repeated = await new InngestTestEngine({
      function: fn,
      events: [event],
    }).execute();

    expect(first.result).toMatchObject({ outcome: "projected" });
    expect(repeated.result).toEqual({
      outcome: "ignored",
      reason: "not-triage-ready",
    });
    expect(state.applied).toEqual({ comment: 1, blocker: 1, labels: 1, state: 1 });
    expect(state.commentMarkers).toHaveLength(1);
    expect(state.blockerIssueIds).toHaveLength(1);
    expect(state.labelIds).toContain("label-unrelated");
    expect(agent.run).toHaveBeenCalledOnce();
    expect(first.ctx.step.sendEvent).not.toHaveBeenCalled();
    expect(repeated.ctx.step.sendEvent).not.toHaveBeenCalled();
  });

  it("uses fixed read and resolution step boundaries", async () => {
    const context = issueContext();
    const linear = fakeLinear({ roots: [context, context] });
    const agent = fakeAgent(success(READY_TO_IMPLEMENT));
    const output = await new InngestTestEngine({
      function: triageFunction(linear.service, agent.agent),
      events: [workEvent(context)],
    }).execute();

    for (const stepId of [
      LINEAR_TRIAGE_LOAD_STEP_ID,
      LINEAR_TRIAGE_CONFIRM_STEP_ID,
      LINEAR_TRIAGE_RESOLVE_STEP_ID,
    ]) {
      expect(output.ctx.step.run).toHaveBeenCalledWith(stepId, expect.any(Function));
    }
  });

  it("rejects invalid trusted configuration before creating the function", () => {
    const context = issueContext();
    const linear = fakeLinear({ roots: [context] });
    const agent = fakeAgent(success(READY_TO_IMPLEMENT));

    expect(() => triageFunction(linear.service, agent.agent, { workspace: " " })).toThrow(
      /workspace/,
    );
    expect(() => triageFunction(linear.service, agent.agent, { maxRuntimeMs: 0 })).toThrow(
      /maxRuntimeMs/,
    );
  });
});

function success(decision: TriageDecision): AgentRunResult {
  return {
    ok: true,
    structuredOutput: decision,
    raw: {},
    session: { provider: "codex", id: "thread-218" },
  };
}
