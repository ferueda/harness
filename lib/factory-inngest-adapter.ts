import { eventType, type Inngest, type InngestFunction } from "inngest";
import {
  runHostedFactoryOperation,
  type HostedFactoryRuntime,
} from "./factory-hosted-operation.ts";
import {
  FactoryOperationRequestSchema,
  type FactoryOperationReceipt,
  type FactoryOperationRequest,
} from "./factory-operation.ts";

export const FACTORY_INNGEST_APP_ID = "harness-factory";
export const FACTORY_INNGEST_FUNCTION_ID = "execute-factory-operation-v1";
export const FACTORY_OPERATION_EVENT_NAME = "harness/factory.operation.requested";
export const FACTORY_OPERATION_EVENT_VERSION = "1";
export const FACTORY_OPERATION_STEP_ID = "run-factory-operation-v1";
export const FACTORY_NEXT_OPERATION_STEP_ID = "send-next-factory-operation-v1";
// Leave time below Inngest's two-hour step ceiling to persist an abort and clean up.
export const FACTORY_INNGEST_MAX_RUNTIME_MS = 110 * 60 * 1_000;

export const FactoryOperationRequestedEvent = eventType(FACTORY_OPERATION_EVENT_NAME, {
  schema: FactoryOperationRequestSchema,
  version: FACTORY_OPERATION_EVENT_VERSION,
});

type HostedFactoryOperationRunner = (input: {
  readonly request: FactoryOperationRequest;
  readonly runtime: HostedFactoryRuntime;
}) => Promise<FactoryOperationReceipt>;

export function createFactoryInngestAdapter(input: {
  readonly client: Inngest.Any;
  readonly runtime: HostedFactoryRuntime;
  /** Focused test seam; production callers use the hosted runner above. */
  readonly runner?: HostedFactoryOperationRunner;
}): InngestFunction.Any {
  if (input.client.id !== FACTORY_INNGEST_APP_ID)
    throw new Error(`Factory Inngest client ID must be ${FACTORY_INNGEST_APP_ID}`);

  const runner = input.runner ?? runHostedFactoryOperation;
  return input.client.createFunction(
    {
      id: FACTORY_INNGEST_FUNCTION_ID,
      concurrency: [{ key: "event.data.workItemKey", limit: 1 }, { limit: 1 }],
      triggers: [FactoryOperationRequestedEvent],
    },
    async ({ event, step }) => {
      const maxRuntimeMs = Math.min(input.runtime.maxRuntimeMs, FACTORY_INNGEST_MAX_RUNTIME_MS);
      const timeoutSignal = AbortSignal.timeout(maxRuntimeMs);
      const signal = input.runtime.signal
        ? AbortSignal.any([input.runtime.signal, timeoutSignal])
        : timeoutSignal;
      const receipt = await step.run(FACTORY_OPERATION_STEP_ID, () =>
        runner({
          request: event.data,
          runtime: { ...input.runtime, maxRuntimeMs, signal },
        }),
      );

      if ("next" in receipt && receipt.next)
        await step.sendEvent(
          FACTORY_NEXT_OPERATION_STEP_ID,
          FactoryOperationRequestedEvent.create(receipt.next),
        );
      return receipt;
    },
  );
}
