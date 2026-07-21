import { Inngest } from "inngest";
import { InngestTestEngine, mockCtx } from "@inngest/test";
import { describe, expect, it, vi } from "vitest";
import {
  createLinearIssueRevisionObservedEvent,
  LinearIssueRevisionObservedEvent,
  linearIssueRevisionEventId,
} from "./inngest/linear-revision-events.ts";
import { WORK_REQUEST_EVENT_NAMES, WORK_REQUEST_EVENT_VERSION } from "./inngest/work-events.ts";
import type { LinearReadinessConfig } from "./linear-readiness.ts";
import {
  createLinearReadinessRouter,
  LINEAR_READINESS_CONFIRM_STEP_ID,
  LINEAR_READINESS_LOAD_STEP_ID,
  LINEAR_READINESS_ROUTER_FUNCTION_ID,
  LINEAR_READINESS_ROUTER_RETRIES,
  LINEAR_READINESS_SEND_STEP_ID,
  type LinearReadinessRouterLinear,
} from "./linear-readiness-router.ts";
import type { LinearIssueContext, LinearIssueReference } from "./linear/read.ts";

const UPDATED_AT = "2026-07-19T01:00:00.000Z";

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
  enabledRoutes: {
    triage: true,
    spec: true,
    implement: true,
  },
};

function client() {
  return new Inngest({
    id: "harness-linear-readiness",
    eventKey: "test",
    fetch: async () => Response.json({ ids: ["sent-event"], status: 200 }),
  });
}

function router(
  linear: LinearReadinessRouterLinear,
  readinessOverride: LinearReadinessConfig = readiness,
) {
  return createLinearReadinessRouter({
    client: client(),
    linear,
    config: { readiness: readinessOverride },
  });
}

function fakeLinear(...contexts: LinearIssueContext[]) {
  let index = 0;
  const getIssueContext = vi.fn<LinearReadinessRouterLinear["getIssueContext"]>(async () => {
    const value = contexts[index] ?? contexts.at(-1);
    index += 1;
    if (!value) throw new Error("Unexpected Linear read");
    return value;
  });
  return {
    service: { getIssueContext } satisfies LinearReadinessRouterLinear,
    getIssueContext,
  };
}

function issueContext(
  input: {
    id?: string;
    identifier?: string;
    updatedAt?: string;
    stateId?: string;
    actionLabelId?: string;
    blockerStateId?: string;
  } = {},
): LinearIssueContext {
  return {
    id: input.id ?? "issue-1",
    identifier: input.identifier ?? "FER-225",
    title: "Route Linear readiness",
    description: "Description",
    url: "https://linear.app/example/FER-225",
    state: workflowState(input.stateId ?? readiness.stateIds.backlog),
    team: { id: readiness.teamId, key: "FER", name: "ferueda" },
    project: {
      id: readiness.projectId,
      name: "Harness",
      url: "https://linear.app/example/project",
    },
    assignee: null,
    creator: null,
    labels: input.actionLabelId
      ? [{ id: input.actionLabelId, name: `Label ${input.actionLabelId}` }]
      : [],
    comments: [],
    parent: null,
    children: [],
    duplicateOf: null,
    blockedBy: input.blockerStateId ? [blocker(input.blockerStateId)] : [],
    related: [],
    attachments: [],
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: input.updatedAt ?? UPDATED_AT,
    completeness: {
      commentsTruncated: false,
      labelsTruncated: false,
      relationsTruncated: false,
      attachmentsTruncated: false,
      childrenTruncated: false,
    },
  };
}

function workflowState(id: string) {
  return { id, name: `State ${id}`, type: "started" };
}

function blocker(stateId: string): LinearIssueReference {
  return {
    id: "blocker-1",
    identifier: "FER-100",
    title: "Blocker",
    url: "https://linear.app/example/FER-100",
    state: workflowState(stateId),
  };
}

function revisionEvent(updatedAt = UPDATED_AT) {
  return createLinearIssueRevisionObservedEvent({
    issueId: "issue-1",
    issueIdentifier: "FER-225",
    updatedAt,
  });
}

function sentEvent(output: Awaited<ReturnType<InngestTestEngine["execute"]>>) {
  const call = vi.mocked(output.ctx.step.sendEvent).mock.calls[0];
  if (!call) throw new Error("Expected a sent work event");
  return call[1] as {
    id: string;
    name: string;
    v: string;
    data: Record<string, unknown>;
  };
}

describe("Linear readiness router", () => {
  it("locks the trusted revision trigger and global function controls", () => {
    const linear = fakeLinear(issueContext());

    expect(router(linear.service).opts).toMatchObject({
      id: LINEAR_READINESS_ROUTER_FUNCTION_ID,
      concurrency: 1,
      retries: LINEAR_READINESS_ROUTER_RETRIES,
      triggers: [LinearIssueRevisionObservedEvent],
    });
  });

  it("routes a matching Backlog revision to triage", async () => {
    const linear = fakeLinear(issueContext());
    const event = revisionEvent();
    const output = await new InngestTestEngine({
      function: router(linear.service),
      events: [event],
    }).execute();

    expect(output.error).toBeUndefined();
    expect(output.result).toMatchObject({
      outcome: "dispatched",
      route: "triage",
      issueId: "issue-1",
    });
    expect(linear.getIssueContext).toHaveBeenCalledExactlyOnceWith("issue-1");
    expect(output.ctx.step.run).toHaveBeenCalledWith(
      LINEAR_READINESS_LOAD_STEP_ID,
      expect.any(Function),
    );
    expect(output.ctx.step.run).not.toHaveBeenCalledWith(
      LINEAR_READINESS_CONFIRM_STEP_ID,
      expect.any(Function),
    );
    expect(sentEvent(output)).toMatchObject({
      name: WORK_REQUEST_EVENT_NAMES.triage,
      v: WORK_REQUEST_EVENT_VERSION,
      data: {
        issueId: "issue-1",
        issueIdentifier: "FER-225",
        causationEventId: linearIssueRevisionEventId(event.data),
      },
    });
  });

  it.each([
    ["spec", readiness.agentActionLabelIds.spec, WORK_REQUEST_EVENT_NAMES.spec],
    ["implement", readiness.agentActionLabelIds.implement, WORK_REQUEST_EVENT_NAMES.implement],
  ] as const)("refetches before an enabled %s dispatch", async (route, labelId, eventName) => {
    const current = issueContext({ stateId: readiness.stateIds.open, actionLabelId: labelId });
    const linear = fakeLinear(current, current);
    const output = await new InngestTestEngine({
      function: router(linear.service),
      events: [revisionEvent()],
    }).execute();

    expect(output.error).toBeUndefined();
    expect(output.result).toMatchObject({ outcome: "dispatched", route });
    expect(linear.getIssueContext).toHaveBeenCalledTimes(2);
    expect(output.ctx.step.run).toHaveBeenCalledWith(
      LINEAR_READINESS_CONFIRM_STEP_ID,
      expect.any(Function),
    );
    expect(sentEvent(output)).toMatchObject({ name: eventName });
  });

  it.each(["2026-07-19T00:59:00.000Z", "2026-07-19T01:01:00.000Z"])(
    "returns stale for a mismatched %s refetch revision",
    async (updatedAt) => {
      const linear = fakeLinear(issueContext({ updatedAt }));
      const output = await new InngestTestEngine({
        function: router(linear.service),
        events: [revisionEvent()],
      }).execute();

      expect(output.result).toEqual({
        outcome: "stale",
        reason: "revision-changed",
        issueId: "issue-1",
      });
      expect(output.ctx.step.sendEvent).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["issue ID", issueContext({ id: "issue-other" }), "expected issue-1"],
    ["identifier", issueContext({ identifier: "FER-999" }), "expected FER-225"],
  ])("rejects a mismatched %s", async (_label, context, message) => {
    const linear = fakeLinear(context);
    const output = await new InngestTestEngine({
      function: router(linear.service),
      events: [revisionEvent()],
    }).execute();

    expect(output.error).toMatchObject({ message: expect.stringContaining(message) });
    expect(output.ctx.step.sendEvent).not.toHaveBeenCalled();
  });

  it("does not dispatch a disabled route", async () => {
    const current = issueContext({
      stateId: readiness.stateIds.open,
      actionLabelId: readiness.agentActionLabelIds.spec,
    });
    const linear = fakeLinear(current);
    const output = await new InngestTestEngine({
      function: router(linear.service, {
        ...readiness,
        enabledRoutes: { ...readiness.enabledRoutes, spec: false },
      }),
      events: [revisionEvent()],
    }).execute();

    expect(output.result).toMatchObject({ outcome: "wait", reason: "route-disabled" });
    expect(linear.getIssueContext).toHaveBeenCalledOnce();
    expect(output.ctx.step.sendEvent).not.toHaveBeenCalled();
  });

  it("drops an actionable snapshot that changes before dispatch", async () => {
    const initial = issueContext({
      stateId: readiness.stateIds.open,
      actionLabelId: readiness.agentActionLabelIds.spec,
    });
    const changed = issueContext({ stateId: readiness.stateIds.needsInput });
    const linear = fakeLinear(initial, changed);
    const output = await new InngestTestEngine({
      function: router(linear.service),
      events: [revisionEvent()],
    }).execute();

    expect(output.result).toEqual({
      outcome: "stale",
      reason: "readiness-changed",
      issueId: "issue-1",
    });
    expect(linear.getIssueContext).toHaveBeenCalledTimes(2);
    expect(output.ctx.step.sendEvent).not.toHaveBeenCalled();
  });

  it("ignores a claimed issue without reusing an earlier route", async () => {
    const linear = fakeLinear(issueContext({ stateId: readiness.stateIds.inProgress }));
    const output = await new InngestTestEngine({
      function: router(linear.service),
      events: [revisionEvent()],
    }).execute();

    expect(output.result).toMatchObject({ outcome: "ignore", reason: "already-claimed" });
    expect(output.ctx.step.sendEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["Needs Input", readiness.stateIds.needsInput, "needs-input"],
    ["Needs Review", readiness.stateIds.needsReview, "needs-review"],
  ] as const)("ignores the human-owned %s status", async (_label, stateId, reason) => {
    const linear = fakeLinear(issueContext({ stateId }));
    const output = await new InngestTestEngine({
      function: router(linear.service),
      events: [revisionEvent()],
    }).execute();

    expect(output.result).toMatchObject({ outcome: "ignore", reason });
    expect(output.ctx.step.sendEvent).not.toHaveBeenCalled();
  });

  it("creates a new triage request when a human returns a newer issue revision to Backlog", async () => {
    const secondUpdatedAt = "2026-07-19T02:00:00.000Z";
    const first = await new InngestTestEngine({
      function: router(fakeLinear(issueContext()).service),
      events: [revisionEvent()],
    }).execute();
    const second = await new InngestTestEngine({
      function: router(fakeLinear(issueContext({ updatedAt: secondUpdatedAt })).service),
      events: [revisionEvent(secondUpdatedAt)],
    }).execute();
    const firstEvent = sentEvent(first);
    const secondEvent = sentEvent(second);

    expect(secondEvent.id).not.toBe(firstEvent.id);
    expect(secondEvent.data.causationEventId).not.toBe(firstEvent.data.causationEventId);
    expect(secondEvent.data.snapshotGeneration).not.toBe(firstEvent.data.snapshotGeneration);
    expect(firstEvent.data).not.toHaveProperty("rawBody");
    expect(firstEvent.data).not.toHaveProperty("signature");
  });

  it("retries a failed durable send with the same event identity", async () => {
    let attempted: unknown;
    const failed = await new InngestTestEngine({
      function: router(fakeLinear(issueContext()).service),
      events: [revisionEvent()],
      transformCtx(raw) {
        const context = mockCtx(raw);
        context.step.sendEvent = vi.fn<typeof context.step.sendEvent>(async (_stepId, event) => {
          attempted = event;
          throw new Error("send unavailable");
        });
        return context;
      },
    }).execute();
    const retry = await new InngestTestEngine({
      function: router(fakeLinear(issueContext()).service),
      events: [revisionEvent()],
    }).execute();

    expect(failed.error).toMatchObject({ message: expect.stringContaining("send unavailable") });
    expect(attempted).toMatchObject({ id: sentEvent(retry).id });
    expect(retry.ctx.step.sendEvent).toHaveBeenCalledWith(
      LINEAR_READINESS_SEND_STEP_ID,
      expect.objectContaining({ id: sentEvent(retry).id }),
    );
  });

  it("rejects invalid trusted configuration before creating the function", () => {
    const linear = fakeLinear(issueContext());

    expect(() =>
      router(linear.service, {
        ...readiness,
        stateIds: { ...readiness.stateIds, open: readiness.stateIds.backlog },
      }),
    ).toThrow(/IDs must be unique/);
  });
});
