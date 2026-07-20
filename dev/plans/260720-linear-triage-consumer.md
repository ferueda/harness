# Project independent Linear triage decisions

## Goal

Implement FER-218 as one independent Inngest consumer for
`work/triage.requested`. It must load current Linear truth, run the existing
read-only triage operation, and project one structured decision through the
standalone Linear service. The function remains unregistered until FER-219
adds the persistent worker.

Projection is intentionally best-effort rather than atomic. One refetch before
the first mutation stops visibly stale work; existing Inngest retries and
idempotent Linear primitives handle ordinary partial failure. Do not add a
projection ledger, repair mode, lock, compare-and-set layer, or second store.

## Changes

1. `lib/linear-triage.ts:createLinearTriageFunction` — add one top-level
   integration module parallel to `lib/linear-readiness-router.ts`. Inject the
   existing Inngest client, `Agent`, workspace/execution settings, and a narrow
   `LinearService` pick containing only the read and projection operations this
   function calls. Reuse `LinearReadinessConfigSchema` as the single trusted
   team, project, lifecycle, Next action, and snapshot-generation mapping;
   validate it and the required execution strings when the function is created.
   Trigger on `TriageWorkRequestedEvent`, keep three function retries, and set
   per-issue concurrency to one with `event.data.issueId`. Do not register the
   function or create another Inngest client in this change.

   The first durable read must require matching issue ID and identifier, an
   enabled triage-ready FER-225 classification, exact event snapshot
   generation, and complete comments, labels, relations, attachments, and
   children. Return a safe non-projected outcome before the agent when any
   condition fails. Adapt the normalized `LinearIssueContext` into
   `TriageWorkItemContext` in this module: use display names rather than Linear
   IDs for prompt labels and states, preserve normalized comments and issue
   references, map attachments to links, and map the five completeness flags
   without leaking SDK objects into `lib/triage`.

2. `lib/linear-triage.ts:createLinearTriageFunction` — run `triageIssue()` in
   one named durable agent step. A `provider` failure must throw from inside
   that step so Inngest retries it; invalid output, cancellation, and workspace
   guard failures return a terminal no-projection result. After a successful
   decision, refetch once and require the same triage-ready snapshot generation
   before any mutation. Resolve the decision's `duplicateOf` and de-duplicated
   `blockedBy` references through `getIssueContext()` in one read-only step and
   pass only the returned opaque IDs to relation mutations. Reject a
   self-reference before writing.

   Derive the hidden comment marker by recomputing
   `workRequestEventId("triage", event.data)`. Render one concise comment from
   the structured decision and safe provenance: outcome/action, route-specific
   rationale, evidence, questions or input reason, relation references,
   provider/model, and policy/schema versions. Do not include the raw prompt,
   webhook data, credentials, provider logs, or internal reasoning.

   Project through fixed named steps after reference resolution:

   - for `ready-for-agent`, ensure the comment, ensure blocker relations, add
     Plan or Implement while removing the other configured actions, then call
     `updateIssueState()` with expected Backlog and target Open;
   - for `needs-input`, ensure the comment and any blocker relations, add Needs
     Input while removing Plan and Implement, then move expected Backlog to
     Open;
   - for `duplicate`, ensure the comment, remove all configured action labels,
     then ensure the duplicate relation and rely on Linear's reserved Duplicate
     transition without an Open update.

   Keep comment, relation, label, and state calls in separate durable steps so
   retries resume from the failed boundary. Labels must precede Open, unrelated
   labels must survive, and an exhausted partial projection is a pilot/manual
   recovery case rather than a new repair subsystem. Never invoke Plan or
   Implement directly.

3. `lib/linear-triage.test.ts` — use `@inngest/test`, a typed fake `Agent`, and
   a narrow fake Linear service as the highest stable seam. Prove the function
   trigger, retries, named steps, and per-issue concurrency; context adaptation;
   exact issue/scope/readiness/generation checks; all five completeness gates;
   provider retry versus terminal agent failures; the single pre-write stale
   exit; reference resolution and self-reference rejection; deterministic
   comment identity; and the ordered Implement, Plan, Needs Input, blocker, and
   Duplicate projections. Cover repeated delivery and failure after each write
   boundary to show existing ensures and additive label/state operations
   converge without duplicate comments or relations, preserve unrelated
   labels, and never emit or call downstream work.

4. `docs/contributing/architecture.md` and
   `docs/contributing/linear-webhook-source.md` — record only the landed
   relationship: the independent triage consumer is defined and composes the
   triage and Linear primitives, but no worker registers it and no production
   automation runs until FER-219. Do not describe the future Connect worker,
   full ownership cutover, or live pilot as current behavior.

## Verify

- `pnpm exec vitest run lib/linear-triage.test.ts lib/linear-readiness.test.ts lib/inngest/work-events.test.ts lib/triage/triage.test.ts lib/linear/write.test.ts`
- `make check`

## Boundaries

- Do not change the triage prompt or decision schema, FER-225 readiness matrix,
  work-event contract, or standalone Linear public API unless implementation
  proves the locked composition cannot be expressed with them.
- Do not add worker/Connect registration, a webhook or `serve()` endpoint, a
  live Inngest smoke, planning or implementation consumers, label creation,
  display-name lookup, Factory dependencies, or broad project-intent cutover.
- Do not add atomic projection guarantees, continuous stale-input comparison,
  general invalid-projection repair, periodic reconciliation, or another
  durable state owner.
