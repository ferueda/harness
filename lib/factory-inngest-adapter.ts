import { createHash } from "node:crypto";
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
export const FACTORY_INNGEST_RETRIES = 3;
// Leave time below Inngest's two-hour step ceiling to persist an abort and clean up.
export const FACTORY_INNGEST_MAX_RUNTIME_MS = 110 * 60 * 1_000;
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const FACTORY_DELIVERY_ID_EPOCH_MS = Date.UTC(2026, 0, 1);

export const FactoryOperationRequestedEvent = eventType(FACTORY_OPERATION_EVENT_NAME, {
  schema: FactoryOperationRequestSchema,
  version: FACTORY_OPERATION_EVENT_VERSION,
});

export function factoryOperationDeliveryId(request: FactoryOperationRequest): string {
  const parsed = FactoryOperationRequestSchema.parse(request);
  const { operation } = parsed;
  const identity = [
    "harness-factory-operation-delivery",
    1,
    FACTORY_OPERATION_EVENT_NAME,
    FACTORY_OPERATION_EVENT_VERSION,
    parsed.projectId,
    parsed.workItemKey,
    operation.phaseRunId,
    operation.handler,
    operation.attempt,
    operation.causationEventId,
    operation.actionKey,
  ];
  const digest = createHash("sha256").update(JSON.stringify(identity)).digest();
  // The current Inngest dev transport requires a ULID and uses its time field
  // for scheduling. A fixed version epoch keeps retries deterministic and due;
  // the remaining 80 bits come from the canonical request hash.
  const ulid = Buffer.alloc(16);
  let timestamp = FACTORY_DELIVERY_ID_EPOCH_MS;
  for (let index = 5; index >= 0; index -= 1) {
    ulid[index] = timestamp & 0xff;
    timestamp = Math.floor(timestamp / 256);
  }
  digest.copy(ulid, 6, 0, 10);
  let value = 0n;
  for (const byte of ulid) value = (value << 8n) | BigInt(byte);
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = ULID_ALPHABET[Number(value & 31n)] + encoded;
    value >>= 5n;
  }
  return encoded;
}

export function createFactoryOperationRequestedEvent(request: FactoryOperationRequest) {
  const parsed = FactoryOperationRequestSchema.parse(request);
  return FactoryOperationRequestedEvent.create(parsed, {
    id: factoryOperationDeliveryId(parsed),
    // Keep transport scheduling tied to the actual send rather than the
    // deterministic ULID's fixed version epoch.
    ts: Date.now(),
  });
}

export function createFactoryInngestDelivery(client: Inngest.Any) {
  assertFactoryInngestClient(client);
  return (request: FactoryOperationRequest) =>
    client.send(createFactoryOperationRequestedEvent(request));
}

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
  assertFactoryInngestClient(input.client);

  const runner = input.runner ?? runHostedFactoryOperation;
  return input.client.createFunction(
    {
      id: FACTORY_INNGEST_FUNCTION_ID,
      concurrency: [{ key: "event.data.workItemKey", limit: 1 }, { limit: 1 }],
      retries: FACTORY_INNGEST_RETRIES,
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
          createFactoryOperationRequestedEvent(receipt.next),
        );
      return receipt;
    },
  );
}

function assertFactoryInngestClient(client: Inngest.Any): void {
  if (client.id !== FACTORY_INNGEST_APP_ID)
    throw new Error(`Factory Inngest client ID must be ${FACTORY_INNGEST_APP_ID}`);
}
