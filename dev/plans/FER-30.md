# Provision Factory workspaces through Grove leases

## Goal

Add the direct `@ferueda/grove` adapter that a future host can use to acquire or
reopen an isolated Factory workspace before invoking an unchanged Factory CLI or
typed action boundary with `--workspace`. The adapter must deterministically map
repository, work item, phase, and phase generation to one lease; create triage,
planning, and implementation checkouts from an authoritative commit; run the
repository-owned setup hook; and return the same canonical path after process
restart without disturbing Git state that Factory has since changed.

Factory remains the live Git and lifecycle authority after initial checkout.
Grove owns pool capacity, lease persistence, worktree creation, serialized setup,
process-safe reset/release, quarantine, and repair. Active planning and
implementation leases remain allocated through waits and failures. Cleanup
requires terminal authority already verified by the caller; the adapter does not
interpret Factory events or operations.

## Changes

1. `package.json`, `pnpm-lock.yaml` — add the exact direct dependency
   `@ferueda/grove@1.4.4`. This published version reruns `postAcquire` for a
   compatible `ifLeased: "return-existing"` acquisition, which is required for
   restart readiness on the original lease and path.

2. `lib/factory-grove-workspace.ts` — add one Factory-specific Grove adapter
   with typed lease intent, ensure/reopen, release, and bounded repair entrypoints.

   - Define `FactoryGroveWorkspaceIntent` from
     `deriveFactoryRepoIdentity(repoRoot).id`, canonical work-item key, phase
     (`triage`, `planning`, or `implementation`), phase generation, and the
     caller-resolved authoritative base SHA. Hash the versioned
     repository/work-item/phase/generation tuple into a Grove-safe lease ID and
     persist the readable tuple, base SHA, and target branch/ref in Grove
     metadata. Use separate deterministic attached branches for planning and
     implementation and a detached checkout for triage; phase remains part of
     the identity, so their leases cannot collide. Deterministic derivation plus
     Grove metadata is the mapping; add no Factory lifecycle fields or second
     lease store.
   - Implement `ensureFactoryGroveWorkspace` over `createGrove`. Accept the
     controller repository, persistent pool directory/capacity, idempotent
     repository-owned setup command, and intent. Configure that command as
     `postAcquire` with `onHookFailure: "fail"`; acquire a new attached branch
     from the exact base SHA with `ifExists: "fail"`, or the exact detached SHA
     for triage, and use `ifLeased: "return-existing"` for compatible reopen.
     Return the lease ID and `realpath` of Grove's path only after setup succeeds.
     A setup failure must prevent Factory invocation; retrying the same intent
     reruns setup on the same committed lease/path.
   - On reopen, validate the immutable lease ID, repository, target, metadata,
     and stable path, then rely on Grove's compatible reacquire. Do not reset,
     fetch/checkout into the worktree, recreate its branch, or require its
     current branch or `HEAD` to equal the initial target: Factory may have
     committed, switched to a publication branch, or retained dirty candidate
     state since acquisition. A conflict, missing active path, busy cleanup, or
     quarantined lease returns typed infrastructure attention and never creates
     a replacement for the same generation.
   - Define caller-verified terminal authority as a closed phase-matched value
     carrying the durable terminal event ID (`triage-terminal`, `plan-merged`,
     or `implementation-merged`). `releaseFactoryGroveWorkspace` must validate
     that authority and the immutable lease metadata, then call
     `grove.release(leaseId, {cleanup: "reset", resetTo: baseSha})` without
     `force` or ignored-file cleaning. Success requires a released result and
     `inspect(leaseId) === null`, returning the slot to pool capacity. Merely
     ensuring or reopening a lease never releases it, which preserves planning
     and implementation work through all pre-terminal waits and failures.
   - Add `repairFactoryGroveWorkspace` as a closed delegation for
     `resume-acquire`, `resume-cleanup`, and `quarantine`; do not expose
     `force-destroy`. Every repair first validates the deterministic intent and
     stored metadata. Cleanup resumption additionally requires the same terminal
     authority and an exact pending reset target of `baseSha`. Unsafe or
     mismatched recovery stays quarantined and is surfaced for infrastructure
     attention rather than being silently reset or replaced.

3. `test/factory-grove-workspace.test.ts` — exercise the adapter against real
   temporary Git repositories and Grove pools, not mocked Git or Grove.

   - Prove deterministic lease/branch derivation before a Factory phase run ID,
     exact initial base checkout, detached triage versus attached planning and
     implementation isolation, and conflict rejection without a second
     worktree.
   - Recreate the adapter to prove compatible reacquire returns the same
     canonical path and reruns a fail-once/idempotent setup hook. Commit, switch
     branches, and retain dirty bytes between calls; assert reopen preserves all
     of that Factory-owned state and performs no checkout or reset.
   - Prove active planning/implementation leases remain allocated until an
     authorized release; wrong or mismatched terminal authority causes no
     mutation. For valid authority, assert non-forced reset release removes the
     lease and restores pool capacity. Exercise the public matching
     resume-acquire/resume-cleanup and quarantine delegations with Grove's real
     persisted states, including rejection of mismatched pending cleanup.

4. `scripts/smoke-factory-grove.ts`, `package.json`,
   `test/docs-contracts.test.ts` — add a small deterministic Grove smoke beside
   the existing Factory system journey and include it in `pnpm smoke:factory`
   without rewriting `scripts/smoke-factory.ts`. In an isolated local
   repository, bare remote, Grove pool, and Factory store: acquire a triage
   lease from an exact commit; observe repository-owned setup; invoke one
   existing Factory triage action through the source CLI using the returned
   `--workspace` and a local provider fake; reconstruct the adapter and
   reacquire the same path; verify setup reran and Factory evidence survived;
   then pass the verified durable triage terminal event to reset/release and
   assert the lease is absent. Keep the smoke offline and clean temporary state
   on success.

5. `docs/contributing/architecture.md`, `docs/contributing/factory.md`,
   `docs/contributing/setup-manifest.md`, `docs/contributing/testing.md`, and
   `docs/contributing/script-command-surface.md` — document only the shipped
   boundary: Grove provisions and safely recycles persistent lease worktrees;
   Factory commands retain lifecycle and live Git authority; callers own phase
   generation and terminal-event verification; repositories own an idempotent,
   credential-free setup command (`make setup-worktree` for Harness); and the
   Grove smoke is part of the explicit Factory smoke gate. Record the persistent
   pool requirement and repair/quarantine attention path without describing an
   Inngest runner as current behavior.

## Verify

- `pnpm exec vitest run test/factory-grove-workspace.test.ts test/docs-contracts.test.ts`
- `make check`
- `make smoke-factory`

## Boundaries

- No identifier-only hosted operation dispatcher, controller extraction,
  publication or merge-acknowledgement variant, terminal-result recovery, or
  change to an existing Factory CLI/typed boundary. Those operation-level host
  concerns belong to FER-93.
- No Inngest implementation, generic workspace-provider abstraction, handler
  registry, lease database, or Factory lifecycle/schema change.
- No reacquire-time checkout/reset, forced cleanup, silent lease replacement,
  ephemeral-container infrastructure, or Codex Desktop bridge.
