# Regenerate missing Factory operation deliveries from canonical state

## Goal

Add an explicitly invoked, host-neutral reconciler for a bounded caller-supplied set of trusted Factory project/work-item targets. For each target it must read the durable Factory log, derive and authenticate only the current invokable reaction, and pass the resulting identifier-only `FactoryOperationRequest` to one injected delivery callback. It must never create workflow authority or mutate lifecycle state: waits and terminal items remain untouched, known stale or superseded reactions are not sent, and a delivery failure is reported without preventing a later reconciliation from deriving the same operation again.

Return one input-ordered result per target with stable `projectId` and `workItemKey` and no reporting store or unbounded diagnostics. Use this closed result contract, with `operation` present whenever a canonical operation was derived:

```ts
type FactoryOperationReconciliationResult =
  | {
      outcome: "delivered";
      projectId: string;
      workItemKey: string;
      operation: FactoryOperationRef;
      reason: string;
    }
  | { outcome: "waiting"; projectId: string; workItemKey: string; reason: FactoryWaitReason }
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
```

The Inngest transport must attach the same deterministic event ID to every send of the same project/work-item/action request. That ID is duplicate-suppression only; Factory JSONL, phase-run evidence, and `FactoryOperationRef.actionKey` remain the correctness authority before and after the transport deduplication window.

## Changes

1. Add `lib/factory-operation-reconciliation.ts` with `FactoryOperationReconciliationTarget`, `FactoryOperationDelivery`, `FactoryOperationReconciliationResult`, and `reconcileFactoryOperations`. Accept a flat readonly target list of `{ projectId, workItemKey, factoryStore }` plus one async delivery callback; require the explicit project ID to match `FactoryStoreMeta.projectId`, process each target once and sequentially in input order, isolate failures per item, and return no aggregate beyond the bounded result array.

   For each target, read the canonical lifecycle events through `readFactoryActionEvents`, reduce them, and use `decideNextFactoryAction`. Map every non-invokable reaction to `waiting`, except `stale-event`, which maps to `stale`; missing, malformed, inaccessible, or identity-divergent evidence maps to `attention`. Define `FACTORY_RECONCILIATION_REASON_MAX_LENGTH = 240` and normalize attention details to one line of at most that many characters so transport or filesystem errors cannot make the report unbounded. For an invoke reaction, take the phase run from the reduced state, recompute its `FactoryOperationRef` with `createFactoryOperationRef`, and form the existing strict identifier-only request.

   Before delivery, call the read-only `resolveFactoryOperation` against the same trusted store and re-read canonical state. Deliver only when the authenticated resolution is current, or when an authenticated completed action result still corresponds to that same current log reaction and therefore needs normal hosted recovery. If the reaction changed, return `stale` without calling the callback; if it became a wait, return `waiting`. Do not hold a lifecycle lock across the async transport call. The hosted runner's existing immediate revalidation remains the correctness backstop for a race after the final read. Catch callback failure as `attention`, retaining the operation in the result, and perform no append, recovery, rollback, provider, Grove, publication, or tracker work.

2. Add `lib/factory-operation-reconciliation.test.ts` with isolated durable-store fixtures at the module boundary. Prove that an invokable reaction whose original hint was never sent is rediscovered as the exact identifier-only request; a callback that records acceptance and then throws leaves Factory event/state bytes unchanged and a later call emits the same action identity; repeated reconciliation without lifecycle change cannot advance Factory or change the operation; superseded, human, publication, merge, complete, failed, phase-command, and stale waits make no delivery call; and a malformed/unavailable target or one failed send reports bounded `attention` without blocking a valid target in another isolated project. Assert one ordered result per input target and that stale/attention results retain a derived operation when applicable.

3. Update `lib/factory-inngest-adapter.ts` and `lib/factory-inngest-adapter.test.ts` so one shared event-construction path owns transport identity. Export a deterministic delivery-ID helper that SHA-256 hashes a fixed, versioned tuple containing the event contract, `projectId`, `workItemKey`, and every `FactoryOperationRef` identity field; export an Inngest delivery callback that validates the fixed app ID and sends `FactoryOperationRequestedEvent.create(request, { id })`; and use the same event builder for the existing `step.sendEvent` next-operation path. Preserve the event name/version and request schema exactly. Test that identical canonical requests keep one ID, project/work-item/action changes alter it, direct reconciliation delivery and chained delivery both attach it, a lost send response can be retried with the same event, and a later duplicate with a different transport identity still converges through the unchanged Factory action identity rather than relying on Inngest deduplication.

4. Update `scripts/smoke-factory-grove.ts` at the initial Inngest send seam to invoke `reconcileFactoryOperations` with the isolated project target and the production Inngest delivery callback, then poll the deterministic event ID and retain the existing execution, Grove release, and saved-result recovery assertions. For the explicit post-release replay, send the same operation request with a distinct test-only transport event ID to model a redelivery that is no longer suppressed; keep the request and Factory action identity unchanged so the smoke continues to prove that action identity, not event identity, prevents provider and setup replay.

5. Update `docs/contributing/factory.md`, `docs/contributing/architecture.md`, and `test/docs-contracts.test.ts` to make `lib/factory-operation-reconciliation.ts` the owner of bounded log-to-delivery repair and `lib/factory-inngest-adapter.ts` the owner of event IDs and sends. Document the caller-supplied trusted target set, explicit invocation/scheduling boundary, four per-item outcomes, failure isolation, no lifecycle mutation, and delivery-ID-versus-action-identity distinction. Keep the current single-operation hosted runner and externally owned host/runtime configuration; do not describe a Harness scheduler, project registry, ingress service, or production worker.

## Verify

- `pnpm exec vitest run lib/factory-operation-reconciliation.test.ts lib/factory-inngest-adapter.test.ts lib/factory-operation.test.ts test/docs-contracts.test.ts`
- `make check`
- `make smoke-factory`

## Boundaries

- Do not discover or register projects/work items from Factory storage, tracker state, environment scanning, or transport state; the host supplies the complete trusted bounded target list.
- Do not add a CLI loop, webhook, scheduler, polling framework, worker deployment, transport registry/plugin system, reporting store, or exported JSON report schema.
- Reconciliation may read lifecycle/action/phase evidence and call delivery only. It must not append or recover Factory events, invoke Grove/providers, publish plans or pull requests, project tracker state, acknowledge merges, or otherwise advance lifecycle state.
- Do not treat Inngest event IDs, send responses, concurrency, retries, or deduplication as authority, and do not change the existing operation request/receipt schemas.
