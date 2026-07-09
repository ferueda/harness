# Plan 260709-live-factory-implementation: Run one live factory implementer

> **Executor instructions**: Follow this plan step by step. Run every verification
> command and confirm the expected result before moving on. If a STOP condition
> occurs, stop and report instead of improvising.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `dev/plans/FER-47.md` shipped dry-run implementation station shell; FER-32 implementation input resolver shipped.
- **Category**: feature
- **Tracker**: FER-48, `https://linear.app/ferueda/issue/FER-48/run-live-factory-implementation-agent`

## Requirements

Build the first live factory implementation station pass:

- Invoke exactly one configured `factory.implementation.roles.implementer` provider.
- Pass `workspaceGuard: "record"` to the provider so tracked source edits are allowed and recorded.
- For Codex implementation runs, prefer `sandboxMode: "workspace-write"` unless the implementation role explicitly configures another sandbox.
- Capture provider raw output, provider stream log, provider session ref when available, and tracked workspace status before and after the run.
- Write `implementation/diff.patch` for the candidate implementation diff.
- Write `implementation/change-review-handoff.md` with enough context for an operator to pass to `harness run change-review`.
- Materialize a harness-owned review commit/ref so the existing `harness run change-review` scope model can review the implementation with `--base <reviewBase> --head <reviewHead>`.
- Stop after implementation. Do not run `change-review`, create a human branch, open a PR, merge, or mutate Linear.
- Add live implementation lifecycle events:
  - `implementation.started`: audit/correlation only; does not move durable `factoryStage`.
  - `implementation.completed`: set durable `factoryStage: "implementation-complete"`.
  - `implementation.failed`: set durable `factoryStage: "implementation-failed"` and preserve plan/direct retry context.
- Keep `implementation-complete` semantics narrow: candidate implementation changes exist, a harness-owned review ref exists, and the next operator step is change review. It does not mean reviewed, approved, PR-ready, merged, or done.

Hard non-goals for this plan:

- No nested or automatic `change-review` loop.
- No human-facing commit, branch, PR, merge, or worktree orchestration.
- No implementer-agent git operations. The implementer prompt must forbid commit/branch/push; the harness command may create only the internal review ref `refs/harness/factory/<run-id>/implementation`.
- No Linear `--apply` or Linear projection change.
- No Git checkout or verification of `approvedPlanCommit`.
- No large structured implementation-output schema unless an existing consumer needs it.

## Current State

Verified on 2026-07-09 from the current checkout.

- `package.json` uses Node ESM TypeScript with direct `.ts` imports. Commands are `pnpm typecheck`, `pnpm test -- <files>`, `pnpm build`, `pnpm lint`, and final `pnpm check`.
- Current worktree already has unrelated local edits in `harness.json` changing factory Cursor models to `grok-4.5`. Do not edit or revert `harness.json` for this plan.
- `workflows/factory-implementation.workflow.ts:14-30` is dry-run only. It throws `FACTORY_IMPLEMENTATION_DRY_RUN_ERROR` when `ctx.dryRun` is false, renders the implementation prompt plus review handoff, then exports dry-run meta.
- `bin/factory-commands.ts:300-344` rejects live implementation before input resolution. The command only exposes `--dry-run`; it hard-codes `dryRun: true` into `createFactoryImplementationRunContext`.
- `lib/factory-implementation-run-context.ts:20-53` only models `FactoryImplementationRunStatus = "dry_run"` and has no fields for raw provider output, stream log, provider session, workspace status, diff, or error.
- `lib/factory-implementation-run-context.ts:9-11` exports `FACTORY_IMPLEMENTATION_DRY_RUN_ERROR`; delete it when live mode replaces the non-dry-run rejection path.
- `lib/factory-implementation-run-context.ts:103-160` writes `context/work-item.json`, `context/implementation-input.json`, planned/direct context, `implementation/prompt.md`, `implementation/change-review-handoff.md`, `summary.md`, and `meta.json`.
- `lib/factory-implementation-run-context.ts:175-204` currently always emits `status: "dry_run"` in meta.
- `lib/agents.ts:57-69` already supports `workspaceGuard`, `sandboxMode`, `approvalPolicy`, `modelReasoningEffort`, `session`, `maxRuntimeMs`, `logPath`, and `signal` on `AgentRunInput`.
- `lib/review-guard.ts:13-22` reads tracked workspace status with `git status --porcelain=v1 -z -- . :!.harness`. `lib/review-guard.ts:68-70` makes `workspaceGuard: "record"` allow tracked changes while preserving before/after status in raw output.
- `providers/codex/codex-agent.ts:86-158` and `providers/cursor/cursor-sdk-agent.ts` capture workspace status through `withWorkspaceGuard`, write stream logs when `logPath` is provided, and return a `session` ref on successful runs.
- `lib/config.ts:133-165` resolves factory role config. It only defaults Codex planning planner roles to `workspace-write`; Codex implementation roles currently inherit global Codex sandbox config or stay undefined.
- `lib/factory-lifecycle.ts:101-176` has schemas for planning events and plan PR events, but no implementation events.
- `lib/factory-lifecycle.ts:352-375` treats `triage.started` and `planning.started` as audit-only and reduces `planning.failed` to `factoryStage: "planning-failed"`.
- `lib/factory-lifecycle.ts:370-375` uses `withoutPublicationReadyFields` for `planning.failed`; that helper is the wrong pattern for implementation failure because FER-48 requires preserving approved-plan retry metadata.
- `lib/factory-schemas.ts:18-39` includes `implementation-started` and `implementation-complete` in `FACTORY_STAGES`, but does not include `implementation-failed`.
- `lib/factory-lifecycle-writes.ts:140-224` has started and terminal helpers for planning lifecycle events; implementation needs the same pattern.
- `docs/contributing/factory.md:431-476` and `docs/contributing/architecture.md:219-224,331-334` document implementation as dry-run only.
- `skills/factory-operator/SKILL.md` is an operator-facing packaged skill and currently documents implementation as dry-run only, with only `--dry-run` commands and dry-run artifacts.
- `skills/change-review-workflow/references/review-handoff.md` defines the reviewer handoff shape: `## Review Handoff`, a `**Status:**` line, then `### Goal`, `### Scope`, `### Files changed`, `### Implementation notes`, `### Verification`, `### Risks to scrutinize`, and `### Open items`.
- `skills/change-review-workflow/SKILL.md:28` documents the critical review-scope contract: `harness run change-review` reviews `merge-base(base, head)..head`; unstaged, staged-but-uncommitted, and untracked files are excluded unless `head` points at a commit/tree containing them. A live implementation station that leaves only dirty worktree changes cannot hand off directly to today's review workflow.
- `lib/prompts/factory-implementation.ts` currently includes the boundary sentence "This station does not own lifecycle updates." That becomes false for the harness command once live implementation writes lifecycle events.
- `test/factory-implementation-run-context.test.ts` covers dry-run context artifacts and the current non-dry-run rejection.
- `test/factory-implementation-cli.test.ts` covers dry-run CLI behavior and asserts live runs reject before role resolution.
- `test/factory-lifecycle.test.ts` is the right regression suite for event schema/reducer behavior.
- `test/config.test.ts` already covers implementation role config; add Codex implementation default sandbox coverage there.
- `README.md` is currently 275 lines. `test/docs-contracts.test.ts` enforces `README.md` stays at or below 300 lines, so README changes must replace existing implementation text in place instead of adding a long new section.
- `docs/contributing/setup-manifest.md:65-68` currently lists `.harness/factory/events/*.jsonl` producers as triage/planning/publication only, and the factory run-dir row does not mention live implementation provider/lifecycle behavior.

Repo conventions to match:

- Keep provider-specific behavior in provider adapters or role config resolution. Workflows should call `Agent.run` through the generic interface.
- Use Zod discriminated unions and `.strict()` schemas for runtime event contracts.
- Use `satisfies` for typed literal objects in tests and config where it preserves narrow types.
- Write artifacts under the station run dir and keep `.harness/` generated state ignored.
- Dry-run factory station commands must not invoke providers, write run `events.jsonl`, append lifecycle state, or mutate trackers.
- Live factory station commands may write `.harness/runs/factory/<run-id>/`, run `events.jsonl`, and `.harness/factory/events|state`; they must not mutate Linear unless a specific apply path exists.

## Commands You Will Need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Inspect scope | `git status --short` | Shows only expected local changes; pre-existing `M harness.json` may be present but must remain untouched |
| Focused implementation tests | `pnpm test -- test/factory-implementation-run-context.test.ts test/factory-implementation.workflow.test.ts test/factory-implementation-cli.test.ts` | exit 0; live and dry-run implementation tests pass |
| Lifecycle/config tests | `pnpm test -- test/factory-lifecycle.test.ts test/config.test.ts` | exit 0; new lifecycle stages/events and Codex sandbox defaults pass |
| Docs contract tests | `pnpm test -- test/docs-contracts.test.ts` | exit 0 if docs contract expectations were updated or remained valid |
| Dist smoke | `pnpm build && pnpm smoke:dist` | exit 0; implementation help includes new live flags |
| Combined focused gate | `pnpm test -- test/factory-implementation-run-context.test.ts test/factory-implementation.workflow.test.ts test/factory-implementation-cli.test.ts test/factory-lifecycle.test.ts test/config.test.ts test/docs-contracts.test.ts` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0, no TypeScript errors |
| Build | `pnpm build` | exit 0 |
| Final gate | `pnpm check` | exit 0 |

## Skills for the Executor

| Skill/tool | Verified source | Use for |
| --- | --- | --- |
| `implement-plan` | `skills/implement-plan/SKILL.md` | Execute this plan phase by phase and stop on drift. |
| `node` | `.agents/skills/node/SKILL.md` | Keep Node TypeScript type-stripping compatible: `.ts` imports, `import type`, no enums/namespaces. |
| `typescript-refactor` | `.agents/skills/typescript-refactor/SKILL.md` | Model statuses and lifecycle events with discriminated unions, literal types, exhaustive switches, and low-cast narrowing. |
| `zod` | `.agents/skills/zod/SKILL.md` | Extend lifecycle schemas with strict object contracts and `z.infer` types. |
| `vitest` | `.agents/skills/vitest/SKILL.md` | Add isolated regression tests with deterministic temp git workspaces and fake providers. |
| `change-review-workflow` | `.agents/skills/change-review-workflow/SKILL.md` | Use its handoff section model and command shape when rendering `implementation/change-review-handoff.md`; do not run review in this plan. |
| `factory-operator` | `skills/factory-operator/SKILL.md` | Update packaged operator guidance for live vs dry-run implementation behavior and artifacts. |

## Scope

In scope, and expected to change:

- `bin/factory-commands.ts`
- `bin/factory-implementation-cli.ts`
- `lib/config.ts`
- `lib/factory-implementation-run-context.ts`
- `lib/factory-workspace-changes.ts` (new, or another tightly named helper if the executor finds an exact existing fit)
- `lib/factory-review-head.ts` (new, or another tightly named helper if the executor finds an exact existing fit)
- `lib/factory-lifecycle.ts`
- `lib/factory-lifecycle-writes.ts`
- `lib/factory-schemas.ts`
- `lib/prompts/factory-implementation.ts`
- `workflows/factory-implementation.workflow.ts`
- `test/config.test.ts`
- `test/factory-implementation-cli.test.ts`
- `test/factory-implementation-run-context.test.ts`
- `test/factory-implementation.workflow.test.ts` (new)
- `test/factory-lifecycle.test.ts`
- `README.md`
- `docs/contributing/architecture.md`
- `docs/contributing/factory.md`
- `docs/contributing/script-command-surface.md`
- `docs/contributing/setup-manifest.md`
- `skills/factory-operator/SKILL.md`
- `test/docs-contracts.test.ts` only if needed to keep doc contracts aligned
- `scripts/smoke-dist.ts`

Out of scope:

- `harness.json`; it has pre-existing local edits. Do not touch or revert it.
- Any Linear adapter mutation or `--apply` path for implementation.
- Any human-facing commit, branch, PR, merge, worktree, or `approvedPlanCommit` checkout/verification logic.
- Any implementer-agent git operation. Internal harness review ref creation is in scope and must not use the real index or current branch.
- Any provider-specific implementation workflow branch outside generic `Agent.run`.
- Any change-review invocation from the implementation station.
- Any new machine-readable implementation result schema beyond the run `meta.json` and artifacts described here.
- Any inbox batch processing or revival of `harness factory dispatch`.

## Project Intent Constraints

Inline constraints from `docs/project-intent.md` for this workflow-wide change:

- Durable docs must remain generic and standalone. Use `/path/to/repo`, `TEAM-123`, and target-repo wording; do not add private downstream paths or repo-specific examples.
- Current behavior and planned/future behavior must stay clearly separated. After this plan lands, docs and skills should describe live implementation as current behavior; still label retry, Linear projection, and worktree orchestration as future work.
- Provider-specific details belong behind provider adapters. The implementation workflow should remain provider-agnostic and call the generic `Agent.run` interface.
- Generated factory artifacts and lifecycle state belong under target-repo `.harness/`; do not create tracked source artifacts for run outputs.
- Runtime schemas and exported schemas must stay aligned when status or lifecycle contracts change.

## Design

The implementation station remains one command that can run in dry-run or live mode.

Dry-run behavior stays compatible:

- No provider invocation.
- No run `events.jsonl`.
- No `.harness/factory` lifecycle events.
- Same prompt/context artifacts as FER-47, with only additive meta fields if unavoidable.

Live behavior:

1. Resolve the work item and implementation input exactly as dry-run does.
2. Create a run context with `maxRuntimeMs`, `signal`, `eventSink`, and `agentProviderFactory`.
3. Require an empty `git status --porcelain=v1 -z -- . :!.harness` result before invoking the provider. This includes tracked, staged, and untracked paths outside `.harness/`. If the live workspace is already dirty, export `implementation-failed` with a clear error and do not invoke the provider.
4. Snapshot `reviewBase = HEAD` as a full commit SHA before invoking the provider.
5. Append lifecycle `work_item.imported` and `implementation.started` before invoking the provider.
6. Render and write the implementation prompt before provider invocation.
7. Capture tracked workspace porcelain status and patch material before the provider.
8. Invoke the configured implementer provider once with:
   - `workspace: ctx.workspace`
   - `prompt`
   - `model: ctx.implementerAgent.model`
   - Codex policy fields from the resolved role
   - `maxRuntimeMs: ctx.maxRuntimeMs`
   - `logPath: <runDir>/implementation/implementer.stream.jsonl`
   - `workspaceGuard: "record"`
   - `signal: ctx.signal`
9. Capture tracked workspace porcelain status and patch material after the provider.
10. If the provider succeeded and tracked porcelain status changed, materialize a review commit and internal ref using a temporary index:
    - `GIT_INDEX_FILE=<runDir>/tmp/review-index`
    - `git read-tree <reviewBase>`
    - stage the post-run worktree into the temporary index with `git add -A -- . :!.harness`, including edits, additions, deletions, and renames while excluding `.harness/`
    - `git write-tree`
    - `git commit-tree <tree> -p <reviewBase> -m "harness factory implementation <runId>"`
    - `git update-ref refs/harness/factory/<runId>/implementation <reviewCommitSha>`
11. Write provider artifacts:
   - `implementation/implementer.raw.json`
   - `implementation/implementer.stream.jsonl` when the provider emitted it
   - `implementation/workspace-status.json`
   - `implementation/diff.patch`
   - completed `implementation/change-review-handoff.md`
12. If the provider failed, tracked porcelain status did not change, or review ref creation failed, export `status: "implementation-failed"` and append `implementation.failed`.
13. If the provider succeeded, tracked porcelain status changed, and `reviewHead` was created, export `status: "implementation-complete"` and append `implementation.completed`.

Use porcelain status inequality, not plain `git diff` inequality, as the success criterion. `git status --porcelain=v1 -z -- . :!.harness` sees tracked edits, staged edits, and untracked new files; plain `git diff` does not see untracked files.

Build `implementation/diff.patch` from `git diff --binary <reviewBase>..<reviewCommitSha>` after successful review ref creation so it matches exactly what `change-review` will inspect. For failed runs where review ref creation did not happen, build `implementation/diff.patch` from best-effort after-run patch material:

- unstaged tracked changes: `git diff --binary -- . :!.harness`
- staged changes, if any: `git diff --cached --binary -- . :!.harness`
- untracked files reported by porcelain: append `git diff --binary --no-index -- /dev/null <path>` output for each untracked file, treating exit code 1 as expected diff output
- untracked directories reported by porcelain: recursively enumerate regular files under the directory, staying workspace-bound and skipping `.harness/`, then apply the same `--no-index` new-file diff per file
- v1 artifact cap for untracked directory expansion: capture at most 500 regular files or 5 MiB of appended no-index patch text, whichever comes first. If the cap is hit, keep success based on porcelain status, set `patchTruncated: true` in `workspace-status.json`, list skipped counts when known, and put a clear truncation warning in the handoff. Do not let post-run artifact capture stall indefinitely on a runaway generated tree.

If patch material is still empty but porcelain changed, keep `implementation/diff.patch` empty, record a status-derived changed-file list in `implementation/workspace-status.json`, and make the handoff explicitly say that the patch is empty while status changed. V1 requires empty pre-run porcelain status before provider invocation; do not try to subtract pre-existing patches.

Review-head materialization must not use the real index, must not move `HEAD`, must not create or checkout a branch, and must leave the worktree dirty for operator inspection. `git add -A -- . :!.harness` is allowed only with `GIT_INDEX_FILE` pointing at the run-local temporary index. The durable review truth is `reviewCommitSha`; if the worktree drifts after the run, the next review/PR station should consume the recorded review ref rather than the dirty tree.

## Steps

### Step 1: Add lifecycle event and stage support

Modify `lib/factory-schemas.ts`:

- Add `"implementation-failed"` to `FACTORY_STAGES`.
- Keep existing `"implementation-started"` for backward compatibility even though `implementation.started` is audit-only and will not reduce to that durable stage.

Modify `lib/factory-lifecycle.ts`:

- Add strict schemas for:
  - `implementation.started`
  - `implementation.completed`
  - `implementation.failed`
- Suggested event data:
  - `implementation.started.data`: optional `linearIssue`, optional `itemFile`
  - `implementation.completed.data`: `diffPath`, `changeReviewHandoffPath`, `reviewBase`, `reviewHead`, `reviewCommitSha`, optional `rawOutputPath`, optional `streamLogPath`, optional `workspaceStatusPath`, optional `session`
  - `implementation.failed.data`: `error`, optional `summaryPath`, optional `rawOutputPath`, optional `streamLogPath`, optional `workspaceStatusPath`, optional `reviewBase`
- Include all three schemas in `FactoryLifecycleEventSchema`.
- In `reduceFactoryLifecycleEvent`:
  - `implementation.started` returns `base` only, like `planning.started`.
  - `implementation.completed` returns `{ ...base, factoryStage: "implementation-complete", factoryRunId: event.runId }` while preserving existing plan/direct metadata already on `base`.
  - `implementation.failed` returns `{ ...base, factoryStage: "implementation-failed", factoryRunId: event.runId }` while preserving plan/direct retry metadata.
- Anti-pattern: do not copy `planning.failed`'s `withoutPublicationReadyFields(...)` reducer shape for implementation events. `implementation.completed` and `implementation.failed` must spread `base` directly and must not call `withoutPublicationReadyFields`, because retry context such as `approvedPlanPath` and `approvedPlanCommit` must survive failed implementation.

Modify `lib/factory-lifecycle-writes.ts`:

- Add `appendImplementationStartedEvent`, matching `appendPlanningStartedEvent`.
- Add `appendImplementationTerminalEvent`, matching `appendPlanningTerminalEvent`, returning `undefined` for dry-run meta.
- Keep paths relative to `meta.workspace` in lifecycle data where current planning helpers do so.

Add tests in `test/factory-lifecycle.test.ts`:

- `implementation.started` updates `lastEventId` but leaves `factoryStage` unchanged.
- `implementation.completed` moves a planned item from `plan-approved` to `implementation-complete`, preserves `approvedPlanPath` and `approvedPlanCommit`, and records review ref data in lifecycle event data.
- `implementation.failed` moves to `implementation-failed` and preserves approved-plan retry fields.
- `appendImplementationTerminalEvent` emits the expected completed/failed event shape and skips dry-run.

**Verify**: `pnpm test -- test/factory-lifecycle.test.ts` -> exit 0.

### Step 2: Resolve Codex implementation sandbox default

Modify `lib/config.ts`:

- Add a named constant for Codex implementation default sandbox, e.g. `FACTORY_IMPLEMENTATION_CODEX_IMPLEMENTER_SANDBOX = "workspace-write"`.
- In `resolveFactoryRoleAgent`, when `input.station === "implementation"` and `input.role === "implementer"` and the effective agent is `codex`, default `sandboxMode` to `"workspace-write"` unless `roleConfig?.sandboxMode` is set.
- Do not let a global `agents.codex.sandboxMode` silently force implementation live runs into read-only. The issue requires implementation to prefer write access unless the implementation role explicitly opts out.
- Preserve existing planning planner behavior and all Cursor validation.

Add tests in `test/config.test.ts`:

- Codex implementation role with no role-level `sandboxMode` resolves to `workspace-write`, even if global `agents.codex.sandboxMode` is `read-only`.
- Codex implementation role with role-level `sandboxMode: "read-only"` preserves `read-only`.
- Cursor implementation role still rejects Codex-only sandbox fields.

**Verify**: `pnpm test -- test/config.test.ts` -> exit 0.

### Step 3: Extend implementation run context and CLI output

Modify `lib/factory-implementation-run-context.ts`:

- Delete `FACTORY_IMPLEMENTATION_DRY_RUN_ERROR` after removing live rejection callers; do not keep stale dry-run-only exports or tests.
- Change `FactoryImplementationRunStatus` to include:
  - `"dry_run"`
  - `"implementation-complete"`
  - `"implementation-failed"`
- Extend `FactoryImplementationArtifacts` with optional live artifacts:
  - `rawOutput?: "implementation/implementer.raw.json"`
  - `streamLog?: "implementation/implementer.stream.jsonl"`
  - `workspaceStatus?: "implementation/workspace-status.json"`
  - `diff?: "implementation/diff.patch"`
- Extend `FactoryImplementationRunMeta` with optional:
  - `error?: string`
  - `implementerSession?: AgentSessionRef`
  - `eventsFile?: string` for live runs
  - `reviewBase?: string`
  - `reviewHead?: string`
  - `reviewCommitSha?: string`
- Extend context options with:
  - `dryRun: boolean`
  - `implementerRole: FactoryRoleAgent`
  - `maxRuntimeMs: number`
  - `signal?: AbortSignal`
  - `eventSink?: WorkflowEventSink`
  - `agentProviderFactory: (options: AgentProviderOptions) => Agent`
- Require production CLI callers to pass `dryRun: true` or `dryRun: false` explicitly; do not rely on an omitted/undefined value to choose live behavior.
- Fail closed for live context construction: if `dryRun !== true`, missing `maxRuntimeMs` or missing `agentProviderFactory` must throw before provider invocation. Dry-run constructors may omit them for test ergonomics.
- Keep `implementerRole` on `FactoryImplementationRunContext`, not only the display `implementerAgent`, because the workflow needs role policy fields and provider construction.
- Build `eventSink` exactly like planning context:
  - dry-run -> `noopEventSink`
  - live with no verbose sink -> `createFileEventSink(runDir)`
  - live with verbose sink -> `createCompositeEventSink(createFileEventSink(runDir), options.eventSink)`
- Set `meta.eventsFile` for live exports to the run-relative or absolute events path following the existing planning meta convention.
- Add `implementerProvider()` to lazily construct the provider from `agentProviderFactory`, `ctx.implementerRole.agent`, and `ctx.implementerRole.codexPathOverride`.
- Add methods for live artifact writes. One acceptable shape:
  - `writeDryRunArtifacts({ prompt, changeReviewHandoff })` for dry-run only
  - `writePromptArtifact({ prompt })` for live pre-provider prompt writes
  - `writeLiveArtifacts({ raw, workspaceStatus, diff, changeReviewHandoff })`
  - `export({ status, error, implementerSession })`
- Live artifact sequencing is fixed: write only `implementation/prompt.md` before provider invocation; write `implementation/change-review-handoff.md` only after the provider returns or throws and failed meta can be exported. Do not write a dry-run-shaped live handoff before the run. Operators who inspect a still-running live run should see the prompt and stream/raw/status artifacts as they appear, not a final handoff.
- Update dry-run workflow call sites from `ctx.export()` to `ctx.export({ status: "dry_run" })`; `buildMeta` must use the passed status rather than hard-coding `"dry_run"`.
- Preserve the test-only context constructor but update tests to pass required live options.
- Include `implementation/diff.patch`, raw output, stream log, workspace status, and completed handoff in `meta.artifacts` for live runs.
- Include live actions in `summary.md`: provider run status, session ref when present, review base/head/commit, diff path, handoff path, lifecycle event note, and explicit "Reviewer invocation: not run."

Modify `bin/factory-implementation-cli.ts`:

- Include the new status union, live artifacts, `implementerSession`, and `error` in CLI output.
- Keep output additive for dry-run compatibility.

Add or update tests in `test/factory-implementation-run-context.test.ts`:

- Dry-run tests still pass and do not expect lifecycle events or raw/diff artifacts.
- Dry-run workflow calls `export({ status: "dry_run" })` and does not need provider-only options.
- Live context creation without `maxRuntimeMs` or without `agentProviderFactory` throws before provider invocation.
- Live context exposes `implementerRole`; provider invocation uses `implementerRole.sandboxMode`, `implementerRole.approvalPolicy`, and `implementerRole.modelReasoningEffort`, while `implementerAgent` remains display/meta data.
- Live context creates durable `events.jsonl` through its file event sink when the workflow emits events.
- Live context export includes live artifact paths and session ref.
- Summary for live meta says review was not run and points to the diff and handoff artifacts.

**Verify**: `pnpm test -- test/factory-implementation-run-context.test.ts` -> exit 0.

### Step 4: Invoke the live implementer in the workflow

Modify `workflows/factory-implementation.workflow.ts`:

- Keep the dry-run branch behavior compatible.
- Add a live branch that:
  - Emits `run:start` and `run:end` workflow events through `ctx.eventSink`, following the planning workflow pattern.
  - Renders the prompt and writes only `implementation/prompt.md` before provider invocation.
  - Requires empty pre-run porcelain status before provider invocation, excluding `.harness/`; if dirty, export `implementation-failed` without invoking the provider.
  - Records `reviewBase` from `HEAD` before provider invocation.
  - Reads tracked porcelain status and patch material before provider invocation.
  - Calls `ctx.implementerProvider().run(...)` exactly once.
  - Passes `workspaceGuard: "record"`.
  - Passes `logPath: join(ctx.runDir, "implementation/implementer.stream.jsonl")`.
  - Passes `model`, `sandboxMode`, `approvalPolicy`, and `modelReasoningEffort` from `ctx.implementerRole`. `ctx.implementerAgent` is display/meta data only and must not be the source of provider policy fields.
  - Passes `maxRuntimeMs` and `signal`.
  - Reads tracked porcelain status and patch material after provider invocation, even when the provider returns `ok: false`.
  - Creates a harness-owned review commit/ref after provider success and status change, using a temporary index and never the real index.
  - Writes raw provider output using the existing `rawAgentArtifact` pattern from planning/triage.
  - Writes `implementation/workspace-status.json` with at least `before`, `after`, `beforePatchSha256`, `afterPatchSha256`, `changedFiles`, `patchTruncated`, optional truncation counts, and optional `reviewBase` / `reviewHead` / `reviewCommitSha`.
  - Writes `implementation/diff.patch` from `reviewBase..reviewCommitSha` for completed runs, with best-effort after-run patch material only for failed runs where no review ref exists.
  - Renders and writes `implementation/change-review-handoff.md` after the provider returns or after a caught live failure is converted to failed meta.
- Treat terminal states as:
  - Provider `ok: false` -> `implementation-failed`, with `error` from provider result.
  - Provider `ok: true` but after porcelain status equals before porcelain status -> `implementation-failed`, with error `Implementer completed without tracked workspace changes`.
  - Provider `ok: true`, after porcelain status differs from before porcelain status, but review ref creation fails -> `implementation-failed`.
  - Provider `ok: true`, after porcelain status differs from before porcelain status, and review ref creation succeeds -> `implementation-complete`.
- Do not run verification commands from inside the station; record "not run by factory implementation station" in the handoff.
- Do not throw for normal provider failure after artifacts and failed meta are written. Return failed meta so the CLI can print artifact paths, then set exit code in the CLI.

Implement patch/status capture in a small `lib/` helper, not directly inside the workflow orchestration. Preferred file: `lib/factory-workspace-changes.ts`, unless the executor finds an exact existing helper to extend. The workflow should call this helper to get `{ before, after, changedFiles, patch, hashes, truncation }` and remain focused on provider/lifecycle/artifact orchestration. Keep path-safety, porcelain parsing, hashing, and truncation in that one helper; test the helper either through workflow fake-provider cases or focused helper tests if that makes edge cases clearer.

Implement review-head materialization in a separate small `lib/` helper, not directly inside the workflow orchestration. Preferred file: `lib/factory-review-head.ts`. One acceptable API:

```ts
export type FactoryReviewHead = {
  reviewBase: string;
  reviewHead: string;
  reviewCommitSha: string;
  diffPatch: string;
};

export function createFactoryReviewHead(input: {
  workspace: string;
  runDir: string;
  runId: string;
  reviewBase: string;
  changedFiles: string[];
}): FactoryReviewHead;
```

The helper must:

- use the `reviewBase` SHA passed by the workflow; do not re-read `HEAD` during materialization
- create a temporary index under the run dir with `GIT_INDEX_FILE`
- run `git read-tree <reviewBase>`
- stage the post-run worktree into that temporary index with `git add -A -- . :!.harness`; this must capture edits, additions, deletions, and renames while excluding `.harness/`
- create the commit with `git commit-tree`
- update only `refs/harness/factory/<runId>/implementation`
- return `diffPatch` from `git diff --binary <reviewBase>..<reviewCommitSha>`
- set deterministic author/committer identity for `git commit-tree`, e.g. `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, and `GIT_COMMITTER_EMAIL`, so temp repos and CI do not depend on ambient git config
- never call `git add` unless `GIT_INDEX_FILE` points at the run-local temporary index
- never call `git commit`, `git checkout`, or mutate the real index/branch

```ts
execFileSync("git", ["diff", "--binary", "--", ".", ":!.harness"], {
  cwd: workspace,
  encoding: "utf8",
});
execFileSync("git", ["diff", "--cached", "--binary", "--", ".", ":!.harness"], {
  cwd: workspace,
  encoding: "utf8",
});
```

Parse porcelain and derive `changedFiles` deterministically:

- Split the `-z` porcelain output on NUL bytes and ignore the trailing empty record.
- For normal records, read the two-character status prefix, then the path after the following space.
- For rename/copy records (`R` or `C` in either status column), porcelain v1 `-z` includes an extra NUL-framed source path; include the destination path in `changedFiles` and advance past the source record.
- For `??` untracked file records, include the file path.
- For `??` untracked directory records, recursively enumerate regular files under the directory, skip `.harness/`, include each file path, and use those files for no-index patch capture.
- Keep all paths relative to `ctx.workspace`, stable-sorted for JSON/handoff output, and reject or skip any resolved path outside the workspace.
- Hashes are SHA-256 hex digests of the exact concatenated before/after patch material strings.

For untracked files, append `git diff --binary --no-index -- /dev/null <path>` output for each file. `git diff --no-index` exits 1 when it produced a diff; treat that as success and use stdout. For untracked directories, append one no-index patch per enumerated file. Stop appending untracked no-index patch output after 500 files or 5 MiB of appended no-index patch text; set `patchTruncated: true`, keep remaining paths in `changedFiles` when cheap to enumerate, and warn in the handoff. Preserve path safety by resolving each untracked path under `ctx.workspace`; do not follow paths outside the workspace.

If `git status` or patch capture fails after context creation, export `implementation-failed` when possible and include the error in meta; only throw if the run cannot write the required failure artifacts.

Update `lib/prompts/factory-implementation.ts`:

- Keep the prompt boundaries strict: no tracker mutation, no PR creation, no branch/worktree orchestration, no change-review execution.
- Add an explicit Station Boundaries bullet to the implementation prompt: the implementer agent must not run git commit, branch, checkout, push, update-ref, or other ref-mutating git commands. The harness command owns the internal review ref after the provider returns.
- Replace the boundary line `This station does not own lifecycle updates.` with: the implementer agent must not append or mutate lifecycle state; the harness command owns lifecycle writes before/after provider invocation.
- Define an explicit handoff renderer input instead of growing ad hoc optional fields on `FactoryImplementationPromptInput`. One acceptable shape:

```ts
type FactoryImplementationHandoffInput =
  | {
      mode: "dry-run";
      implementationInput: FactoryImplementationInput;
      implementerAgent: FactoryStationAgentMeta;
    }
  | {
      mode: "live";
      status: "implementation-complete" | "implementation-failed";
      implementationInput: FactoryImplementationInput;
      implementerAgent: FactoryStationAgentMeta;
      artifacts: {
        diff: string;
        rawOutput: string;
        workspaceStatus: string;
        changeReviewHandoff: string;
        streamLog?: string;
      };
      changedFiles: string[];
      provider: {
        session?: AgentSessionRef;
        error?: string;
      };
      review?: {
        reviewBase: string;
        reviewHead: string;
        reviewCommitSha: string;
      };
      warnings: {
        dirtyBefore: boolean;
        emptyPatchWithStatusChange: boolean;
        patchTruncated: boolean;
      };
    };
```

- Map handoff status from the discriminant: dry-run -> `**Status:** in_progress`; live complete -> `**Status:** complete`; live failed -> `**Status:** blocked`.
- For live handoff rendering, require `diff`, `rawOutput`, `workspaceStatus`, and `changeReviewHandoff` artifact paths; `streamLog` and `session` are optional because provider support can vary.
- Use one handoff renderer contract for both dry-run and live modes. Always emit:
  - `## Review Handoff`
  - `**Status:** complete` for `implementation-complete`; `**Status:** blocked` for `implementation-failed`; `**Status:** in_progress` for dry-run because no implementation has run yet
  - `### Goal`
  - `### Scope`
  - `### Files changed`
  - `### Implementation notes`
  - `### Verification`
  - `### Risks to scrutinize`
  - `### Open items`
- In dry-run mode, keep placeholder body text inside those `###` sections, for example `_To be filled after implementation._` and `_Not run yet._`; do not emit the old top-level `## Goal` / `## Scope` shape.
- In live mode, populate the same headings with:
  - goal, mode, source/plan context
  - files changed from after status
  - review base/head/commit when available
  - diff artifact path
  - provider/session/raw/stream artifacts
  - verification not run
  - explicit next operator step: run `harness run change-review --base <reviewBase> --head <reviewHead> --handoff-stdin --verbose` separately with this handoff and the internal review ref
  - warning when before-run porcelain status was non-empty for failed best-effort artifact capture; completed v1 runs should start clean
  - warning when `diff.patch` is empty but porcelain status changed
  - warning when patch capture was truncated by the v1 untracked-directory artifact cap

Add workflow/provider tests in a new `test/factory-implementation.workflow.test.ts` (preferred) or similarly named workflow-focused test file. Keep `test/factory-implementation-run-context.test.ts` focused on context construction, export/meta, event sink setup, and artifact API behavior.

Workflow-focused tests should cover:

- Update `expectHandoffModel` so dry-run and live handoffs both assert the single heading contract: `## Review Handoff`, `**Status:**`, `### Goal`, `### Scope`, `### Files changed`, `### Implementation notes`, `### Verification`, `### Risks to scrutinize`, and `### Open items`.
- Update dry-run assertions to expect placeholder bodies under the `###` headings and `**Status:** in_progress`; remove assertions for the old top-level `## Goal` / `## Scope` shape.
- Fake live provider receives `workspaceGuard: "record"` and the expected `logPath`.
- Fake live provider edits a tracked file; workflow writes `implementation/implementer.raw.json`, `implementation/workspace-status.json`, `implementation/diff.patch`, a non-placeholder `implementation/change-review-handoff.md`, `summary.md`, and `meta.json`.
- `diff.patch` is generated from `reviewBase..reviewCommitSha` and includes the tracked edit.
- Meta status is `implementation-complete`; meta includes `implementerSession`, `reviewBase`, `reviewHead`, and `reviewCommitSha`.
- Handoff includes the required review handoff headings, diff artifact, raw artifact, stream log artifact, review command with `--base <reviewBase> --head <reviewHead>`, "Reviewer invocation: not run", and no claim of approval.
- Handoff renderer tests or workflow tests cover the explicit dry-run/live renderer input contract, including required live artifact paths and status mapping.
- Fake live provider only creates a new untracked file; workflow returns `implementation-complete`, `workspace-status.json` lists the new file, and `diff.patch` either contains a no-index new-file patch or the handoff explicitly warns that the patch is empty while status changed.
- Fake live provider creates only an untracked directory containing a file; workflow returns `implementation-complete`, `workspace-status.json` lists the file, and either `diff.patch` includes the new-file patch or the handoff explicitly warns that the patch is empty while status changed.
- Fake provider coverage asserts `workspace-status.json.changedFiles` is stable-sorted and derived from porcelain records, including an untracked directory path expanded to contained files.
- A clean live run creates `refs/harness/factory/<runId>/implementation`; `git diff <reviewBase>..<reviewHead>` matches `implementation/diff.patch`.
- A pre-existing dirty workspace fails before provider invocation and does not create a review ref. Cover both a tracked edit and a pre-existing untracked file.
- A provider that deletes a tracked file completes, creates a review ref, and `git diff <reviewBase>..<reviewHead>` shows the deletion.
- A provider that renames a tracked file completes, creates a review ref, and `changedFiles`, the review ref tree, and `diff.patch` agree on the rename/destination.
- Review-ref creation works in a temp repo with no ambient git user config because the helper sets deterministic commit identity for `commit-tree`.
- Provider success plus review-ref creation failure returns `implementation-failed`.
- A live fake-provider run creates durable `events.jsonl` in the run directory.
- Fake provider returning `ok: false` writes failed meta and raw/status artifacts; meta status is `implementation-failed`.
- Fake provider returning `ok: true` without porcelain status changes becomes `implementation-failed`.

**Verify**: `pnpm test -- test/factory-implementation-run-context.test.ts test/factory-implementation.workflow.test.ts` -> exit 0.

### Step 5: Wire the live CLI and lifecycle writes

Modify `bin/factory-commands.ts`:

- Change `addFactoryImplementationStationCommand(factory)` to `addFactoryImplementationStationCommand(factory, options)`.
- Extend `FactoryImplementationStationOptions` with:
  - `maxRuntimeMs: number`
  - `verbose: boolean`
- Add options to `harness factory implementation run`:
  - `--max-runtime-ms <ms>` using `config.positiveNumber` and `config.defaultMaxRuntimeMs`
  - `--verbose` to emit workflow events to stderr
- Remove the pre-resolution live rejection at `bin/factory-commands.ts:310-312`.
- Delete imports/usages/tests for `FACTORY_IMPLEMENTATION_DRY_RUN_ERROR`; live mode replaces that error path.
- Keep `--dry-run` available and keep dry-run behavior unchanged.
- Resolve the implementer role and implementation input exactly as today.
- Add an `AbortController` with SIGINT/SIGTERM handling, matching planning and triage commands.
- Create the implementation context with:
  - `maxRuntimeMs: options.maxRuntimeMs`
  - `dryRun: options.dryRun`; pass `false` explicitly when the flag is absent
  - `signal: runAbort.signal`
  - `eventSink: options.verbose ? config.writeVerboseWorkflowEvent : undefined`; the context must compose this with its own live file event sink
  - `agentProviderFactory: createAgentProvider`
- For live runs only:
  - append `work_item.imported`
  - append `implementation.started`
  - run the workflow
  - append `implementation.completed` or `implementation.failed` from returned meta
- Extract a testable helper instead of leaving lifecycle terminalization inline in the Commander action. Name suggestion:

```ts
export async function runFactoryImplementationWithLifecycle(input: {
  ctx: FactoryImplementationRunContext;
  issueRef?: string;
  itemFile?: string;
  factoryStateRoot?: string;
  runImplementation?: (
    ctx: FactoryImplementationRunContext,
  ) => Promise<FactoryImplementationRunMeta>;
}): Promise<FactoryImplementationRunMeta> {
  // dry-run: just run implementation; no lifecycle writes
  // live: append imported + started, invoke runner, append terminal
  // live throw after started: export failed meta, append failed terminal, return failed meta
}
```

- Helper behavior:
  - If `ctx.dryRun` is true, call `runImplementation(ctx)` and return the meta. Do not append lifecycle events.
  - If live, append `work_item.imported` and `implementation.started` before invoking `runImplementation`.
  - If `runImplementation` returns meta, append `appendImplementationTerminalEvent({ meta })` and return meta.
  - If `runImplementation` throws after started, call `ctx.export({ status: "implementation-failed", error: errorMessage(error) })`, append `appendImplementationTerminalEvent({ meta: failedMeta, error: errorMessage(error) })`, and return `failedMeta`.
  - Rethrow only if failed meta/artifacts cannot be exported or terminal lifecycle append fails; this means the command cannot honestly report durable terminalization.
  - Accept `factoryStateRoot` only for tests; production should omit it and use the workspace default `.harness/factory`.
- Copy-paste hazard: do not copy `runFactoryPlanningWithLinearApply` throw behavior. Planning exports failed meta and rethrows; implementation must terminalize and return failed meta so the CLI can print JSON artifact paths and set `process.exitCode = 1`.
- The Commander action should own only CLI setup/teardown and output:

```ts
const runAbort = new AbortController();
const onRunAbort = () => runAbort.abort();
process.once("SIGINT", onRunAbort);
process.once("SIGTERM", onRunAbort);
let meta: FactoryImplementationRunMeta | undefined;
try {
  const ctx = createFactoryImplementationRunContext({ ..., dryRun: Boolean(options.dryRun), ... });
  meta = await runFactoryImplementationWithLifecycle({
    ctx,
    issueRef: options.linearIssue,
    itemFile: options.itemFile,
  });
  console.log(JSON.stringify(factoryImplementationCliOutput(meta), null, 2));
  if (meta.status === "implementation-failed") process.exitCode = 1;
} finally {
  process.off("SIGINT", onRunAbort);
  process.off("SIGTERM", onRunAbort);
}
```

After `runFactoryImplementationWithLifecycle` returns failed meta, do not rethrow in the Commander action; rely on printed CLI JSON and `process.exitCode = 1`.
- Do not create any Linear adapter or apply path for implementation.
- Print `factoryImplementationCliOutput(meta)` as JSON.
- Set `process.exitCode = 1` when `meta.status === "implementation-failed"`; leave dry-run and implementation-complete at 0.
- For completed live runs, CLI JSON must include `reviewBase`, `reviewHead`, and `reviewCommitSha` so a future review station or operator can invoke `harness run change-review` without parsing comments or handoff prose.

Add CLI tests in `test/factory-implementation-cli.test.ts`:

- Update the existing "requires dry-run before role resolution" test; live no longer rejects immediately. Replace it with a test that invalid input still fails with the existing "one of --item-file or --linear-issue is required" validation or missing item-file error.
- Keep dry-run tests asserting no `.harness/factory`.
- Add a CLI-level test with an injected/fake provider only if the current command design allows injection. If not, keep live provider invocation covered in workflow tests and add CLI tests for option parsing/help:
  - `--max-runtime-ms` appears in help.
  - `--verbose` appears in help.
  - Dry-run still succeeds without provider credentials.
- Add focused unit tests for `runFactoryImplementationWithLifecycle` with a fake runner and temp lifecycle root:
  - dry-run does not append lifecycle events
  - live success appends `work_item.imported`, `implementation.started`, and `implementation.completed`
  - live success includes review ref fields in terminal lifecycle event data
  - live returned failed meta appends `implementation.failed`
  - live runner throw after started exports failed meta, appends `implementation.failed`, returns failed meta, and does not rethrow
  - helper rethrows when failed meta export or terminal lifecycle append cannot be written

**Verify**: `pnpm test -- test/factory-implementation-cli.test.ts test/factory-implementation-run-context.test.ts` -> exit 0.

### Step 6: Update docs and command surface

Update `README.md`:

- Keep README under the existing docs contract limit of 300 lines. It is currently 275 lines, so replace the existing dry-run-only implementation paragraph in place instead of adding a new long section.
- Keep live implementation examples to one or two lines maximum; push detail to `docs/contributing/factory.md` and `skills/factory-operator/SKILL.md`.
- Change implementation wording from "currently dry-run only" to:
  - dry-run prepares artifacts without provider invocation
  - live runs one implementer, writes candidate workspace changes/artifacts, and creates an internal review ref
  - review remains a separate operator-run `change-review` step
  - no Linear mutation, PR, human branch, merge, or human-facing commit is performed by implementation.
- Add concise live command examples without `--dry-run`, reusing or replacing nearby dry-run examples rather than growing the README.

Update `docs/contributing/factory.md`:

- In the implementation station section, document dry-run and live modes separately.
- Document live artifact layout:

```text
.harness/runs/factory/<run-id>/
  context/
    work-item.json
    implementation-input.json
    plan-ref.json | source-material.json
  implementation/
    prompt.md
    implementer.raw.json
    implementer.stream.jsonl
    workspace-status.json
    diff.patch
    change-review-handoff.md
  events.jsonl
  summary.md
  meta.json
```

- Document lifecycle semantics for `implementation.started`, `implementation.completed`, and `implementation.failed`.
- Document review-ref semantics:
  - `reviewBase` is the `HEAD` commit captured before the implementer runs
  - `reviewHead` is `refs/harness/factory/<run-id>/implementation`
  - `reviewCommitSha` is the internal commit object behind that ref
  - `implementation-complete` requires the review ref to exist
  - the ref is not a human-facing branch/PR commit and should be treated as factory infrastructure
- Update the stale lifecycle paragraph currently listing only `triage.started` and `planning.started` as audit-only and triage/planning/plan_pr terminal events as durable transitions. It must say `implementation.started` is audit-only, and `implementation.completed` / `implementation.failed` own durable implementation stage moves.
- Keep Linear projection coarse: no implementation Linear apply status in this issue.
- State that `implementation-complete` means candidate changes and a review ref exist and need review, not approval.

Update `docs/contributing/architecture.md`:

- Change implementation workflow text from "dry-run only" to "dry-run or one live provider pass plus internal review ref materialization".
- Document lifecycle and artifact ownership.

Update `docs/contributing/script-command-surface.md`:

- Update factory artifact writing row so live implementation invokes a provider, creates an internal review ref, and writes lifecycle state, while dry-run does not.
- Keep the no Linear mutation boundary explicit.

Update `docs/contributing/setup-manifest.md`:

- Add live `harness factory implementation run` to the `.harness/factory/events/*.jsonl` producer list.
- Ensure `.harness/factory/state/*.json` remains described as the rebuildable read model derived from lifecycle events, now including implementation events.
- Update the `.harness/runs/factory/<run-id>/` row so dry-run factory commands do not invoke providers or write lifecycle/run events, while live implementation invokes one provider, creates `refs/harness/factory/<run-id>/implementation`, and writes run `events.jsonl` plus lifecycle state.

Update `skills/factory-operator/SKILL.md`:

- Add live implementation commands without `--dry-run`.
- Keep dry-run examples and explain that dry-run prepares artifacts without provider invocation.
- Document live implementation artifacts, lifecycle semantics, and the exact boundary: no Linear mutation, no review run, no PR/human branch/human commit/worktree automation.
- State that the next operator step after `implementation-complete` is a separate `harness run change-review` run using the recorded `reviewBase` and `reviewHead`.

Update `test/docs-contracts.test.ts` if any explicit doc contract strings need to change. The existing README length assertion is part of the contract; do not weaken it.

Update `scripts/smoke-dist.ts`:

- Extend implementation help assertions to include `--max-runtime-ms`.
- Extend implementation help assertions to include `--verbose`.

**Verify**: `pnpm test -- test/docs-contracts.test.ts && pnpm build && pnpm smoke:dist` -> exit 0, including the `README.md should stay a concise user entrypoint` assertion.

### Step 7: Run focused and full gates

Run focused checks:

```bash
pnpm test -- test/factory-implementation-run-context.test.ts test/factory-implementation.workflow.test.ts test/factory-implementation-cli.test.ts test/factory-lifecycle.test.ts test/config.test.ts test/docs-contracts.test.ts
pnpm typecheck
pnpm build
pnpm smoke:dist
```

Expected: all exit 0.

Run final gate:

```bash
pnpm check
```

Expected: exit 0.

Before handoff, inspect:

```bash
git status --short
git diff -- bin/factory-commands.ts bin/factory-implementation-cli.ts lib/config.ts lib/factory-implementation-run-context.ts lib/factory-workspace-changes.ts lib/factory-review-head.ts lib/factory-lifecycle.ts lib/factory-lifecycle-writes.ts lib/factory-schemas.ts lib/prompts/factory-implementation.ts workflows/factory-implementation.workflow.ts test/config.test.ts test/factory-implementation-cli.test.ts test/factory-implementation-run-context.test.ts test/factory-implementation.workflow.test.ts test/factory-lifecycle.test.ts README.md docs/contributing/architecture.md docs/contributing/factory.md docs/contributing/script-command-surface.md docs/contributing/setup-manifest.md skills/factory-operator/SKILL.md test/docs-contracts.test.ts scripts/smoke-dist.ts
```

Expected:

- Only in-scope files changed by this plan, plus the pre-existing `harness.json` local edit if still present.
- No implementation-generated `.harness/` artifacts staged or committed.
- No Linear/GitHub/worktree automation added.

## Test Plan

Required new or updated coverage:

- `test/factory-lifecycle.test.ts`
  - implementation started is audit-only
  - implementation completed sets `implementation-complete`
  - implementation failed sets `implementation-failed`
  - plan/direct retry metadata is preserved
  - lifecycle write helpers emit valid events
- `test/config.test.ts`
  - Codex implementation role defaults to `workspace-write`
  - role-level sandbox override wins
  - Cursor implementation roles still reject Codex-only fields
- `test/factory-implementation-run-context.test.ts`
  - dry-run compatibility
  - dry-run and live handoffs share the same `## Review Handoff` / `**Status:**` / `###` heading contract
  - context construction, event-sink setup, export/meta, and artifact API behavior only
- `test/factory-implementation.workflow.test.ts`
  - live run fails before provider invocation when pre-run porcelain status is non-empty
  - live provider invocation uses `workspaceGuard: "record"`
  - raw/stream/session/status/diff/handoff artifacts are written
  - complete status requires actual porcelain status change and successful review ref creation
  - a provider that only creates a new untracked file still completes and records the new file
  - a provider that only creates an untracked directory with a file still completes and records the file
  - internal review ref is created with a temporary index and `git diff <reviewBase>..<reviewHead>` matches `implementation/diff.patch`
  - review ref creation failure maps to `implementation-failed`
  - live runs write durable `events.jsonl`
  - provider failure writes failed meta/artifacts
- `test/factory-implementation-run-context.test.ts` should still cover missing live `maxRuntimeMs` or `agentProviderFactory` failing before provider invocation
- `test/factory-implementation-cli.test.ts`
  - live no longer rejects only because `--dry-run` is absent
  - dry-run still succeeds without lifecycle state
  - help includes live options
  - `runFactoryImplementationWithLifecycle` covers imported/started/terminal lifecycle writes for dry-run, live success, live failed meta, and live runner throw after started
  - Commander action prints returned failed meta and sets exit code 1 without rethrowing after helper-terminalized failures
- `scripts/smoke-dist.ts`
  - implementation run help includes `--max-runtime-ms` and `--verbose`
- `test/docs-contracts.test.ts`
  - updated only when docs contract strings need alignment
  - README remains at or below 300 lines after live implementation wording changes

Use temp git workspaces in workflow tests. Initialize a repo, commit a tracked file, then cover a tracked edit, an untracked new file, and an untracked directory containing a file. Assert success from porcelain status changes, not only from `git diff --binary -- . :!.harness`.

Use pre-existing dirty tracked and untracked fixtures to prove the live implementation station fails closed before provider invocation. This v1 intentionally does not subtract baseline dirt.

## Done Criteria

All must hold:

- [ ] `harness factory implementation run --dry-run` still writes only dry-run context/prompt/handoff/summary/meta artifacts and no lifecycle state.
- [ ] Dry-run and live handoffs use one heading contract: `## Review Handoff`, `**Status:**`, and `### Goal` / `### Scope` / `### Files changed` / `### Implementation notes` / `### Verification` / `### Risks to scrutinize` / `### Open items`.
- [ ] Dry-run handoff uses `**Status:** in_progress` and retains placeholder body text under the shared headings.
- [ ] Live implementation invokes exactly one configured implementer provider.
- [ ] Provider input includes `workspaceGuard: "record"`.
- [ ] Provider input takes `model`, `sandboxMode`, `approvalPolicy`, and `modelReasoningEffort` from `ctx.implementerRole`.
- [ ] Codex implementation roles default to `sandboxMode: "workspace-write"` unless role config explicitly overrides it.
- [ ] `FACTORY_IMPLEMENTATION_DRY_RUN_ERROR` and the old non-dry-run rejection test are gone or replaced with live fail-closed tests.
- [ ] Live run writes `implementation/implementer.raw.json`, `implementation/implementer.stream.jsonl` when emitted, `implementation/workspace-status.json`, `implementation/diff.patch`, and completed `implementation/change-review-handoff.md`.
- [ ] Live run writes durable run `events.jsonl`, and `meta.eventsFile` points to it.
- [ ] Live run fails before provider invocation when `git status --porcelain=v1 -z -- . :!.harness` is non-empty before start.
- [ ] Live successful run with tracked changes creates `refs/harness/factory/<run-id>/implementation`, returns/prints `status: "implementation-complete"`, includes `reviewBase` / `reviewHead` / `reviewCommitSha`, and appends lifecycle `implementation.completed`.
- [ ] Live successful run that only creates a new untracked file returns/prints `status: "implementation-complete"`, creates a review ref, and records that file in status/handoff artifacts.
- [ ] Live successful run that only creates a new untracked directory with a file returns/prints `status: "implementation-complete"`, creates a review ref, and records that file in status/handoff artifacts.
- [ ] `implementation/diff.patch` for completed runs is generated from `reviewBase..reviewCommitSha`.
- [ ] Review-ref tests cover tracked edit, untracked file, untracked directory, tracked deletion, and tracked rename.
- [ ] Review-ref creation uses a temporary index and deterministic commit-tree identity.
- [ ] Live provider failure or no tracked porcelain status change returns/prints `status: "implementation-failed"` and appends lifecycle `implementation.failed`.
- [ ] Provider success plus review ref creation failure returns/prints `status: "implementation-failed"` and appends lifecycle `implementation.failed`.
- [ ] `runFactoryImplementationWithLifecycle` unit tests prove a live workflow throw after `implementation.started` exports failed meta when possible, appends terminal `implementation.failed`, returns failed meta, and does not rethrow after durable terminalization.
- [ ] `workspace-status.json.changedFiles` is parsed from NUL-framed porcelain, stable-sorted, expands untracked directories to files, and records `patchTruncated` when the v1 untracked patch cap is hit.
- [ ] Handoff rendering uses the explicit dry-run/live input contract and maps dry-run to `in_progress`, complete to `complete`, and failed to `blocked`.
- [ ] `implementation.started` lifecycle event does not move durable `factoryStage`.
- [ ] Implementation prompt boundaries say the implementer agent must not append lifecycle state; the harness command owns lifecycle writes.
- [ ] No command runs change-review, mutates Linear, creates a human-facing commit/branch/PR/worktree, or verifies/checks out `approvedPlanCommit`.
- [ ] The implementer prompt forbids agent-owned git operations; the only git ref created by the station is the harness-owned `refs/harness/factory/<run-id>/implementation`.
- [ ] Docs distinguish dry-run from live behavior and preserve generic target-repo examples.
- [ ] README changes replace existing implementation text in place, keep README at or below 300 lines, and leave detailed live behavior in contributor docs/operator skill.
- [ ] `docs/contributing/setup-manifest.md` lists live implementation as a lifecycle producer and distinguishes dry-run from live run-dir behavior.
- [ ] `docs/contributing/factory.md` lifecycle event paragraph includes `implementation.started` as audit-only and `implementation.completed` / `implementation.failed` as durable transitions.
- [ ] `skills/factory-operator/SKILL.md` distinguishes dry-run from live behavior and no longer says implementation is dry-run only.
- [ ] `scripts/smoke-dist.ts` checks implementation help for `--max-runtime-ms` and `--verbose`.
- [ ] Focused test command exits 0.
- [ ] `pnpm typecheck` exits 0.
- [ ] `pnpm build` exits 0.
- [ ] `pnpm check` exits 0.

## STOP Conditions

Stop and report if:

- Current code no longer has the dry-run guard in `workflows/factory-implementation.workflow.ts` or `bin/factory-commands.ts`; this plan's baseline has drifted.
- `Agent.run` no longer supports `workspaceGuard`, `logPath`, `signal`, or `maxRuntimeMs`.
- Provider adapters do not honor `workspaceGuard: "record"` after focused tests are written.
- Implementing live mode appears to require human-facing commits, branches, worktree orchestration, PR creation, or Linear mutation.
- Implementing live mode appears to require the implementer agent to run git commit/branch/push commands.
- The harness-owned review ref cannot be created without mutating the real index, moving `HEAD`, checking out a branch, or creating a human-facing branch.
- Implementing patch capture requires subtracting dirty pre-run patches rather than failing closed when pre-run porcelain status is non-empty.
- Patch/status capture cannot be isolated in a small `lib/` helper without making the workflow substantially more complex.
- The context cannot be made to create durable live `events.jsonl` with the same file/composite sink pattern as planning.
- `runFactoryImplementationWithLifecycle` cannot be made to unit-test live throw-after-started terminalization without broad CLI architecture changes.
- A live workflow throw after `implementation.started` cannot produce failed meta and terminal lifecycle state with the existing context shape.
- The shared handoff renderer cannot preserve dry-run placeholders while emitting the `change-review-workflow` heading contract.
- The handoff renderer cannot be given an explicit dry-run/live TypeScript input without broad prompt API churn outside the in-scope files.
- Live context cannot keep `implementerRole` available for provider policy fields without broad type churn outside the in-scope files.
- README live implementation docs cannot fit under the existing 300-line contract without deleting unrelated README content.
- Implementation lifecycle reducer changes appear to require stripping `approvedPlanPath` or `approvedPlanCommit` on `implementation.failed`.
- A review or test requires adding a structured implementation-output schema beyond run meta/artifacts.
- A step requires editing `harness.json`; it has unrelated pre-existing changes.
- Focused verification fails twice after reasonable local fixes.

## Maintenance Notes

- FER-30 owns worktree orchestration; do not let this station grow that responsibility.
- Future retry from `implementation-failed` should use preserved lifecycle metadata and run artifacts; this plan only creates the state needed for that future input resolver work.
- Future Linear projection should stay coarse. Review-running belongs under "Implementing"; visible "Implementation Failed" should wait for a separate projection design.
- Reviewers should scrutinize the boundary between candidate changes and approval. Any text that implies `implementation-complete` is reviewed or PR-ready is wrong.
- Reviewers should also scrutinize dirty-workspace and untracked-file behavior. V1 fails closed when pre-run porcelain status is non-empty before live provider invocation; it does not compute a clean patch delta from pre-existing changes.
- Reviewers should verify the internal review ref is built with a temporary index and that `implementation/diff.patch` matches the review scope passed to `change-review`.
