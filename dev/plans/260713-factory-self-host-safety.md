# Keep Factory self-host actions stable across provider refs and controller upgrades

## Goal

Fix the two FER-82 failures proven by the FER-78 dogfood run: a Codex producer
may rotate its private `refs/codex/**` bookkeeping without mutating repository
authority, and a manual Factory phase must remain readable when the Harness
controller is upgraded between invocations. Preserve raw Git evidence and all
branch, tag, Harness-ref, HEAD, and index guards. Accept only the two known
pre-publication v1 read shapes while keeping newly appended events and written
phase identities strict.

## Changes

1. **`lib/factory-implementation-candidate-action.ts` and a small Git-ref comparison helper — distinguish provider bookkeeping from repository refs.**
   - Canonicalize `git for-each-ref` output only for comparison. When the
     snapshotted producer provider is Codex, omit the exact `refs/codex/`
     namespace; do not omit `refs/codex-review`, branches, tags,
     `refs/harness/**`, or any other ref. Cursor receives no ignored namespace.
   - Keep the unfiltered before/after strings in staged provider evidence. Use
     the same provider-aware comparison for successful mutation enforcement
     and failed-provider unchanged classification so the failure kind cannot
     disagree with the final guard.
   - Extend `test/factory-implementation-actions.test.ts` with Codex-owned churn
     that produces a candidate, Cursor execution with `refs/codex/**` churn
     that remains human-required, Codex execution with adjacent
     `refs/codex-review` churn that remains human-required, and the existing
     real-ref rejection seam.

2. **`lib/factory-lifecycle-events.ts`, `lib/factory-lifecycle-kernel.ts`, `lib/factory-state-machine.ts`, and `lib/factory-plan-publication.ts` — separate narrow historical reads from current event writes.**
   - Read the exact legacy v1 `plan_pr.opened` shape whose data has `url` and
     `plan` but no `head`; represent the unavailable head honestly in rebuilt
     planning state. Continue requiring a 40-character head before any new
     `plan_pr.opened` append. Do not invent or infer a published head.
   - Preserve reduction through the matching historical `plan_pr.merged` event
     so an already-approved plan can still authorize implementation. Any new
     merge acknowledgement that requires an exact publication head must reject
     a headless historical publication with an explicit diagnostic before Git
     ancestry work.
   - Add `test/factory-action-kernel.test.ts` coverage that rebuilds and resolves
     implementation authority from a FER-78-shaped legacy log while proving a
     newly appended headless event is rejected. Add a focused
     `test/factory-planning-cli.test.ts` handler regression for the missing-head
     merge diagnostic. Apply the `zod` guidance at the durable read/write
     boundaries rather than weakening unrelated schemas.

3. **`lib/factory-phase-run.ts` and `lib/factory-implementation-run-context.ts` tests — normalize only the known legacy implementation identity.**
   - On read, default a v1 implementation identity missing `baseRef` to the
     historical controller default `main`. `writeFactoryPhaseRunIdentity` and
     direct `FactoryPhaseRunIdentitySchema` validation must continue requiring
     `baseRef`; malformed or differently incomplete identities remain errors.
   - Add a phase-reopen regression using the exact pre-FER-78 identity shape and
     retain strict-write assertions. Use inferred Zod input/output types; avoid
     casts or a general migration registry.

4. **`docs/contributing/factory.md` and `skills/factory-operator/SKILL.md` — state the manual self-host controller boundary.**
   - One active phase must use one stable Harness controller checkout/version.
     When Harness dogfoods itself, run the controller from a separate fixed
     checkout or installed shim and treat the implementation workspace as the
     mutable target. Upgrade the controller only between phases or after the
     active phase is explicitly closed.
   - Keep this operational guidance only; do not add version pinning,
     controller deployment, or runtime-management code.

## Verify

- `pnpm exec vitest run test/factory-implementation-actions.test.ts test/factory-action-kernel.test.ts test/factory-planning-cli.test.ts test/docs-contracts.test.ts`
- `pnpm check`
- From the exact final controller tip, use a disposable target and store to run
  one real Codex implementation candidate while its private refs churn; confirm
  candidate publication, unchanged repository-owned refs, and retained raw ref
  evidence. Separately reopen generic FER-78-shaped legacy event and phase
  fixtures through the source CLI without rewriting their durable files.

## Boundaries

- No generic migration framework, store-format bump, state rewrite, recovery
  engine, provider ref deletion, scheduler, or runtime/version manager.
- Do not resume or rewrite the failed FER-78 action; prove the corrected
  behavior with isolated fixtures and a fresh live smoke.
- No ref namespace beyond provider-matched `refs/codex/**` becomes mutable.
