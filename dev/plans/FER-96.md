# Run authenticated Factory operations through Grove

## Goal

Add the host-neutral application runner that accepts only `{ projectId, workItemKey, operation }`, resolves all paths and execution controls from separately injected trusted project runtime configuration, and composes the canonical Factory operation resolver/executor with the existing Grove adapter. One delivery must either recover a completed action before touching Grove, report the current stale or waiting state without Grove or provider work, or acquire the immutable phase workspace, revalidate lifecycle truth, and execute at most one existing action. Receipts are strict reconstructable hints; Factory JSONL, immutable phase evidence, action results, and Git remain authoritative.

The runner is complete when divergent identity fails closed, a lifecycle change during acquisition prevents provider execution, only executed or recovered results can advertise the next identifier-only invoke request, and the real-Grove smoke proves both current execution and replay after the terminal lease has been released.

## Changes

1. `lib/factory-phase-run.ts:FactoryPhaseRunIdentitySchema`, a new focused `lib/factory-phase-git.ts`, and the create/open paths in `lib/factory-run-context.ts`, `lib/factory-planning-run-context.ts`, and `lib/factory-implementation-run-context.ts` — make immutable Git execution authority portable across Grove hosts. New phase identities use version 2 and keep `workspace` only as local provenance. For every Git-backed phase, persist one `git` value with the exact shape `{ repositoryId, baseSha, target }`, where `baseSha` is the full `HEAD^{commit}` and `target` is either `{ mode: "detached" }` or `{ mode: "branch", branchRef: "refs/heads/..." }`. Snapshot this soft-optional identity for triage and local planning, require the branch form for pull-request planning and implementation, and continue allowing manual non-Git triage/local planning with no `git` value. Keep `baseRef` only as pull-request target metadata. Read existing version-1 phase identities for same-path manual recovery/publication, but never synthesize repository authority from their mutable path; they are not eligible for the hosted runner. Centralize snapshot and reopen checks so a version-2 phase can reopen at a different absolute path only when the canonical Git repository identity matches and the persisted base object exists: a detached target must still have detached `HEAD` exactly at `baseSha`, while a branch target must still be on the recorded full branch ref with `baseSha` as an ancestor, leaving the existing action-specific candidate/dirty-state checks to enforce the narrower live state. Route the existing plan publication and implementation action/revision/publication base/branch reads through the normalized Git-identity helpers rather than retaining parallel authorities.

   Extend the existing phase-context tests (`test/factory-triage.workflow.test.ts`, `test/factory-planning-run-context.test.ts`, `test/factory-implementation-actions.test.ts`, and `test/factory-action-kernel.test.ts`) to prove new Git snapshots, non-Git compatibility, version-1 local-only compatibility, accepted relocation to the same repository/target, and rejection of repository, base, target, or path-only impersonation before an action opens.

2. `lib/factory-operation.ts:FactoryOperationRefSchema`, `resolveFactoryOperation`, and completed-result recovery — add the strict identifier-only request and receipt contracts while preserving `FactoryOperationRef` unchanged. The runtime receipt schema and `schemas/factory-operation-receipt.schema.json` must stay aligned and represent this closed union:

   ```text
   common:    version: 1, projectId, workItemKey, operation
   executed:  outcome: "executed",  resultEventId, next?
   recovered: outcome: "recovered", resultEventId, next?
   stale:     outcome: "stale",     observedEventId
   waiting:   outcome: "waiting",   observedEventId, reason
   next:      { projectId, workItemKey, operation }
   ```

   Make every object strict so stale/waiting cannot carry `next` and no variant can leak paths, credentials, Git details, lifecycle state, candidates, provider/session data, or evidence; `waiting.reason` uses the existing closed wait-reason literals from `FactoryReaction`. Extend resolution with the canonical observed event ID needed for stale/waiting receipts. For an authenticated completed action result, add an idempotent recovery helper that compare-appends that exact terminal event using its causation event as the expected cursor; existing identical events return the current reduced state, while divergent content or an invalid cursor fails closed. Derive a possible next request only when `decideNextFactoryAction` returns an invoke reaction against that canonical post-result state/event, and recompute its `FactoryOperationRef` with `createFactoryOperationRef`. Add `test/factory-operation-schema-sync.test.ts` for JSON Schema/Zod parity and forbidden-field coverage, and extend `lib/factory-operation.test.ts` for conditional append, observed IDs, and next-request derivation.

3. Add `lib/factory-hosted-operation.ts:runHostedFactoryOperation` as the sole composition boundary. Its trusted runtime input contains the expected project and repository IDs, `FactoryStoreMeta`, `FactoryGroveWorkspaceConfig`, timeout/signal/event controls, the existing provider factory, and the existing triage/reviewer test seams; the delivery request supplies no path, credential, work item payload, base SHA, or Grove intent. Execute one request in this order:

   1. Parse the strict request; require its project ID to match both trusted runtime and store metadata; authenticate the operation/action key and phase-run identity from the trusted store; find the matching phase request in canonical lifecycle JSONL; verify its factory-store work-item artifact and derived key; and require a version-2 Git identity whose repository ID matches trusted runtime. Treat missing/partial Git authority or a null phase-request predecessor as ineligible, not as a cue to inspect the current checkout or a mutable base ref.
   2. Resolve before acquisition. Recover and append an authenticated completed result immediately, or return stale/waiting from the observed canonical event, without constructing Grove or a provider.
   3. For a current operation, use only the phase request's `expectedPredecessor` as `phaseGeneration` and the persisted Git base as `baseSha`; derive the Grove intent, then require its repository, phase, work item, base, and detached/deterministic branch target to equal the authenticated phase identity before calling `ensureFactoryGroveWorkspace`.
   4. Validate the returned lease/intent and canonical workspace against the same trusted repository/base/target, resolve the operation again, and return recovered/stale/waiting if lifecycle truth changed during acquisition. Only an operation still current reaches `executeFactoryOperation`, which performs its own immediate context and reaction revalidation and dispatches one existing exhaustive handler.
   5. Authenticate the persisted result returned by execution, emit `executed`, and add `next` only from the canonical invoke reaction selected after that result. Do not follow the hint or release, repair, or replace the Grove lease.

   Add `lib/factory-hosted-operation.test.ts` with isolated real Factory stores/phase evidence and only the Grove/provider boundaries injected. Prove early completed replay, stale, waiting, project/work-item/action/result divergence, missing Git authority, and target mismatch make zero Grove and provider calls; a state mutation inside acquisition returns stale/waiting and makes zero provider calls; a current request uses the request predecessor as generation and invokes one handler once; and executed/recovered next hints are recomputed while all other receipts omit them.

4. `scripts/smoke-factory-grove.ts` — replace the manual CLI composition with the production hosted runner while keeping the real temporary Git repository, Grove pool, durable Factory store, setup hook, and local provider fake. Prepare one pending triage phase/request from immutable evidence, let the runner acquire the detached Grove checkout and execute it, release the lease from the authenticated terminal triage event, then redeliver the identical request. Assert the replay is `recovered`, the provider and setup hook each ran only for the first delivery, the released lease was not recreated, and lifecycle/action evidence stayed unchanged. Keep the smoke deterministic, offline, isolated from user state, and clean on success.

5. `docs/contributing/architecture.md`, `docs/contributing/factory.md`, `docs/contributing/setup-manifest.md`, `docs/contributing/testing.md`, `docs/contributing/script-command-surface.md`, and `test/docs-contracts.test.ts` — replace the current statement that no hosted operation runner ships with the new callable boundary. Document identifier-only delivery versus trusted runtime ownership, immutable phase Git identity and path provenance, early result recovery, Grove acquisition followed by Factory revalidation, receipt-as-hint semantics, and the upgraded replay-after-release smoke. Keep the Grove adapter's lease/release ownership and the manual CLI's phase-start, continuation, projection, publication, and merge policy unchanged; do not describe a scheduler or deployment integration.

## Verify

- `pnpm exec vitest run lib/factory-operation.test.ts lib/factory-hosted-operation.test.ts test/factory-operation-schema-sync.test.ts test/factory-action-kernel.test.ts test/factory-triage.workflow.test.ts test/factory-planning-run-context.test.ts test/factory-implementation-actions.test.ts test/docs-contracts.test.ts`
- `make check`
- `make smoke-factory`

## Boundaries

- Do not add Inngest code, events, deployment configuration, a project/workspace/handler registry, multi-worker fencing, or horizontal-scaling policy.
- Do not move phase start/restart, continuation, tracker projections, pull-request publication, merge acknowledgement, Grove terminal release/repair, or next-request scheduling into the runner.
- Do not move staged provider/reviewer recovery ahead of the acquired workspace and existing Git/context validation. Only a fully authenticated terminal `action-result.json` may recover before Grove.
- Do not add receipt signatures, a receipt ledger, a second lifecycle source of truth, or fields beyond the locked identifier-only contract.
