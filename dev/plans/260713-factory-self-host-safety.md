# Keep Factory self-host implementation stable across Codex ref churn

## Goal

Fix the FER-82 false positive proven by the FER-78 dogfood run: a Codex producer
may rotate its private `refs/codex/**` bookkeeping without mutating repository
authority. Preserve raw Git evidence and all branch, tag, Harness-ref, HEAD,
and index guards. Keep one strict durable schema; stale dogfood records from
older controller shapes remain archive/reset inputs rather than a permanent
compatibility contract.

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
- No ref namespace beyond provider-matched `refs/codex/**` becomes mutable.
