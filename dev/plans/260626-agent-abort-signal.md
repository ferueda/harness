# Plan 260626-agent-abort-signal: Propagate AbortSignal with caller-visible cancellation

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none (integrate with `260626-incremental-stream-json-parsing.md` `runAgent` if landed)
- **Category**: dx
- **Source**: GNHF adoption item #3
- **Revised**: 2026-06-26 — round 2: wrapper envelope `aborted`; precedence vs timeout; explicit out-of-scope CLI/workflow wiring

## Why this matters

Harness has no `AbortSignal` on `Agent.run()`. The **AI agent caller** that runs `harness run change-review` cannot cancel a long review gracefully. Timeouts kill processes but cancellation is indistinguishable from reviewer failure in `meta.json` / stdout.

GNHF wires abort to child kill and uses `activeAbortController` per iteration. Harness needs the same primitive **plus** a caller-visible contract and **nested** process cleanup (wrapper → real `agent` CLI).

## Caller-visible contract (required)

When a run or reviewer is aborted (future workflow wiring; provider must support now):

| Field | Value |
|-------|-------|
| `AgentRunResult` | `ok: false`, `aborted: true`, `error: "Agent was aborted"`, `exitCode: 130` |
| `failedReviews[].error` | Include `"aborted"` or prefix `"Agent was aborted"` |
| Future `meta.json` | `aborted: true` at run or step level when workflow cancels |
| CLI exit code | `130` when user/agent sends SIGINT to `harness run` (optional Step 7) |

**Distinguish:** `cancelled` (peer aborted) vs `failed` (reviewer defect) vs `aborted` (explicit cancel) — document for future `steps.json`; provider returns `aborted`.

## Process boundary (required)

```
lib/cursor-agent.ts          kill wrapper on signal
  → cursor-agent.ts          forward SIGTERM to runAgent AbortController
    → runner.ts              kill real `agent` subprocess
```

Killing wrapper Node only may **orphan** the nested `agent` process. Wrapper must not treat abort as `"Failed to start Cursor CLI"` throw — abort is a **terminal result** from `runAgent`.

## Current state

| File | Today |
|------|-------|
| `lib/agents.ts` | `maxRuntimeMs` only |
| `providers/cursor/lib/runner.ts` | Timer SIGTERM/SIGKILL |
| `lib/cursor-agent.ts` | No signal on wrapper spawn |
| `providers/cursor/cursor-agent.ts` | Catches `runAgent` reject as startup failure |
| `providers/codex/codex-agent.ts` | Internal timeout `AbortController` |
| `providers/cursor/cursor-sdk-agent.ts` | `run.cancel()` on timeout |

## Scope

**In scope:**
- `lib/agents.ts` — `signal?: AbortSignal`; extend `AgentRunResult` with optional `aborted?: boolean`
- `providers/cursor/lib/stream-utils.ts` — `setupAbortHandler`
- `providers/cursor/lib/runner.ts` — abort → kill `agent` child; return `{ aborted: true }` not throw
- `providers/cursor/cursor-agent.ts` — internal `AbortController`; forward wrapper SIGTERM; map abort to envelope error with `aborted` semantics
- `lib/cursor-agent.ts` — abort wrapper; map to `AgentRunResult.aborted`
- `providers/codex/codex-agent.ts` — **compose** external signal with existing timeout signal
- `providers/cursor/cursor-sdk-agent.ts` — compose with budget timeout; call `run.cancel()` on external abort
- `lib/workflow-context.ts` — propagate `aborted` in thrown error message for `failedReviews`
- Tests

**Out of scope (explicit — not done criteria for this plan):**
- Workflow `input.signal` wiring in `createWorkflowContext` / `runReviewSteps`
- CLI `harness run` exit code `130` on SIGINT (future workflow AbortController plan)
- Parallel peer cancellation (`cancelled` vs `failed`) — see `260626-workflow-step-events.md`
- GNHF `--max-tokens` mid-run abort

## Steps

### Step 1: Extend types

```typescript
// lib/agents.ts
export type AgentRunInput = { /* ... */ signal?: AbortSignal };

export type AgentRunResult =
  | { ok: true; /* ... */ }
  | { ok: false; error: string; exitCode: number; aborted?: boolean; /* ... */ };
```

**Verify**: `npm run typecheck` → exit 0

### Step 2: `setupAbortHandler` in stream-utils

Port GNHF `setupAbortHandler`. Unit test: abort → `child.kill` called.

**Verify**: test passes

### Step 3: `runAgent` — abort as result, not throw

1. `setupAbortHandler(signal, subprocess, onAbort)` — `onAbort` sets `aborted: true`, kills child, settles with result object
2. **Precedence:** if `aborted`, do not set `timedOut` / `timeoutKind`; shared `settled` guard with timer kill
3. Return `{ aborted: true, exitCode: 130, isError: true, timedOut: false, ... }` — **do not reject** promise for abort
4. Test: abort before max-runtime fires → `aborted: true`, not `timedOut: true`

**Verify**: `providers/cursor/cursor-agent.test.ts` — abort does not hit "Failed to start Cursor CLI"

### Step 4: Wrapper `cursor-agent.ts`

1. Create `AbortController` for each run; pass `signal` to `runAgent`
2. On wrapper `SIGTERM`/`SIGINT`: `controller.abort()`
3. Map aborted `runAgent` result to envelope: add `aborted?: boolean` to envelope (or `status: "aborted"`); `finish()` uses **exit 130** when aborted (mirror SDK)
4. Update `parseCursorAgentOutput` in `lib/cursor-agent.ts` to map `envelope.aborted` → `AgentRunResult.aborted`

**Verify**: wrapper forwards abort to runner; envelope carries `aborted` through parent parse

### Step 5: Parent `lib/cursor-agent.ts`

1. Pass `input.signal` — compose with optional local controller
2. On abort: `child.kill("SIGTERM")` on wrapper
3. Return `AgentRunResult` with `aborted: true`, `exitCode: 130`

**Verify**: `test/workflow-context.test.ts` passes

### Step 6: Compose signals — Codex and SDK

**Codex:** Merge external `input.signal` with existing timeout controller. On external abort (not timeout): `aborted: true`, `exitCode: 130`, `error: "Agent was aborted"`. Timeout stays `exitCode: 124`.

**Cursor SDK:** On external `input.signal` abort: `run.cancel()` + `aborted: true`, `exitCode: 130`. Timeout path: `124`, no `aborted` flag.

**Verify**: existing timeout tests still pass; add abort test per provider where mockable

### Step 7: Workflow error surfacing (minimal)

In `lib/workflow-context.ts` when `!result.ok`:

```typescript
if (result.aborted) {
  throw new Error(`Agent was aborted: ${config.stage} reviewer`);
}
```

Optional: extend `FailedReview` in `lib/aggregate.ts` with `aborted?: boolean` if propagating structured field (preferred over string grep for AI agents).

**Note:** `reviewProvider.run` does **not** pass `signal` yet — providers are abort-ready; end-to-end cancel awaits a future workflow plan.

**Verify**: dedicated test — mock provider `{ ok: false, aborted: true, exitCode: 130 }` → `ctx.agent()` / `failedReviews` reflects abort (not generic "reviewer failed")

### Step 8: Full verification

**Verify**: `npm test` && `npm run lint` → exit 0

## Future workflow contract (document only)

- Parallel cancel: peers get `cancelled` status in `steps.json`, not `failed`
- Serial stop-on-failure: no abort needed (existing break)
- Inngest step cancel → same `signal`

## Workflow / CLI / agent impact

| Surface | This plan | Future |
|---------|-----------|--------|
| `harness run` stdout | Unchanged unless abort | `aborted: true` in meta |
| AI agent cancel | SIGKILL only today | `exit 130`, clear error string |
| Nested `agent` | Orphan risk fixed | — |

## Done criteria

- [ ] `AgentRunInput.signal` and `AgentRunResult.aborted` exist
- [ ] `runAgent` returns abort result (no throw); `aborted` wins over `timedOut`
- [ ] Wrapper envelope includes `aborted`; parent maps to `AgentRunResult`
- [ ] Wrapper forwards abort to nested `agent`
- [ ] Codex/SDK: external abort → `aborted: true`, exit `130`; timeout → `124`
- [ ] `workflow-context` surfaces abort in error (and optional `FailedReview.aborted`)
- [ ] Abort-specific test exists (not only "workflow-context passes")
- [ ] **Not required:** CLI exit `130` or workflow `signal` wiring
- [ ] `npm test` exits 0
- [ ] `dev/plans/README.md` updated

## STOP conditions

Stop and report if:

- SDK has no cancel and product requires SDK abort.
- Abort wiring breaks timeout exit codes (`124` vs `130`).
- Extending `AgentRunResult` breaks consumers beyond fixable `workflow-context` check.

## Maintenance notes

- Wire `runReviewSteps` `AbortController` in separate workflow plan.
- PR: listener cleanup; no orphaned `agent` processes after cancel.
