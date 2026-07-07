# Plan 260707-linear-plan-pr-handoff: Make Linear planning handoff use plan PRs

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the next
> step. If anything in the "STOP conditions" section occurs, stop and report.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: Linear read-only triage input. STOP before Step 1 unless the
  current branch contains `lib/factory-triage-input.ts` and
  `harness factory triage --help` includes `--linear-issue`.
- **Category**: workflow

## Why this matters

Tracker-backed planning needs a durable handoff that a later implementation
station can read from `main`. A local uncommitted `dev/plans/*.md` file is not a
safe handoff, and storing full plans in Linear comments makes Linear the artifact
store. The agreed model keeps the approved plan as a repo artifact, but publishes
it through a small plan PR before Linear moves to `Ready to Implement`.

## Current state

Relevant files:

- `lib/factory-planning-run-context.ts` writes an approved plan to
  `dev/plans/<date-slug>.md` inside the current workspace. It does not create a
  branch, commit, or PR.
- `lib/factory-schemas.ts` has flat metadata keys `approvedPlanPath`,
  `approvedPlanPrUrl`, and `approvedPlanCommit`, and already accepts
  `factoryStage: "plan-pr-open"`.
- Contributor docs and todos now describe the target model: tracker-backed plans
  use stable tracker-key filenames, move through `plan-pr-open`, and require a
  merged plan PR before implementation.
- Runtime code still needs the target behavior: tracker-key filename derivation,
  run metadata/summary patch helpers, stage decoupling, publication commands,
  and planned-work validation.
- Current Linear integration is read-only for fetch/triage input. Linear status
  and comment mutation are future work.

Agreed design:

```text
Linear issue FER-123
  -> planning station drafts/reviews
  -> approved plan written to dev/plans/FER-123.md
  -> operator opens plan PR manually
  -> operator runs harness factory planning publish --run-dir ... --pr-url ...
  -> Linear comment can link plan path and PR
  -> plan PR merges
  -> operator runs harness factory planning mark-plan-merged --run-dir ... --commit ...
  -> Linear moves to Ready to Implement
  -> implementation reads dev/plans/FER-123.md from main
```

Invariant:

```text
Linear status Ready to Implement after planning means the approved plan exists on main.
```

## Commands you will need

| Purpose       | Command                                                                                           | Expected on success |
| ------------- | ------------------------------------------------------------------------------------------------- | ------------------- |
| Focused tests | `pnpm exec vitest run test/factory-planning*.test.ts test/cli.test.ts`                            | all pass            |
| Typecheck     | `pnpm typecheck`                                                                                  | exit 0              |
| Full gate     | `pnpm check`                                                                                      | exit 0              |
| Plan review   | `node bin/harness.ts run plan-review --plan dev/plans/260707-linear-plan-pr-handoff.md --verbose` | verdict pass        |

## Suggested executor toolkit

| Skill                                                                 | Use for                                         |
| --------------------------------------------------------------------- | ----------------------------------------------- |
| `typescript-refactor` (`.agents/skills/typescript-refactor/SKILL.md`) | Type-safe metadata and command-surface changes. |
| `vitest` (`.agents/skills/vitest/SKILL.md`)                           | Planning station and CLI tests.                 |

## Constraints

- Current behavior and planned work must stay clearly separated in docs.
- Provider-specific behavior belongs behind adapters; workflows should stay
  provider-agnostic.
- Runtime schemas and exported schemas must stay aligned when either side
  changes.
- Linear mutation and GitHub PR creation belong in adapter/command layers, not
  inside planner agent prompts.
- This slice is manual-first: it delivers tracker-key plan files, metadata
  update commands, validation helpers, and comment-template helpers. Live Linear
  comment posting and Linear status moves remain a future apply slice.
- The current `factory-operator` skill stops before mutating Linear/GitHub/Jira
  or Inngest; preserve that boundary unless a later apply plan explicitly
  changes it.

Intent constraints from `docs/project-intent.md` and `docs/contributing/factory.md`:

- Durable docs must stay generic and standalone; use target-repo examples, not
  private downstream repo assumptions.
- Current behavior and planned work must be clearly separated.
- Provider-specific details belong behind adapters; workflows should stay
  provider-agnostic.
- Runtime schemas and exported schemas must stay aligned when either side
  changes.
- Linear status moves and live Linear comment posting remain future apply work
  in this slice.

## Scope

In scope:

- `lib/factory-planning-run-context.ts`
- `lib/factory-schemas.ts`
- `bin/factory-commands.ts`
- `lib/factory-linear-adapter.ts` only when adding Linear planning comments/status
- pure planning-publication helpers under `lib/`
- `scripts/smoke-dist.ts`
- planning/CLI tests under `test/`
- `README.md`
- docs under `docs/contributing/`, `skills/factory-operator/`, and `dev/todo/`

Out of scope:

- Direct commits to `main`.
- Making Linear comments or attachments the canonical full plan store.
- Posting live Linear comments or moving Linear statuses.
- Automatically creating GitHub PRs.
- Object storage for `.harness/runs`.
- Implementation station automation.
- Inngest webhook/runtime code.

## Steps

### Step 1: Normalize tracker-backed plan filenames

Make tracker-backed planning default to `dev/plans/<tracker-key>.md`, for
example `dev/plans/FER-123.md`. Keep `--output-plan` as the explicit override.
For local/manual items without tracker metadata, keep the existing date/title
fallback.

Tracker-key rules:

- A work item is tracker-backed when `workItem.metadata.tracker` is present and
  shaped with a supported `source` and `id`. Only `linear` and `github` are
  supported for tracker-key paths in this slice. Tracker metadata with `jira`,
  `file`, `manual`, or malformed ids should fail closed with a clear error
  instead of guessing a filename. Tracker-backed items use tracker filenames and
  the plan PR gate. Local/manual items without tracker metadata keep the
  existing date/title fallback and do not enter `plan-pr-open`.
- Linear tracker metadata uses `metadata.tracker.id` directly, for example
  `FER-123`. Reuse or align with the existing Linear identifier parser in
  `lib/factory-linear-adapter.ts`: lowercase input and single-letter team keys
  accepted by Linear fetch should still map to an uppercase tracker filename.
- GitHub tracker metadata shaped as `owner/repo#123` maps to `GH-123`.
  Acceptance rule: `^[-.A-Za-z0-9_]+/[-.A-Za-z0-9_.]+#\d+$`. Reject shapes
  such as `repo#123`, `owner/repo`, or `owner/repo#abc`.
- Other tracker sources should fail with a clear error until explicitly mapped.
- Preserve tracker-key casing in the filename.
- Bypass `safeSlug` for tracker-key paths after validating the key with
  source-specific path-safe parsing:
  - Linear: same accepted shape as Linear issue identifiers, normalized to
    uppercase `<TEAM>-<number>`.
  - GitHub: `owner/repo#123` only, normalized to `GH-123`.
- Keep `deriveFactoryWorkItemPlanSlug` for local/manual date-slug fallback only.
  Remove tracker-aware slugging from this helper once `deriveTrackerPlanPath`
  exists, so there is only one tracker filename derivation path.

Add one helper for this, for example `deriveTrackerPlanPath(workItem)` near the
existing planning path logic or near `deriveFactoryWorkItemPlanSlug`, then use
it from `resolveOutputPlan`.

Wire the path resolver explicitly:

- change `resolveOutputPlan` to accept the `FactoryWorkItem` or a pre-resolved
  tracker key instead of only a title-derived slug
- call `deriveTrackerPlanPath` from `resolveOutputPlan` before the local/manual
  date-slug fallback
- update `writeFinalPlan` to pass the work item into `resolveOutputPlan`
- keep explicit `--output-plan` as the highest-priority override

Preserve the planner draft/review loop under `.harness/runs/factory/<run-id>/`.
Only the final approved plan should be copied into `dev/plans`.

Replanning policy:

- Keep the existing no-overwrite guard.
- If `dev/plans/<tracker-key>.md` already exists, fail closed with a clear
  message that tells the operator to use `--output-plan` for an explicit replan
  path or manually remove/supersede the old plan.

**Verify**:

```bash
pnpm exec vitest run test/factory-planning.workflow.test.ts test/factory-planning.workflow-failures.test.ts test/factory-planning-output-schema-sync.test.ts
```

Expected: all tests pass, including new filename coverage for Linear tracker
metadata and the existing failure-path test updated away from
`YYMMDD-gh-123-fix-export-crash.md`.

### Step 2: Add shared planning handoff metadata helpers

Add one shared helper path that owns loading, validating, patching, and
summarizing planning handoff metadata. Do not duplicate ad hoc `meta.json`
parsing in command handlers. Put these helpers in
`lib/factory-planning-handoff.ts`, then import them from the planning run
context, CLI commands, and future validation callers.

Recommended shape:

```ts
FactoryPlanningRunMetaSchema
loadFactoryPlanningRunMeta(runDir): FactoryPlanningRunMeta
updateFactoryPlanningHandoff(runDir, patch): FactoryPlanningRunMeta
renderFactoryPlanningSummary(meta): string
```

The helpers should:

- validate the loaded `meta.json` before mutation
- apply only the supported handoff metadata patch fields
- rewrite `meta.json`
- rewrite `summary.md` using the same summary renderer as live planning runs
- return the updated typed metadata for CLI JSON output

Validation contract:

- `FactoryPlanningRunMetaSchema` should validate at least `workflow`,
  `status`, `workspace`, `runDir`, `outputPlan`, and `factoryMetadata`.
- The schema should be a partial/picked runtime validator over the existing
  exported `FactoryPlanningRunMeta` shape, not a divergent replacement type.
- `loadFactoryPlanningRunMeta` should parse `meta.json` with that schema and
  reject incompatible `factoryMetadata` before patching.
- `publish` requires `workflow === "factory-planning"`,
  `status === "plan-approved"`, `factoryMetadata.approvedPlanPath`, and no
  obviously invalid `factoryMetadata.factoryStage`.
- `mark-plan-merged` requires the same base fields plus
  `factoryMetadata.approvedPlanPrUrl`.
- Invalid run metadata should fail before writing and produce a typed,
  actionable factory/planning error for the CLI to print.

Summary output must include the handoff fields operators need:

- extract the current private `renderSummary` in
  `lib/factory-planning-run-context.ts` into `renderFactoryPlanningSummary`
- current planning run status
- current `factoryMetadata.factoryStage`
- approved plan path
- plan PR URL when present
- approved plan commit when present
- next action text:
  - `plan-pr-open` without PR URL: open a plan PR, then register it with
    `publish`
  - `plan-pr-open` with PR URL: merge the plan PR, then register the commit with
    `mark-plan-merged`
  - `plan-approved` with commit: ready for future tracker move to
    `Ready to Implement`

Wire existing metadata fields during the planning/PR handoff:

- `approvedPlanPath`: repo-relative plan path, e.g. `dev/plans/FER-123.md`
- `approvedPlanPrUrl`: plan PR URL while the plan is awaiting merge
- `approvedPlanCommit`: merge commit or commit pin after the plan lands

Stage rules:

- only override the stage for successful tracker-backed approvals:
  `status === "plan-approved"` and supported tracker metadata present
- after planner approval: `FactoryPlanningRunStatus` may remain `plan-approved`
  as the station outcome, but exported `factoryMetadata.factoryStage` must be
  `plan-pr-open` for tracker-backed runs until a merge commit is recorded.
  At this point `approvedPlanPrUrl` may be absent; that is the normal
  "plan file exists locally, PR not registered yet" intermediate state.
- tracker metadata presence controls the plan PR gate even when the operator
  used `--output-plan`; explicit output paths do not bypass `plan-pr-open`
- local/manual items without tracker metadata keep
  `factoryStage: "plan-approved"` on planner approval
- all other terminal statuses must preserve the current `planningStage(status)`
  mapping, including `planning-failed`, `plan-needs-human`, and
  `plan-review-unresolved`
- after plan PR merge and commit capture: `factoryStage = "plan-approved"`
- planned work must not be considered `Ready to Implement` until
  `approvedPlanCommit` exists

Update `planningStage`, `buildFactoryMetadata`, or a new planning metadata
builder so run status and handoff stage are decoupled. Existing tests in
`test/factory-planning.workflow-failures.test.ts` that currently expect
`factoryStage: "plan-approved"` at workflow end should be updated to expect
`plan-pr-open` for tracker-backed planning. Add or preserve failure-path
metadata expectations for `planning-failed`, `plan-needs-human`, and
`plan-review-unresolved`.

**Verify**:

```bash
pnpm typecheck
pnpm exec vitest run test/factory-planning*.test.ts
```

Expected: exit 0.

### Step 3: Add manual plan PR publication flow

First restructure `harness factory planning` into a command group so publication
subcommands do not inherit the station command's required options. The final
command tree should be:

```bash
harness factory planning [run] --workspace /path/to/repo --item-file work-item.json
harness factory planning publish --run-dir .harness/runs/factory/<run-id> --pr-url <url>
harness factory planning mark-plan-merged --run-dir .harness/runs/factory/<run-id> --commit <sha>
```

Implementation guidance:

- move the current planning station options/action onto a `run` subcommand
- create the `run` subcommand with Commander 15's `{ isDefault: true }`, so the
  existing `harness factory planning --item-file ...` invocation keeps working
- keep `publish` and `mark-plan-merged` as sibling subcommands with only their
  own required options
- do not leave required `--item-file` or `--workspace` options on the parent
  `planning` group if that makes publication commands inherit them

`publish`:

```text
load run meta.json
  -> require status plan-approved and approvedPlanPath
  -> validate --pr-url
  -> set approvedPlanPrUrl
  -> set factoryStage=plan-pr-open
  -> rewrite meta.json and summary.md
  -> print JSON with factoryMetadata and suggested Linear comment text
```

`mark-plan-merged`:

```text
load run meta.json
  -> require approvedPlanPath and approvedPlanPrUrl
  -> validate --commit is non-empty
  -> set approvedPlanCommit
  -> set factoryStage=plan-approved
  -> rewrite meta.json and summary.md
  -> print JSON with factoryMetadata and suggested Linear completion comment text
```

CLI output contract for both publication commands:

```json
{
  "runId": "20260707-120000",
  "runDir": ".harness/runs/factory/20260707-120000",
  "factoryMetadata": {
    "factoryStage": "plan-pr-open",
    "approvedPlanPath": "dev/plans/FER-123.md",
    "approvedPlanPrUrl": "https://github.com/owner/repo/pull/123",
    "approvedPlanCommit": "abc1234"
  },
  "linearComment": "..."
}
```

The operator creates the plan PR manually using normal git/GitHub tooling for
now. Direct commits to `main` are not allowed. Automatic PR creation can come
later after we choose a GitHub adapter or a `gh` wrapper.

Update command-surface coverage:

- `test/cli.test.ts` should assert help for both nested subcommands.
- Existing `test/cli.test.ts` assertions for `--item-file`, `--output-plan`,
  and `--dry-run` should move from parent `harness factory planning --help` to
  `harness factory planning run --help`, unless Commander intentionally keeps
  default-subcommand flags visible on parent help and the test documents that
  behavior.
- Add a regression test proving `harness factory planning --item-file ...`
  still routes to the default `run` subcommand.
- `scripts/smoke-dist.ts` should smoke-check generated help for
  `harness factory planning run --help`,
  `harness factory planning publish --help` and
  `harness factory planning mark-plan-merged --help`.
- Existing `scripts/smoke-dist.ts` assertions for `--item-file`,
  `--output-plan`, and `--dry-run` should move to the run subcommand help.
- `README.md`, `docs/contributing/factory.md`, and
  `skills/factory-operator/SKILL.md` should show the manual sequence:
  planning run -> manual plan PR -> `publish` -> merge PR ->
  `mark-plan-merged`.
- `docs/contributing/script-command-surface.md` should list the nested planning
  subcommands under the Source CLI row, Factory artifact writing row, and
  generated-help inventory. Classify them as local run metadata writers, not
  Linear/GitHub mutators.
- `dev/plans/README.md` should keep this plan's row current after
  implementation; verify with
  `rg "260707-linear-plan-pr-handoff" dev/plans/README.md`.

**Verify**:

```bash
pnpm exec vitest run test/cli.test.ts test/factory-planning.workflow.test.ts
```

Expected: command help/output tests cover `run`, `publish`, and
`mark-plan-merged`, and publication subcommands do not require `--item-file`.

### Step 4: Add Linear planning comment helpers

Add pure helpers that render the Linear comments future apply mode will post.
Do not call the Linear API in this slice. The first helper renders the comment
after `publish`:

```md
<!-- harness-factory:planning:<run-id> -->

Factory plan ready.

Plan: `dev/plans/FER-123.md`
Plan PR: https://github.com/owner/repo/pull/123
Run: `.harness/runs/factory/<run-id>`
Next: merge plan PR, then move to Ready to Implement.
```

The second helper renders the completion comment after `mark-plan-merged`:

```md
<!-- harness-factory:planning-approved:<run-id> -->

Factory plan approved.

Plan: `dev/plans/FER-123.md`
Merged PR: https://github.com/owner/repo/pull/123
Commit: `abc1234`
Next: Ready to Implement.
```

**Verify**:

```bash
pnpm exec vitest run test/factory-linear*.test.ts
```

Expected: pure helper tests pass. Place helpers in `lib/factory-linear-adapter.ts`
or a focused companion module such as `lib/factory-linear-planning.ts`; pair any
companion module with a matching `test/factory-linear*.test.ts` file. Do not add
live Linear mutation unless this slice explicitly chooses apply mode.

### Step 5: Add handoff validation for future implementation

Add a shared validation helper for planned work, for example
`validatePlannedWorkHandoff(metadata, workspace)`, in
`lib/factory-planning-handoff.ts`, and test it. This helper is called by the
future implementation station only after tracker/factory state has selected the
planned-work path, meaning `factoryStage === "plan-approved"` and the handoff
contains approved plan metadata. Triage metadata is preserved, so
tracker-planned items may still have `factoryRoute: "ready-to-plan"`; do not use
that route alone as the readiness signal. The helper must reject `plan-pr-open`
because the plan PR has not landed yet.

Use a structured result or typed error, but make failures actionable for CLI
operators. The helper should fail closed when planned work is marked ready but
lacks:

- `approvedPlanPath`
- an existing plan file at that path
- `approvedPlanCommit`

For this slice, `approvedPlanCommit` is a trust boundary captured by the manual
`mark-plan-merged` command. Do not add a git ancestry check yet. Future apply
work can validate that the commit is reachable from the configured base branch.

Do not add an implementation station in this plan. This helper is the scoped
contract future implementation/review stations will call.

**Verify**:

```bash
pnpm exec vitest run test/factory-intake.test.ts test/factory-planning*.test.ts
pnpm check
```

Expected: all pass.

## Test plan

- Add unit tests for tracker-key filename generation.
- Keep metadata schema tests for `approvedPlanPrUrl` and `plan-pr-open` passing.
- Add Linear comment rendering/parsing tests before implementing mutation.
- Add CLI tests for any new planning options or output fields.
- Add tests for `harness factory planning publish` and
  `harness factory planning mark-plan-merged`.
- Add tests that `harness factory planning publish` does not require
  `--item-file`, and that existing `harness factory planning --item-file ...`
  still works.
- Move existing planning help assertions to `harness factory planning run --help`
  when parent help no longer owns station flags.
- Add tests for `FactoryPlanningRunMetaSchema` rejecting incompatible run
  metadata before publication commands write.
- Add tests for summary content after `publish` and `mark-plan-merged`.
- Add tests for planned-work handoff validation.
- Add dist smoke help checks for both new planning subcommands.
- Run `pnpm check` before review.

## Done criteria

- [ ] Tracker-backed plans default to `dev/plans/<tracker-key>.md`.
- [ ] Pure Linear planning comment helpers include plan path and plan PR URL.
- [ ] `publish` and `mark-plan-merged` commands update run metadata and summary.
- [ ] Metadata records `approvedPlanPath`, `approvedPlanPrUrl`, and
      `approvedPlanCommit` when available.
- [ ] The plan PR publication path is executable, either automated or explicit
      manual commands.
- [ ] Planned-work handoff validation exists for future implementation stations.
- [ ] Command inventory docs and dist smoke help checks include the new planning
      publication subcommands.
- [ ] `README.md` and `skills/factory-operator/SKILL.md` show the manual
      planning publication sequence.
- [ ] Docs clearly state that Linear status moves remain future apply work.
- [ ] `pnpm check` exits 0.
- [ ] `dev/plans/README.md` status row is updated.

## STOP conditions

Stop and report if:

- The implementation requires direct commits to `main`.
- The work appears to require automatic GitHub PR creation rather than
  manual-first publication commands.
- Linear cannot reliably store or update factory comments with stable markers.
- The plan path cannot be resolved from tracker metadata without guessing.

## Maintenance notes

- `dev/plans` remains the canonical implementation input for repo-backed work.
- `.harness/runs/factory/*` remains execution trace, not the implementation
  handoff.
- Linear issue descriptions should keep the original issue/request context.
  Factory outputs belong in marked comments.
- A future Inngest slice can automate the merge-detected transition to
  `Ready to Implement`.
