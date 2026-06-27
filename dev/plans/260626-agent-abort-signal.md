# Plan 260626-agent-abort-signal: Propagate SDK AbortSignal with caller-visible cancellation

> **Archive note:** Implemented and removed from the active queue. Historical reference only — do not execute step-by-step. Next work: [`260627-remove-cursor-cli-review-runtime.md`](./260627-remove-cursor-cli-review-runtime.md).

## Status

- **Status**: done (archived from active queue)
- **Completed**: 2026-06-27
- **Merged**: [#36](https://github.com/ferueda/harness/pull/36)
- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: dx
- **Revised**: 2026-06-27 — SDK-first cancellation; Cursor CLI subprocess kill-tree work removed from this plan
- **Related**: `dev/plans/260627-sdk-agent-stream-logs.md`

## Why this matters

Harness has no external `AbortSignal` on `Agent.run()`. Timeouts exist, but a caller cannot intentionally cancel a long SDK reviewer and receive a clear cancellation result. Since `change-review` now defaults to SDK providers, the useful cancellation primitive is provider-level cancellation: Cursor SDK `run.cancel()` and Codex SDK `signal` on `runStreamed()` / `run()`.

This plan makes providers abort-ready and standardizes the result contract. It does not implement full CLI SIGINT handling or legacy Cursor CLI subprocess cleanup.

## Current state

- `lib/agents.ts` — `AgentRunInput` has `maxRuntimeMs`, but no caller-provided `signal`; failed results have no `aborted` flag.
- `providers/cursor/cursor-sdk-agent.ts` — has timeout logic and calls `run.cancel()` when a run times out.
- `providers/codex/codex-agent.ts` — creates an internal `AbortController`, passes `signal` to `thread.run(...)`, and maps timeout to exit `124`.
- `lib/workflow-context.ts` — calls `reviewProvider.run(...)` without a signal and throws generic `<stage> reviewer failed: ...` errors.
- `lib/cursor-agent.ts` and `providers/cursor/cursor-agent.ts` still support Cursor CLI runtime, but SDK cancellation is the production path.

Relevant current excerpts:

```ts
// lib/agents.ts
export type AgentRunInput = {
  workspace: string;
  prompt: string;
  schemaPath?: string;
  model?: string;
  sandboxMode?: AgentSandboxMode;
  approvalPolicy?: AgentApprovalPolicy;
  modelReasoningEffort?: AgentReasoningEffort;
  maxRuntimeMs: number;
};
```

```ts
// providers/cursor/cursor-sdk-agent.ts
if (timedOut && run) {
  await cancelRun(run);
}
```

```ts
// providers/codex/codex-agent.ts
const controller = new AbortController();
const timeout = setTimeout(() => {
  timedOut = true;
  controller.abort();
  timeoutReject?.(new Error("timeout"));
}, input.maxRuntimeMs);
```

## Caller-visible contract

When a provider is cancelled by an external caller signal:

| Field | Value |
|-------|-------|
| `AgentRunResult` | `ok: false`, `aborted: true`, `error: "Agent was aborted"`, `exitCode: 130` |
| Timeout result | `ok: false`, no `aborted`, timeout wording, `exitCode: 124` |
| Workflow error | Include `"Agent was aborted"` so failed review summaries are distinguishable |
| Future `meta.json` | Can add `aborted: true` at run/step level when workflow-level signal wiring lands |

Terminology:

- `aborted` means explicit caller cancellation.
- `timeout` means harness budget expiry.
- `cancelled` from an SDK terminal run status should remain provider status unless it was caused by caller abort.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `pnpm run typecheck` | exit 0, no TypeScript errors |
| Tests | `pnpm test -- providers/cursor/cursor-sdk-agent.test.ts providers/codex/codex-agent.test.ts test/workflow-context.test.ts` | exit 0, targeted tests pass |
| Full tests | `pnpm test` | exit 0 |
| Lint | `pnpm run lint` | exit 0 |

## Suggested executor toolkit

| Skill | Use for |
|-------|---------|
| `node` | AbortController composition, listener cleanup, async timeout behavior |
| `typescript-refactor` | Typed result contract and signal composition without unsafe casts |
| `vitest` | Abort tests with mock SDK runs and async assertions |

## Scope

**In scope**:

- `lib/agents.ts` — add `signal?: AbortSignal` to `AgentRunInput`; add `aborted?: boolean` to failed `AgentRunResult`.
- `providers/cursor/cursor-sdk-agent.ts` — compose external abort with existing timeout budget; call `run.cancel()` on external abort after a run exists.
- `providers/codex/codex-agent.ts` — compose external abort with existing timeout controller; pass the composed signal to Codex turn options.
- `lib/workflow-context.ts` — surface `result.aborted` with a clear error string.
- Tests for Cursor SDK, Codex SDK, and workflow error surfacing.

**Out of scope**:

- Cursor CLI wrapper `SIGTERM` forwarding.
- `providers/cursor/lib/runner.ts` nested process kill-tree cleanup.
- `harness run` process-level SIGINT handling and shell exit code `130`.
- Workflow-level `AbortController` orchestration across parallel reviewers.
- Peer cancellation semantics for partially failed parallel review runs.
- Removing `--runtime cli` from the product.

## Steps

### Step 1: Extend the provider contract

Edit `lib/agents.ts`.

Add:

```ts
signal?: AbortSignal;
```

to `AgentRunInput`.

Add:

```ts
aborted?: boolean;
```

to the failed `AgentRunResult` branch only.

Do not require success results to carry cancellation metadata.

**Verify**: `pnpm run typecheck` -> exit 0.

### Step 2: Add signal composition helper

Create a small internal helper where it best fits. Prefer a provider-local helper first; extract to `lib/agent-signals.ts` only if both providers would otherwise duplicate non-trivial code.

Behavior:

- Inputs: external `AbortSignal | undefined`, timeout milliseconds.
- Outputs: composed `signal`, `isTimedOut()`, `isExternallyAborted()`, and `cleanup()`.
- Timeout aborts with timeout state and should produce exit `124`.
- External abort should produce exit `130`.
- If external signal is already aborted before provider work starts, return an aborted result without creating a provider run.
- Remove event listeners in `cleanup()`.

**Verify**: `pnpm run typecheck` -> exit 0.

### Step 3: Wire Cursor SDK external abort

Edit `providers/cursor/cursor-sdk-agent.ts`.

Implementation requirements:

- Keep current total `maxRuntimeMs` budget across create/send/wait.
- If `input.signal` aborts before `CursorSdkAgent.create`, return `Agent was aborted`, `exitCode: 130`, `aborted: true`.
- If abort happens after `run` exists, call `run.cancel()` once.
- Timeout still calls `run.cancel()` and returns exit `124` without `aborted`.
- Preserve workspace mutation guard behavior; if abort and workspace mutation both happen, keep the existing guard semantics only if tests already require it. Otherwise prefer explicit abort result.
- Avoid unhandled rejections from late SDK work, matching the current timeout pattern.

Tests in `providers/cursor/cursor-sdk-agent.test.ts`:

- Pre-aborted signal does not call `createSdkAgent`.
- Abort while waiting calls fake `run.cancel()` and returns `aborted: true`, `exitCode: 130`.
- Timeout still returns `exitCode: 124`, not `aborted`.
- Delayed rejection after abort does not emit `unhandledRejection`.

**Verify**: `pnpm test -- providers/cursor/cursor-sdk-agent.test.ts` -> exit 0.

### Step 4: Wire Codex external abort

Edit `providers/codex/codex-agent.ts`.

Implementation requirements:

- Compose `input.signal` with the existing timeout `AbortController`.
- Pass the composed signal as Codex `TurnOptions.signal`.
- If external abort happens, return `ok: false`, `aborted: true`, `exitCode: 130`, `error: "Agent was aborted"`.
- If timeout happens, preserve current timeout result: `exitCode: 124`, timeout wording, no `aborted`.
- Preserve delayed rejection handling after timeout/abort.
- If `260627-sdk-agent-stream-logs` has already switched Codex to `runStreamed()`, pass the same composed signal to `runStreamed(...)`.

Tests in `providers/codex/codex-agent.test.ts`:

- Pre-aborted signal returns `aborted: true` and does not start a run.
- Abort while the fake run is pending aborts the signal and returns `exitCode: 130`.
- Timeout test remains `exitCode: 124`.
- Delayed rejection after abort does not emit `unhandledRejection`.

**Verify**: `pnpm test -- providers/codex/codex-agent.test.ts` -> exit 0.

### Step 5: Surface aborts in workflow errors

Edit `lib/workflow-context.ts`.

When `reviewProvider.run(...)` returns `!result.ok`:

```ts
if (result.aborted) {
  throw new Error(`Agent was aborted: ${config.stage} reviewer`);
}
throw new Error(`${config.stage} reviewer failed: ${result.error}`);
```

Add a workflow-context test with injected provider:

- Provider returns `{ ok: false, aborted: true, error: "Agent was aborted", exitCode: 130 }`.
- `ctx.agent("review-implementation")` rejects with `Agent was aborted: implementation reviewer`.

Do not add workflow `signal` input in this plan.

**Verify**: `pnpm test -- test/workflow-context.test.ts` -> exit 0.

### Step 6: Full verification and index

Run:

```bash
pnpm run typecheck
pnpm test
pnpm run lint
```

Expected: all exit 0.

Update `dev/plans/README.md` after implementation status changes.

## Test plan

- Provider unit tests cover pre-abort, mid-run abort, timeout precedence, and late rejection handling.
- Workflow test covers caller-visible abort wording.
- Existing timeout tests remain unchanged except for internal helper setup.

## Done criteria

- [x] `AgentRunInput.signal` exists.
- [x] Failed `AgentRunResult` supports `aborted?: boolean`.
- [x] Cursor SDK external abort calls `run.cancel()` when possible and returns exit `130`.
- [x] Codex external abort uses `TurnOptions.signal` and returns exit `130`.
- [x] Timeout paths still return exit `124` and do not set `aborted`.
- [x] Workflow error text distinguishes explicit abort from reviewer failure.
- [x] No Cursor CLI subprocess kill-tree implementation is added by this plan.
- [x] Targeted tests pass.
- [x] `pnpm run typecheck`, `pnpm test`, and `pnpm run lint` pass.
- [x] `dev/plans/README.md` reflects status after implementation.

## STOP conditions

Stop and report if:

- Cursor SDK `run.cancel()` cannot be called after external abort without causing unhandled rejections.
- Codex SDK cannot accept a composed `AbortSignal` in the installed version.
- Timeout and abort race in a way that makes exit `124` vs `130` nondeterministic.
- Correct workflow cancellation requires changing `runReviewSteps` orchestration; that belongs in a separate workflow plan.

## Maintenance notes

- Workflow-level cancellation: pass orchestrator `signal` through `reviewProvider.run(...)` when added; decide parallel peer marking in `steps.json`.
- Stream writer cleanup on abort shipped with PR #36 (`260627-sdk-agent-stream-logs` + `260626-agent-abort-signal`).
- Cursor CLI cancellation is out of scope unless review runtime is retained — see [`260627-remove-cursor-cli-review-runtime.md`](./260627-remove-cursor-cli-review-runtime.md).
