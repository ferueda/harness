import { factoryActionKey, type FactoryPhase } from "./factory-action-contract.ts";
import type { FactoryActionEvent } from "./factory-lifecycle-events.ts";

export function assertFactoryActionEventIdentity(event: FactoryActionEvent): string {
  const actionKey = factoryActionKey({
    phaseRunId: event.phaseRunId,
    handler: event.data.handler,
    attempt: event.data.attempt,
    causationEventId: event.data.causationEventId,
  });
  const expectedId = `${event.type}:${actionKey}`;
  if (event.id !== expectedId) {
    throw new Error(`Factory action event identity mismatch: expected ${expectedId}`);
  }
  if (event.type === "factory.action.failed" && event.data.phase !== actionEventPhase(event)) {
    throw new Error("Factory action event phase mismatch");
  }
  return actionKey;
}

function actionEventPhase(event: FactoryActionEvent): FactoryPhase {
  if (event.type === "factory.action.failed") {
    if (event.data.handler === "triageWorkItem") return "triage";
    if (event.data.handler.includes("Plan")) return "planning";
    return "implementation";
  }
  if (event.type.startsWith("triage.")) return "triage";
  if (event.type.startsWith("planning.")) return "planning";
  return "implementation";
}
