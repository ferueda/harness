# Plan 260708-linear-planning-publish-handoff: Add Linear publish and merge handoff apply

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `dev/plans/260707-linear-planning-apply.md`
- **Category**: dx
- **Issue**: https://linear.app/ferueda/issue/FER-26/add-planning-publish-and-merge-handoff

## Why this matters

Linear planning apply now gets a tracker-backed issue from `Needs Plan` through
an approved local plan file, but it intentionally stops before
`Ready to Implement`. That is correct because implementation should not start
until the approved plan is present in source control. The missing step is a
deterministic publication handoff: registering a plan PR should move Linear to
`Plan Needs Review`, and registering the merged commit should move Linear to
`Ready to Implement`.

This plan keeps GitHub PR creation out of scope. The operator still opens or
merges the plan PR manually; harness records those facts, posts deterministic
Linear comments, and moves the Linear issue to the next board state.

## Current state

Relevant files:

- `bin/factory-commands.ts` owns the public factory CLI. It defines
  `harness factory planning publish` and
  `harness factory planning mark-plan-merged`.
- `lib/factory-planning-handoff.ts` owns local planning run handoff metadata:
  `approvedPlanPrUrl`, `approvedPlanCommit`, and `factoryStage`.
- `lib/factory-linear-adapter.ts` owns Linear issue reads, status updates, and
  deterministic comments for triage plus existing planning comment renderers.
- `lib/factory-linear-planning-apply.ts` owns the planning-run `--apply`
  pattern: validate status map, fetch issue, assert scope, move status, write a
  marker comment, and dedupe by marker.
- `lib/factory-linear-types.ts` defines the small Linear SDK surface harness
  tests and adapters use.
- `test/factory-planning-handoff.test.ts`,
  `test/factory-linear-adapter.test.ts`,
  `test/factory-planning-apply-command.test.ts`, and `test/cli.test.ts` are the
  closest test patterns.
- `docs/contributing/factory.md`, `docs/contributing/architecture.md`,
  `docs/contributing/script-command-surface.md`,
  `docs/contributing/setup-manifest.md`, and `README.md` document the factory
  operator model.

Current CLI shape in `bin/factory-commands.ts`:

```ts
planning
  .command("publish")
  .description("Register the plan PR for an approved planning run")
  .requiredOption("--run-dir <path>", "factory planning run directory")
  .requiredOption("--pr-url <url>", "plan PR URL")
  .action((options: FactoryPlanningPublishOptions) => {
    const meta = updateFactoryPlanningHandoff(options.runDir, {
      approvedPlanPrUrl: options.prUrl,
      factoryStage: "plan-pr-open",
    });
    // prints factoryMetadata and suggested Linear comment only
  });

planning
  .command("mark-plan-merged")
  .description("Register the merged plan commit for an approved planning run")
  .requiredOption("--run-dir <path>", "factory planning run directory")
  .requiredOption("--commit <sha>", "merged plan commit")
  .action((options: FactoryPlanningMarkMergedOptions) => {
    const meta = updateFactoryPlanningHandoff(options.runDir, {
      approvedPlanCommit: options.commit,
      factoryStage: "plan-approved",
    });
    // prints factoryMetadata and suggested Linear comment only
  });
```

Current local handoff validation in `lib/factory-planning-handoff.ts`:

```ts
if (meta.status !== "plan-approved") {
  throw new FactoryPlanningError(`Planning run is not approved: ${meta.status}`);
}
if (!metadata?.approvedPlanPath) {
  throw new FactoryPlanningError("Planning run is missing approvedPlanPath");
}
if (!isTrackerBackedPlanningHandoff(metadata)) {
  throw new FactoryPlanningError("Planning publication requires tracker-backed metadata");
}
```

Current Linear comment renderers in `lib/factory-linear-adapter.ts`:

```ts
renderLinearPlanningReadyComment({
  runId,
  approvedPlanPath,
  approvedPlanPrUrl,
  runDir,
});

renderLinearPlanningApprovedComment({
  runId,
  approvedPlanPath,
  approvedPlanPrUrl,
  approvedPlanCommit,
  runDir,
});
```

Current docs explicitly say publication commands are local-only. This must
change only for explicit `--apply`.

The repository is Node 24+ TypeScript ESM. Imports use `.ts` extensions and
type-only imports where appropriate. Validation uses Zod and `safeParse` at
boundaries. Tests use Vitest with local fake clients rather than live API calls.

## Commands you will need

| Purpose | Command | Expected on success |
| ------- | ------- | ------------------- |
| Targeted tests | `pnpm exec vitest run test/factory-linear-adapter.test.ts test/factory-planning-handoff.test.ts test/factory-planning-apply-command.test.ts test/cli.test.ts` | exit 0, all selected tests pass |
| Typecheck | `pnpm exec tsc -p tsconfig.json --noEmit` | exit 0, no errors |
| Full gate | `pnpm check` | exit 0 |
| CLI help smoke | `node bin/harness.ts factory planning publish --help && node bin/harness.ts factory planning mark-plan-merged --help` | exit 0, help includes any new flags |

## Suggested executor toolkit

- `node` skill: use for Node 24 TypeScript ESM patterns, especially `.ts`
  imports and type-only imports.
- `vitest` skill: use for adding focused fake-client tests and avoiding shared
  mutable state.
- `zod` skill: use if adding or changing validation schemas; prefer existing
  `safeParse` and formatted error patterns.
- `factory-operator` skill: use when updating operator-facing Linear mutation
  policy and stop conditions.
- `implement-plan` skill: use to execute this plan phase by phase.

## Scope

**In scope**:

- Add explicit Linear apply support to:
  - `harness factory planning publish`
  - `harness factory planning mark-plan-merged`
- Reuse local metadata updates from `updateFactoryPlanningHandoff`.
- Post deterministic Linear comments and dedupe by marker.
- Move Linear statuses:
  - `publish --apply`: current issue status should become `Plan Needs Review`.
  - `mark-plan-merged --apply`: current issue status should become
    `Ready to Implement`.
- Validate Linear team/project/status scope using existing adapter helpers.
- Update focused tests and contributor docs.
- Preserve explicit operator control: `--apply` is always opt-in, and harness
  does not open or merge GitHub PRs in this slice.

**Out of scope**:

- Opening GitHub PRs automatically.
- Detecting GitHub merge webhooks.
- Inngest orchestration.
- Implementation station consumption of `Ready to Implement`.
- Changing planning run `--apply` behavior.
- Changing the existing Linear status names in `harness.json`.
- Adding new Linear statuses such as `Plan PR Open`.

## Design decisions

1. Keep publication and merge as explicit operator commands. The operator
   supplies `--pr-url` and `--commit`; harness does not create or merge PRs.
2. Add `--linear-issue <issue>` and `--apply` to both publication commands.
   Local-only mode without `--apply` remains supported and should keep printing
   suggested `linearComment`.
3. `--apply` must require `--linear-issue`, `LINEAR_API_KEY`, and
   `factory.linear` config. It must be rejected before metadata mutation if
   the required Linear inputs/config are missing.
4. Publication apply should update local metadata first only after CLI inputs
   and Linear adapter construction are valid. If Linear terminal mutation then
   fails, the command may return non-zero with local metadata already updated,
   matching the existing planning-run apply model where local success can
   outlive terminal Linear failure. The JSON output should expose the local
   metadata, `linearApplied`, any `linearUpdate`, and terminal apply errors.
5. `Plan Needs Review` is a human-review board state. For this publish path,
   the comment marker/body disambiguates "approved plan PR needs review/merge"
   from "plan-review-unresolved".
6. `Ready to Implement` only happens after `approvedPlanCommit` is recorded.
7. Linear state transitions must be guarded before mutation:
   - `publish --apply`: allow configured `Planning` as the primary input,
     configured `Needs Plan` for local-only planning runs that never moved the
     tracker to `Planning`, and configured `Plan Needs Review` as an idempotent
     re-apply input; reject all other statuses.
   - `mark-plan-merged --apply`: allow configured `Plan Needs Review` as the
     primary input and configured `Ready to Implement` as an idempotent re-apply
     input; reject all other statuses.
8. `--linear-issue` must match the planning run tracker metadata before local
   metadata updates or Linear mutation. Reuse `parseLinearIssueIdentifier` for
   both values, compare canonical team key plus issue number, accept case
   variants such as `fer-123` and `FER-123`, and reject mismatches.
9. Keep generated output contracts small and stable. Apply-mode CLI JSON should
   extend the existing `factoryPlanningPublicationCliOutput` output in
   `bin/factory-commands.ts`. Non-apply mode keeps the current shape. Apply
   mode adds `linearApplied` and `linearUpdate.terminal` to the existing
   publication fields:

```ts
{
  runId: string;
  workflow: "factory-planning";
  status: "plan-approved";
  workspace: string;
  runDir: string;
  factoryMetadata: FactoryPlanningMetadata;
  summaryPath: string;
  metaPath: string;
  linearComment: string;
  linearApplied: boolean;
  linearUpdate?: {
    terminal: LinearPlanningHandoffUpdatePlan;
  };
}
```
10. Terminal Linear mutation failures after local metadata is written should
    print persisted `factoryMetadata`, `linearComment`, `linearApplied: false`,
    and any partial `linearUpdate`, then exit non-zero. Do not copy the
    planning-run `linearApplied: true` terminal-failure convention for these
    publication commands.

## Steps

### Step 1: Add Linear publication apply helpers

Create a small helper module, recommended:
`lib/factory-linear-planning-handoff.ts`. If the existing
`lib/factory-linear-planning-apply.ts` remains clearer after the edit, it is
acceptable to colocate the new helper there instead. In either case, keep the
exported symbols below explicit.

Implement types and functions similar to `lib/factory-linear-planning-apply.ts`:

- `LinearPlanningHandoffInput`:
  - `issueRef`
  - `runId`
  - `runDir`
  - `approvedPlanPath`
  - `approvedPlanPrUrl`
- `LinearPlanningMergedInput` extends the above with:
  - `approvedPlanCommit`
- `LinearPlanningHandoffUpdatePlan`:
  - `issueIdentifier`
  - `runId`
  - `runDir`
  - `stage: "publish" | "merged"`
  - `fromStatus?: string`
  - `targetStatus`
  - `commentMarker`
  - `commentBody`

Add:

- `assertLinearPlanningHandoffApplyAllowed(...)` or separate publish/merged
  guards:
  - publish allows current Linear status `settings.statuses.planning`,
    `settings.statuses.needsPlan`, and `settings.statuses.needsPlanReview`.
  - merged allows current Linear status `settings.statuses.needsPlanReview` and
    `settings.statuses.readyToImplement`.
  - rejected statuses must fail before `updateIssue` or `createComment`.
- `applyLinearPlanningPublished(...)`
  - validate status map
  - fetch issue
  - assert configured team/project scope
  - assert allowed current status before mutation
  - target status: `settings.statuses.needsPlanReview`
  - update issue status if needed
  - comment marker: `<!-- harness-factory:planning:<runId> -->`
  - comment body: existing `renderLinearPlanningReadyComment(...)`
  - skip `createComment` when marker already exists
- `applyLinearPlanningMerged(...)`
  - same validation/scope pattern
  - assert allowed current status before mutation
  - target status: `settings.statuses.readyToImplement`
  - comment marker: `<!-- harness-factory:planning-approved:<runId> -->`
  - comment body: existing `renderLinearPlanningApprovedComment(...)`
  - skip duplicate comments

Reuse internal dependency injection like `LinearPlanningApplyDeps` so unit tests
can exercise logic through `createLinearFactoryAdapterForClient` with fake
clients.

Expose methods on `LinearFactoryAdapter`:

- `applyPlanningPublished(input)`
- `applyPlanningMerged(input)`

Update `fakeLinearAdapter` so tests fail closed unless overrides are supplied.

**Verify**:
`pnpm exec vitest run test/factory-linear-adapter.test.ts` exits 0 after adding
or adjusting tests in Step 3.

### Step 2: Wire CLI `--apply` for publish and mark-plan-merged

In `bin/factory-commands.ts`, update command options:

```text
harness factory planning publish --run-dir <path> --pr-url <url> [--linear-issue <issue>] [--apply]
harness factory planning mark-plan-merged --run-dir <path> --commit <sha> [--linear-issue <issue>] [--apply]
```

Behavior:

- Without `--apply`: keep current local behavior and JSON shape as much as
  possible. It should still print `factoryMetadata` and `linearComment`.
- With `--apply`:
  - reject if `--linear-issue` is missing
  - load run metadata and reject if `--linear-issue` does not match
    `metadata.tracker.id` using `parseLinearIssueIdentifier` on both values
    and comparing normalized team key plus number
  - reject if `metadata.tracker.source` is not `linear`
  - resolve `factory.linear` config from the run workspace or current command
    workspace pattern already used by factory commands. Prefer the run metadata
    workspace when available; do not invent a new global config path.
  - require `LINEAR_API_KEY`
  - create Linear adapter
  - call `updateFactoryPlanningHandoff(...)`
  - call `adapter.applyPlanningPublished(...)` or
    `adapter.applyPlanningMerged(...)`
  - print JSON with:
    - existing local metadata output
    - `linearApplied: true`
    - `linearUpdate: { terminal: ... }`

Add or reuse an exported command helper so tests can exercise apply behavior
without shelling into a live Linear API, recommended:

```ts
runFactoryPlanningPublicationWithLinearApply({
  mode: "publish" | "mark-plan-merged",
  runDir,
  issueRef,
  prUrl,
  commit,
  env,
  adapterFactory,
  output,
});
```

The helper should own:

- apply preflight validation before local mutation
- tracker issue mismatch validation
- local metadata update through `updateFactoryPlanningHandoff`
- terminal Linear apply
- JSON output
- terminal Linear failure handling

Keep errors deterministic:

- `--apply` with no `--linear-issue` should fail before local metadata writes.
- Missing `LINEAR_API_KEY` should fail before local metadata writes.
- Missing `factory.linear` should fail before local metadata writes.
- `--linear-issue` mismatching run metadata should fail before local metadata
  writes.
- tracker-backed runs whose `metadata.tracker.source` is not `linear` should
  fail before local metadata writes.
- Invalid local run metadata should still fail before Linear mutation.
- If terminal Linear mutation fails after local metadata is updated, print JSON
  that includes persisted metadata, `linearApplied: false`, and any partial
  `linearUpdate` available, then throw or rethrow the terminal error so the CLI
  exits non-zero. This is intentionally stricter than
  `runFactoryPlanningWithLinearApply`, which currently reports terminal failure
  differently.

Do not add a `--workspace` option unless needed for config resolution. If
config resolution cannot reliably use `meta.workspace`, add `--workspace` and
document why. The preferred shape is to load the planning run metadata first,
use `meta.workspace` for `resolveFactoryLinearSettings({ workspace:
meta.workspace })`, then validate/update metadata and Linear.

**Verify**:
`node bin/harness.ts factory planning publish --help` and
`node bin/harness.ts factory planning mark-plan-merged --help` exit 0 and show
the new flags.

### Step 3: Add tests for Linear handoff apply

Add unit coverage in `test/factory-linear-adapter.test.ts`:

- `applyPlanningPublished`:
  - from `Planning` to `Plan Needs Review`
  - from `Needs Plan` to `Plan Needs Review` for local-only planning runs
  - allows idempotent re-apply from `Plan Needs Review`
  - rejects unrelated statuses before mutation
  - creates one comment with the planning marker
  - includes plan path, PR URL, run dir, and next action
  - skips duplicate marker comments
  - validates configured project scope before mutation
- `applyPlanningMerged`:
  - from `Plan Needs Review` to `Ready to Implement`
  - allows idempotent re-apply from `Ready to Implement`
  - rejects unrelated statuses before mutation
  - creates one approved marker comment
  - includes plan path, PR URL, commit, and next action
  - skips duplicate marker comments
  - validates configured project scope before mutation

Add CLI coverage in `test/cli.test.ts`:

- help includes `--apply` and `--linear-issue` for both commands.
- local-only mode still works.
- `--apply` without `--linear-issue` fails before mutating metadata.
- missing `LINEAR_API_KEY` with `--apply` fails before mutating metadata.
- non-Linear tracker metadata with `--apply` fails before mutating metadata.
- case-variant `--linear-issue` values like `fer-123` match `FER-123`.

Add command-function coverage if a direct fake adapter seam exists or is added
near `test/factory-planning-apply-command.test.ts`:

- publish apply output includes `linearApplied: true` and `linearUpdate`.
- mark-merged apply output includes `linearApplied: true` and `linearUpdate`.
- mismatched `--linear-issue` and run metadata fails before local metadata
  mutation.
- if Linear terminal apply fails after metadata update, output/error handling
  prints persisted metadata with `linearApplied: false` and exits non-zero.
- `test/cli.test.ts` and `test/factory-planning-handoff.test.ts` assertions for
  `planningNextAction` are updated to expect implementation-ready wording after
  `approvedPlanCommit` is recorded.

**Verify**:
`pnpm exec vitest run test/factory-linear-adapter.test.ts test/factory-planning-handoff.test.ts test/factory-planning-apply-command.test.ts test/cli.test.ts`
exits 0.

### Step 4: Update docs and command inventory

Update:

- `README.md`
- `docs/contributing/factory.md`
- `docs/contributing/architecture.md`
- `docs/contributing/script-command-surface.md`
- `docs/contributing/setup-manifest.md`
- `skills/factory-operator/SKILL.md`

Required doc changes:

- Publication commands are local-only unless `--apply` is present.
- `publish --apply --linear-issue ...` mutates Linear to `Plan Needs Review`
  and posts/registers the plan PR comment.
- `mark-plan-merged --apply --linear-issue ...` mutates Linear to
  `Ready to Implement` and posts the approved-plan comment.
- These commands do not open PRs or inspect GitHub merge state.
- `LINEAR_API_KEY` is required for apply mode.
- Apply mode validates the issue's current Linear status before mutation.
- Command surface mutability table should classify these apply modes as Linear
  mutating, while non-apply mode stays local artifact writing.
- Update local handoff summary wording so a run with `factoryStage:
  "plan-approved"` and `approvedPlanCommit` says implementation can start, not
  that a future tracker move is still required.
- Extend `skills/factory-operator/SKILL.md` Stop Conditions so Linear mutation
  is allowed only for explicit `harness factory triage --apply`, existing
  `harness factory planning run --apply`, and the two new explicit publication
  apply commands. Non-apply publication remains local-only.

Avoid duplicating generated help. Mention new flags only where command behavior
or mutability is explained.

**Verify**:
`pnpm exec vitest run test/docs-contracts.test.ts` exits 0.

### Step 5: Run final gates and optional live smoke

Run:

```bash
pnpm exec vitest run test/factory-linear-adapter.test.ts test/factory-planning-handoff.test.ts test/factory-planning-apply-command.test.ts test/cli.test.ts test/docs-contracts.test.ts
pnpm exec tsc -p tsconfig.json --noEmit
pnpm check
```

Expected: all commands exit 0.

Optional live smoke after code review:

1. Use a disposable Linear issue, not `FER-26`, unless the human explicitly
   asks to move `FER-26`.
2. Create or reuse a local approved factory planning run fixture with
   tracker-backed metadata.
3. Run publish apply and confirm Linear goes to `Plan Needs Review`.
4. Run mark-plan-merged apply and confirm Linear goes to `Ready to Implement`.
5. Archive or reset the disposable issue.

## Test plan

- Adapter tests should validate status movement, marker comments, duplicate
  comment skip, and project-scope failure before mutation.
- CLI tests should validate new flags, missing apply requirements, and that
  local-only mode remains stable.
- Command helper tests should validate issue-ref mismatch, rejected input
  statuses, non-Linear tracker rejection, and terminal Linear failure output.
- Existing handoff tests should continue to prove local metadata validation and
  `validatePlannedWorkHandoff` fail closed until `approvedPlanCommit` exists.
- Docs contract tests should pass after command/mutability docs update.

## Done criteria

- [x] `harness factory planning publish --apply --linear-issue ...` exists and
      moves Linear to `Plan Needs Review`.
- [x] `harness factory planning mark-plan-merged --apply --linear-issue ...`
      exists and moves Linear to `Ready to Implement`.
- [x] Non-apply publish/mark-plan-merged behavior remains local-only.
- [x] Linear comments are deterministic, marker-based, and deduped.
- [x] Missing `--linear-issue`, missing `LINEAR_API_KEY`, missing
      `factory.linear`, invalid run metadata, and project mismatch fail before
      unintended mutation.
- [x] Linear status guards reject publish/merge commands from the wrong board
      states before mutation.
- [x] `publish --apply` accepts a tracker still in `Needs Plan` when local
      planning already produced approved metadata.
- [x] Apply-mode JSON output includes a stable `linearApplied` and
      `linearUpdate` contract.
- [x] Non-Linear tracker metadata rejects apply mode before metadata mutation.
- [x] Local handoff summary says plan-approved runs with a commit are ready for
      implementation.
- [x] Focused tests and docs tests pass.
- [x] `pnpm check` passes.
- [x] `dev/plans/README.md` marks this plan `approved` before implementation
      begins.

## STOP conditions

Stop and report back if:

- The current publish/mark-plan-merged commands no longer match the current
  state excerpts above.
- The implementation appears to require GitHub API calls or automatic PR
  creation.
- Linear SDK comment/status mutation requires a wider client surface than
  `updateIssue` and `createComment`.
- You cannot resolve `factory.linear` config from the planning run workspace
  without adding a new command-level workspace concept.
- A test requires live Linear network access; unit and CLI tests must use fakes
  or environment stubbing.

## Maintenance notes

- Future Inngest or GitHub webhook automation should call the same handoff
  apply logic instead of duplicating status/comment code.
- Implementation station work should rely on `factoryStage: "plan-approved"`
  plus `approvedPlanCommit`, not just the Linear status.
- `Plan Needs Review` remains intentionally overloaded as a human-attention
  state; deterministic comment markers disambiguate unresolved plan-review
  findings from approved plan PR review.
