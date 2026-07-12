import {
  deriveFactoryWorkItemKey,
  readFactoryLifecycleEvents,
} from "./factory-lifecycle-legacy.ts";
import type { FactoryWorkItem } from "./factory-schemas.ts";

export type FactoryTriagePolicyResult = {
  hadPriorCompletion: boolean;
  priorCompletionRunId?: string;
};

export function assertFactoryTriageAllowed(input: {
  factoryStateRoot: string;
  workItem: FactoryWorkItem;
  rerun: boolean;
}): FactoryTriagePolicyResult {
  const workItemKey = deriveFactoryWorkItemKey(input.workItem);
  const events = readFactoryLifecycleEvents({
    factoryStateRoot: input.factoryStateRoot,
    workItemKey,
  });
  const priorCompletion = events.findLast((event) => event.type === "triage.completed");
  if (!priorCompletion) return { hadPriorCompletion: false };

  const result = {
    hadPriorCompletion: true,
    priorCompletionRunId: priorCompletion.runId,
  } satisfies FactoryTriagePolicyResult;
  if (input.rerun) return result;

  throw new Error(
    `Factory triage already completed for ${workItemKey} in run ${priorCompletion.runId}; use --rerun to intentionally repeat triage.`,
  );
}
