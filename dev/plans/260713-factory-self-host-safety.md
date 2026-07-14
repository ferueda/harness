# Keep Factory self-host implementation stable across ambient ref churn

## Goal

Fix the FER-82 false positive proven by dogfood: another worktree sharing the
Git common directory may move unrelated refs without mutating this action's
authority. Preserve raw global Git evidence while enforcing the current branch,
current phase-owned Harness refs, HEAD, workspace, and index guards. Keep one
strict durable schema; stale dogfood records from older controller shapes remain
archive/reset inputs rather than a permanent compatibility contract.

## Changes

1. **Factory implementation actions and a small Git-ref snapshot helper — enforce action-owned authority.**
   - Hard-compare resolved and symbolic HEAD, the persisted current branch tip,
     and exact refname-to-OID state below the current phase's
     `refs/harness/factory/<phaseRunId>/` namespace before and after producers
     and reviewers, then revalidate before candidate publication or promotion.
   - Keep unfiltered global before/after ref strings in staged action evidence
     as diagnostics only. Shared global snapshots cannot attribute unrelated
     branch, tag, or private-ref movement to the active worktree.
   - Cover producer and reviewer execution in worktrees sharing one Git common
     directory: unrelated movement passes; current branch and current
     phase-owned ref movement remains human-required.

2. **`docs/contributing/factory.md` and `skills/factory-operator/SKILL.md` — state the manual self-host controller boundary.**
   - One active phase must use one stable Harness controller checkout/version.
     When Harness dogfoods itself, run the controller from a separate fixed
     checkout or installed shim and treat the implementation workspace as the
     mutable target. Upgrade the controller only between phases or after the
     active phase is explicitly closed.
   - Keep this operational guidance only; do not add version pinning,
     controller deployment, or runtime-management code.

## Verify

- `pnpm exec vitest run test/factory-implementation-actions.test.ts test/factory-action-kernel.test.ts test/docs-contracts.test.ts`
- `pnpm check`
- From the exact final controller tip, use a disposable target and store to run
  one real Codex implementation candidate while its private refs churn; confirm
  candidate publication, unchanged repository-owned refs, and retained raw ref
  evidence. Confirm that headless plan publication events and implementation
  phase identities missing `baseRef` fail strict validation.

## Boundaries

- No compatibility adapter, generic migration framework, store-format bump,
  state rewrite, recovery engine, provider ref deletion, scheduler, or
  runtime/version manager.
- Do not resume or rewrite the failed FER-78 action; prove the corrected
  behavior with isolated fixtures and a fresh live smoke.
- Unrelated global refs are diagnostic because their writes cannot be attributed
  from a repository-global snapshot; current branch and phase-owned refs remain
  exact hard gates.
