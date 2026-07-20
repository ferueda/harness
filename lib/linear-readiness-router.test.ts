import { createHmac } from "node:crypto";
import { Inngest } from "inngest";
import { InngestTestEngine, mockCtx } from "@inngest/test";
import { describe, expect, it, vi } from "vitest";
import { WORK_REQUEST_EVENT_NAMES, WORK_REQUEST_EVENT_VERSION } from "./inngest/work-events.ts";
import {
  LINEAR_WEBHOOK_RECEIVED_EVENT_ID_PREFIX,
  LinearWebhookReceivedEvent,
} from "./inngest/linear-webhook-transform.ts";
import type { LinearReadinessConfig } from "./linear-readiness.ts";
import {
  createLinearReadinessRouter,
  LINEAR_READINESS_CONFIRM_STEP_ID,
  LINEAR_READINESS_LOAD_STEP_ID,
  LINEAR_READINESS_ROUTER_FUNCTION_ID,
  LINEAR_READINESS_ROUTER_RETRIES,
  LINEAR_READINESS_SEND_STEP_ID,
  LINEAR_READINESS_VERIFY_STEP_ID,
  type LinearReadinessRouterLinear,
} from "./linear-readiness-router.ts";
import type { LinearIssueContext, LinearIssueReference } from "./linear/read.ts";

const SECRET = "linear-webhook-secret";
const ORGANIZATION_ID = "organization-1";
const RECEIVED_AT = Date.parse("2026-07-19T15:00:00.000Z");

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
    plan: true,
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
  configOverrides: {
    webhookSecret?: string;
    organizationId?: string;
    readiness?: LinearReadinessConfig;
  } = {},
) {
  return createLinearReadinessRouter({
    client: client(),
    linear,
    config: {
      webhookSecret: configOverrides.webhookSecret ?? SECRET,
      organizationId: configOverrides.organizationId ?? ORGANIZATION_ID,
      readiness: configOverrides.readiness ?? readiness,
    },
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
    stateId?: string;
    actionLabelId?: string;
    blockerStateId?: string;
  } = {},
): LinearIssueContext {
  return {
    id: "issue-1",
    identifier: "FER-225",
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
    updatedAt: "2026-07-19T01:00:00.000Z",
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

function receivedEvent(
  input: {
    action?: string;
    type?: string;
    organizationId?: string;
    deliveryId?: string;
    webhookTimestamp?: number;
    data?: unknown;
    signature?: string;
    rawBody?: string;
  } = {},
) {
  const deliveryId = input.deliveryId ?? "delivery-1";
  const payload = {
    action: input.action ?? "create",
    type: input.type ?? "Issue",
    organizationId: input.organizationId ?? ORGANIZATION_ID,
    webhookTimestamp: input.webhookTimestamp ?? RECEIVED_AT,
    data:
      "data" in input
        ? input.data
        : {
            id: "issue-1",
            updatedAt: "2026-07-19T15:00:00.000Z",
          },
  };
  const rawBody = input.rawBody ?? JSON.stringify(payload);
  const signature = input.signature ?? createHmac("sha256", SECRET).update(rawBody).digest("hex");
  const options = {
    id:
      deliveryId.trim() === ""
        ? undefined
        : `${LINEAR_WEBHOOK_RECEIVED_EVENT_ID_PREFIX}${deliveryId}`,
    ts: RECEIVED_AT,
  };
  return LinearWebhookReceivedEvent.create({ rawBody, signature, deliveryId }, options);
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
  it("locks the untrusted trigger and global function controls", () => {
    const linear = fakeLinear(issueContext());
    const fn = router(linear.service);

    expect(fn.opts).toMatchObject({
      id: LINEAR_READINESS_ROUTER_FUNCTION_ID,
      concurrency: 1,
      retries: LINEAR_READINESS_ROUTER_RETRIES,
      triggers: [LinearWebhookReceivedEvent],
    });
  });

  it.each(["create", "update"])("routes an authenticated Issue/%s to triage", async (action) => {
    const linear = fakeLinear(issueContext());
    const output = await new InngestTestEngine({
      function: router(linear.service),
      events: [receivedEvent({ action })],
    }).execute();

    expect(output.error).toBeUndefined();
    expect(output.result).toMatchObject({
      outcome: "dispatched",
      route: "triage",
      issueId: "issue-1",
    });
    expect(linear.getIssueContext).toHaveBeenCalledExactlyOnceWith("issue-1");
    expect(output.ctx.step.run).toHaveBeenCalledWith(
      LINEAR_READINESS_VERIFY_STEP_ID,
      expect.any(Function),
    );
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
        causationEventId: `${LINEAR_WEBHOOK_RECEIVED_EVENT_ID_PREFIX}delivery-1`,
      },
    });
  });

  it.each([
    ["plan", readiness.nextActionLabelIds.plan, WORK_REQUEST_EVENT_NAMES.plan],
    ["implement", readiness.nextActionLabelIds.implement, WORK_REQUEST_EVENT_NAMES.implement],
  ] as const)("refetches before an enabled %s dispatch", async (route, labelId, eventName) => {
    const current = issueContext({ stateId: readiness.stateIds.open, actionLabelId: labelId });
    const linear = fakeLinear(current, current);
    const output = await new InngestTestEngine({
      function: router(linear.service),
      events: [receivedEvent({ action: "update" })],
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

  it.each([
    ["invalid signature", receivedEvent({ signature: "invalid" }), "invalid-delivery"],
    ["missing signature", receivedEvent({ signature: "" }), "invalid-delivery"],
    [
      "stale timestamp",
      receivedEvent({ webhookTimestamp: RECEIVED_AT - 61_000 }),
      "invalid-delivery",
    ],
    ["malformed supported payload", receivedEvent({ data: null }), "invalid-delivery"],
    [
      "wrong organization",
      receivedEvent({ organizationId: "organization-2" }),
      "wrong-organization",
    ],
    [
      "authenticated irrelevant event",
      receivedEvent({ type: "Comment" }),
      "authenticated-irrelevant",
    ],
    [
      "authenticated unsupported action",
      receivedEvent({ action: "remove", data: null }),
      "authenticated-irrelevant",
    ],
  ])("stops %s before any Linear read or send", async (_label, event, reason) => {
    const linear = fakeLinear();
    const output = await new InngestTestEngine({
      function: router(linear.service),
      events: [event],
    }).execute();

    expect(output.error).toBeUndefined();
    expect(output.result).toEqual({ outcome: "ignored", reason });
    expect(linear.getIssueContext).not.toHaveBeenCalled();
    expect(output.ctx.step.sendEvent).not.toHaveBeenCalled();
  });

  it("does not dispatch a disabled route", async () => {
    const current = issueContext({
      stateId: readiness.stateIds.open,
      actionLabelId: readiness.nextActionLabelIds.plan,
    });
    const linear = fakeLinear(current);
    const output = await new InngestTestEngine({
      function: router(linear.service, {
        readiness: {
          ...readiness,
          enabledRoutes: { ...readiness.enabledRoutes, plan: false },
        },
      }),
      events: [receivedEvent({ action: "update" })],
    }).execute();

    expect(output.result).toMatchObject({
      outcome: "wait",
      reason: "route-disabled",
    });
    expect(linear.getIssueContext).toHaveBeenCalledOnce();
    expect(output.ctx.step.sendEvent).not.toHaveBeenCalled();
  });

  it("drops an actionable snapshot that changes before dispatch", async () => {
    const initial = issueContext({
      stateId: readiness.stateIds.open,
      actionLabelId: readiness.nextActionLabelIds.plan,
    });
    const changed = issueContext({
      stateId: readiness.stateIds.open,
      actionLabelId: readiness.nextActionLabelIds.needsInput,
    });
    const linear = fakeLinear(initial, changed);
    const output = await new InngestTestEngine({
      function: router(linear.service),
      events: [receivedEvent({ action: "update" })],
    }).execute();

    expect(output.result).toEqual({
      outcome: "stale",
      reason: "readiness-changed",
      issueId: "issue-1",
    });
    expect(linear.getIssueContext).toHaveBeenCalledTimes(2);
    expect(output.ctx.step.sendEvent).not.toHaveBeenCalled();
  });

  it("ignores a self-generated In Progress update without reusing an earlier route", async () => {
    const linear = fakeLinear(issueContext({ stateId: readiness.stateIds.inProgress }));
    const output = await new InngestTestEngine({
      function: router(linear.service),
      events: [receivedEvent({ action: "update" })],
    }).execute();

    expect(output.result).toMatchObject({
      outcome: "ignore",
      reason: "already-claimed",
    });
    expect(linear.getIssueContext).toHaveBeenCalledOnce();
    expect(output.ctx.step.sendEvent).not.toHaveBeenCalled();
  });

  it("uses stable work identity without forwarding raw webhook data", async () => {
    const firstLinear = fakeLinear(issueContext());
    const secondLinear = fakeLinear(issueContext());
    const first = await new InngestTestEngine({
      function: router(firstLinear.service),
      events: [receivedEvent({ deliveryId: "delivery-1" })],
    }).execute();
    const second = await new InngestTestEngine({
      function: router(secondLinear.service),
      events: [receivedEvent({ deliveryId: "delivery-2" })],
    }).execute();
    const firstEvent = sentEvent(first);
    const secondEvent = sentEvent(second);

    expect(secondEvent.id).toBe(firstEvent.id);
    expect(secondEvent.data.causationEventId).not.toBe(firstEvent.data.causationEventId);
    expect(JSON.stringify(firstEvent)).not.toContain("Linear-Signature");
    expect(firstEvent.data).not.toHaveProperty("rawBody");
    expect(firstEvent.data).not.toHaveProperty("signature");
    expect(firstEvent.data).not.toHaveProperty("stateId");
    expect(firstEvent.data).not.toHaveProperty("labelId");
  });

  it("retries a failed durable send with the same event identity", async () => {
    const firstLinear = fakeLinear(issueContext());
    let attempted: unknown;
    const failed = await new InngestTestEngine({
      function: router(firstLinear.service),
      events: [receivedEvent()],
      transformCtx(raw) {
        const context = mockCtx(raw);
        context.step.sendEvent = vi.fn<typeof context.step.sendEvent>(async (_stepId, event) => {
          attempted = event;
          throw new Error("send unavailable");
        });
        return context;
      },
    }).execute();
    const retryLinear = fakeLinear(issueContext());
    const retry = await new InngestTestEngine({
      function: router(retryLinear.service),
      events: [receivedEvent()],
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

    expect(() => router(linear.service, { webhookSecret: "" })).toThrow(/webhookSecret/);
    expect(() =>
      router(linear.service, {
        readiness: {
          ...readiness,
          stateIds: { ...readiness.stateIds, open: readiness.stateIds.backlog },
        },
      }),
    ).toThrow(/IDs must be unique/);
  });
});
