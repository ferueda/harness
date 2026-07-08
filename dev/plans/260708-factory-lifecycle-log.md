# Plan 260708-factory-lifecycle-log: Add factory lifecycle event log and read model

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: dx
- **Issue**: https://linear.app/ferueda/issue/FER-34/define-factory-event-log-and-read-model

## Why this matters

The factory currently has several partial sources of truth for lifecycle state:
Linear statuses, Linear marker comments, per-run `meta.json`, and work item
metadata. That is already making the next implementation station brittle,
because the implementer needs one reliable answer to "is this work ready, and
what plan should I use?" Build a small harness-owned event log now so Linear can
remain the human board, run artifacts can remain execution evidence, and future
Inngest can orchestrate commands without becoming the lifecycle database.

This plan intentionally adopts the useful parts of the reference articles
without building a distributed system:

- Restate, ["Every System is a Log"](https://www.restate.dev/blog/every-system-is-a-log-avoiding-coordination-in-distributed-applications):
  one scoped log avoids coordination between independent state stores.
- "The Log Is the Agent" attachment:
  durable history is primary; summaries and views are projections.
- "The Agent Loop Architecture" attachment:
  Inngest-style orchestration should provide durable steps, retries, locks, and
  observability later; it should call harness station code, not replace harness
  lifecycle state.
- Warp, ["We are now factory engineers, not product engineers"](https://www.warp.dev/blog/we-are-now-factory-engineers-not-product-engineers):
  station automation should be observable, measurable, and improved over time,
  but humans can still intervene at explicit factory boundaries.

## Current state

Repo facts:

- Runtime is Node/TypeScript with native `.ts` execution and ESM imports.
- Package manager is `pnpm`; verification is `pnpm check` or focused
  `pnpm test -- <file>`.
- Zod schemas live near their domain boundary and export both schema and
  inferred types.
- Tests live in `test/*.test.ts` and use Vitest.
- `docs/project-intent.md` requires durable docs to stay generic, generated
  artifacts to live under the target repo `.harness/`, and runtime schemas to
  stay aligned with any exported schemas. This slice adds internal runtime
  schemas only; no exported JSON schema change is required unless
  implementation later exposes lifecycle events as a public schema.

Relevant files:

- `lib/factory-schemas.ts` - defines `FactoryWorkItem`, route, stage, tracker,
  and metadata schemas.
- `lib/factory-linear-adapter.ts` - fetches Linear issues and currently derives
  `metadata.factoryStage` from Linear status and recent comments.
- `lib/factory-linear-planning-apply.ts` - parses recent Linear planning marker
  comments to distinguish planning-attention states.
- `lib/factory-planning-run-context.ts` - writes planning run `meta.json` and
  currently embeds lifecycle metadata such as `approvedPlanPath`.
- `lib/factory-planning-handoff.ts` - validates plan publication and
  implementation readiness from metadata.
- `bin/factory-commands.ts` - operator CLI for triage, planning, plan publish,
  and mark-plan-merged.
- `docs/contributing/factory.md` - current operator contract.
- `skills/factory-operator/SKILL.md` - current operator-facing skill docs.

Current source-of-truth map:

| Today                                                                                     | Problem                                                         | New canonical source                                                                   |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Linear status -> `factoryStage` in `factory-linear-adapter.ts`                            | Linear is a human board, not durable harness state.             | Factory read model derived from lifecycle events.                                      |
| Linear marker comments -> planning attention in `factory-linear-planning-apply.ts`        | Recent-comment window is brittle and not a durable state store. | `planning.completed` event with `status=plan-needs-human` or `plan-review-unresolved`. |
| Planning run `meta.json` -> `approvedPlanPath`, `approvedPlanPrUrl`, `approvedPlanCommit` | Run-local metadata is not a per-work-item lifecycle index.      | Lifecycle events plus state projection keyed by work item.                             |
| `FactoryWorkItem.metadata` passed between commands                                        | Metadata is a transport shape, not durable truth.               | Enrich metadata from the read model when resolving input.                              |
| Linear comments with plan PR/merge markers                                                | Useful for humans, brittle for machine state.                   | Comments become projections of logged events.                                          |

Keep these as source of truth outside the lifecycle log:

- Git remains source of truth for committed plan files and code.
- Linear issue title, description, labels, and human comments remain source
  material for agent context.
- `.harness/runs/*` remains execution evidence and debugging artifacts.
- `events.jsonl` under a run remains workflow telemetry, not factory lifecycle.
- Inngest run history later remains orchestrator telemetry.

Target local storage:

```text
<factory-state-root>/events/<work-item-filename>.jsonl
<factory-state-root>/state/<work-item-filename>.json
```

`factoryStateRoot` is the control-plane location for lifecycle truth. In this
slice it defaults to `<workspace>/.harness/factory`. Do not bake lifecycle paths
directly into `workspace`; future worktree support must be able to run station
commands in a worktree while writing the same shared factory state root. The
actual file names use the `workItemKeyToFilename` algorithm defined below, not
the raw work item key.

Use JSONL first. Defer SQLite until cross-work-item queries, indexing, or
concurrency pressure justifies it.

## Commands you will need

| Purpose       | Command                                                                                                                                                                              | Expected on success |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| Install       | `pnpm install`                                                                                                                                                                       | exit 0              |
| Typecheck     | `pnpm typecheck`                                                                                                                                                                     | exit 0, no errors   |
| Focused tests | `pnpm test -- test/factory-lifecycle.test.ts test/factory-linear-adapter.test.ts test/factory-planning-apply-command.test.ts test/factory-planning-handoff.test.ts test/cli.test.ts` | all pass            |
| Full check    | `pnpm check`                                                                                                                                                                         | exit 0              |

## Suggested executor toolkit

| Skill                    | Use for                                                          |
| ------------------------ | ---------------------------------------------------------------- |
| `implement-plan`         | Execute this plan phase-by-phase.                                |
| `node`                   | File I/O, JSONL append/read, and native TypeScript import shape. |
| `typescript-refactor`    | Discriminated event unions and exported type architecture.       |
| `zod`                    | Event/state schemas, safe parsing, and boundary errors.          |
| `vitest`                 | New reducer/store tests and CLI regression tests.                |
| `change-review-workflow` | Review final changes before PR.                                  |
| `factory-operator`       | Validate docs against current operator commands and vocabulary.  |

## Scope

**In scope**:

- Add a local factory lifecycle log and read model.
- Write lifecycle events from existing triage, planning, publish, and
  mark-plan-merged command paths.
- Prefer the read model over Linear-derived lifecycle metadata when resolving
  factory work items.
- Add an internal `factoryStateRoot` seam for lifecycle store helpers. Default
  it to `<workspace>/.harness/factory`; do not require a public CLI flag in this
  slice.
- Record execution context on lifecycle events so workspace-relative artifact
  paths can be resolved against the workspace that produced them.
- Keep existing Linear status/comment projections working for humans.
- Add tests and docs.

**Out of scope**:

- SQLite event store.
- Inngest integration.
- Worktree creation, checkout, cleanup, or scheduling.
- Public `--factory-state-root` CLI flag unless implementation needs it for
  current tests. If a future public flag is added, use that exact name.
- Auto-discovery from `git common-dir` or a control checkout.
- Cross-process or cross-worktree locking.
- GitHub webhook or GitHub issue integration.
- New implementation station behavior.
- Removing all Linear comment markers in one sweep.
- Changing plan PR mechanics.
- Batch dispatch or inbox automation.
- Lifecycle writes for low-level `harness run factory-triage`. The
  operator-facing `harness factory ...` station commands own lifecycle writes in
  this slice; low-level workflow primitives remain escape hatches.
- Any write into `.harness/runs/*` as committed source.

## Data model

Add a small event contract. Suggested shape:

```ts
type FactoryLifecycleEvent =
  | WorkItemImportedEvent
  | TriageStartedEvent
  | TriageCompletedEvent
  | TriageFailedEvent
  | PlanningStartedEvent
  | PlanningCompletedEvent
  | PlanningFailedEvent
  | PlanPrOpenedEvent
  | PlanPrMergedEvent;
```

Common fields:

```ts
{
  version: 1,
  id: string,
  type: string,
  workItemKey: string,
  occurredAt: string,
  runId?: string,
  source: "harness",
  execution?: {
    workspace: string,
    runDir?: string,
    branch?: string,
    head?: string
  },
  data: object
}
```

`execution.workspace` is where the station ran and where workspace-relative
artifact paths such as `approvedPlanPath` resolve. It is not the lifecycle
storage location. The lifecycle storage location is always `factoryStateRoot`.

Event data shapes:

| Event                | Required `data` fields                                                        | Optional `data` fields                                                                            |
| -------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `work_item.imported` | `source`, `title`                                                             | `tracker`, `url`, `labels`                                                                        |
| `triage.started`     | none                                                                          | `linearIssue`, `itemFile`                                                                         |
| `triage.completed`   | `route`, `nextAction`, `rationale`, `routeArtifactPath`, `triageArtifactPath` | `questions`, `reconsiderWhen`                                                                     |
| `triage.failed`      | `error`                                                                       | `summaryPath`                                                                                     |
| `planning.started`   | none                                                                          | `linearIssue`, `itemFile`                                                                         |
| `planning.completed` | `status`                                                                      | `approvedPlanPath`, `humanQuestions`, `reviewFindingsPath`, `planReviewRefPath`, `iterationCount` |
| `planning.failed`    | `error`                                                                       | `summaryPath`                                                                                     |
| `plan_pr.opened`     | `approvedPlanPath`, `approvedPlanPrUrl`                                       | none                                                                                              |
| `plan_pr.merged`     | `approvedPlanPath`, `approvedPlanPrUrl`, `approvedPlanCommit`                 | none                                                                                              |

Use Zod discriminated unions so each event type validates only its own payload.
Use existing schemas where possible: `FactoryRouteSchema`,
`FactoryNextActionSchema`, `FactoryStageSchema`, `FactoryTrackerRefSchema`, and
the planning status enum from `lib/factory-planning-run-context.ts`.
For `work_item.imported`, `data.source` means `FactoryWorkItem.source`; tracker
details belong in optional `data.tracker` from `workItem.metadata.tracker`.

Work item key:

- Use `<source>:<tracker-id-or-item-id>` as the logical key, for example
  `linear:FER-34`.
- `deriveFactoryWorkItemKey` precedence:
  - If valid `metadata.tracker` exists, return
    `${metadata.tracker.source}:${metadata.tracker.id}`. Example:
    `github:owner/repo#123` for a file-backed item carrying tracker metadata.
  - Else if `workItem.id` already contains `:`, return `workItem.id` as-is.
    Example: `linear:FER-34`.
  - Else return `${workItem.source}:${workItem.id}`. Example:
    `file:local-1`.
- Add `workItemKeyToFilename(workItemKey: string): string`. Exact algorithm:
  - Replace every character outside `[A-Za-z0-9._-]` with `-`.
  - Collapse repeated `-`.
  - Trim leading/trailing `-`.
  - If empty, use `work-item`.
  - Truncate the readable prefix to 80 characters.
  - Append `-` plus the first 12 lowercase hex chars of
    `sha256(workItemKey)`.
  - Return an extensionless file stem. Example shape:
    `linear-FER-34-<hash>` and `github-owner-repo-123-<hash>`.
  - `factoryLifecycleEventPath` appends `.jsonl`.
    `factoryLifecycleStatePath` appends `.json`.
  - The hash is mandatory collision protection; do not rely on the readable
    prefix being unique.
- Derive event/state file paths from `factoryStateRoot + workItemKey`, never
  from worktree path, run dir, or current process cwd.

Reducer output:

```ts
type FactoryLifecycleState = {
  version: 1;
  workItemKey: string;
  source?: FactoryWorkItem["source"];
  tracker?: FactoryTrackerRef;
  title?: string;
  factoryStage?: FactoryStage;
  factoryRoute?: FactoryRoute;
  factoryNextAction?: FactoryNextAction;
  factoryRunId?: string;
  approvedPlanPath?: string;
  approvedPlanPrUrl?: string;
  approvedPlanCommit?: string;
  lastEventId?: string;
  updatedAt?: string;
};
```

State machine principles:

- `factoryStage` is the durable work-item lifecycle state, not a live process
  monitor.
- `*.started` events are execution history. They must not overwrite
  `factoryStage`, because a process crash before the terminal event would strand
  the read model in a transient state.
  In the read model, started events update only bookkeeping such as
  `lastEventId` and `updatedAt`; do not set `factoryRunId` until a terminal
  event.
- Linear statuses such as `Triaging` and `Planning` remain human board
  projections while a station is running. Run-local `events.jsonl` remains the
  live execution timeline.
- Terminal station events own durable transitions:
  `triage.completed`, `triage.failed`, `planning.completed`,
  `planning.failed`, `plan_pr.opened`, and `plan_pr.merged`.
- Keep this slice tolerant rather than over-constrained: event writers should
  be deterministic, but the reducer should stay a pure fold over historical
  events and should not require a full workflow engine or lock manager.

Important mapping:

| Event                                                                                   | Read model effect                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `work_item.imported`                                                                    | Records tracker/title/source only; does not set `factoryStage`, so partial logs cannot regress lifecycle state to `incoming`.                                                                                                                                          |
| `triage.started`                                                                        | Records active run metadata only; does not update `factoryStage`, so a later failure cannot strand the read model in `triaging`.                                                                                                                                       |
| `triage.completed` route `ready-to-implement`                                           | Sets `factoryStage=ready-to-implement`, `factoryRoute=ready-to-implement`, `factoryNextAction=implement-directly`, and `factoryRunId=runId`.                                                                                                                           |
| `triage.completed` route `ready-to-plan`                                                | Sets `factoryStage=ready-to-plan`, `factoryRoute=ready-to-plan`, `factoryNextAction=create-plan`, and `factoryRunId=runId`.                                                                                                                                            |
| `triage.completed` route `needs-info`                                                   | Sets `factoryStage=needs-info`, `factoryRoute=needs-info`, `factoryNextAction=ask-human`, and `factoryRunId=runId`.                                                                                                                                                    |
| `triage.completed` route `wait-to-implement`                                            | Sets `factoryStage=wait-to-implement`, `factoryRoute=wait-to-implement`, `factoryNextAction=park`, and `factoryRunId=runId`.                                                                                                                                           |
| `triage.failed`                                                                         | Updates `factoryRunId`, `updatedAt`, and `lastEventId` only; leaves failure details in the JSONL event and leaves prior durable `factoryStage` unchanged because `FACTORY_STAGES` has no triage-failed stage. Operators recover by rerunning triage with a new run id. |
| `planning.started`                                                                      | Records active run metadata only; does not update `factoryStage`, so a process crash cannot strand the read model in `planning`.                                                                                                                                       |
| `planning.completed` status `plan-approved` for supported tracker-backed work           | Sets `factoryStage=plan-pr-open`, `approvedPlanPath`, and `factoryRunId=runId`.                                                                                                                                                                                        |
| `planning.completed` status `plan-approved` for non-tracker or unsupported tracker work | Sets `factoryStage=plan-approved`, `approvedPlanPath`, and `factoryRunId=runId`.                                                                                                                                                                                       |
| `planning.completed` status `plan-needs-human`                                          | Sets `factoryStage=plan-needs-human`, `factoryRunId=runId`, and keeps latest human questions in event data. Clears stale `approvedPlanPrUrl` and `approvedPlanCommit`.                                                                                                 |
| `planning.completed` status `plan-review-unresolved`                                    | Sets `factoryStage=plan-review-unresolved`, `factoryRunId=runId`, and keeps latest unresolved-review details in event data. Clears stale `approvedPlanPrUrl` and `approvedPlanCommit`.                                                                                 |
| `planning.failed`                                                                       | Sets `factoryStage=planning-failed` and `factoryRunId=runId`. Clears stale `approvedPlanPrUrl` and `approvedPlanCommit`; keep prior `approvedPlanPath` only as historical context, not implementation readiness.                                                       |
| `plan_pr.opened`                                                                        | Sets `factoryStage=plan-pr-open`, `approvedPlanPath`, `approvedPlanPrUrl`, and `factoryRunId=runId`. Clears stale `approvedPlanCommit`.                                                                                                                                |
| `plan_pr.merged`                                                                        | Sets `factoryStage=plan-approved`, `approvedPlanPath`, `approvedPlanPrUrl`, `approvedPlanCommit`, and `factoryRunId=runId`.                                                                                                                                            |

Reducer fold rules:

- Process events in JSONL order.
- Each event overlays only the fields named in the mapping above.
- All other `FactoryLifecycleState` fields carry forward from the prior state.
- Publication events must populate `approvedPlanPath`, `approvedPlanPrUrl`, and
  `approvedPlanCommit` from their own event data even if older logs lack a
  preceding `planning.completed` event.
- Publication fields must be replaced or cleared explicitly:
  - `planning.completed` with `status=plan-approved` sets the new
    `approvedPlanPath` and clears stale `approvedPlanPrUrl` and
    `approvedPlanCommit`.
  - `planning.completed` with `status=plan-needs-human` or
    `plan-review-unresolved` clears stale `approvedPlanPrUrl` and
    `approvedPlanCommit`.
  - `planning.failed` clears stale `approvedPlanPrUrl` and
    `approvedPlanCommit`.
  - `plan_pr.opened` sets `approvedPlanPath` and `approvedPlanPrUrl`, and clears
    stale `approvedPlanCommit`.
  - `plan_pr.merged` sets all publication fields.
- For `planning.completed` with `status=plan-approved`, select the stage from
  accumulated `state.tracker`, which is populated by `work_item.imported`.
  Match the publication predicate in `lib/factory-planning-handoff.ts`: only
  `tracker.source === "linear"` or `"github"` requires a plan PR and moves to
  `plan-pr-open`; file/manual work and unsupported tracker sources such as Jira
  reduce to `plan-approved`. Do not call `hasSupportedTracker` on a partial work
  item from inside the reducer. Lifecycle stage selection is source-based only
  and may differ from run `meta.json` for malformed tracker ids; lifecycle state
  is canonical for future station decisions after merge.

## Steps

### Step 1: Add lifecycle schemas, store, and reducer

Create `lib/factory-lifecycle.ts`.

Implement:

- `FactoryLifecycleEventSchema`
- `FactoryLifecycleStateSchema`
- `deriveFactoryWorkItemKey(workItem: FactoryWorkItem): string`
- `workItemKeyToFilename(workItemKey: string): string`
- `resolveFactoryStateRoot(input: { workspace: string; factoryStateRoot?: string }): string`
- `factoryLifecycleEventPath(factoryStateRoot: string, workItemKey: string): string`
- `factoryLifecycleStatePath(factoryStateRoot: string, workItemKey: string): string`
- `readFactoryLifecycleEvents(input): FactoryLifecycleEvent[]`
- `appendFactoryLifecycleEvent(input): FactoryLifecycleEvent`
- `reduceFactoryLifecycleEvents(events): FactoryLifecycleState | undefined`
- `loadFactoryLifecycleState(input): FactoryLifecycleState | undefined`
- `writeFactoryLifecycleState(input): FactoryLifecycleState`
- `mergeFactoryStateIntoWorkItem(workItem, state): FactoryWorkItem`
- `FactoryLifecycleError`

Use `FactoryLifecycleError` for malformed JSONL, invalid event payloads, and
cache/JSONL mismatch failures that should surface to operators.

Store behavior:

- Create directories lazily.
- Parse JSONL line by line.
- Reject malformed existing event lines with a typed error.
- Deduplicate by event `id` on append. If an event with the same `id` already
  exists, return the existing event and do not append another line.
- After append, rebuild and write the state JSON cache.
- Treat `state/*.json` as a disposable cache. If `state.lastEventId` does not
  match the last JSONL event id, rebuild from JSONL.
- Do not implement distributed locking or compare-and-swap in this slice.
- Tests must use isolated temporary `factoryStateRoot` directories. Do not add
  concurrent-write tests or locking in this slice.

Use deterministic event ids where possible:

- `work_item.imported:<workItemKey>`. Later imports for the same work item are
  idempotent no-ops under the dedupe rule.
  This intentionally freezes initial imported title/labels/tracker URL for this
  slice. Add a future `work_item.updated` event only if refresh semantics become
  necessary.
- `triage.started:<runId>`
- `triage.completed:<runId>`
- `triage.failed:<runId>`
- `planning.started:<runId>`
- `planning.completed:<runId>`
- `planning.failed:<runId>`
- `plan_pr.opened:<runId>:<pr-url>`
- `plan_pr.merged:<runId>:<commit>`

`mergeFactoryStateIntoWorkItem` precedence:

- Start from the fetched or file-backed work item.
- Preserve tracker/context fields such as `linearStatus`, `linearProjectId`,
  `linearCommentsIncluded`, labels, title, body, and URL.
- Overlay lifecycle-owned fields from state: `factoryStage`, `factoryRoute`,
  `factoryNextAction`, `factoryRunId`, `approvedPlanPath`,
  `approvedPlanPrUrl`, and `approvedPlanCommit`.
- Overlay only lifecycle fields that are present on the reduced state. Do not
  write `undefined` over Linear/bootstrap metadata; import-only or partial logs
  must retain fallback metadata for unset fields.
- Do not remove unknown metadata keys.
- Lifecycle state wins over Linear-derived lifecycle fields whenever both are
  present.

**Verify**:

```bash
pnpm typecheck
```

Expected: exit 0.

### Step 2: Add reducer and store tests

Create `test/factory-lifecycle.test.ts`.

Cover:

- Work item key derivation for Linear ids, file-only ids, and file-backed work
  items carrying tracker metadata. Tracker metadata wins over file ids.
- `workItemKeyToFilename` for Linear, GitHub-style `github:owner/repo#123`, and
  file-backed ids with path separators; each includes a stable hash suffix.
- JSONL append writes one line and creates the state cache.
- Duplicate event id is idempotent.
- Malformed JSONL line throws a clear lifecycle error.
- Triage route events produce the expected stage and next action.
- Started-then-failed triage does not leave `factoryStage=triaging`; it
  preserves the prior durable stage while recording failure/run data.
- Started-only triage and planning logs with no terminal event do not change
  durable `factoryStage` or `factoryRunId`.
- Started-then-thrown planning does not leave `factoryStage=planning`; the catch
  path appends `planning.failed`, while a missing terminal event preserves the
  prior durable stage.
- Import-only JSONL plus conflicting Linear `factoryStage` keeps the Linear
  fallback stage because reduced lifecycle state has no stage yet.
- Planning approved for tracker-backed work produces `plan-pr-open` plus
  `approvedPlanPath`.
- Planning approved for file/manual work produces `plan-approved` plus
  `approvedPlanPath`.
- Planning approved for unsupported tracker sources such as Jira produces
  `plan-approved`, not `plan-pr-open`.
- Plan PR opened then merged produces `plan-approved` and
  `approvedPlanCommit`.
- `planning.failed`, `plan-needs-human`, and `plan-review-unresolved` after
  `plan_pr.opened` clear stale PR URL/commit readiness fields.
- New `planning.completed` after a prior `plan_pr.merged` clears stale commit
  until a new merge event arrives.
- A second `triage.completed` with a different route is last-write-wins.
- `triage.failed` after prior `triage.completed` preserves the prior durable
  route/stage and records only run/failure bookkeeping.
- `plan_pr.opened` after `plan_pr.merged` clears stale commit and returns to
  `plan-pr-open`.
- Cross-root pathing: with `workspace=/tmp/worktree` and
  `factoryStateRoot=/tmp/control/.harness/factory`, appending writes lifecycle
  files under the factory state root while preserving `execution.workspace` as
  `/tmp/worktree`.
- `mergeFactoryStateIntoWorkItem` overlays lifecycle fields while preserving
  tracker-specific metadata such as `linearStatus`.
- `mergeFactoryStateIntoWorkItem` lifecycle fields win when Linear-derived
  `factoryStage` conflicts with lifecycle state.

Model tests after existing factory tests that use temporary directories, such
as `test/factory-planning-handoff.test.ts`.

**Verify**:

```bash
pnpm test -- test/factory-lifecycle.test.ts
```

Expected: all tests pass.

### Step 3: Write lifecycle events from station commands

Update `bin/factory-commands.ts` and helper modules as needed.

Triage:

- If current inline triage command code makes live lifecycle tests awkward,
  extract named helper boundaries instead of asserting only through commander
  CLI plumbing. Preferred shape: small exported lifecycle writer helpers such as
  `appendFactoryTriageLifecycleEvents`,
  `appendFactoryPlanningLifecycleEvents`, and
  `appendFactoryPlanningPublicationLifecycleEvent`, called from
  `bin/factory-commands.ts`. Prefer a small module such as
  `lib/factory-lifecycle-writes.ts` instead of growing
  `bin/factory-commands.ts`. Keep behavior unchanged.
- After resolving the work item and before live station execution, append
  `work_item.imported` and `triage.started` for non-dry-run runs.
- After successful triage export, append `triage.completed` with route,
  next action, run id, route artifact path, rationale, and questions when
  present.
- After `meta.status === "completed"`, call the existing
  `readFactoryTriageArtifact(meta)` helper for rationale, questions, and route
  details before building the `triage.completed` event.
- Use exact triage artifact mappings from `FactoryRunMeta` after export:
  `triageArtifactPath = meta.artifacts.triage` and
  `routeArtifactPath = meta.artifacts.routeSummary ?? meta.artifacts.route`.
  These paths are run-artifact paths; resolve them relative to
  `execution.runDir` when read later. Do not treat them as
  workspace-relative source files.
- On station failure, append `triage.failed` after `meta.json` exists, with
  run id and error summary.
- Triage failures normally return failed meta through `ctx.exportFailed`; do not
  rely on a catch block. After `await runFactoryTriage(ctx)`, append
  `triage.completed` when `meta.status === "completed"` and `triage.failed`
  when `meta.status === "failed"`, using `meta.error` and artifact paths. Use a
  catch only for pre-meta bootstrap failures where no run id exists.
- Do not append lifecycle events for `--dry-run`.

Planning:

- After resolving the work item and before live planner execution, append
  `work_item.imported` and `planning.started` for non-dry-run runs.
- Wire planning lifecycle appends inside or immediately around the exported
  helpers in `bin/factory-commands.ts`, especially
  `runFactoryPlanningWithLinearApply` and
  `runFactoryPlanningPublicationWithLinearApply`, not only inside Commander
  action handlers. Preserve existing exported signatures and Linear apply
  ordering used by `test/factory-planning-apply-command.test.ts`.
- For Linear apply, append `work_item.imported` and `planning.started` before
  moving the issue to `Planning`; append terminal planning events only after the
  planning run returns meta. Existing Linear status/comment mutation remains a
  projection after station execution.
- In `runFactoryPlanningWithLinearApply`, insert lifecycle appends at the top of
  the helper before `applyPlanningStarted`, using `input.ctx` for
  runId/runDir/workspace. Preserve exported signatures and existing terminal
  Linear apply ordering.
- After the planning run finishes, append:
  - `planning.completed` for `plan-approved`, `plan-needs-human`, and
    `plan-review-unresolved`.
  - `planning.failed` for `planning-failed`.
- Include `approvedPlanPath`, run id, human questions, `reviewFindingsPath`,
  and `planReviewRefPath` when derivable from the latest planning iteration.
  `planReviewRefPath` is not a `FactoryPlanningRunMeta` field; derive it from
  the latest iteration's review reference artifact path, matching the existing
  `iterations/<n>/plan-review-ref.json` layout.
  Store it workspace-relative:
  `relative(meta.workspace, join(meta.runDir, "iterations", String(n), "plan-review-ref.json"))`.
  Use the same workspace-relative convention for `reviewFindingsPath`.
- If planning throws before returning `FactoryPlanningRunMeta`, append
  `planning.failed` from the command/helper catch path. Keep
  `createFactoryPlanningRunContext` outside the inner try so the catch has
  `ctx.runId`, `ctx.runDir`, and `execution.workspace`; append with those values
  before rethrowing. Returned `meta.status === "planning-failed"` uses the
  normal `planning.failed` append path, while terminal success statuses use
  `planning.completed`.
  Target structure:

  ```ts
  const ctx = createFactoryPlanningRunContext(...);
  append work_item.imported + planning.started;
  try {
    const meta = await runPlanning(ctx);
    append planning.completed or planning.failed from meta;
    return meta;
  } catch (error) {
    append planning.failed with ctx.runId, ctx.runDir, execution.workspace;
    throw error;
  }
  ```

- Do not append lifecycle events for `--dry-run`.

Publication:

- In `planning publish`, after local handoff metadata validates and updates,
  append `plan_pr.opened`.
- In `planning mark-plan-merged`, after local handoff metadata validates and
  updates, append `plan_pr.merged`.
- Publication commands start from `runDir`, not a fresh work item input. Derive
  append inputs from loaded planning run meta:
  `workspace = meta.workspace`,
  `factoryStateRoot = resolveFactoryStateRoot({ workspace: meta.workspace })`,
  `workItemKey = deriveFactoryWorkItemKey({ id: meta.workItem.id, source: meta.workItem.source, title: meta.workItem.title, body: "", labels: [], metadata: meta.factoryMetadata })`,
  `execution.workspace = meta.workspace`, `execution.runDir = meta.runDir`, and
  event ids from `meta.runId`.
- Keep existing Linear `--apply` behavior unchanged; Linear status/comment
  changes are projections of the logged state.
- Per-run `meta.json` remains execution evidence. If an edge malformed tracker
  id makes run metadata and lifecycle state disagree, lifecycle state from the
  reducer is canonical for future station decisions after merge.

**Verify**:

```bash
pnpm test -- test/cli.test.ts test/factory-planning-apply-command.test.ts
```

Expected: existing CLI tests pass after updates or new assertions.

### Step 4: Prefer lifecycle read model for input and readiness

Update input resolution so command gates read lifecycle state first.

Target behavior:

- Linear fetch can still include `linearStatus`, issue data, labels, and recent
  comments in the work item body.
- `harness factory linear fetch` should also merge lifecycle state when it
  exists, so operator-visible JSON reflects canonical factory state. Without a
  lifecycle state file, fetch remains a bootstrap/import view derived from
  Linear status and recent comments.
- If lifecycle state exists for the work item key, merge it into
  `workItem.metadata` and use it for planning-entry validation.
- If no lifecycle state exists, keep the current Linear-status fallback so old
  issues still work.
- For `Needs Clarification`, stop depending on recent planning marker comments
  when lifecycle state exists. The read model's `plan-needs-human` state is the
  machine source of truth.

Likely touch points:

- `lib/factory-triage-input.ts` - after work item resolution, load and merge
  lifecycle state.
- `bin/factory-commands.ts` - update the `harness factory linear fetch` handler,
  which currently calls `adapter.fetchWorkItem` directly, to merge lifecycle
  state or call a shared lifecycle merge helper before printing JSON.
- Extract a testable fetch helper, for example `fetchFactoryLinearWorkItem`,
  that accepts an optional Linear adapter factory and performs lifecycle merge.
  `test/cli.test.ts` should exercise that helper or a thin exported action
  wrapper with a fake Linear adapter and seeded lifecycle JSONL; do not require a
  live `LINEAR_API_KEY` for this regression.
- `lib/factory-linear-adapter.ts` - keep Linear metadata, but add a clear code
  comment that `factoryStageForStatus` is a fallback/projection bootstrap, not
  canonical lifecycle state once the lifecycle log exists.
- `lib/factory-planning-input.ts` - no schema change expected; it should receive
  enriched metadata.
- `lib/factory-planning-handoff.ts` - keep metadata validation, but plan for the
  implementation station to call the read model later. Do not rewrite the
  implementation station in this plan.

**Verify**:

```bash
pnpm test -- test/factory-triage-input.test.ts test/factory-linear-adapter.test.ts test/factory-planning-input.test.ts test/factory-planning-handoff.test.ts
```

Expected: all tests pass. Add a regression test that pre-seeds
`.harness/factory/events/<workItemKeyToFilename(key)>.jsonl` with valid
lifecycle events, optionally also writes a matching state cache, and asserts
`harness factory linear fetch` output uses replayed lifecycle metadata over
Linear-derived fallback metadata.

### Step 5: Documentation sweep and operator skill update

Do a documentation sweep, not just a narrow setup-manifest edit. This state
ownership change affects how operators, future implementers, and future
orchestrators understand the factory.

Update when applicable:

- `README.md` - update only if the public factory overview or docs index needs
  to mention the lifecycle log at the top level.
- `docs/contributing/index.md` - keep contributor navigation aligned if new or
  renamed docs sections are added.
- `docs/contributing/factory.md`
- `docs/contributing/architecture.md`
- `docs/contributing/script-command-surface.md` only if command semantics change.
- `docs/contributing/setup-manifest.md`
- `docs/project-intent.md` only if the generated-artifact ownership rule needs
  clarification. Keep it generic and avoid target-repo examples.
- `skills/factory-operator/SKILL.md`
- `dev/plans/README.md` - move this plan from `ready` to `in_progress` when
  implementation starts, then follow the README completion rule when the PR
  lands.

Search and reconcile stale wording:

- `rg -n "Linear status|marker comment|factoryStage|approvedPlanPath|approvedPlanCommit|meta.json|source of truth|plan-pr-open|plan-approved" README.md docs skills dev/plans`
- Replace any machine-state wording that still makes Linear comments, Linear
  statuses, or run `meta.json` canonical.
- Keep wording clear that Linear is the human board/projection, Git is the
  committed artifact/code source, and `.harness/factory/events/*.jsonl` is the
  local factory lifecycle source of truth.
- Do not update archived or unrelated plans unless they would actively confuse
  the next factory executor. Prefer a short "superseded by lifecycle log" note
  over broad historical rewrites.

Document:

- `.harness/factory/events/*.jsonl` is the canonical local lifecycle log.
- `.harness/factory/state/*.json` is a cache/projection rebuilt from events.
- `.harness/factory/events/*.jsonl` and `.harness/factory/state/*.json` are
  generated local state and must not be committed.
- `docs/contributing/setup-manifest.md` must list explicit rows for
  `.harness/factory/events/*.jsonl` and `.harness/factory/state/*.json`,
  including created-by commands, ignored commit policy, and notes that JSONL is
  canonical while state is rebuildable.
- Suggested setup-manifest row content:
  - `.harness/factory/events/*.jsonl` - created by live
    `harness factory ...` station commands; canonical local lifecycle event log;
    ignored and never committed.
  - `.harness/factory/state/*.json` - created/rebuilt by lifecycle store helper;
    read-model cache derived from JSONL; ignored and safe to delete/rebuild.
- Linear statuses/comments are human-visible projections.
- Run `meta.json` remains execution evidence, not per-work-item truth.
- Git remains source of truth for committed plan files/code.
- Inngest later should call station helpers/CLI and append lifecycle events; it
  does not own factory lifecycle truth.
- SQLite is deferred until query/concurrency needs justify it.
- Future implementation-station docs should say readiness comes from the
  lifecycle read model, not from parsing tracker comments.
- Future worktree docs should say station commands may run in a worktree while
  lifecycle storage points at a shared `factoryStateRoot`.

**Verify**:

```bash
pnpm test -- test/docs-contracts.test.ts
```

Expected: docs contract tests pass. Extend `test/docs-contracts.test.ts` or add
a focused docs contract test so verification fails unless
`docs/contributing/setup-manifest.md` includes the lifecycle event and state
artifact rows with created-by, ignore policy, and canonical/cache notes. Add
docs-contract assertions for any new public command-surface or setup-manifest
requirements introduced by the implementation.

### Step 6: Run full verification and review

Run:

```bash
pnpm check
```

Expected: exit 0.

Then run the change review workflow before opening a PR:

```bash
printf '%s\n' "<self-contained handoff>" | node bin/harness.ts run change-review --workspace "$PWD" --base main --head HEAD --handoff-stdin --verbose
```

Expected: reviewers either pass or findings are triaged, fixed, and re-reviewed.

## Test plan

New tests:

- `test/factory-lifecycle.test.ts`
  - event schema validation
  - append/read/reduce
  - idempotent duplicate event id
  - stable extensionless filename-stem sanitization with hash suffix
  - state projection for triage/planning/publish/merge
  - cross-root `workspace` vs `factoryStateRoot`
  - lifecycle-state merge into work item metadata

Updated tests:

- `test/cli.test.ts`
  - station commands write lifecycle events for live runs, not dry runs.
  - publish/mark-plan-merged writes expected events.
  - `harness factory linear fetch` output merges pre-seeded lifecycle events over
    Linear-derived fallback metadata.
- `test/factory-triage-input.test.ts`
  - resolver-level lifecycle merge: seed lifecycle JSONL events, resolve with a
    fake Linear adapter returning conflicting `factoryStage`, and assert
    lifecycle metadata wins.
- `test/factory-linear-adapter.test.ts`
  - Linear status mapping remains fallback.
  - lifecycle state overrides fallback when present.
- `test/factory-planning-input.test.ts`
  - planning accepts lifecycle-derived `plan-needs-human` without relying on
    recent marker comments.
- `test/factory-planning-apply-command.test.ts`
  - existing Linear projections still happen after lifecycle event writes.

Full verification:

```bash
pnpm check
```

Expected: typecheck, lint, format check, and tests pass.

## Done criteria

- [ ] `.harness/factory/events/<workItemKeyToFilename(work-item-key)>.jsonl`
      is written by live triage, planning, publish, and mark-plan-merged paths.
- [ ] `.harness/factory/state/<workItemKeyToFilename(work-item-key)>.json` is
      derived from events and treated as a rebuildable cache.
- [ ] Lifecycle helper paths are derived from `factoryStateRoot`, defaulting to
      `<workspace>/.harness/factory`.
- [ ] Lifecycle events preserve execution context separately from lifecycle
      storage location.
- [ ] Existing Linear issue fetches still provide issue description, labels,
      and recent comments to agents.
- [ ] Existing Linear status/comment mutations still work as human board
      projections.
- [ ] Planning-entry validation prefers lifecycle state when present.
- [ ] Recent Linear marker comments are no longer required for machine
      lifecycle state when a lifecycle log exists.
- [ ] `pnpm check` exits 0.
- [ ] `dev/plans/README.md` status row stays accurate.

## STOP conditions

Stop and report if:

- Adding lifecycle reads requires changing provider/session logic.
- The event store needs cross-process locking to pass tests.
- The implementation requires adding SQLite or another dependency.
- Existing Linear `--apply` live behavior would change in a way not covered by
  this plan.
- A command would need to mutate Linear in dry-run mode.
- Plan PR publication semantics need GitHub API integration.
- The implementation requires building, detecting, or managing git worktrees.

## Maintenance notes

- This is the local source-of-truth slice only. Future Inngest work should
  reuse the same lifecycle append/reducer helpers inside durable steps.
- Future worktree support should pass a shared `factoryStateRoot` pointing at
  the control checkout's `.harness/factory`. Never key lifecycle storage on a
  worktree path.
- Workspace-relative artifacts from events resolve against
  `execution.workspace`, not against `factoryStateRoot`.
- Do not make Linear comments canonical again. They are for humans and dedupe,
  not machine state.
- If JSONL replay becomes slow or cross-work-item queries become important,
  add SQLite as a projection/index, not as a replacement for the event contract
  unless a separate migration plan explicitly changes ownership.
- Concurrent commands for the same work item are unsupported in this slice. If
  concurrent writes corrupt or desync the state cache, recover by deleting the
  affected `state/*.json` cache and replaying the JSONL event log; then rerun the
  station if the event log itself is incomplete.
- If `FactoryLifecycleError` reports a malformed/corrupt event log, operators
  may archive or delete the affected events file and rely on Linear bootstrap
  state until stations rewrite lifecycle events. Do not add automatic repair in
  this slice.
- Initial `work_item.imported` metadata is idempotent. If future operators need
  title/label/tracker URL refresh after import, add a new `work_item.updated`
  event instead of changing import dedupe semantics.
- The implementation station should consume `FactoryLifecycleState` for
  `approvedPlanPath` and `approvedPlanCommit` after this lands.
