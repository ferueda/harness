import { z } from "zod";
import type { FactoryHandler, FactoryPhase } from "./factory-action-contract.ts";
import type { FactoryLifecycleEvent } from "./factory-lifecycle-events.ts";

const Common = z.object({
  projectionVersion: z.literal(1),
  workItemKey: z.string(),
  lastEventId: z.string(),
  updatedAt: z.iso.datetime(),
});
export const FactoryLifecycleStateSchema = z.union([
  Common.extend({ phase: z.literal("idle"), status: z.literal("idle") }),
  Common.extend({
    phase: z.literal("triage"),
    status: z.literal("awaiting-result"),
    phaseRunId: z.string(),
  }),
  Common.extend({
    phase: z.literal("triage"),
    status: z.enum(["routed", "needs-human", "parked", "failed"]),
    phaseRunId: z.string(),
    route: z.string().optional(),
  }),
  Common.extend({
    phase: z.enum(["planning", "implementation"]),
    status: z.enum([
      "awaiting-candidate",
      "awaiting-review",
      "needs-revision",
      "needs-human",
      "awaiting-plan-merge",
      "approved",
      "complete",
      "failed",
    ]),
    phaseRunId: z.string(),
  }),
]);
export type FactoryLifecycleState = z.infer<typeof FactoryLifecycleStateSchema>;

export type FactoryReaction =
  | {
      kind: "invoke";
      phase: FactoryPhase;
      handler: FactoryHandler;
      attempt: number;
      causationEventId: string;
      scheduling: "immediate" | "retry";
      reason: string;
    }
  | {
      kind: "wait";
      reason: "phase-command" | "human" | "plan-merge" | "complete" | "failed" | "stale-event";
      command?: string;
    };

export function reduceFactoryLifecycleEvents(
  events: readonly FactoryLifecycleEvent[],
): FactoryLifecycleState | undefined {
  let state: FactoryLifecycleState | undefined;
  for (const event of events) state = reduce(state, event);
  return state;
}

function reduce(
  current: FactoryLifecycleState | undefined,
  event: FactoryLifecycleEvent,
): FactoryLifecycleState {
  const base = {
    projectionVersion: 1 as const,
    workItemKey: event.workItemKey,
    lastEventId: event.id,
    updatedAt: event.occurredAt,
  };
  if (current && current.workItemKey !== event.workItemKey)
    throw new Error("Factory event work-item mismatch");
  switch (event.type) {
    case "work_item.imported":
      return { ...base, phase: "idle", status: "idle" };
    case "triage.requested":
      return { ...base, phase: "triage", status: "awaiting-result", phaseRunId: event.phaseRunId };
    case "triage.work_item.completed": {
      const status =
        event.data.route === "needs-info"
          ? "needs-human"
          : event.data.route === "wait-to-implement"
            ? "parked"
            : "routed";
      return {
        ...base,
        phase: "triage",
        status,
        phaseRunId: event.phaseRunId,
        route: event.data.route,
      };
    }
    case "planning.requested":
      return {
        ...base,
        phase: "planning",
        status: "awaiting-candidate",
        phaseRunId: event.phaseRunId,
      };
    case "implementation.requested":
      return {
        ...base,
        phase: "implementation",
        status: "awaiting-candidate",
        phaseRunId: event.phaseRunId,
      };
    case "factory.action.failed":
      return {
        ...base,
        phase: event.data.phase,
        status: event.data.failureKind === "terminal" ? "failed" : "needs-human",
        phaseRunId: event.phaseRunId,
      } as FactoryLifecycleState;
  }
}

export function decideNextFactoryAction(
  state: FactoryLifecycleState,
  latestEvent: FactoryLifecycleEvent,
): FactoryReaction {
  if (state.lastEventId !== latestEvent.id) return { kind: "wait", reason: "stale-event" };
  if (latestEvent.type === "triage.requested")
    return {
      kind: "invoke",
      phase: "triage",
      handler: "triageWorkItem",
      attempt: 1,
      causationEventId: latestEvent.id,
      scheduling: "immediate",
      reason: "triage-requested",
    };
  if (latestEvent.type === "factory.action.failed" && latestEvent.data.failureKind === "retryable")
    return {
      kind: "invoke",
      phase: latestEvent.data.phase,
      handler: latestEvent.data.handler,
      attempt: latestEvent.data.attempt,
      causationEventId: latestEvent.id,
      scheduling: "retry",
      reason: "retryable-failure",
    };
  if (state.status === "failed") return { kind: "wait", reason: "failed" };
  if (state.status === "needs-human" || state.status === "parked")
    return { kind: "wait", reason: "human" };
  if (state.status === "complete") return { kind: "wait", reason: "complete" };
  return {
    kind: "wait",
    reason: "phase-command",
    ...(latestEvent.type === "triage.work_item.completed"
      ? { command: latestEvent.data.nextCommand }
      : {}),
  };
}
