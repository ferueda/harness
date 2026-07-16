import { Inngest } from "inngest";
import { InngestTestEngine, mockCtx } from "@inngest/test";
import { expect, test, vi } from "vitest";
import { fixture } from "./factory-hosted-operation-test-fixtures.ts";
import {
  runHostedFactoryOperation,
  type HostedFactoryRuntime,
} from "./factory-hosted-operation.ts";
import { readFactoryActionEvents } from "./factory-lifecycle-kernel.ts";
import { createFactoryOperationRef, type FactoryOperationReceipt } from "./factory-operation.ts";
import {
  createFactoryInngestAdapter,
  FACTORY_INNGEST_APP_ID,
  FACTORY_INNGEST_FUNCTION_ID,
  FACTORY_INNGEST_MAX_RUNTIME_MS,
  FACTORY_NEXT_OPERATION_STEP_ID,
  FACTORY_OPERATION_EVENT_NAME,
  FACTORY_OPERATION_EVENT_VERSION,
  FACTORY_OPERATION_STEP_ID,
  FactoryOperationRequestedEvent,
} from "./factory-inngest-adapter.ts";

function client() {
  return new Inngest({
    id: FACTORY_INNGEST_APP_ID,
    eventKey: "test",
    fetch: async () => Response.json({ ids: ["test-next-event"], status: 200 }),
  });
}

function eventFor(request: ReturnType<typeof fixture>["request"]) {
  return FactoryOperationRequestedEvent.create(request);
}

test("locks the identifier-only versioned event and scheduling controls", () => {
  const value = fixture();
  const fn = createFactoryInngestAdapter({ client: client(), runtime: value.runtime });

  expect(fn.opts).toMatchObject({
    id: FACTORY_INNGEST_FUNCTION_ID,
    concurrency: [{ key: "event.data.workItemKey", limit: 1 }, { limit: 1 }],
    triggers: [FactoryOperationRequestedEvent],
  });
  expect(FactoryOperationRequestedEvent).toMatchObject({
    name: FACTORY_OPERATION_EVENT_NAME,
    version: FACTORY_OPERATION_EVENT_VERSION,
  });
  expect(eventFor(value.request)).toEqual({
    name: FACTORY_OPERATION_EVENT_NAME,
    data: value.request,
    id: undefined,
    ts: undefined,
    v: FACTORY_OPERATION_EVENT_VERSION,
    meta: undefined,
    validate: expect.any(Function),
  });
  expect(
    FactoryOperationRequestedEvent.schema.safeParse({ ...value.request, workspace: "/tmp" })
      .success,
  ).toBe(false);
  expect(() =>
    createFactoryInngestAdapter({
      client: new Inngest({ id: "wrong-app" }),
      runtime: value.runtime,
    }),
  ).toThrow(/harness-factory/);
});

test("bounds the runtime and combines the host and deadline signals", async () => {
  const value = fixture();
  const host = new AbortController();
  let receivedRuntime: HostedFactoryRuntime | undefined;
  const runner = vi.fn(async (input) => {
    receivedRuntime = input.runtime;
    return {
      version: 1 as const,
      ...value.request,
      outcome: "stale" as const,
      observedEventId: value.requested.id,
    };
  });
  const fn = createFactoryInngestAdapter({
    client: client(),
    runtime: {
      ...value.runtime,
      maxRuntimeMs: FACTORY_INNGEST_MAX_RUNTIME_MS * 2,
      signal: host.signal,
    },
    runner,
  });
  const output = await new InngestTestEngine({
    function: fn,
    events: [eventFor(value.request)],
  }).execute();

  expect(output.error).toBeUndefined();
  expect(runner).toHaveBeenCalledOnce();
  expect(receivedRuntime?.maxRuntimeMs).toBe(FACTORY_INNGEST_MAX_RUNTIME_MS);
  expect(receivedRuntime?.signal).not.toBe(host.signal);
  expect(receivedRuntime?.signal?.aborted).toBe(false);
  host.abort("host stopped");
  expect(receivedRuntime?.signal?.aborted).toBe(true);
  expect(output.ctx.step.run).toHaveBeenCalledWith(FACTORY_OPERATION_STEP_ID, expect.any(Function));
});

test("a durable retryable failure succeeds and emits only its derived operation", async () => {
  const value = fixture();
  const fn = createFactoryInngestAdapter({ client: client(), runtime: value.runtime });
  const output = await new InngestTestEngine({
    function: fn,
    events: [eventFor(value.request)],
  }).execute();

  expect(output.error).toBeUndefined();
  expect(output.result).toMatchObject({
    version: 1,
    ...value.request,
    outcome: "executed",
    resultEventId: value.failed().id,
  });
  const result = output.result as FactoryOperationReceipt;
  expect("next" in result && result.next).toEqual({
    projectId: value.projectId,
    workItemKey: value.workItemKey,
    operation: createFactoryOperationRef({
      phaseRunId: value.phaseRunId,
      handler: "triageWorkItem",
      attempt: 1,
      causationEventId: value.failed().id,
    }),
  });
  expect(output.ctx.step.sendEvent).toHaveBeenCalledWith(
    FACTORY_NEXT_OPERATION_STEP_ID,
    expect.objectContaining({
      name: FACTORY_OPERATION_EVENT_NAME,
      v: FACTORY_OPERATION_EVENT_VERSION,
      data: "next" in result ? result.next : undefined,
    }),
  );
  expect(value.runProvider).toHaveBeenCalledOnce();
});

test("duplicate delivery recovers the same action without following its hint", async () => {
  const value = fixture();
  const fn = createFactoryInngestAdapter({ client: client(), runtime: value.runtime });
  const first = await new InngestTestEngine({
    function: fn,
    events: [eventFor(value.request)],
  }).execute();
  const second = await new InngestTestEngine({
    function: fn,
    events: [eventFor(value.request)],
  }).execute();

  expect(first.result).toMatchObject({ outcome: "executed", operation: value.operation });
  expect(second.result).toMatchObject({ outcome: "recovered", operation: value.operation });
  expect(first.ctx.step.run).toHaveBeenCalledOnce();
  expect(second.ctx.step.run).toHaveBeenCalledOnce();
  expect(value.runProvider).toHaveBeenCalledOnce();
  expect(first.ctx.step.sendEvent).toHaveBeenCalledOnce();
  expect(second.ctx.step.sendEvent).toHaveBeenCalledOnce();
});

test("stale delivery returns without another event", async () => {
  const value = fixture();
  const staleRequest = {
    ...value.request,
    operation: createFactoryOperationRef({
      ...value.operation,
      causationEventId: "older-request",
    }),
  };
  const fn = createFactoryInngestAdapter({ client: client(), runtime: value.runtime });
  const output = await new InngestTestEngine({
    function: fn,
    events: [eventFor(staleRequest)],
  }).execute();

  expect(output.result).toMatchObject({ outcome: "stale", operation: staleRequest.operation });
  expect(output.ctx.step.sendEvent).not.toHaveBeenCalled();
  expect(value.runProvider).not.toHaveBeenCalled();
});

test.each([
  "phase-command",
  "human",
  "plan-publication",
  "plan-merge",
  "pr-publication",
  "pr-merge",
  "complete",
  "failed",
  "stale-event",
] as const)("the %s wait returns without another event", async (reason) => {
  const value = fixture();
  const receipt: FactoryOperationReceipt = {
    version: 1,
    ...value.request,
    outcome: "waiting",
    observedEventId: value.requested.id,
    reason,
  };
  const fn = createFactoryInngestAdapter({
    client: client(),
    runtime: value.runtime,
    runner: async () => receipt,
  });
  const output = await new InngestTestEngine({
    function: fn,
    events: [eventFor(value.request)],
  }).execute();

  expect(output.result).toEqual(receipt);
  expect(output.ctx.step.sendEvent).not.toHaveBeenCalled();
});

test("a host failure before a receipt rejects without emitting", async () => {
  const value = fixture();
  const runtime = {
    ...value.runtime,
    ensureWorkspace: vi.fn(async () => {
      throw new Error("Grove unavailable");
    }),
  };
  const fn = createFactoryInngestAdapter({ client: client(), runtime });
  const output = await new InngestTestEngine({
    function: fn,
    events: [eventFor(value.request)],
  }).execute();

  expect(output.error).toMatchObject({ message: expect.stringContaining("Grove unavailable") });
  expect(output.result).toBeUndefined();
  expect(output.ctx.step.sendEvent).not.toHaveBeenCalled();
  expect(value.runProvider).not.toHaveBeenCalled();
});

test("a deadline abort during real provider work persists and succeeds", async () => {
  const value = fixture();
  const providerStarted = Promise.withResolvers<void>();
  let providerSignal: AbortSignal | undefined;
  value.providerRun.mockImplementation(async (input) => {
    const signal = input.signal;
    providerSignal = signal;
    if (!signal || signal.aborted)
      throw new Error("deadline must abort after provider work starts");
    providerStarted.resolve();
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    return {
      ok: false,
      error: "deadline expired",
      exitCode: 130,
      aborted: true,
      raw: { workspaceStatus: { before: "clean", after: "clean" } },
    };
  });
  const runner = vi.fn<typeof runHostedFactoryOperation>(runHostedFactoryOperation);
  const fn = createFactoryInngestAdapter({
    client: client(),
    runtime: {
      ...value.runtime,
      maxRuntimeMs: 100,
      triage: { nextLiveRunRequiresRerun: true },
    },
    runner,
  });
  const execution = new InngestTestEngine({
    function: fn,
    events: [eventFor(value.request)],
  }).execute();
  await providerStarted.promise;
  const output = await execution;

  expect(output.error).toBeUndefined();
  expect(runner).toHaveBeenCalledOnce();
  expect(value.providerRun).toHaveBeenCalledOnce();
  expect(providerSignal?.aborted).toBe(true);
  const persisted = readFactoryActionEvents(value.factoryStateRoot, value.workItemKey, {
    mode: "inspection",
  }).at(-1);
  expect(persisted).toMatchObject({
    type: "factory.action.failed",
    data: { failureKind: "human-required", message: "Agent was aborted: factory-triage" },
  });
  expect(output.result).toMatchObject({
    outcome: "executed",
    resultEventId: persisted?.id,
  });
  await expect(output.state[Object.keys(output.state)[0]!]).resolves.toMatchObject({
    outcome: "executed",
    resultEventId: persisted?.id,
  });
});

test("a send failure replays the saved Factory result without provider work", async () => {
  const value = fixture();
  const runner = vi.fn<typeof runHostedFactoryOperation>(runHostedFactoryOperation);
  const fn = createFactoryInngestAdapter({ client: client(), runtime: value.runtime, runner });
  const failedSend = await new InngestTestEngine({
    function: fn,
    events: [eventFor(value.request)],
    transformCtx(raw) {
      const context = mockCtx(raw);
      context.step.sendEvent = vi.fn().mockRejectedValue(new Error("send unavailable"));
      return context;
    },
  }).execute();
  const evidenceAfterFailure = readFactoryActionEvents(value.factoryStateRoot, value.workItemKey, {
    mode: "inspection",
  });

  expect(failedSend.error).toMatchObject({ message: expect.stringContaining("send unavailable") });
  expect(runner).toHaveBeenCalledOnce();
  expect(value.runProvider).toHaveBeenCalledOnce();
  const checkpointedSteps = Object.values(failedSend.state);
  expect(checkpointedSteps).toHaveLength(1);
  const checkpointedReceipt = await checkpointedSteps[0];
  expect(checkpointedReceipt).toMatchObject({
    outcome: "executed",
    operation: value.operation,
  });

  const replay = await new InngestTestEngine({
    function: fn,
    events: [eventFor(value.request)],
    steps: [{ id: FACTORY_OPERATION_STEP_ID, handler: () => checkpointedReceipt }],
  }).execute();
  expect(replay.error).toBeUndefined();
  expect(replay.result).toEqual(checkpointedReceipt);
  expect(runner).toHaveBeenCalledOnce();
  expect(replay.ctx.step.run).toHaveBeenCalledOnce();
  expect(replay.ctx.step.sendEvent).toHaveBeenCalledOnce();
  expect(value.runProvider).toHaveBeenCalledOnce();
  expect(
    readFactoryActionEvents(value.factoryStateRoot, value.workItemKey, { mode: "inspection" }),
  ).toEqual(evidenceAfterFailure);
});
