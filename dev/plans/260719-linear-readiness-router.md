# Route verified Linear readiness into work events

## Goal

Implement FER-225 as one stateless readiness router: authenticate the untrusted
`linear/webhook.received` delivery, reload bounded Linear truth, classify it
through deterministic ID-based policy, and emit at most one provider-neutral
request. The stable Inngest event/run is the execution claim. Linear remains the
durable lifecycle and action record, while later consumers own any In Progress
projection; the router introduces no station chain, provider choice, mutation,
or second state store.

## Changes

1. `lib/inngest/work-events.ts` — define strict, versioned Zod/Inngest contracts
   for `work/triage.requested`, `work/plan.requested`, and
   `work/implementation.requested`. All three share exactly this provider-neutral
   data contract:

   ```ts
   type WorkRequestData = Readonly<{
     issueId: string;
     issueIdentifier: string;
     causationEventId: string;
     snapshotGeneration: string;
   }>;
   ```

   The Inngest event `v` is the contract version and the event name expresses
   the requested route. Consumers refetch and confirm lifecycle/action through
   their own trusted ID configuration; no state ID or label ID crosses this
   boundary. Derive a namespaced SHA-256 event ID from version, event name,
   issue ID, and canonical snapshot generation, not the webhook delivery alone.
   Raw webhook data and secrets must never enter these events.

2. `lib/linear-readiness.ts` — add the pure readiness policy over
   `LinearIssueContext` and explicit configured team, project, lifecycle-state,
   and Next action label IDs. Return a discriminated
   `dispatch | wait | ignore | invalid` result with these stable outcomes:

   | Snapshot                                      | Result                                              | Reason                     |
   | --------------------------------------------- | --------------------------------------------------- | -------------------------- |
   | wrong team or project                         | `ignore`                                            | `out-of-scope`             |
   | labels or relations truncated                 | `invalid`                                           | `incomplete-context`       |
   | Backlog + no Next action                      | `dispatch triage` when enabled, otherwise `wait`    | `ready` / `route-disabled` |
   | Backlog + any Next action                     | `wait`                                              | `projection-repair`        |
   | Open + Plan + no unresolved blocker           | `dispatch plan` when enabled, otherwise `wait`      | `ready` / `route-disabled` |
   | Open + Implement + no unresolved blocker      | `dispatch implement` when enabled, otherwise `wait` | `ready` / `route-disabled` |
   | Open + Needs Input                            | `wait`                                              | `needs-input`              |
   | Open + Plan or Implement + unresolved blocker | `wait`                                              | `blocked`                  |
   | Open + no Next action                         | `invalid`                                           | `missing-next-action`      |
   | Open + conflicting Next actions               | `invalid`                                           | `conflicting-next-action`  |
   | In Progress                                   | `ignore`                                            | `already-claimed`          |
   | In Review                                     | `ignore`                                            | `human-review`             |
   | Done, Canceled, or Duplicate                  | `ignore`                                            | `terminal`                 |
   | any unknown lifecycle ID                      | `invalid`                                           | `unknown-state`            |

   Other labels do not affect classification. A blocker is unresolved when its
   state is not one of the configured terminal IDs. Define
   `snapshotGeneration` as a SHA-256 hash over canonical JSON containing only:
   issue ID, team ID, project ID or null, lifecycle state ID, the sorted
   configured Next action label IDs that are present, sorted blocker
   `{ issueId, stateId }` pairs, and the labels/relations truncation flags.
   Relevant state, action, scope, blocker, or completeness changes must change
   the generation; comments, attachments, timestamps, names, titles, assignees,
   unrelated labels, and array order must not. Keep display names, Linear SDK
   objects, mutations, and Inngest out of this module. Colocated table-driven
   tests prove the matrix, exact-ID scope, blocker state, canonical generation,
   relevant changes, unrelated changes, and order independence.

3. `lib/linear-readiness-router.ts` — create an injected top-level Inngest
   function factory that consumes `LinearWebhookReceivedEvent` with global
   concurrency one. Keep only typed event contracts and the hosted transform in
   `lib/inngest/`; this top-level adapter follows the existing composition
   boundary because it coordinates the readiness operation with the standalone
   Linear reader. Its first durable step reconstructs the exact UTF-8 bytes,
   calls `verifyLinearIssueChangedWebhook` with `event.ts`, checks the configured
   organization, and returns safe terminal outcomes for invalid, stale,
   unsupported, or out-of-organization deliveries without logging their body,
   signature, or secret. Later steps load context through a narrow standalone
   Linear service seam and classify it.

   Dispatch never mutates Linear. For Plan and Implement, refetch and reclassify
   in a durable step immediately before sending; return without emitting when
   the canonical generation or decision changed. Call `step.sendEvent` with the
   deterministic work event so Inngest owns delivery retries and event identity.
   A consumer registered by later work must serialize per issue, refetch the
   lifecycle/action/blocker preconditions implied by its event type, and own any
   best-effort In Progress projection. Other Linear/upstream failures remain
   retryable. Use the Node, Zod, Inngest, and Vitest guidance already loaded for
   type-strippable modules, strict boundary schemas, durable step placement, and
   typed test doubles.

4. `lib/linear-readiness-router.test.ts` — exercise the real function
   with `@inngest/test` and a narrow fake Linear service. Prove valid create and
   update routing; invalid signatures, missing headers, malformed supported
   payloads, stale receipt timestamps, wrong organizations, and authenticated
   irrelevant events; disabled routes; scope and truncation failures; repeated
   snapshots and stable event IDs; stale refetches; function concurrency;
   durable send retry identity; and absence of raw webhook data from work
   events. For every rejected or authenticated-irrelevant delivery, assert zero
   Linear reads and zero sends. Exercise a self-generated authenticated update
   that refetches In Progress and performs no send, proving the adapter does not
   reuse an earlier dispatch result.

5. `docs/contributing/architecture.md` and the focused Linear/Inngest
   contributor docs — record only the landed relationship: the router verifies
   hosted webhook events and emits independent work requests, while no
   persistent worker or consumer is registered until FER-218/FER-219. Remove
   this plan and move FER-225 into `dev/plans/README.md` shipped history when the
   implementation lands.

## Verify

- `pnpm exec vitest run lib/linear-readiness.test.ts lib/inngest/work-events.test.ts lib/linear-readiness-router.test.ts`
- `make check`

## Boundaries

- Do not add a Harness webhook route, `serve()` endpoint, Connect worker,
  provider execution, prompt policy, planning/implementation consumer, periodic
  scan, display-name lookup, Factory dependency, or generic workflow framework.
- Do not enable a route unless its consumer is supplied by the later worker.
- Do not mutate Linear or treat lifecycle state as an execution lock in this
  router. Inngest owns the work-event/run identity; consumers own lifecycle
  projection.
- Stop and return to design if safe dispatch requires another durable state
  store or trusting any transform-derived issue, action, or organization field
  before verification.
