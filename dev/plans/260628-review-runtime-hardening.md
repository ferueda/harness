# Plan 260628-review-runtime-hardening: Shared review guard, provider invoke DRY, registry layering, CLI abort

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `dev/plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 63b01fc..HEAD -- lib/ providers/ workflows/ bin/harness.ts test/`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Status**: `done`
- **Depends on**: [260628-harness-verification-baseline.md](./260628-harness-verification-baseline.md) — **hard gate** (`done`; `test/review-output-schema-sync.test.ts` must exist)
- **Category**: tech-debt
- **Planned at**: commit `63b01fc`, 2026-06-28
- **Revised**: 2026-06-28 — post `review-spec` (pass 2)

## Why this matters

Review runtime has five gaps: (1) Cursor's post-run `git status` failure discards successful reviews; (2) Codex has no post-run workspace check; (3) provider invoke code is duplicated across Cursor/Codex; (4) `lib/agent-provider.ts` creates a `lib → providers → lib` import cycle; (5) provider-level `AbortSignal` exists (PR #36) but the CLI never passes one on SIGINT. This plan extracts shared modules, applies consistent workspace guarding to both providers, moves provider registration out of `lib/`, and wires run-scoped cancellation from `harness run change-review`.

## Decisions (locked for this plan)

| Topic | Decision |
|-------|----------|
| Post-run git failure | Return `ok: true` when agent succeeded but post-run status unreadable; set `raw.workspaceStatus.guard: "unverified"` (extend existing `workspaceStatus` shape — no parallel top-level keys) |
| Pre-run git failure | Hard-fail with full `AgentRunResult` (unchanged) |
| Codex guard | Same shared guard as Cursor after every run |
| Ctrl+C | **Abort entire run** — one `AbortController` shared by all parallel reviewers |
| CLI exit on abort | `process.exitCode` stays verdict-based (`1` on failure) — **not** shell `130` (same scope as `260626-agent-abort-signal`; provider still returns `exitCode: 130`) |
| Registry | `createAgentProvider` in `providers/registry.ts`; `lib/workflow-context.ts` does **not** import `providers/` |
| `errorArtifact` | Shared superset: `name`/`message`/`stack` plus optional Cursor SDK fields (`code`, `status`, `requestId`, `isRetryable`, `helpUrl`, `operation`, `endpoint`) |
| Stream settle | Minimal shared timeout race in `lib/agent-invoke.ts`; provider-specific wrappers keep Cursor `onTimeout` lifecycle |

## Current state

**Workspace guard (Cursor only, brittle post-run):**

```ts
// providers/cursor/cursor-sdk-agent.ts:338-348
function withWorkspaceGuard(result, workspace, beforeStatus) {
  const afterStatus = readWorkspaceStatus(workspace);
  if (!afterStatus.ok) {
    return { ...afterStatus.error, raw: addWorkspaceStatus(...) }; // drops successful result
  }
}
```

Pre-run failure returns `beforeStatus.error` as full `AgentRunResult` (`cursor-sdk-agent.ts:87-90`). `readWorkspaceStatus` failure shape is `{ ok: false; error: AgentRunResult }` (`cursor-sdk-agent.ts:300-308`), not a plain string.

Existing raw convention uses `workspaceStatus: { before, after? }` via `addWorkspaceStatus` (`cursor-sdk-agent.ts:370-380`). Tests assert this shape (`cursor-sdk-agent.test.ts`).

`readWorkspaceStatus` uses `git status --porcelain=v1 -z -- . :!.harness` (`cursor-sdk-agent.ts:293`). Codex has no guard. Codex tests use temp dirs **without** `git init` — adding pre-run guard will break them until fixed.

**Cursor `errorArtifact` superset** (`cursor-sdk-agent.ts:545-567`) — shared helper must preserve SDK fields; tests at `cursor-sdk-agent.test.ts:999-1008`.

**Import cycle:** `lib/workflow-context.ts` → `lib/agent-provider.ts` → `providers/codex/codex-agent.ts` → `lib/*`

**Abort gap:** `AgentRunInput.signal` at `lib/agents.ts:47`; not passed from `workflow-context.ts:337-345` or `bin/harness.ts`.

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Typecheck | `pnpm typecheck` | exit 0 |
| Tests     | `pnpm test` | exit 0 |
| Targeted  | `pnpm test -- providers/ test/workflow-context.test.ts test/agent-signals.test.ts test/agent-provider.test.ts lib/review-guard.test.ts lib/agent-invoke.test.ts` | exit 0 |
| Full gate | `pnpm check` | exit 0 |

## Suggested executor toolkit

| Skill / resource | Use for |
|------------------|---------|
| `typescript-refactor` | Extract modules, `Omit<>` type split for factory |
| `vitest` | Provider tests; `vi.useFakeTimers()` for settle timeout |
| `node` | `AbortController`, `process.off` in `finally` |

## Scope

**In scope** — create or modify:
- `lib/review-guard.ts`, `lib/review-guard.test.ts`
- `lib/agent-invoke.ts`, `lib/agent-invoke.test.ts`
- `lib/agents.ts` — add `AgentProviderOptions`
- `providers/registry.ts` (create)
- `providers/cursor/cursor-sdk-agent.ts`, `providers/codex/codex-agent.ts`
- `providers/codex/codex-agent.test.ts` — add `createGitWorkspace()` (mirror `cursor-sdk-agent.test.ts:34-42`)
- `lib/workflow-context.ts`, `bin/harness.ts`
- `test/agent-provider.test.ts`, `test/workflow-context.test.ts`
- Delete `lib/agent-provider.ts`
- `dev/plans/README.md`

**Out of scope:** skills/, README, Codex policy floor, plan/handoff paths, `steps.json`, gitignored-file detection, shell exit `130`, second Ctrl+C force-exit.

## Git workflow

- Branch: `feat/review-runtime-hardening`
- One commit per file
- Conventional commits: `refactor:`, `fix:`, `feat:`, `test:`

## Steps

### Step 1: Extract `lib/agent-invoke.ts`

Shared helpers:

- `errorMessage(error: unknown): string`
- `errorArtifact(error: unknown): unknown` — **superset** of Codex + Cursor SDK fields (see `cursor-sdk-agent.ts:545-567`)
- `STREAM_SETTLE_TIMEOUT_MS = 1_000`
- `raceWithTimeout<T>(task, fallback, timeoutMs?)` — minimal shared timeout race only

Keep provider-specific wrappers in each provider:
- Cursor: `settleCursorStreamTask` (generator stop, writer close, custom error — `cursor-sdk-agent.ts:488-517`)
- Codex: `settleCodexStreamTask` calling `raceWithTimeout`

`lib/agent-invoke.test.ts`:
- `errorArtifact` for plain `Error`, non-Error, and Error with SDK extension fields
- `raceWithTimeout` timeout path with `vi.useFakeTimers()` (`test/workflow-events.test.ts:170`)

**Verify**: `pnpm test -- lib/agent-invoke.test.ts` → exit 0.

### Step 2: Extract `lib/review-guard.ts`

```ts
export function readWorkspaceStatus(workspace: string):
  | { ok: true; value: string }
  | { ok: false; error: AgentRunResult }

export function withWorkspaceGuard(
  result: AgentRunResult,
  workspace: string,
  beforeStatus: string,
): AgentRunResult
```

Move `addWorkspaceStatus` / related helpers here. Export shared type:

```ts
export type WorkspaceStatusMeta = {
  before: string;
  after?: string;
  guard?: "unverified";
};
```

**Behavior:**

| Case | Result |
|------|--------|
| Pre-run `readWorkspaceStatus` fails | Return `error` `AgentRunResult` unchanged |
| Post-run fails, `result.ok === true` | `ok: true`, preserve structured output; `raw.workspaceStatus: { before, guard: "unverified" }` |
| Post-run fails, `result.ok === false`, `result.aborted` | Preserve abort contract (`aborted`, `exitCode: 130`, original error); attach `{ before, guard: "unverified" }` — do not replace with git error |
| Post-run fails, `result.ok === false` (other) | Keep failure; add `workspaceStatus.guard: "unverified"` when attaching status |
| Both readable, equal | Result with `workspaceStatus: { before, after }` |
| Both readable, differ (not aborted cancel) | `ok: false`, workspace modified error (keep Cursor copy) |

Comment: tracked porcelain only (`:!.harness`); gitignored changes not detected.

`lib/review-guard.test.ts`: test `withWorkspaceGuard` with synthetic status results (avoid over-mocking `execFileSync`). Post-run failure + `ok: true` input → still `ok: true` with `guard: "unverified"`.

**Verify**: `pnpm test -- lib/review-guard.test.ts` → exit 0.

### Step 3: Refactor Cursor provider

- Import guard + invoke helpers from `lib/`
- Remove local duplicates
- **Add** regression test (none exists today): mock/spy post-run `readWorkspaceStatus` → `!ok` while agent result is `ok: true` with `structuredOutput` → expect `ok: true`, output preserved, `raw.workspaceStatus.guard === "unverified"`

**Verify**: `pnpm test -- providers/cursor/cursor-sdk-agent.test.ts` → exit 0.

### Step 4: Add workspace guard to Codex provider

**Before any provider logic:** add `createGitWorkspace()` to `codex-agent.test.ts` (copy from `cursor-sdk-agent.test.ts:34-42`). Use it in **every** test that calls `.run()` — pre-run guard requires a git repo.

In `codex-agent.ts`:
- Pre-run `readWorkspaceStatus`; fail fast on `!ok` (return `error` `AgentRunResult`)
- Wrap every return **after** `beforeStatus` is captured (mirror Cursor — not schema/pre-abort early returns)
- Use shared invoke helpers

Add guard tests: unchanged status passes; mutation fails when porcelain differs.

**Verify**: `pnpm test -- providers/codex/codex-agent.test.ts` → exit 0.

### Step 5: Move provider registry out of `lib/`

1. Add to `lib/agents.ts`:

```ts
export type AgentProviderOptions = {
  provider: AgentProviderName;
  codexPathOverride?: string;
};
```

2. Create `providers/registry.ts` — move factory from `lib/agent-provider.ts`. **Preserve lazy Cursor load**: keep `createLazyCursorSdkAgent()` with dynamic `import()` (`lib/agent-provider.ts:17-26`); only Codex is statically imported.

3. Type split in `lib/workflow-context.ts`:

```ts
type WorkflowOptions = {
  /* existing fields */
  agentProviderFactory: (opts: AgentProviderOptions) => Agent;
};

type WorkflowContextFactoryOptions = Omit<WorkflowOptions, "agentProviderFactory"> & {
  agentProviderFactory?: (opts: AgentProviderOptions) => Agent;
};
```

- `createWorkflowContext(options: WorkflowOptions)` — factory **required**
- `createWorkflowContextForTest(options: WorkflowContextFactoryOptions)` — factory optional (existing mocks pass factory; no in-`lib/` default)

4. In `createWorkflowContextInternal`, **remove** `options.agentProviderFactory ?? createAgentProvider` — use `options.agentProviderFactory` only (required on production path).

5. Remove `import` of `lib/agent-provider.ts` from workflow-context.

6. `bin/harness.ts`: `import { createAgentProvider } from "../providers/registry.ts"`; pass `agentProviderFactory: createAgentProvider`.

7. `test/workflow-context.test.ts`:
   - Import `AgentProviderOptions` from `lib/agents.ts` (not deleted `agent-provider.ts`)
   - Lines ~40, ~83: pass `agentProviderFactory: createAgentProvider` from registry

8. `test/agent-provider.test.ts`: import from `providers/registry.ts`.

9. Delete `lib/agent-provider.ts`.

10. `rg 'from "\.\./providers/|from '\''\.\./providers/' lib/` → no matches.

**Verify**: `pnpm typecheck && pnpm test -- test/agent-provider.test.ts test/workflow-context.test.ts` → exit 0.

### Step 6: Wire CLI `AbortSignal`

1. `WorkflowOptions` + `createWorkflowContextInternal`: add `signal?: AbortSignal`; pass to `reviewProvider.run({ ..., signal: options.signal })`.

2. `bin/harness.ts` `addReviewCommand` action:

```ts
const runAbort = new AbortController();
const onRunAbort = () => runAbort.abort();
process.once("SIGINT", onRunAbort);
process.once("SIGTERM", onRunAbort);
try {
  const ctx = createWorkflowContext({
    ...resolvedOptions,
    agentProviderFactory: createAgentProvider,
    signal: runAbort.signal,
    eventSink: options.verbose ? writeVerboseWorkflowEvent : undefined,
  });
  // ...
} finally {
  process.off("SIGINT", onRunAbort);
  process.off("SIGTERM", onRunAbort);
}
```

Document: CLI `process.exitCode` remains `1` on aborted failed runs, not `130`. Abort surfaces via existing `ctx.agent` throw (`workflow-context.ts:362-364`) → workflow `exportFailed` / partial meta (no new export behavior).

3. `test/workflow-context.test.ts`: mock provider receives `signal`; abort → `"Agent was aborted"` / `aborted: true`.

**Verify**: `pnpm test -- test/workflow-context.test.ts providers/` → exit 0.

### Step 7: Final gate and index

`pnpm check` → exit 0. Mark plan `done` in `dev/plans/README.md`.

## Test plan

| File | Cases |
|------|-------|
| `lib/agent-invoke.test.ts` | Superset `errorArtifact`; `raceWithTimeout` |
| `lib/review-guard.test.ts` | Post-run unverified preserves success; mutation fails |
| `providers/cursor/cursor-sdk-agent.test.ts` | Full suite; **new** post-run git-failure preserves success; SDK error artifact fields |
| `providers/codex/codex-agent.test.ts` | Git workspaces on all `.run()` tests; guard |
| `test/workflow-context.test.ts` | `signal` forwarded; abort path; factory on bare `createWorkflowContext` |
| `test/agent-provider.test.ts` | Registry import |

## Done criteria

- [x] Shared `review-guard` + `agent-invoke` with tests
- [x] Codex uses guard; all Codex `.run()` tests use git workspace
- [x] Post-run git failure preserves successful Cursor review (`guard: "unverified"`)
- [x] `errorArtifact` preserves Cursor SDK extension fields
- [x] `providers/registry.ts` exists; `lib/agent-provider.ts` deleted; no `lib/` → `providers/` imports
- [x] `bin/harness.ts` passes factory + signal; listeners removed in `finally`
- [x] `pnpm check` exit 0
- [x] `dev/plans/README.md` updated

## STOP conditions

Stop and report if:

- `lib/workflow-context.ts` must statically import `providers/` to compile — revisit Step 5 type split.
- Codex tests fail because workspaces lack git — fix with `createGitWorkspace()`, do not disable guard.
- Cursor tests fail on post-run-failure — update expectations for `guard: "unverified"`, do not revert fix.
- `pnpm check` fails from unrelated parse-plan drift — report conflict.
- Sync test from baseline plan reveals schema drift — **hard gate**: baseline plan must be `done` first (`test/review-output-schema-sync.test.ts` exists).

## Maintenance notes

- Third provider: register in `providers/registry.ts`; use `review-guard` + `agent-invoke`.
- `steps.json` / Inngest: pass same run-scoped `signal`.
- PR review focus: `workspaceStatus.guard` shape, `errorArtifact` superset, `process.off` cleanup, zero `lib/` → `providers/` imports.
- Deferred: shell exit `130`, gitignored-file detection, parse-retry todo.
