import type { FactoryHandler } from "./factory-action-contract.ts";
import type { FactoryLifecycleEvent } from "./factory-lifecycle-events.ts";
import type { FactoryPhaseRunIdentity } from "./factory-phase-run.ts";

export type FactoryActionFailure = {
  failureKind: "retryable" | "human-required" | "terminal";
  message: string;
};

export function classifyFactoryActionFailure(input: {
  identity: FactoryPhaseRunIdentity;
  events: readonly FactoryLifecycleEvent[];
  handler: FactoryHandler;
  attempt: number;
  causationEventId: string;
  proposed: FactoryActionFailure;
}): FactoryActionFailure {
  const policy = input.identity.version === 2 ? input.identity.automaticActionPolicy : undefined;
  if (input.proposed.failureKind !== "retryable" || !policy) return input.proposed;

  let executions = 1;
  let predecessorId = input.causationEventId;
  for (let index = input.events.length - 1; index >= 0; index -= 1) {
    const event = input.events[index]!;
    if (
      event.id !== predecessorId ||
      event.type !== "factory.action.failed" ||
      event.phaseRunId !== input.identity.phaseRunId ||
      event.data.handler !== input.handler ||
      event.data.attempt !== input.attempt
    )
      break;
    executions += 1;
    predecessorId = event.data.causationEventId;
  }

  if (executions < policy.maxExecutions) return input.proposed;
  return {
    failureKind: "human-required",
    message: `Factory automatic retry ceiling reached after ${executions} executions (limit ${policy.maxExecutions}): ${input.proposed.message}`,
  };
}
