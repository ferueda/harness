# Linear planning apply integration

Status: `approved`

## Goal

Add explicit Linear write mode for the planning station without making the
station responsible for plan PR publication or implementation readiness.

After this slice, an operator can run:

```bash
harness factory planning run --workspace /path/to/repo --linear-issue ENG-123 --apply
```

The command should:

- fetch the Linear issue as the planning work item
- accept only `Needs Plan` or `Planning Failed`
- move the issue to `Planning` before provider/reviewer work starts
- run the existing planning/review loop unchanged
- post one deterministic Linear outcome comment
- move failures or human-blocked outcomes to the configured attention status

It should not move the issue to `Ready to Implement`. That belongs to the plan
merge handoff after the plan PR exists and the approved plan commit is known.

## Context

Implemented already:

- Linear read adapter and `harness factory linear fetch`
- Linear-backed triage input and triage `--apply`
- Linear-backed planning input
- repo-backed approved plan output under `dev/plans/<tracker-key>.md`
- local plan PR handoff commands:
  - `harness factory planning publish`
  - `harness factory planning mark-plan-merged`

Current gap:

- planning from Linear is read-only toward Linear
- a live planning run does not show `Planning` on the Linear board
- terminal planning results require the operator to infer what happened from
  local artifacts

Prerequisite:

- Linear project scoping must be in place before this runtime slice lands.
  `factory.linear.projectId` should reject issues outside the target repo
  project before any planning apply mutation runs.

## Non-Goals

- no GitHub PR creation
- no direct commit to `main`
- no full plan body copied into Linear
- no Inngest/webhook orchestration
- no implementation station
- no backlog batch processing
- no `Ready to Implement` movement from `planning run --apply`
- no mutation for `planning publish` or `mark-plan-merged` in this slice

## Skills for the executor

| Skill                    | Why                                                                       |
| ------------------------ | ------------------------------------------------------------------------- |
| `typescript-refactor`    | Type the Linear adapter methods and CLI output without widening to `any`. |
| `vitest`                 | Add focused adapter and CLI validation tests.                             |
| `zod`                    | Keep metadata/status parsing at command boundaries explicit.              |
| `factory-operator`       | Preserve station semantics and Linear board policy.                       |
| `change-review-workflow` | Review the final implementation before PR.                                |

## Design

### CLI

Add `--apply` to `harness factory planning run`.

Validation:

- `--apply` requires `--linear-issue`
- `--apply` rejects `--item-file`
- `--apply` rejects `--dry-run`
- source validation still runs before role/config resolution
- Linear config and `LINEAR_API_KEY` errors remain specific

JSON output should include the existing planning output plus optional Linear
apply data, following the triage output pattern:

```json
{
  "runId": "20260707-120000",
  "workflow": "factory-planning",
  "status": "plan-approved",
  "linearApplied": true,
  "linearUpdate": {
    "started": {
      "issueIdentifier": "ENG-123",
      "stage": "start",
      "fromStatus": "Needs Plan",
      "targetStatus": "Planning"
    },
    "terminal": {
      "issueIdentifier": "ENG-123",
      "stage": "complete",
      "fromStatus": "Planning",
      "targetStatus": "Planning",
      "commentMarker": "<!-- harness-factory:planning-apply:20260707-120000 -->"
    }
  }
}
```

For Linear-backed non-apply runs, keep `linearApplied: false` if the command
already exposes a Linear-specific field; otherwise do not add a field only for
read-only mode.

### Adapter

Extend `LinearFactoryAdapter` with planning methods mirroring triage:

```ts
type LinearPlanningApplyStage = "start" | "complete" | "failed";

type LinearPlanningApplyInput = {
  issueRef: string;
  runId: string;
  runDir: string;
};

type LinearPlanningCompletedInput = LinearPlanningApplyInput & {
  status: FactoryPlanningRunStatus;
  approvedPlanPath?: string;
  humanQuestions?: string[];
  error?: string;
};

type LinearPlanningFailedInput = LinearPlanningApplyInput & {
  error: string;
};

applyPlanningStarted(input: LinearPlanningApplyInput): Promise<LinearPlanningUpdatePlan>
applyPlanningCompleted(input: LinearPlanningCompletedInput): Promise<LinearPlanningUpdatePlan>
applyPlanningFailed(input: LinearPlanningFailedInput): Promise<LinearPlanningUpdatePlan>
```

The CLI may pass `FactoryPlanningRunMeta` through a small helper that narrows it
to `LinearPlanningCompletedInput`; the adapter should not depend on the full
run meta shape.

Meta mapping:

| Adapter input      | Source                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------- |
| `status`           | `meta.status`                                                                                |
| `approvedPlanPath` | `meta.factoryMetadata?.approvedPlanPath`, then workspace-relative `meta.outputPlan` fallback |
| `humanQuestions`   | `meta.humanQuestions`                                                                        |
| `error`            | `meta.error`                                                                                 |

Call `applyPlanningCompleted` for every non-throw terminal planning status.
Reserve `applyPlanningFailed` for thrown command errors after
`applyPlanningStarted` succeeds.

Use explicit marker helpers:

```ts
linearPlanningApplyCommentMarker(runId);
linearPlanningApplyFailedCommentMarker(runId);
```

Use a planning-apply namespace so these comments do not collide with the
existing manual publish handoff renderer:
`harness-factory:planning-apply:<run-id>` for completed outcomes and
`harness-factory:planning-apply-failed:<run-id>` for thrown failures.
Keep publish-handoff markers (`harness-factory:planning:` and
`harness-factory:planning-approved:`) separate.

Planning apply entry guard:

- accept configured `needsPlan`
- accept configured `planningFailed`
- reject every other status before mutation

Started behavior:

- validate status map
- fetch issue
- verify team
- move to configured `planning`

Completed behavior:

| Factory planning status    | Linear target     | Comment purpose                                      |
| -------------------------- | ----------------- | ---------------------------------------------------- |
| `plan-approved`            | `Planning`        | Plan ready; open/register/merge plan PR next.        |
| `plan-needs-human`         | `Needs Info`      | Human questions from the planner/reviewer loop.      |
| `plan-review-unresolved`   | `Planning Failed` | Review did not pass within the station loop.         |
| `planning-failed`          | `Planning Failed` | Station failed; include concise error text.          |
| thrown after apply started | `Planning Failed` | Command failed after moving the issue to `Planning`. |

- `plan-approved`
  - keep or move to configured `planning`
  - post `Factory plan ready` marker comment from a dedicated apply renderer
  - include `approvedPlanPath`, run dir, and next action:
    `Open/register a plan PR, merge it, then mark the plan merged.`
  - do not require `approvedPlanPrUrl`
- `plan-needs-human`
  - move to configured `needsInfo`
  - post comment with human questions when present
- `plan-review-unresolved`
  - move to configured `planningFailed`
  - post comment explaining review did not pass within the station loop
- `planning-failed`
  - move to configured `planningFailed`
  - post comment with the error
- `dry_run` should never reach apply mode because CLI rejects it

Failed behavior:

- use when the command throws after the issue has been moved to `Planning`
- move to configured `planningFailed`
- post a failure marker comment with the error

Idempotency:

- use stable marker comments keyed by run id
- check recent comments before posting, same as triage
- skip status update when already at target

Do not reuse `renderLinearPlanningReadyComment` for planning apply. That
renderer belongs to the manual `planning publish` handoff and requires
`approvedPlanPrUrl`. Add a separate apply renderer without PR URL input.

### Command Flow

The planning command should follow triage apply shape:

1. validate flags
2. resolve factory planning settings and roles
3. resolve Linear settings when `--linear-issue` is present
4. resolve the work item using the same `linearAdapterFactory` reuse pattern as
   triage so fetch and apply share one adapter instance
5. assert planning entry status
6. create planning run context
7. if `--apply`, call `applyPlanningStarted`
8. run `runFactoryPlanning(ctx)`
9. if `--apply`, call `applyPlanningCompleted`
10. if the run throws after start, call `applyPlanningFailed`, then rethrow

Terminal apply errors after a successful planning run should mirror triage:
catch the terminal Linear mutation error, print JSON with
`linearApplied: true` and partial `linearUpdate: { started, terminal }`, then
throw the terminal apply error after printing. Operators must still receive the
local planning run metadata when the Linear terminal mutation fails.

If a process crashes after moving Linear to `Planning`, the next retry should
fail closed because `Planning` is not an allowed entry status. The operator must
inspect the run artifacts and manually reset the issue to `Needs Plan` or
`Planning Failed` before rerunning.

Do not create a separate orchestrator abstraction in this slice.

## Implementation Steps

1. Update types and renderers in `lib/factory-linear-adapter.ts`.
   - Add planning update input/output types.
   - Add planning marker helpers.
   - Add status target mapping for planning run statuses.
   - Prefer extracting marker/render/target-status helpers into
     `lib/factory-linear-planning-apply.ts` if adding them inline would push
     `lib/factory-linear-adapter.ts` past the repository LOC guideline.
   - Keep comment text short and deterministic.

2. Add adapter planning mutations.
   - Reuse existing helpers: status-map validation, issue fetch, team guard,
     workflow-state fetch, comment marker dedupe.
   - Add and export `assertLinearPlanningApplyAllowed` for allowed planning
     entry statuses.

3. Wire CLI apply mode in `bin/factory-commands.ts`.
   - Add `apply?: boolean` to planning options.
   - Add `.option("--apply", ...)`.
   - Validate bad flag combinations before role/config resolution.
   - Extract or reuse a shared `validateFactoryApplyOptions` helper instead of
     duplicating triage validation logic under a second shape.
   - Reuse the triage `linearAdapterFactory` and `requireLinearApplyAdapter`
     pattern so input fetch and mutations share one adapter instance.
   - Include Linear apply results as `linearUpdate: { started, terminal }` in
     the JSON output.
   - Prefer extracting `bin/factory-planning-cli.ts` with
     `FactoryPlanningLinearUpdate` types, mirroring `bin/factory-triage-cli.ts`,
     instead of leaving the new output contract inline.
   - Preserve existing exit-code behavior.

4. Update docs.
   - `README.md`
   - `docs/contributing/factory.md`
   - `docs/contributing/script-command-surface.md`
   - `docs/contributing/architecture.md`
   - `docs/contributing/setup-manifest.md` if auth wording changes
   - `skills/factory-operator/SKILL.md`

5. Update tests.
   - Adapter tests for:
     - accepted start statuses
     - rejected start statuses
     - `assertLinearPlanningApplyAllowed`
     - approved plan comment and `Planning` terminal status
     - needs-human to `Needs Info`
     - unresolved/failure to `Planning Failed`
     - duplicate comment suppression
   - Extend `test/factory-linear-test-helpers.ts` with default throw stubs for
     the new planning apply methods so existing Linear input tests compile.
   - CLI tests for:
     - add `test/factory-planning-cli.test.ts`, mirroring
       `test/factory-triage-cli.test.ts`
     - `factoryPlanningCliOutput` omits `linearApplied` on read-only runs
     - `factoryPlanningCliOutput` includes `linearUpdate: { started, terminal }`
       on apply runs
     - help includes `--apply`
     - `--apply` requires `--linear-issue`
     - `--apply` rejects `--dry-run`
     - `--apply` rejects `--item-file`
     - source validation still wins over role/config errors
     - thrown planning run after `applyPlanningStarted` invokes
       `applyPlanningFailed`, records the failure marker, and rethrows

6. Verification.
   - `pnpm exec vitest run test/factory-linear-adapter.test.ts test/cli.test.ts`
   - `pnpm exec vitest run test/factory-planning-input.test.ts`
   - `pnpm exec vitest run test/docs-contracts.test.ts`
   - `pnpm typecheck`
   - `pnpm check`
   - add a `scripts/smoke-dist.ts` assertion that
     `harness factory planning run --help` includes `--apply`

7. Live smoke with a disposable Linear issue after unit checks pass.
   - Create or reuse a disposable issue in `Needs Plan`.
   - Confirm `--dry-run --apply` rejects without mutating.
   - Run `harness factory planning run --linear-issue <issue> --apply`.
   - Verify the issue reaches `Planning` for approved-plan output or the
     expected attention status for blocked/failure output.
   - Verify exactly one marker comment for the run.

## Done Criteria

- Linear planning apply is explicit, opt-in, and rejected for dry-runs.
- `Needs Plan | Planning Failed -> Planning` is applied before planner work.
- Terminal comments are deterministic and concise.
- Planning apply never moves Linear to `Ready to Implement`.
- Existing read-only planning behavior remains unchanged.
- Tests and docs cover the new command surface.
- `change-review-workflow` passes or every finding is triaged and resolved.

If `lib/factory-linear-adapter.ts` grows beyond the repository LOC guideline,
extract planning marker/render/target-status helpers into a focused module
instead of further growing the adapter.

## Follow-Up

Next slice: Linear plan merge handoff apply.

That should add an explicit mutation path for
`harness factory planning mark-plan-merged --apply` so the operator can move a
Linear issue to `Ready to Implement` only after `approvedPlanCommit` exists.
