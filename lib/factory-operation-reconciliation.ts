import { readFactoryActionEvents } from "./factory-lifecycle-kernel.ts";
import {
  createFactoryOperationRef,
  FactoryOperationRequestSchema,
  resolveFactoryOperation,
  type FactoryOperationRef,
  type FactoryOperationRequest,
} from "./factory-operation.ts";
import {
  decideNextFactoryAction,
  reduceFactoryLifecycleEvents,
  type FactoryLifecycleState,
  type FactoryReaction,
  type FactoryWaitReason,
} from "./factory-state-machine.ts";
import type { FactoryStoreMeta } from "./factory-store.ts";

export const FACTORY_RECONCILIATION_REASON_MAX_LENGTH = 240;

export type FactoryOperationReconciliationTarget = {
  readonly projectId: string;
  readonly workItemKey: string;
  readonly factoryStore: FactoryStoreMeta;
};

export type FactoryOperationDelivery = (request: FactoryOperationRequest) => Promise<unknown>;

export type FactoryOperationReconciliationResult =
  | {
      outcome: "phase-start";
      projectId: string;
      workItemKey: string;
      reaction: Extract<FactoryReaction, { kind: "start-phase" }>;
    }
  | {
      outcome: "delivered";
      projectId: string;
      workItemKey: string;
      operation: FactoryOperationRef;
      reason: string;
    }
  | {
      outcome: "waiting";
      projectId: string;
      workItemKey: string;
      reason: FactoryWaitReason;
    }
  | {
      outcome: "stale";
      projectId: string;
      workItemKey: string;
      operation?: FactoryOperationRef;
      reason: "stale-event" | "superseded";
    }
  | {
      outcome: "attention";
      projectId: string;
      workItemKey: string;
      operation?: FactoryOperationRef;
      reason: string;
    };

/** Rediscover current operation hints without changing durable Factory state. */
export async function reconcileFactoryOperations(
  targets: readonly FactoryOperationReconciliationTarget[],
  deliver: FactoryOperationDelivery,
): Promise<FactoryOperationReconciliationResult[]> {
  const results: FactoryOperationReconciliationResult[] = [];
  for (const target of targets) results.push(await reconcileTarget(target, deliver));
  return results;
}

async function reconcileTarget(
  target: FactoryOperationReconciliationTarget,
  deliver: FactoryOperationDelivery,
): Promise<FactoryOperationReconciliationResult> {
  const identity = { projectId: target.projectId, workItemKey: target.workItemKey };
  let operation: FactoryOperationRef | undefined;
  try {
    if (target.projectId !== target.factoryStore.projectId)
      throw new Error("Factory reconciliation project identity mismatch");

    const initial = readReaction(target);
    if (initial.reaction.kind === "start-phase")
      return phaseStartResult(identity, initial.reaction);
    if (initial.reaction.kind === "wait") return waitResult(identity, initial.reaction);

    operation = operationFor(phaseRunId(initial.state), initial.reaction);
    const request = FactoryOperationRequestSchema.parse({ ...identity, operation });
    const resolution = resolveFactoryOperation({
      projectId: target.projectId,
      projectRoot: target.factoryStore.projectRoot,
      factoryStateRoot: target.factoryStore.factoryStateRoot,
      workspaceRef: target.factoryStore.repo.id,
      factoryStore: target.factoryStore,
      workItemKey: target.workItemKey,
      operation,
    });
    if (resolution.status === "stale")
      return { outcome: "stale", ...identity, operation, reason: "superseded" };
    if (resolution.status === "wait") return waitResult(identity, resolution.reaction);

    // Resolution can authenticate a staged completed result. The log must still
    // request the same action before hosted recovery is safe to redeliver.
    const current = readReaction(target);
    if (current.reaction.kind === "start-phase")
      return phaseStartResult(identity, current.reaction);
    if (current.reaction.kind === "wait") return waitResult(identity, current.reaction);
    const currentOperation = operationFor(phaseRunId(current.state), current.reaction);
    if (currentOperation.actionKey !== operation.actionKey)
      return { outcome: "stale", ...identity, operation, reason: "superseded" };

    await deliver(request);
    return { outcome: "delivered", ...identity, operation, reason: current.reaction.reason };
  } catch (error) {
    return {
      outcome: "attention",
      ...identity,
      ...(operation ? { operation } : {}),
      reason: boundedReason(error),
    };
  }
}

function readReaction(target: FactoryOperationReconciliationTarget): {
  state: FactoryLifecycleState;
  reaction: FactoryReaction;
} {
  const events = readFactoryActionEvents(target.factoryStore.factoryStateRoot, target.workItemKey, {
    mode: "inspection",
  });
  const latest = events.at(-1);
  const state = reduceFactoryLifecycleEvents(events);
  if (!latest || !state) throw new Error("Factory reconciliation has no durable lifecycle state");
  return { state, reaction: decideNextFactoryAction(state, latest) };
}

function phaseRunId(state: NonNullable<ReturnType<typeof reduceFactoryLifecycleEvents>>): string {
  if (!("phaseRunId" in state))
    throw new Error("Factory reconciliation invokable state has no phase run identity");
  return state.phaseRunId;
}

function operationFor(
  phaseRunId: string,
  reaction: Extract<FactoryReaction, { kind: "invoke" }>,
): FactoryOperationRef {
  return createFactoryOperationRef({
    phaseRunId,
    handler: reaction.handler,
    attempt: reaction.attempt,
    causationEventId: reaction.causationEventId,
  });
}

function waitResult(
  identity: { projectId: string; workItemKey: string },
  reaction: Extract<FactoryReaction, { kind: "wait" }>,
): FactoryOperationReconciliationResult {
  if (reaction.reason === "stale-event")
    return { outcome: "stale", ...identity, reason: "stale-event" };
  return { outcome: "waiting", ...identity, reason: reaction.reason };
}

function phaseStartResult(
  identity: { projectId: string; workItemKey: string },
  reaction: Extract<FactoryReaction, { kind: "start-phase" }>,
): FactoryOperationReconciliationResult {
  return { outcome: "phase-start", ...identity, reaction };
}

function boundedReason(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  const oneLine = detail.replace(/\s+/g, " ").trim() || "Factory reconciliation failed";
  return oneLine.slice(0, FACTORY_RECONCILIATION_REASON_MAX_LENGTH);
}
