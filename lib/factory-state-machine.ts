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
  validateFactoryTransition(current, event);
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
    case "planning.candidate.produced":
      return {
        ...base,
        phase: "planning",
        status: "awaiting-review",
        phaseRunId: event.phaseRunId,
      };
    case "planning.input.required":
      return { ...base, phase: "planning", status: "needs-human", phaseRunId: event.phaseRunId };
    case "planning.review.completed":
      return {
        ...base,
        phase: "planning",
        status:
          event.data.verdict === "pass"
            ? "awaiting-plan-merge"
            : event.data.verdict === "needs_changes" &&
                event.data.attempt < event.data.reviewCeiling
              ? "needs-revision"
              : "needs-human",
        phaseRunId: event.phaseRunId,
      };
    case "plan_pr.opened":
      return {
        ...base,
        phase: "planning",
        status: "awaiting-plan-merge",
        phaseRunId: event.phaseRunId,
      };
    case "plan_pr.merged":
      return { ...base, phase: "planning", status: "approved", phaseRunId: event.phaseRunId };
    case "implementation.requested":
      return {
        ...base,
        phase: "implementation",
        status: "awaiting-candidate",
        phaseRunId: event.phaseRunId,
      };
    case "implementation.candidate.produced":
      return {
        ...base,
        phase: "implementation",
        status: "awaiting-review",
        phaseRunId: event.phaseRunId,
      };
    case "implementation.review.completed":
      return {
        ...base,
        phase: "implementation",
        status:
          event.data.verdict === "pass"
            ? "complete"
            : event.data.verdict === "needs_changes" &&
                event.data.attempt < event.data.reviewCeiling
              ? "needs-revision"
              : "needs-human",
        phaseRunId: event.phaseRunId,
      };
    case "factory.action.failed":
      return {
        ...base,
        phase: event.data.phase,
        status: event.data.failureKind === "terminal" ? "failed" : "needs-human",
        phaseRunId: event.phaseRunId,
      };
  }
}

function validateFactoryTransition(
  current: FactoryLifecycleState | undefined,
  event: FactoryLifecycleEvent,
): void {
  if (event.type === "work_item.imported") {
    if (current) throw new Error("work_item.imported must be the first Factory event");
    return;
  }
  if (!current) throw new Error(`${event.type} requires an imported work item`);
  if (
    "expectedPredecessor" in event.data &&
    event.data.expectedPredecessor !== current.lastEventId
  ) {
    throw new Error(`${event.type} expected predecessor does not match the Factory cursor`);
  }
  if ("causationEventId" in event.data && event.data.causationEventId !== current.lastEventId) {
    throw new Error(`${event.type} causation does not match the Factory cursor`);
  }
  if ("phaseRunId" in current && event.phaseRunId && current.phaseRunId !== event.phaseRunId) {
    const startsPhase = event.type.endsWith(".requested");
    if (!startsPhase) throw new Error(`${event.type} phase run does not match active state`);
  }
  const allowed = (() => {
    switch (event.type) {
      case "triage.requested":
        return (
          current.phase === "idle" ||
          current.status === "routed" ||
          current.status === "parked" ||
          current.status === "needs-human" ||
          current.status === "failed"
        );
      case "triage.work_item.completed":
        return (
          current.phase === "triage" &&
          current.status === "awaiting-result" &&
          event.data.handler === "triageWorkItem"
        );
      case "planning.requested":
        return current.phase === "triage" && current.status === "routed";
      case "planning.candidate.produced":
        return (
          current.phase === "planning" &&
          (current.status === "awaiting-candidate" || current.status === "needs-revision") &&
          event.data.handler === "producePlanCandidate"
        );
      case "planning.input.required":
        return (
          current.phase === "planning" &&
          (current.status === "awaiting-candidate" || current.status === "needs-revision") &&
          event.data.handler === "producePlanCandidate"
        );
      case "planning.review.completed":
        return (
          current.phase === "planning" &&
          current.status === "awaiting-review" &&
          event.data.handler === "reviewPlanCandidate"
        );
      case "plan_pr.opened":
        return current.phase === "planning" && current.status === "awaiting-plan-merge";
      case "plan_pr.merged":
        return current.phase === "planning" && current.status === "awaiting-plan-merge";
      case "implementation.requested":
        return (
          (current.phase === "triage" && current.status === "routed") ||
          (current.phase === "planning" && current.status === "approved")
        );
      case "implementation.candidate.produced":
        return (
          current.phase === "implementation" &&
          (current.status === "awaiting-candidate" || current.status === "needs-revision") &&
          event.data.handler === "produceImplementationCandidate"
        );
      case "implementation.review.completed":
        return (
          current.phase === "implementation" &&
          current.status === "awaiting-review" &&
          event.data.handler === "reviewImplementationCandidate"
        );
      case "factory.action.failed":
        return current.status.startsWith("awaiting-") || current.status === "needs-revision";
    }
  })();
  if (!allowed)
    throw new Error(
      `Invalid Factory transition: ${current.phase}/${current.status} -> ${event.type}`,
    );
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
  if (
    latestEvent.type === "planning.requested" ||
    (latestEvent.type === "planning.review.completed" && state.status === "needs-revision")
  )
    return {
      kind: "invoke",
      phase: "planning",
      handler: "producePlanCandidate",
      attempt: latestEvent.type === "planning.requested" ? 1 : latestEvent.data.attempt + 1,
      causationEventId: latestEvent.id,
      scheduling: "immediate",
      reason:
        latestEvent.type === "planning.requested" ? "planning-requested" : "review-needs-changes",
    };
  if (latestEvent.type === "planning.candidate.produced")
    return {
      kind: "invoke",
      phase: "planning",
      handler: "reviewPlanCandidate",
      attempt: latestEvent.data.attempt,
      causationEventId: latestEvent.id,
      scheduling: "immediate",
      reason: "candidate-produced",
    };
  if (
    latestEvent.type === "implementation.requested" ||
    (latestEvent.type === "implementation.review.completed" && state.status === "needs-revision")
  )
    return {
      kind: "invoke",
      phase: "implementation",
      handler: "produceImplementationCandidate",
      attempt: latestEvent.type === "implementation.requested" ? 1 : latestEvent.data.attempt + 1,
      causationEventId: latestEvent.id,
      scheduling: "immediate",
      reason:
        latestEvent.type === "implementation.requested"
          ? "implementation-requested"
          : "review-needs-changes",
    };
  if (latestEvent.type === "implementation.candidate.produced")
    return {
      kind: "invoke",
      phase: "implementation",
      handler: "reviewImplementationCandidate",
      attempt: latestEvent.data.attempt,
      causationEventId: latestEvent.id,
      scheduling: "immediate",
      reason: "candidate-produced",
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
