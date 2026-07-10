# Plan FER-52: Add fail-closed Linear projection to factory implementation

> **Executor instructions**: Follow this plan in order. Run every verification
> command and confirm the expected result before continuing. Stop and report if
> any STOP condition occurs; do not improvise.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: none; planning apply, durable lifecycle state, and the live implementation station are shipped
- **Category**: feature, factory, tracker integration
- **Issue**: FER-52

## Why this matters

The implementation station already creates durable candidate-change evidence,
an internal review ref, and authoritative lifecycle events, but it cannot
project active or failed implementation work to Linear. This change adds an
explicit, constrained `--apply` path: eligible work moves to `Implementing`, a
local success leaves it there with a review handoff marker, and a local failure
moves it to `Implementation Failed` with retry guidance. Durable lifecycle
state remains machine truth; Linear remains a coarse, fail-closed human guard.

## Requirements

- Add `harness factory implementation run --linear-issue TEAM-123 --apply`.
- `--apply` requires `--linear-issue` and rejects `--item-file` and `--dry-run`.
  Validate these combinations before role, config, credential, or file
  resolution so usage errors win.
- Add required non-empty `factory.linear.statuses` mappings:
  - `implementing`: `Implementing`
  - `implementationFailed`: `Implementation Failed`
- Keep `done`, `canceled`, and `duplicate` optional. Add no Done, review, PR, or
  merge projection.
- Treat the two new required keys as a manual target-config migration. Missing
  keys must produce actionable config guidance: create/confirm both team states,
  add both mappings to `harness.json`, then rerun. Do not infer names, create
  Linear states, or mutate target configuration.
- Before every Linear mutation, validate the configured status map, issue
  existence, team, and configured project scope. The apply-start path must
  re-fetch and revalidate immediately before mutation.
- Applied entry policy is conditional:

  | Durable/factory attempt | Required metadata | Only allowed Linear status |
  | --- | --- | --- |
  | First planned run | `factoryStage: plan-approved` plus valid approved-plan handoff | `Ready to Implement` |
  | First direct run | `factoryStage: ready-to-implement`, route `ready-to-implement`, next action `implement-directly` | `Ready to Implement` |
  | Planned retry | `factoryStage: implementation-failed` plus preserved valid approved-plan handoff | `Implementation Failed` |
  | Direct retry | `factoryStage: implementation-failed` plus preserved direct route/action markers | `Implementation Failed` |

- Lifecycle/factory metadata determine readiness. Linear is the human-visible
  consistency guard. Fail closed on every status/lifecycle disagreement.
- Never accept `Implementing` as a start state. Active resume/recovery is a
  future explicit command.
- Every live implementation command, applied or not, must acquire one
  implementation-specific execution lease for the canonical work-item key,
  reload lifecycle state after acquisition, and rerun readiness before context
  creation, lifecycle writes, Linear mutation, or provider invocation. For
  Linear-backed input, re-fetch and merge the issue after acquisition before
  that readiness check; a status observed before waiting for the lease is never
  sufficient. Dry-run remains lease-free.
- The execution lease must fail fast on contention and remain held through
  local terminalization and terminal Linear handling. It is distinct from the
  short lifecycle projection lock; never hold that short lock across network or
  provider work.
- Execution leases use an unbounded age policy both when acquired and when
  displayed by `harness factory status`. Same-host dead owners remain stale and
  recoverable; live same-host, remote, incomplete, and invalid owners fail
  closed. A healthy execution lease older than 30 minutes must not be labeled
  stale.
- Before provider invocation in applied mode, require the status update to
  return `success: true`, immediately re-fetch the issue by immutable id, and
  assert its exact normalized state is `Implementing`. A thrown rejection,
  resolved `{ success: false }`, missing state, stale Ready/Failed state, or any
  other post-update state prevents provider invocation.
- Terminal projection starts only from exact `Implementing`. On local
  `implementation-complete`, re-fetch and verify the issue remains
  `Implementing`, perform no repairing status write, and post at most one marker
  containing the durable run directory, `reviewBase`, `reviewHead`,
  `reviewCommitSha`, and
  `harness run change-review --base <reviewBase> --head <reviewHead>`.
- On local `implementation-failed`, require current `Implementing`, move to
  `Implementation Failed`, require `success: true`, immediately re-fetch and
  verify exact `Implementation Failed`, then post at most one marker containing
  the durable run directory, error, and retry guidance using
  `harness factory implementation run --linear-issue TEAM-123 --apply`.
- Terminal Ready, Implementation Failed, missing, or any other externally
  drifted state is a terminal apply error: do not mutate status or comment.
  Complete replay is marker-idempotent while the issue remains Implementing;
  failed-terminal replay from Implementation Failed is deliberately rejected.
- Confirm `success: true` for every status/comment mutation. A resolved
  `{ success: false }` from a terminal status or comment mutation is a terminal
  apply error, not success.
- Marker dedupe remains run-id based and bounded by the adapter's recent-comment
  fetch. Do not add pagination or a new idempotency store.
- Append local terminal lifecycle state before terminal Linear projection. If
  terminal apply fails, preserve and print the completed local output, then
  exit non-zero with the terminal apply error.
- A start-apply failure after context/imported/started creation writes durable
  failed meta and summary, records no provider artifacts and no terminal
  lifecycle event, performs no terminal Linear apply, prints the local output,
  then exits non-zero with the start error. Because `implementation.started` is
  audit-only, lifecycle readiness remains at the original first/retry entry.
- Keep `implementation.started` audit-only and preserve existing completed/
  failed lifecycle event and exported schema contracts.
- Generated evidence must be truthful: the implementer/provider never owns
  tracker mutation; the Harness command owns requested projection. Applied
  summaries record that apply was requested without claiming terminal apply
  succeeded. No-apply summary, prompt, persisted context/meta, and CLI output
  retain their existing shape and no-apply wording.
- Preserve all other no-apply behavior: Linear-backed first runs accept only
  `Ready to Implement`; item-file and dry-run rules, provider workflow, review
  ref creation, lifecycle ordering, and exit semantics remain unchanged.
- Preserve the exported
  `runFactoryImplementationWithLifecycle(...): Promise<FactoryImplementationRunMeta>`
  compatibility wrapper. Add a distinct apply-aware orchestration result with
  `meta`, optional `linearUpdate`, `startApplyError`, and `terminalApplyError`;
  do not make existing no-apply callers infer a changed return shape.
- Update contributor docs and `skills/factory-operator/SKILL.md` with the board
  model `Ready to Implement -> Implementing <-> Implementation Failed`.

## Current state

Verified at `HEAD` `8280a26` on 2026-07-10. The worktree is clean. Baseline
verification passed:

```text
pnpm exec vitest run test/config.test.ts test/factory-implementation-input.test.ts test/factory-implementation-cli.test.ts test/factory-implementation-run-context.test.ts test/factory-linear-adapter.test.ts test/factory-store.test.ts test/docs-contracts.test.ts
Test Files 7 passed (7); Tests 187 passed (187)
```

- `lib/schemas.ts:29-46` has a strict Linear status object with
  `readyToImplement`, but no implementation projection keys. `lib/config.ts`
  parses the full config before returning command settings, so required keys are
  intentionally a repository-wide config migration; current Zod formatting is
  not actionable for this migration.
- `bin/factory-commands.ts:524-625` exposes implementation `run` without
  `--apply`. It resolves lifecycle-enriched input once, creates a context, and
  then invokes `runFactoryImplementationWithLifecycle`; no lease closes the
  read-to-context race.
- `lib/factory-implementation-input.ts:42-137` checks Linear Ready before
  planned/direct classification. Planned validation requires `plan-approved`;
  direct validation requires `ready-to-implement`. It cannot classify a
  preserved `implementation-failed` retry.
- `lib/factory-planning-handoff.ts:221-244` combines the `plan-approved` stage
  gate with reusable plan path/commit/file checks. Retry needs only the latter,
  without weakening the existing public gate.
- `lib/factory-triage-input.ts:83-134` fetches Linear and then merges canonical
  lifecycle state. `lib/factory-lifecycle.ts` preserves tracker fields such as
  `linearStatus` while lifecycle state replaces factory stage/route/plan fields.
- `lib/factory-lifecycle.ts` keeps `implementation.started` audit-only and
  terminal events preserve route/approved-plan provenance while changing stage
  to complete/failed. Existing lifecycle tests cover this contract.
- `lib/factory-locks.ts:87-166` applies the same default 30-minute age threshold
  to every inspected filename. `lib/factory-status.ts:49` calls that generic
  inspection without a lease policy, so a live execution lease would appear
  stale at the default provider timeout. Dead-owner liveness and remote/
  incomplete/invalid classifications already exist.
- `lib/factory-linear-types.ts:14-21` types `updateIssue` and `createComment`
  results as `unknown`. `lib/factory-linear-adapter.ts:585-593` and all comment
  sites await but discard mutation payloads. In contrast,
  `lib/factory-linear-create.ts:58-67` explicitly rejects `success: false`.
  Even a checked `{ success: true }` payload contains no resulting issue state,
  so it cannot prove a requested transition reached `Implementing` or
  `Implementation Failed`; an explicit fresh issue/state read is required.
- `lib/factory-linear-adapter.ts:457-510` validates status map and issue scope
  during fetch. Its bootstrap mapper has no `Implementing` or
  `Implementation Failed` fallback. `lib/factory-linear-planning-apply.ts` is
  the adapter convention for status/scope revalidation, target resolution, and
  marker dedupe.
- `lib/factory-implementation-run-context.ts:442` always writes
  `- Linear mutation: not run.`. `lib/prompts/factory-implementation.ts:64`
  says the station does not own tracker mutation. Applied runs would therefore
  create misleading durable summaries and provider instructions.
- `lib/factory-implementation-run-context.ts:179-198` creates context files, but
  the workflow does not write `implementation/prompt.md` until provider workflow
  entry. Its artifact manifest currently always advertises prompt/handoff paths.
  A start-apply failure therefore needs an explicit pre-provider export shape;
  otherwise it would advertise files that were never written.
- `runFactoryImplementationWithLifecycle` at
  `bin/factory-commands.ts:628-698` currently returns only
  `FactoryImplementationRunMeta`. It appends imported/started before calling the
  workflow and terminalizes only workflow outcomes. The planning exemplar at
  `bin/factory-commands.ts:836-933` returns `{ meta, linearUpdate,
  terminalApplyError }`; implementation needs a named apply-aware wrapper while
  preserving the current no-apply helper contract used throughout
  `test/factory-implementation-cli.test.ts`.
- `bin/factory-implementation-cli.ts` has no optional Linear result fields.
  Planning/triage CLI output uses optional `linearApplied` and `linearUpdate`
  fields; absent options are omitted.
- `README.md`, `docs/contributing/architecture.md`, and the packaged operator
  skill describe implementation as never mutating Linear. README is 292 lines;
  `test/docs-contracts.test.ts:567-572` enforces a 300-line maximum.
- The previous review observed this unrelated ambient `harness.json` hunk:

  ```diff
  @@ -17,8 +17,8 @@
         "roles": {
           "triager": {
             "agent": "codex",
  -          "model": "gpt-5.6-terra",
  -          "modelReasoningEffort": "medium"
  +          "model": "gpt-5.6-luna",
  +          "modelReasoningEffort": "high"
           }
         }
  ```

  That unrelated change is now committed at `HEAD` by `8280a26`. Treat
  `gpt-5.6-luna`/`high` as protected baseline: do not revert, rewrite, or include
  those model lines in the FER-52 review diff. `harness.json` is also an FER-52
  target for status mappings, so path-only review isolation is insufficient.

## Design decisions

### Config and bootstrap

Keep both new keys required in the strict schema because team workflow names
cannot be safely inferred. Add a narrow config-error formatter that recognizes
missing implementation keys in an otherwise legacy-shaped Linear status map,
lists every missing JSON path, and gives the manual upgrade sequence. Preserve
ordinary Zod errors for all other invalid input.

Bootstrap mapping is display/fallback only:

- `Ready to Implement` -> `ready-to-implement` (existing)
- `Implementing` -> `implementation-started`
- `Implementation Failed` -> `implementation-failed`

Lifecycle overlay still wins. Mapping `Implementing` must never make the run
eligible.

### Attempt-aware readiness

Replace `linearReadyStatus` with an explicit projection input:

```ts
type FactoryImplementationLinearProjection = {
  mode: "observe" | "apply";
  readyToImplement: string;
  implementationFailed: string;
};
```

Classify lifecycle attempt and mode first, then check the one matching Linear
status. `observe` preserves first-run-only behavior. `apply` permits retries
only with `implementation-failed` plus independently valid planned/direct
provenance. Export a helper deriving `"first" | "retry"` from a validated input;
do not persist an attempt field in existing implementation-input artifacts.

Extract stage-independent approved-plan artifact validation and have existing
`validatePlannedWorkHandoff` delegate after retaining its `plan-approved` gate.
The retry path calls the extracted helper only after proving the failed stage.

### Execution lease and status inspection

Add `lib/factory-implementation-policy.ts` with:

- a stable `.implementation-execution` filename suffix/predicate;
- awaited `withFactoryImplementationExecutionLease` using existing acquire/
  release primitives, `timeoutMs: 0`, and `staleAfterMs: Infinity`;
- fresh lifecycle reload and readiness classification inside the lease, with a
  new Linear fetch/merge for Linear-backed work before classification.

Add a generic per-filename stale-threshold resolver to lock inspection rather
than hard-coding station behavior into the lock parser. `factoryStatus` supplies
the implementation lease policy: `Infinity` for matching execution-lease
filenames, current 30-minute behavior for lifecycle locks. PID death remains an
independent stale condition, so same-host dead leases stay stale. Remote,
missing, invalid, and live same-host execution leases remain non-stale/fail
closed regardless of age.

### Linear mutation contracts and adapter

Model the SDK mutation payload as `{ success: boolean }` for `updateIssue` and
`createComment`. Add one shared assertion matching the create path and route all
status/comment writes through checked helpers. This is a correctness fix for
existing triage/planning writes as well as the new implementation path; do not
leave unchecked direct calls.

Add `lib/factory-linear-implementation-apply.ts` with typed start/completed/
failed inputs and output. Mirror planning dependency injection. The facade
remains the only production constructor and exposes:

- `applyImplementationStarted({ issueRef, runId, runDir, attempt })`
- `applyImplementationCompleted({ issueRef, runId, runDir, reviewBase, reviewHead, reviewCommitSha })`
- `applyImplementationFailed({ issueRef, runId, runDir, error })`

Start accepts exactly Ready for `first` and Failed for `retry`; `Implementing`
is not idempotent start. After the checked update, re-fetch by the original
issue's immutable `id` (not by reusing the possibly cached issue object),
revalidate identifier/team/project scope, resolve the fresh state, and require
exact normalized `Implementing`. Return the started update record only after
that verification. `success: true` with Ready, Failed, missing, or another
fresh state is a start failure and no provider may run.

Terminal methods use a stricter transition table:

| Local terminal result | Required freshly fetched entry state | Mutation | Required postcondition |
| --- | --- | --- | --- |
| `implementation-complete` | exact `Implementing` | none | a second fresh scope/state check is still exact `Implementing` before comment |
| `implementation-failed` | exact `Implementing` | checked update to `Implementation Failed` | fresh scope/state check is exact `Implementation Failed` before comment |

Any Ready, already-Failed, missing, or unrelated terminal entry state fails
before status/comment mutation. Complete may be called again while still
Implementing and marker dedupe makes the comment idempotent. Failed-terminal
replay from Implementation Failed is not accepted: marker dedupe protects
uncertain duplicate comment submission, but is not permission to replay a
terminal transition after the board left Implementing. A new retry first uses
the normal failed-attempt start transition back to Implementing. If the failure
status write succeeds but state verification or comment creation fails, local
lifecycle remains authoritative and the CLI surfaces the terminal apply error;
there is no comment-only repair command in this slice.

Stable terminal marker bodies:

```text
<!-- harness-factory:implementation:<runId> -->

Factory implementation ready for review.

Status: implementation-complete
Run: `<durable runDir>`
Review base: `<reviewBase>`
Review head: `<reviewHead>`
Review commit: `<reviewCommitSha>`
Next: `harness run change-review --base <reviewBase> --head <reviewHead>`
```

```text
<!-- harness-factory:implementation-failed:<runId> -->

Factory implementation failed.

Status: implementation-failed
Run: `<durable runDir>`
Error: <error>
Retry: inspect the run, then run `harness factory implementation run --linear-issue <resolved issue identifier> --apply`.
```

### Truthful artifacts and orchestration

Pass an internal `linearApplyRequested` boolean from the command into the run
context and prompt renderer. Do not add it to persisted
`context/implementation-input.json`, `meta.json`, lifecycle events, or exported
schemas.

- No-apply summary retains exact line `- Linear mutation: not run.`.
- Applied summary records request/ownership, not success, for example
  `- Linear apply: requested; Harness command owns start and terminal projection.`
- No-apply prompt retains its current tracker-boundary line.
- Applied prompt states that the implementer/provider must not mutate the
  tracker and the Harness command owns requested pre/post-provider projection.
- Extend context export with an internal pre-provider-failure option. It writes
  `meta.json` and `summary.md`, omits unwritten prompt/handoff/live artifact
  paths **and** `eventsFile`, and states provider/reviewer were not invoked and
  lifecycle contains imported/started audit evidence but no terminal event.
  Make the affected artifact/event fields optional only for this result shape;
  normal applied and all no-apply manifests remain unchanged. Do not create an
  empty workflow event log merely to preserve the old field.

Preserve the existing exported local helper as a compatibility wrapper:

```ts
runFactoryImplementationWithLifecycle(input): Promise<FactoryImplementationRunMeta>
```

Extract its lifecycle/provider logic once into an internal core with start and
terminal hooks; do not copy the lifecycle sequence. Add the command-facing
apply wrapper, modeled on `runFactoryPlanningWithLinearApply`:

```ts
type FactoryImplementationLinearUpdate = {
  started?: LinearImplementationUpdatePlan;
  terminal?: LinearImplementationUpdatePlan;
};

type FactoryImplementationApplyRunResult = {
  meta: FactoryImplementationRunMeta;
  linearUpdate?: FactoryImplementationLinearUpdate;
  startApplyError?: unknown;
  terminalApplyError?: unknown;
};

runFactoryImplementationWithLinearApply(input):
  Promise<FactoryImplementationApplyRunResult>;
```

Invariants: `startApplyError` and `terminalApplyError` are mutually exclusive;
a start failure has no update record, provider call, terminal lifecycle event,
or terminal adapter call. A terminal failure may contain a verified started
record but no terminal record. No-apply callers continue receiving plain meta.

Applied live order:

1. acquire execution lease;
2. reload lifecycle; for Linear-backed work re-fetch/merge the issue; reclassify,
   then create/announce run from that fresh input;
3. append imported and audit-only started events;
4. apply start, then independently re-fetch/revalidate exact `Implementing`;
5. invoke provider workflow;
6. export/append local terminal state;
7. require fresh terminal entry `Implementing`, apply/verify the exact terminal
   postcondition, then dedupe/comment;
8. release lease in awaited `finally`;
9. print local CLI output, then throw start or terminal apply failure if present.

On start failure, catch only the apply error, export pre-provider failed meta/
summary, append no `implementation.failed`, return `startApplyError`, and release
the lease. The command prints `linearApplied: false` with no `linearUpdate`, then
throws the original start error so stderr/exit are non-zero. If that evidence
export fails, throw `AggregateError([startApplyError, exportError])`; no stdout is
required because no reliable meta exists. Retry remains the same first/retry
attempt because started is audit-only, provided Linear still has its required
entry status. If post-update verification failed and Linear later shows
Implementing, fail closed; the operator must inspect the durable run, confirm
provider was not invoked, and restore the required entry status before retry.

No terminal Linear apply follows a failed local terminal append. Terminal Ready,
Failed, missing, or other drift returns `terminalApplyError`; the command prints
local meta and verified started update first, then throws. Preserve current
AggregateError behavior when failed-meta export or local terminalization fails.

Use planning/triage CLI result convention only for apply:

```ts
linearApplied?: boolean; // present only for --apply; true only when all requested projections succeed
linearUpdate?: { started?: LinearImplementationUpdatePlan; terminal?: LinearImplementationUpdatePlan };
```

Omit both properties for no-apply and dry-run so current output shape is exact.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Install | `pnpm install --frozen-lockfile` | exit 0 |
| Config | `pnpm exec vitest run test/config.test.ts test/cli.test.ts` | mappings and migration tests pass |
| Readiness | `pnpm exec vitest run test/factory-planning-handoff.test.ts test/factory-implementation-input.test.ts test/factory-lifecycle.test.ts` | first/retry matrix passes |
| Lease/status | `pnpm exec vitest run test/factory-implementation-policy.test.ts test/factory-store.test.ts test/factory-lifecycle.test.ts` | exclusion and status classification pass |
| Adapter | `pnpm exec vitest run test/factory-linear-implementation-apply.test.ts test/factory-linear-adapter.test.ts` | apply and checked-mutation tests pass |
| Artifacts/workflow | `pnpm exec vitest run test/factory-implementation-run-context.test.ts test/factory-implementation.workflow.test.ts` | applied/no-apply wording and workflow tests pass |
| Command | `pnpm exec vitest run test/factory-implementation-apply-command.test.ts test/factory-implementation-cli.test.ts` | ordering, failures, and output tests pass |
| Docs | `pnpm exec vitest run test/docs-contracts.test.ts` | docs contracts pass; README <= 300 lines |
| Help | `node bin/harness.ts factory implementation run --help` | includes `--apply` |
| Typecheck | `pnpm typecheck` | exit 0, no errors |
| Format/lint | `pnpm format:check && pnpm lint` | both exit 0 |
| Dist smoke | `pnpm smoke:dist` | built implementation help includes `--apply` |
| Full gate | `pnpm check` | all Make gates pass |

## Skills for the executor

| Step | Verified skill/tool | Use |
| --- | --- | --- |
| All implementation steps | `implement-plan` | Execute phase-by-phase; honor scope, gates, and STOP conditions. |
| Schema/config | `zod` | Preserve strict parsing and actionable boundary errors. |
| Types, leases, adapter, orchestration | `typescript-refactor` | Keep discriminated attempt types, checked unknown boundaries, and awaited cleanup exhaustive. |
| All tests | `vitest` | Use isolated async fakes and explicit resolved-failure assertions. |
| Operator docs | `factory-operator` | Keep commands and lifecycle/projection guidance aligned with actual behavior. |
| Final review | `change-review-workflow` | Build an isolated review ref, pipe a self-contained handoff with `--handoff-stdin`, triage, fix, and re-review. |

## Scope

**In scope — modify only these files unless a STOP condition is resolved:**

- `lib/schemas.ts`
- `lib/config.ts`
- `harness.json` — status mappings only; protected model lines must not change
- `harness.old.json`
- `lib/factory-planning-handoff.ts`
- `lib/factory-implementation-input.ts`
- `lib/factory-implementation-policy.ts` (new)
- `lib/factory-locks.ts`
- `lib/factory-status.ts`
- `lib/factory-linear-types.ts`
- `lib/factory-linear-adapter.ts`
- `lib/factory-linear-planning-apply.ts`
- `lib/factory-linear-planning-handoff.ts`
- `lib/factory-linear-implementation-apply.ts` (new)
- `lib/factory-implementation-run-context.ts`
- `lib/prompts/factory-implementation.ts`
- `workflows/factory-implementation.workflow.ts`
- `bin/factory-implementation-cli.ts`
- `bin/factory-commands.ts`
- `test/config.test.ts`
- `test/cli.test.ts`
- `test/factory-linear-test-helpers.ts`
- `test/factory-planning-handoff.test.ts`
- `test/factory-implementation-input.test.ts`
- `test/factory-implementation-policy.test.ts` (new)
- `test/factory-store.test.ts`
- `test/factory-linear-adapter.test.ts`
- `test/factory-linear-implementation-apply.test.ts` (new)
- `test/factory-implementation-run-context.test.ts`
- `test/factory-implementation.workflow.test.ts`
- `test/factory-implementation-cli.test.ts`
- `test/factory-implementation-apply-command.test.ts` (new)
- `test/factory-lifecycle.test.ts` only for retry-provenance regression coverage
- `test/docs-contracts.test.ts` only if an exact implementation-doc contract is needed; do not relax the 300-line limit
- `scripts/smoke-dist.ts`
- `README.md`
- `docs/contributing/architecture.md`
- `docs/contributing/factory.md`
- `docs/contributing/setup-manifest.md`
- `docs/contributing/script-command-surface.md`
- `skills/factory-operator/SKILL.md`

**Out of scope — do not touch:**

- Lifecycle event schemas/reducer semantics in `lib/factory-lifecycle.ts` or
  `lib/factory-lifecycle-writes.ts`; tests may confirm existing behavior.
- Exported factory planning/triage JSON schemas; implementation has no station
  output JSON schema change.
- Provider adapters, provider selection, workspace patch capture, or internal
  review-ref materialization semantics.
- Change-review execution inside implementation, human branches/worktrees,
  commits, PR publication, GitHub mutation, or merge detection.
- Resume/retry from active `Implementing`, reset commands, or new lifecycle
  events.
- Review-running, review-complete, PR-ready, Done, merged, canceled, or
  duplicate status projection.
- Linear pagination, webhook/backend work, Inngest, Jira, or GitHub adapters.
- Generic one-active-station scheduling or a generic station/apply framework.
- `dev/plans/README.md`; factory owns approved-plan publication bookkeeping.
- Any `harness.json` agent/model/effort changes, especially the protected
  triager `gpt-5.6-luna`/`high` baseline.
- The draft plan file during implementation; it is read-only review input.

## Implementation steps

### Step 0: Freeze baseline and protect overlapping `harness.json` hunks

- Record `BASE_HEAD=$(git rev-parse HEAD)` and the complete initial
  `git status --short --untracked-files=all` plus `git diff --binary` as ambient
  baseline evidence outside the repository (for example `/tmp/fer52-baseline.*`).
- Confirm `BASE_HEAD` contains triager model `gpt-5.6-luna` and effort `high`.
  The historical terra/medium -> luna/high diff above is unrelated, already
  committed baseline, and must not appear in the FER-52 diff.
- If the worktree has new unrelated changes, preserve them. Record every
  overlapping in-scope hunk, not only paths; later review-tree staging must
  reject those hunks.
- Run the baseline focused suite before editing.

**Verify:**

```bash
BASE_HEAD=$(git rev-parse HEAD)
git status --short --untracked-files=all
git diff --binary
node -e 'const c=require("./harness.json"); if(c.factory.triage.roles.triager.model!=="gpt-5.6-luna"||c.factory.triage.roles.triager.modelReasoningEffort!=="high") process.exit(1)'
pnpm exec vitest run test/config.test.ts test/factory-implementation-input.test.ts test/factory-implementation-cli.test.ts test/factory-implementation-run-context.test.ts test/factory-linear-adapter.test.ts test/factory-store.test.ts test/docs-contracts.test.ts
```

Expected: protected values match; 7 files/187 current tests pass before edits;
ambient hunks are recorded exactly.

### Step 1: Add required status mappings and actionable migration

- Add required non-empty `implementing` and `implementationFailed` to the strict
  schema.
- Add the narrow missing-key migration error in `lib/config.ts`; list one or
  both missing paths deterministically and preserve all unrelated Zod errors.
- Update only status-map sections in `harness.json`, `harness.old.json`, and all
  typed fixtures/helpers. Do not touch protected model lines.
- Add bootstrap mappings in the Linear adapter. They are fallback display state,
  not entry policy.
- Test one-key/both-key omission through an unrelated config resolver, optional
  terminal keys, strict unknown keys, status-map validation, and fallback map.

**Verify:**

```bash
pnpm exec vitest run test/config.test.ts test/cli.test.ts test/factory-linear-adapter.test.ts
git diff --unified=0 "$BASE_HEAD" -- harness.json
if git diff --unified=0 "$BASE_HEAD" -- harness.json | rg -n '"model"|"modelReasoningEffort"'; then exit 1; else test $? -eq 1; fi
```

Expected: tests pass; the `harness.json` diff contains status mappings only and
no protected model/effort hunk.

### Step 2: Classify first/retry readiness before Linear projection

- Extract reusable stage-independent approved-plan validation and retain the
  existing `validatePlannedWorkHandoff` stage gate/result.
- Implement the explicit observe/apply projection input and attempt helper.
- Preserve planned-mode precedence whenever publication signals exist.
- Add planned/direct first/retry matrix tests: cross-paired statuses,
  `Implementing`, complete/active stages, missing provenance, invalid plan,
  bootstrap-only failure metadata, lifecycle-overlay retry, and observe retry
  rejection.

**Verify:**

```bash
pnpm exec vitest run test/factory-planning-handoff.test.ts test/factory-implementation-input.test.ts test/factory-lifecycle.test.ts
```

Expected: all pass; lifecycle provenance enables only the matching applied
retry, while existing no-apply first-run behavior remains green.

### Step 3: Add execution lease plus truthful status inspection

- Add the implementation execution policy module and distinct filename helper.
  Acquire fail-fast with unbounded age, await callback in `try/finally`, and
  release only after terminal handling settles.
- Add fresh lifecycle reload/classification within the lease and return fresh
  work item/input for context creation. Linear-backed work must re-fetch and
  merge the issue within the lease before classification; never reuse its
  pre-lease Ready/Failed status.
- Extend generic lock inspection with a per-filename age-policy seam.
  `factoryStatus` supplies unbounded age only for implementation execution lease
  filenames; ordinary lifecycle lock behavior stays unchanged.
- Add deterministic tests for same-item contention, different-item independence,
  async retention, success/throw release, dead recovery, and remote/missing/
  invalid fail-closed behavior.
- In `test/factory-store.test.ts`, add factory-status regressions for:
  - live same-host execution lease older than 30 minutes -> `stale: false`;
  - same-host dead execution lease -> `stale: true`;
  - remote old execution lease -> `stale: false`, `remote-owner` warning;
  - existing ordinary old remote lifecycle-lock behavior remains unchanged.
- Test fresh lifecycle revalidation blocking a complete run and forcing a new
  retry classification after a failed run. Separately hold a same-item lease,
  change a Linear issue from the pre-lease Ready/Failed state, release it, and
  prove the waiting command re-fetches, fails closed before context/lifecycle/
  provider work, and does not use stale metadata.

**Verify:**

```bash
pnpm exec vitest run test/factory-implementation-policy.test.ts test/factory-store.test.ts test/factory-lifecycle.test.ts
```

Expected: all pass; healthy long execution leases are never age-stale, dead
same-host leases are stale, and no same-item concurrent callback can run.

### Step 4: Check every Linear mutation result and add implementation apply

- Type `updateIssue`/`createComment` as returning a shared success payload.
- Add shared checked update/comment helpers. Replace every unchecked direct
  status/comment mutation in triage, planning apply, planning handoff, and the
  new implementation adapter. Keep thrown errors unchanged; reject resolved
  `success: false` with operation-specific errors.
- Update all fake clients to return `{ success: true }` by default.
- Add the narrow implementation apply module, exact start guard, target
  resolution, marker rendering/dedupe, and facade methods from Design.
- Add a dependency-injected fresh-state verifier that re-fetches by immutable
  issue id, revalidates issue identity/team/project, and asserts one exact
  normalized expected state. Use it after every implementation status write and
  for the no-write complete postcondition; never treat `success: true` alone as
  transition proof.
- Enforce exact terminal entry `Implementing` before any terminal mutation or
  comment. Do not reuse the permissive planning terminal behavior.
- Adapter tests must distinguish thrown rejection from resolved failure:
  - `updateIssue` resolves false on first/retry start -> reject;
  - `updateIssue` throws on start -> reject separately;
  - start returns success true but immutable-id refetch still reports Ready,
    Failed, missing state, or another state -> reject with no started record;
  - `createComment` resolves false after terminal status -> reject;
  - `createComment` throws -> reject separately;
  - complete from Implementing performs no status write, verifies a fresh
    Implementing state, and dedupes/comments;
  - failed terminal from Implementing verifies fresh Failed after checked write;
  - complete/failed terminal entry from Ready, Implementation Failed, missing,
    or unrelated state -> reject before status/comment mutation;
  - failed write returns success true but post-read remains Implementing or
    reports another state -> reject before comment;
  - complete replay while Implementing dedupes; failed replay from Failed rejects;
  - duplicate marker skips comment; status update remains independent;
  - precondition/scope/status-map failures produce zero mutations.
- Add focused existing-path regressions proving triage/planning now reject
  resolved false rather than reporting successful apply.

**Verify:**

```bash
pnpm exec vitest run test/factory-linear-implementation-apply.test.ts test/factory-linear-adapter.test.ts
```

Expected: all pass; no transition is reported until both mutation payload and
fresh exact state agree, and external terminal drift is never overwritten.

### Step 5: Make generated summaries and prompts truthful

- Add internal `linearApplyRequested` to run-context options/context and thread
  it into prompt/summary rendering through the workflow. Do not persist it in
  existing context/meta/lifecycle schemas.
- Preserve exact no-apply summary line and tracker-boundary prompt wording.
- Add conditional applied wording that separates implementer/provider
  prohibition from Harness command projection ownership and records request,
  not claimed terminal success.
- Add the pre-provider-failure export option: omit prompt/handoff/live artifact
  paths and `eventsFile` when they were never written; state provider/reviewer
  not invoked and imported/started-only lifecycle evidence. Update the internal
  artifact/event typing so only this result may omit those fields; keep the
  option internal rather than widening persisted input/meta schemas.
- Add tests for applied and no-apply planned/direct prompt and summary text,
  plus assertions that no-apply artifact keys/meta/context JSON shapes remain
  unchanged. Add a start-failure export assertion that every advertised path
  exists, `eventsFile` is absent, and no provider/prompt/handoff/diff artifact
  is advertised.

**Verify:**

```bash
pnpm exec vitest run test/factory-implementation-run-context.test.ts test/factory-implementation.workflow.test.ts
```

Expected: all pass; applied artifacts mention requested Harness-owned Linear
projection, while no-apply artifacts retain the current line and shape.

### Step 6: Wire `--apply`, fresh input, lifecycle, and terminal errors

- Add the option and call `validateFactoryApplyOptions` before all other
  resolution. Reuse one cached Linear adapter for input fetch and apply.
- Dry-run follows current context path and takes no lease. Every live path enters
  the execution lease, reloads lifecycle and (for Linear-backed work) re-fetches/
  merges Linear, reclassifies, then creates/announces context from fresh input.
- Preserve `runFactoryImplementationWithLifecycle` as the plain-meta
  compatibility wrapper. Extract one internal lifecycle core and add
  `runFactoryImplementationWithLinearApply` returning the exact
  `FactoryImplementationApplyRunResult` from Design. Update only the station
  command and new apply tests to consume the apply-aware result; existing
  no-apply tests/callers keep plain meta.
- Refactor lifecycle orchestration without copying it. Preserve imported/
  started/terminal contents, caught provider failure behavior, AggregateError
  precedence, and terminal lifecycle gate.
- Start apply occurs after local imported/started audit writes but before
  provider. Return a started record only after immutable-id refetch confirms
  exact Implementing.
- On start failure, create pre-provider failed meta/summary, omit unwritten
  provider artifacts, append no terminal lifecycle event, call no terminal
  adapter, and return `{ meta, startApplyError }`. The command prints stdout
  with `linearApplied: false` and no `linearUpdate`, releases the lease, then
  throws the original error. Test the resulting non-zero exit/stderr and that a
  same-status retry remains lifecycle-eligible because started is audit-only.
- Complete requires all review refs and exact terminal entry/postcondition
  Implementing. Failure uses local meta error, requires entry Implementing, and
  verifies exact Failed after mutation. Every terminal drift error is captured
  as `terminalApplyError`; local meta and any verified started record print
  before the command throws.
- Error precedence is exact:
  1. context/imported/started/local lifecycle failures throw immediately; no
     Linear mutation or stdout without reliable meta;
  2. start apply failure returns failed meta plus `startApplyError`, prints, then
     throws; provider/terminal paths are skipped;
  3. provider returned/thrown failure becomes local failed meta and terminal
     lifecycle, then attempts failed projection;
  4. local terminalization failure throws/Aggregates and skips terminal apply;
  5. terminal apply failure returns meta plus `terminalApplyError`, prints, then
     throws;
  6. with no apply error, current failed-meta exit code remains 1 and complete
     remains 0.
- Add optional CLI `linearApplied`/`linearUpdate` only for `--apply`; no-apply
  output omits both. Extend source/dist help.
- Command tests must use a real adapter backed by a fake Linear client for two
  critical resolved-failure cases:
  - start `updateIssue -> { success: false }`: zero provider calls and no
    terminal apply;
  - terminal `createComment -> { success: false }`: local terminal meta/output
    preserved, `terminalApplyError` set, final command error non-zero.
  - start `updateIssue -> { success: true }` followed by fresh Ready: durable
    pre-provider failed meta/summary, imported+started only, zero provider and
    terminal-adapter calls, no terminal lifecycle event, stdout before non-zero
    error, and subsequent same-entry retry remains lifecycle-eligible;
  - terminal external drift to Ready/Failed/other: local terminal remains,
    zero terminal mutation/comment, stdout before terminal apply error;
  - failed transition success true followed by fresh Implementing/other:
    terminal apply error before comment.
  Keep thrown-rejection cases separate. Add a held-lease regression in which
  Linear changes after the initial fetch; when the lease releases, stale status
  must block before context creation, lifecycle writes, or provider invocation.
- Also cover lease/freshness order, attempt forwarding, complete refs, returned
  and thrown provider failure, local terminal append failure, no-apply lease,
  dry-run no lease, and exact no-apply CLI shape.

**Verify:**

```bash
pnpm exec vitest run test/factory-implementation-apply-command.test.ts test/factory-implementation-cli.test.ts test/factory-implementation-run-context.test.ts test/factory-implementation.workflow.test.ts
node bin/harness.ts factory implementation run --help
```

Expected: tests pass; help includes `--apply`; every start requires a fresh
Implementing postcondition, start failure leaves complete truthful evidence but
no terminal lifecycle, and all terminal drift/failure surfaces after local output.

### Step 7: Update deterministic operator/documentation contracts

- Add status mappings, manual upgrade, command examples, exact flag conflicts,
  conditional entry matrix, lifecycle authority, markers, failure semantics,
  execution lease inspection, and board model to the scoped docs/skill.
- Document exact projection guards: start requires a fresh verified Implementing
  post-state; terminal projection begins only from Implementing and never repairs
  external drift. Document pre-provider start failure as a durable failed run
  with imported/started audit evidence only, no provider/terminal event, stdout
  then non-zero error, and same-entry retry only while Linear still matches. If
  Linear later shows Implementing after failed verification, require inspection
  and deliberate restoration rather than automatic resume.
- Replace only these verified stale unconditional claims:
  - README text containing `stops before change-review; it does not mutate Linear`;
  - architecture text containing `It does not mutate Linear, create` in the
    implementation station sections;
  - operator skill sentence `It does not run change-review, mutate Linear`.
  - `docs/contributing/factory.md` text stating `There is no Linear apply path
    for implementation in this station` and listing `no Linear mutation` as an
    implementation non-goal.
  Conditional text such as “without `--apply` does not mutate Linear” is valid
  and must not be rejected by a broad regex.
- Add the new policy/apply modules to architecture ownership and command/setup
  surfaces. Keep durable docs generic; no local home/run paths.
- Keep README at or below 300 lines. Move depth to factory contributor docs
  rather than weakening `test/docs-contracts.test.ts`.

**Verify:**

```bash
test "$(wc -l < README.md | tr -d ' ')" -le 300
if rg -n -F 'stops before change-review; it does not mutate Linear' README.md; then exit 1; else test $? -eq 1; fi
if rg -n -F 'It does not mutate Linear, create' docs/contributing/architecture.md; then exit 1; else test $? -eq 1; fi
if rg -n -F 'It does not run change-review, mutate Linear' skills/factory-operator/SKILL.md; then exit 1; else test $? -eq 1; fi
if rg -n -F 'There is no Linear apply path for implementation in this station' docs/contributing/factory.md; then exit 1; else test $? -eq 1; fi
if rg -n -F 'Non-goals: no nested change-review loop, no PR creation, no Linear mutation' docs/contributing/factory.md; then exit 1; else test $? -eq 1; fi
rg -n 'implementationFailed|Implementing|implementation run.*--apply' README.md docs/contributing skills/factory-operator/SKILL.md
pnpm exec vitest run test/docs-contracts.test.ts
```

Expected: every command exits 0; exact stale claims are absent; positive terms
are documented; docs-contract test passes with README <= 300 lines.

### Step 8: Run gates and review only FER-52 hunks

- Run all focused/full gates and inspect the complete ambient diff.
- Reconfirm protected `harness.json` model lines are unchanged from `BASE_HEAD`.
- Build a temporary-index review commit parented directly to `BASE_HEAD`; do not
  move the human branch or real index. Add only FER-52 paths. For
  `harness.json` and any file with recorded baseline overlap, use
  `GIT_INDEX_FILE=... git add -p` and select only FER-52 hunks. Never stage the
  historical model/effort hunk. This is hunk-level isolation, not a path-only
  status check.
- Diff `BASE_HEAD..REVIEW_REF` separately from the ambient worktree and prove the
  review diff contains only FER-52 changes and no protected model fields.
- Compose a self-contained `HANDOFF` shell variable containing goal, behavior,
  actual changed files from the isolated diff, verification commands/results,
  known ambient baseline, and scrutiny points (entry matrix, mutation payloads,
  lease status, terminal error order, no-apply artifacts). Do not write a
  handoff file.
- Pipe the handoff through `--handoff-stdin` and review the current factory draft
  at `.harness/runs/factory/20260710-052528-b4f576/planning/draft.md`.
- Read every reviewer artifact, triage each finding Implement/Adapt/Decline,
  apply accepted fixes, rerun affected gates, and re-review after material
  changes.

**Verification/build recipe:**

```bash
pnpm exec vitest run test/config.test.ts test/cli.test.ts test/factory-planning-handoff.test.ts test/factory-implementation-input.test.ts test/factory-implementation-policy.test.ts test/factory-store.test.ts test/factory-linear-adapter.test.ts test/factory-linear-implementation-apply.test.ts test/factory-implementation-run-context.test.ts test/factory-implementation.workflow.test.ts test/factory-implementation-cli.test.ts test/factory-implementation-apply-command.test.ts test/factory-lifecycle.test.ts test/docs-contracts.test.ts
pnpm typecheck
pnpm format:check
pnpm lint
pnpm smoke:dist
pnpm check
git diff --check
node -e 'const c=require("./harness.json"); if(c.factory.triage.roles.triager.model!=="gpt-5.6-luna"||c.factory.triage.roles.triager.modelReasoningEffort!=="high") process.exit(1)'
if git diff --unified=0 "$BASE_HEAD" -- harness.json | rg -n '"model"|"modelReasoningEffort"'; then exit 1; else test $? -eq 1; fi

REVIEW_TMP=$(mktemp -d)
export GIT_INDEX_FILE="$REVIEW_TMP/index"
git read-tree "$BASE_HEAD"
# Add new/unrelated-free FER-52 files explicitly with `git add -A -- <paths>`.
# For harness.json and every overlapping file, use `git add -p -- <path>` and
# select only FER-52 hunks; reject all recorded baseline hunks.
git diff --cached --check
git diff --cached --stat
git diff --cached --binary
REVIEW_TREE=$(git write-tree)
REVIEW_COMMIT=$(printf '%s\n' 'Review FER-52 implementation' | git commit-tree "$REVIEW_TREE" -p "$BASE_HEAD")
REVIEW_REF="refs/harness/reviews/fer-52-$REVIEW_COMMIT"
unset GIT_INDEX_FILE
git update-ref "$REVIEW_REF" "$REVIEW_COMMIT"
git diff --check "$BASE_HEAD" "$REVIEW_REF"
git diff --name-status "$BASE_HEAD" "$REVIEW_REF"
if git diff --unified=0 "$BASE_HEAD" "$REVIEW_REF" -- harness.json | rg -n '"model"|"modelReasoningEffort"'; then exit 1; else test $? -eq 1; fi
test -s .harness/runs/factory/20260710-052528-b4f576/planning/draft.md

# Populate exact gate outcomes; no placeholder may remain when review starts.
VERIFICATION_SUMMARY='Focused suite: PASS; typecheck: PASS; format: PASS; lint: PASS; dist smoke: PASS; pnpm check: PASS'
HANDOFF=$(cat <<EOF
Goal: implement FER-52 constrained Linear apply for factory implementation.
Behavior: Ready first runs and Implementation Failed retries move to Implementing; local complete posts review handoff; local failure moves to Implementation Failed; lifecycle remains authoritative.
Review scope: BASE_HEAD..REVIEW_REF, temporary-index tree containing only FER-52 hunks. The committed harness.json luna/high triager configuration is protected baseline and excluded.
Changed files:
$(git diff --name-only "$BASE_HEAD" "$REVIEW_REF")
Verification: $VERIFICATION_SUMMARY
Scrutinize: checked success:false plus immutable-id post-state verification; no provider and audit-only lifecycle after failed start; exact Implementing terminal entry guard; local-before-Linear terminal ordering; explicit apply-result/printing precedence; long-lease status classification; first/retry fail-closed matrix; exact no-apply output/artifact behavior.
EOF
)
printf '%s\n' "$HANDOFF" | node bin/harness.ts run change-review --workspace . --base "$BASE_HEAD" --head "$REVIEW_REF" --plan .harness/runs/factory/20260710-052528-b4f576/planning/draft.md --handoff-stdin --verbose
```

Expected: all gates exit 0; isolated diff excludes ambient/protected hunks;
change-review receives the populated handoff, completes all roles, and every
finding has one recorded disposition.

## Test plan

- **Config/bootstrap:** required/non-empty mappings; one/both missing keys;
  unrelated config resolver; strict keys; optional terminal keys; shipped
  configs; Ready/Implementing/Failed fallback mapping; lifecycle overlay wins.
- **Readiness:** planned/direct first/retry; exact status per attempt;
  disagreement both directions; active/completed rejection; missing provenance;
  plan artifact failures; observe retry rejection; bootstrap alone insufficient.
- **Execution lease/status:** same-item fail-fast; different items independent;
  async retention; cleanup; dead recovery; remote/missing/invalid fail closed;
  >30-minute live lease not stale in factory status; dead stale; remote non-stale;
  ordinary lifecycle-lock age behavior unchanged; fresh lifecycle gate; Linear
  status changed while waiting for the lease is re-fetched and fails closed
  before context/lifecycle/provider work.
- **Mutation contract:** every fake returns a success payload; update/comment
  resolved false and thrown rejection are separate tests; existing triage/
  planning and new implementation paths never report unchecked success;
  implementation status writes also require an immutable-id fresh-state match.
- **Implementation adapter:** scope/status-map validation; exact first/retry
  entry; no Implementing start; success-true-but-state-unchanged start failure;
  terminal entry only from Implementing; complete fresh-Implementing check;
  failure fresh-Failed check; Ready/Failed/missing/other drift rejection;
  complete replay versus failed replay policy; complete refs/command; failure
  retry guidance; marker dedupe; status update independent of comment dedupe.
- **Artifacts:** applied/no-apply summary and prompt ownership wording; applied
  records request only; no-apply summary/prompt/context/meta shape unchanged;
  pre-provider failure advertises only files that exist and explains
  provider-not-run plus imported/started-only lifecycle evidence; it omits
  `eventsFile` rather than advertising an unwritten workflow event log.
- **Orchestration/CLI:** lease -> fresh input -> context -> local audit -> checked
  and freshly verified start -> provider -> local terminal -> guarded/verified
  terminal order; start false or unchanged fresh state means zero provider and
  no terminal lifecycle/apply; start failed meta prints before error; terminal
  false/drift/postcondition failure preserves output then errors; explicit
  apply-result contract; provider thrown/returned failure; local terminal
  failure; optional apply-only output; source/dist help and flag precedence.
- **Docs/regression:** exact stale claims removed; valid conditional claim
  allowed; README <= 300; docs contracts pass; lifecycle audit-only semantics,
  provider workflow, review refs, and full gate remain green.

## Done criteria

All must hold:

- [ ] Required mappings parse, validate, bootstrap, and have actionable manual migration guidance.
- [ ] Implementation `--apply` exists; invalid combinations fail before config/provider work.
- [ ] First runs accept only Ready; failed retries accept only Failed; Implementing and disagreements fail before provider.
- [ ] Every live implementation uses the distinct lease and fresh lifecycle gate;
  Linear-backed work re-fetches/merges the issue after acquisition; dry-run does not.
- [ ] Factory status does not age-stale a live execution lease, but still identifies dead/remote/incomplete/invalid ownership safely.
- [ ] Every Linear status/comment result is checked; start and failed-terminal
  transitions require exact fresh post-state; success true with unchanged state
  never invokes provider or posts a terminal comment.
- [ ] Terminal projection accepts only exact Implementing; Ready, Failed,
  missing, or other drift never gets overwritten.
- [ ] Complete/failure markers contain required durable evidence and dedupe by run id.
- [ ] Local terminal state precedes terminal apply; resolved-false terminal apply prints local output then exits non-zero.
- [ ] Start apply failure writes truthful failed meta/summary and imported/
  started audit evidence only, advertises no unwritten provider artifacts,
  including no unwritten `eventsFile`, prints local output, appends no terminal
  lifecycle, and exits non-zero.
- [ ] Existing lifecycle helper still returns plain meta; the apply wrapper
  returns the documented meta/update/start-error/terminal-error result and
  command printing/error precedence is covered.
- [ ] Applied prompt/summary state Harness-command ownership/request truthfully; no-apply artifact and CLI shapes remain exact.
- [ ] No lifecycle/schema, review/PR/Done, provider, or active-resume scope was added.
- [ ] README is <= 300 lines; exact doc checks and `test/docs-contracts.test.ts` pass.
- [ ] Protected `harness.json` luna/high lines equal baseline and are absent from the isolated FER-52 diff.
- [ ] All focused commands, typecheck, format, lint, dist smoke, and `pnpm check` exit 0.
- [ ] Temporary review ref contains only FER-52 hunks; full change-review ran with populated `HANDOFF` via `--handoff-stdin`; every finding is dispositioned.

## STOP conditions

Stop and report; do not improvise if:

- Current code no longer merges lifecycle state over Linear bootstrap before implementation readiness.
- Retry requires accepting active `Implementing`, inventing reset/resume events,
  editing lifecycle history, or inferring provenance from Linear comments.
- Planned retry requires duplicated plan validation or weakening the existing
  `validatePlannedWorkHandoff` stage contract.
- Correct exclusion requires holding the short lifecycle lock across network or
  provider work, or the execution lease cannot span fresh-read through terminal handling.
- Factory-status inspection cannot distinguish execution-lease age policy while
  retaining dead-owner detection and remote/incomplete/invalid fail-closed behavior.
- Any start status mutation can resolve false without blocking provider invocation.
- Any implementation status update can return success true without a fresh
  immutable-id state read proving the exact expected postcondition.
- Terminal projection would overwrite or comment from any state other than
  exact Implementing, or would accept failed-terminal replay from Failed.
- A start-apply failure cannot produce truthful durable failed meta/summary
  without appending a terminal lifecycle event or advertising unwritten files.
- Complete meta lacks any review ref; do not post a partial handoff.
- Local terminal append fails; do not issue terminal Linear projection.
- Truthful applied artifacts require changing persisted implementation input,
  lifecycle, or exported schema shape; stop rather than widen contracts.
- Correctness requires Done/review/PR projection, active resume, provider API,
  human branch/worktree/PR flow, or generic scheduling/framework work.
- Protected `harness.json` model lines differ from `gpt-5.6-luna`/`high`, or an
  unrelated overlapping hunk cannot be excluded safely.
- The isolated review diff contains ambient changes, protected model fields, or
  cannot be proven separately from the worktree.
- README cannot remain <= 300 lines without deleting required entrypoint links;
  move details to contributor docs rather than relaxing the contract.
- A gate fails twice after a reasonable scoped fix, or requires an out-of-scope file.
- The current draft is missing at
  `.harness/runs/factory/20260710-052528-b4f576/planning/draft.md` before review.

## Maintenance notes

- `Implementing` intentionally spans implementation, review, and PR work. Future
  review/PR commands should normally retain it.
- A crash after confirmed start may leave Linear at `Implementing`; this command
  intentionally refuses to resume. Recovery needs an explicit future policy.
- Execution-lease filename semantics are now consumed by status inspection;
  changing the suffix requires updating both acquisition and inspection tests.
- Shared mutation-success checks protect all current Linear apply paths. New
  mutation methods must use them rather than awaiting raw SDK payloads.
- Linear update success is necessary but insufficient for implementation: new
  transitions must retain immutable-id post-update verification and exact
  terminal entry guards.
- Start-apply failures intentionally leave only imported/started audit events;
  changing `implementation.started` from audit-only would require revisiting
  retry semantics and this failure contract.
- Marker dedupe remains bounded by recent comments. Pagination/idempotency-store
  changes require a separate design.
- Reviewers should prioritize the attempt matrix, payload-success confirmation,
  lease inspection, local/remote terminal error ordering, and no-apply artifact
  compatibility over marker prose.
