# Plan 260707-linear-triage-apply: Add Linear triage apply mode

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report - do not improvise.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: Linear read-only adapter and triage input integration on main
- **Category**: dx

## Why this matters

Linear is now a read-only input source for factory triage. The next useful slice
is letting the operator run one Linear issue through triage and have harness
apply the deterministic board update: move the issue to `Triaging` while the
station runs, then move it to the terminal status with a concise comment. This
keeps Linear as the human-visible board while preserving harness as the station
logic and artifact owner.

This plan is only for **triage apply**. Planning apply, implementation, Inngest,
GitHub, batch processing, and automatic PR creation remain out of scope.

## Current state

Relevant files:

- `bin/factory-commands.ts` - owns `harness factory linear fetch`,
  `harness factory triage`, and planning publication commands.
- `bin/factory-triage-cli.ts` - shapes triage CLI JSON output.
- `lib/factory-linear-adapter.ts` - current Linear SDK adapter. It can fetch and
  normalize one issue, validate configured statuses, and render planning
  comments. It cannot mutate Linear yet.
- `lib/factory-triage-input.ts` - resolves either `--item-file` or
  `--linear-issue` into a `FactoryWorkItem`.
- `lib/factory-run-context.ts` and `workflows/factory-triage.workflow.ts` - own
  triage run artifacts and route metadata.
- `test/factory-linear-adapter.test.ts` - current pure adapter coverage.
- `test/cli.test.ts` - current CLI coverage for Linear-backed triage errors and
  planning handoff commands.
- `docs/contributing/factory.md`, `docs/contributing/script-command-surface.md`,
  `docs/contributing/setup-manifest.md`, `skills/factory-operator/SKILL.md`,
  and `README.md` - public/contributor docs affected by new command behavior.

Current CLI excerpt from `bin/factory-commands.ts`:

```ts
type FactoryTriageStationOptions = {
  workspace?: string;
  itemFile?: string;
  linearIssue?: string;
  runsDir?: string;
  maxRuntimeMs: number;
  dryRun: boolean;
  verbose: boolean;
};
```

```ts
.option("--item-file <path>", "factory work item JSON file")
.option("--linear-issue <issue>", "Linear issue identifier, e.g. TEAM-123")
.option("--dry-run", "prepare context and placeholder routing only", false)
```

Current Linear adapter type from `lib/factory-linear-adapter.ts`:

```ts
export type LinearFactoryAdapter = {
  fetchWorkItem: (issueRef: string) => Promise<FactoryWorkItem>;
  validateStatusMap: () => Promise<LinearStatusMapValidation>;
};
```

Current status mapping from `lib/factory-linear-adapter.ts`:

```ts
if (normalized === normalizeName(statuses.intake)) return "incoming";
if (normalized === normalizeName(statuses.triaging)) return "triaging";
if (normalized === normalizeName(statuses.needsInfo)) return "needs-info";
if (normalized === normalizeName(statuses.needsPlan)) return "ready-to-plan";
if (normalized === normalizeName(statuses.readyToImplement)) return "ready-to-implement";
if (normalized === normalizeName(statuses.parked)) return "wait-to-implement";
if (normalized === normalizeName(statuses.planning)) return "planning";
if (normalized === normalizeName(statuses.planningFailed)) return "planning-failed";
return undefined;
```

`Triage Failed` is intentionally not mapped to `factoryStage`; it is preserved as
`metadata.linearStatus` only.

Route-to-status contract from `dev/todo/260704-factory-adapters-orchestration.md`:

```text
ready-to-implement -> Linear status: Ready to Implement
ready-to-plan      -> Linear status: Needs Plan
needs-info         -> Linear status: Needs Info + comment with questions
wait-to-implement  -> Linear status: Parked + comment with reconsiderWhen
triage failure     -> Linear status: Triage Failed + error comment
```

Entry guard contract:

```text
harness factory triage --linear-issue ... --apply
  accepts: Backlog, Needs Info, Triage Failed
  rejects: Needs Plan, Ready to Implement, Parked, Triaging, Planning, etc.
```

On `--apply`, use in-flight status:

```text
Backlog | Needs Info | Triage Failed -> Triaging -> terminal triage status
```

The first adapter version may rely on manual reset if a process crashes while
the issue is in `Triaging`.

## Commands you will need

| Purpose              | Command                                                                             | Expected on success               |
| -------------------- | ----------------------------------------------------------------------------------- | --------------------------------- |
| Focused adapter test | `pnpm exec vitest run test/factory-linear-adapter.test.ts`                          | exit 0, all tests pass            |
| Focused CLI test     | `pnpm exec vitest run test/cli.test.ts --testNamePattern "Linear"`                  | exit 0, matching tests pass       |
| Docs contract        | `pnpm exec vitest run test/docs-contracts.test.ts`                                  | exit 0, all tests pass            |
| Typecheck            | `pnpm typecheck`                                                                    | exit 0, no errors                 |
| Full gate            | `pnpm check`                                                                        | exit 0, lint/test/type/build pass |
| Live smoke           | `LINEAR_API_KEY=... node bin/harness.ts factory triage --linear-issue TEAM-123 ...` | works on a disposable issue       |

Do not print `LINEAR_API_KEY`. For live smoke, use a disposable Linear issue in
the configured `factory.linear.teamKey` team.

## Suggested executor toolkit

| Skill                                                                       | Use for                                                                        |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `implement-plan` (`skills/implement-plan/SKILL.md`)                         | Execute this plan phase by phase.                                              |
| `typescript-refactor` (`.agents/skills/typescript-refactor/SKILL.md`)       | Keep adapter types narrow and avoid unsafe casts around Linear SDK-like types. |
| `vitest` (`.agents/skills/vitest/SKILL.md`)                                 | Add adapter and CLI regression tests with isolated fake clients.               |
| `zod` (`.agents/skills/zod/SKILL.md`)                                       | Validate any new structured CLI output or metadata shape if introduced.        |
| `factory-operator` (`skills/factory-operator/SKILL.md`)                     | Run and inspect factory triage artifacts and Linear-backed smoke tests.        |
| `change-review-workflow` (`.agents/skills/change-review-workflow/SKILL.md`) | Review the finished PR before opening it.                                      |

## Scope

**In scope**:

- `lib/factory-linear-adapter.ts`
- `lib/factory-triage-input.ts` only if input result shape must carry adapter or
  Linear metadata
- `bin/factory-commands.ts`
- `bin/factory-triage-cli.ts`
- `test/factory-linear-adapter.test.ts`
- `test/factory-triage-cli.test.ts`
- `test/factory-triage-input.test.ts` if input validation changes
- `test/cli.test.ts`
- `README.md`
- `docs/contributing/factory.md`
- `docs/contributing/script-command-surface.md`
- `docs/contributing/setup-manifest.md`
- `docs/contributing/architecture.md` only if source-area ownership changes
- `skills/factory-operator/SKILL.md`
- `scripts/smoke-dist.ts` only if generated help expectations change
- `dev/plans/README.md`

**Out of scope**:

- `harness factory planning --linear-issue`
- Planning `--apply`
- Moving issues to `Ready to Implement` after plan PR merge
- Backlog listing or batch processing
- Inngest, webhooks, locks, retries, or durable orchestration
- GitHub/Jira adapters
- Linear OAuth
- Linear labels as canonical factory state
- Storing full plans in Linear comments or issue descriptions
- Automatically opening, merging, or inspecting GitHub PRs

## Steps

### Step 1: Add Linear update contracts and pure rendering helpers

Extend `lib/factory-linear-adapter.ts` with triage apply types before writing
SDK mutations.

Add exported types similar to:

```ts
export type LinearTriageApplyStage = "start" | "complete" | "failed";

export type LinearTriageApplyInput = {
  issueRef: string;
  runId: string;
  runDir: string;
};

export type LinearTriageCompletedInput = LinearTriageApplyInput & {
  triage: FactoryTriageOutput;
  routePlan: FactoryRoutePlan;
};

export type LinearTriageFailedInput = LinearTriageApplyInput & {
  error: string;
};

export type LinearTriageUpdatePlan = {
  issueIdentifier: string;
  runId: string;
  runDir: string;
  stage: LinearTriageApplyStage;
  fromStatus?: string;
  targetStatus: string;
  commentMarker?: string;
  commentBody?: string;
};
```

Input field sources:

- `issueRef`: the operator-provided `--linear-issue` value.
- `runId` and `runDir`: `ctx.runId` and `ctx.runDir` from
  `createFactoryRunContext`.
- `triage`: parsed from `factory-triage.json` after a completed run with
  `parseFactoryTriageOutput`.
- `routePlan`: reconstructed with `buildFactoryRoutePlan(workItem, triage)` after
  parsing the final triage output.
- `error`: `meta.error` after a failed triage run, falling back to a concise
  generic message only if absent.

Add pure helpers:

- `linearTriageTargetStatus(settings, route)`:
  - `ready-to-implement` -> `settings.statuses.readyToImplement`
  - `ready-to-plan` -> `settings.statuses.needsPlan`
  - `needs-info` -> `settings.statuses.needsInfo`
  - `wait-to-implement` -> `settings.statuses.parked`
- `assertLinearTriageApplyAllowed(settings, statusName)`:
  - allow `settings.statuses.intake`, `settings.statuses.needsInfo`,
    `settings.statuses.triageFailed`
  - throw a clear error for everything else
- `renderLinearTriageCompleteComment(input)` using marker:
  `<!-- harness-factory:triage:<run-id> -->`
- `renderLinearTriageFailedComment(input)` using marker:
  `<!-- harness-factory:triage-failed:<run-id> -->`

Comment content should be concise:

```text
<!-- harness-factory:triage:<run-id> -->
Factory triage complete.

Route: ready-to-plan
Run: `.harness/runs/factory/<run-id>`
Next: Needs Plan
```

The `Next:` value must come from the resolved configured status name, not a
hardcoded English label. Pass the resolved target status into the renderer or
derive it with `linearTriageTargetStatus(settings, route)`. For `Run:`, match
the current planning comment behavior and use the stored run directory value
passed to the renderer; do not invent a second path format in this slice.

For `needs-info`, include a short questions section sourced from
`FactoryTriageOutput.questions`. For `wait-to-implement`, include
`reconsiderWhen` when present. For failures, include `meta.error`.

Do not call Linear APIs in this step.

**Verify**:

```bash
pnpm exec vitest run test/factory-linear-adapter.test.ts
```

Expected: all existing tests pass, plus new pure-helper tests for each route,
entry guard rejection, questions, reconsiderWhen, and failure comment markers.

### Step 2: Add Linear mutation methods behind the adapter

Extend `LinearFactoryAdapter` with mutation methods:

```ts
export type LinearFactoryAdapter = {
  fetchWorkItem: (issueRef: string) => Promise<FactoryWorkItem>;
  validateStatusMap: () => Promise<LinearStatusMapValidation>;
  applyTriageStarted: (input: LinearTriageApplyInput) => Promise<LinearTriageUpdatePlan>;
  applyTriageCompleted: (input: LinearTriageCompletedInput) => Promise<LinearTriageUpdatePlan>;
  applyTriageFailed: (input: LinearTriageFailedInput) => Promise<LinearTriageUpdatePlan>;
};
```

Extend `LinearClientLike` minimally:

```ts
type LinearClientLike = {
  issue: (id: string) => Promise<LinearIssueLike>;
  issues: (variables?: unknown) => Promise<LinearConnectionLike<LinearIssueLike>>;
  teams: (variables?: unknown) => Promise<LinearConnectionLike<LinearTeamLike>>;
  updateIssue: (id: string, input: unknown) => Promise<unknown>;
  createComment: (input: { issueId: string; body: string }) => Promise<unknown>;
};
```

Implementation rules:

- Reuse `fetchIssue`, `fetchTeam`, `validateStatusMap`, and normalized status
  matching. Do not duplicate Linear lookup logic.
- Resolve configured status names to workflow state IDs from
  `team.states({ first: STATUS_FETCH_LIMIT })`.
- `applyTriageStarted`:
  - fetch latest issue and state
  - enforce entry guard from Step 1
  - update issue state to `settings.statuses.triaging`
  - skip update only if already at `Triaging` is **not** allowed; this first
    slice should fail from `Triaging` and ask for manual reset
  - return a `LinearTriageUpdatePlan`
- `applyTriageCompleted`:
  - map route to target status
  - update issue state to target status unless already at target status
  - create completion comment unless an existing issue comment includes the same
    hidden marker
  - return a `LinearTriageUpdatePlan`
- `applyTriageFailed`:
  - update issue state to `settings.statuses.triageFailed`
  - create failure comment unless the same marker exists
  - return a `LinearTriageUpdatePlan`

Use `issue.comments({ last: COMMENT_FETCH_LIMIT })` for idempotency in this
slice. Do not add pagination yet; document that the marker dedupe is best-effort
over the recent comments window.

**Verify**:

```bash
pnpm exec vitest run test/factory-linear-adapter.test.ts
```

Expected: fake-client tests prove status IDs are used in `updateIssue`, duplicate
markers skip `createComment`, terminal statuses are skipped when already at
target, and disallowed entry statuses reject before any mutation.

### Step 3: Wire `harness factory triage --linear-issue ... --apply`

Update `bin/factory-commands.ts`.

Add `apply: boolean` to `FactoryTriageStationOptions` and add:

```ts
.option("--apply", "apply deterministic Linear status/comment updates", false)
```

Validation rules:

- `--apply` requires `--linear-issue`.
- `--apply` and `--item-file` must fail clearly.
- `--apply` and `--dry-run` must fail clearly.
- Existing input-source errors should still win when neither source or both
  sources are provided.
- Add a small local `validateFactoryTriageApplyOptions(options)` helper in
  `bin/factory-commands.ts`. Call it immediately after
  `validateFactoryTriageWorkItemInput(options)` and before role/config
  resolution. Do not overload `validateFactoryTriageWorkItemInput`; it should
  keep owning only input-source validation.

Adapter lifecycle strategy:

- Do **not** make `workflows/factory-triage.workflow.ts` aware of Linear.
- Do **not** return a Linear adapter from `resolveFactoryTriageWorkItem`; that
  helper should stay an input resolver.
- In `bin/factory-commands.ts`, when `options.linearIssue` is present, use a
  lazy cached adapter so existing `resolveFactoryTriageWorkItem` validation still
  owns the `LINEAR_API_KEY` error order:

  ```ts
  let linearAdapter: LinearFactoryAdapter | undefined;
  const linearAdapterFactory = options.linearIssue
    ? (input) => {
        linearAdapter ??= createLinearFactoryAdapter(input);
        return linearAdapter;
      }
    : undefined;
  ```

- Pass that same adapter into `resolveFactoryTriageWorkItem` through the existing
  `linearAdapterFactory` seam so `fetchWorkItem` and later apply calls use one
  adapter instance:

  ```ts
  linearAdapterFactory,
  ```

- After `resolveFactoryTriageWorkItem`, `linearAdapter` must be defined whenever
  `--linear-issue` is set; fail clearly if not.
- Call `linearAdapter.applyTriageStarted`, `linearAdapter.applyTriageCompleted`,
  and `linearAdapter.applyTriageFailed` from `bin/factory-commands.ts` only when
  `--apply` is set.
- Keep all Linear mutations in `lib/factory-linear-adapter.ts` plus
  `bin/factory-commands.ts`; `workflows/factory-triage.workflow.ts` must not
  import Linear or know about tracker mutations.

Recommended CLI flow:

1. Validate input source.
2. Resolve triager role and Linear settings.
3. Resolve Linear work item and keep the adapter available for apply.
4. Create `FactoryRunContext` so `ctx.runId` and `ctx.runDir` exist.
5. If `--apply`, call
   `linearAdapter.applyTriageStarted({ issueRef, runId, runDir })` before
   `runFactoryTriage(ctx)`.
6. Run the triage workflow.
7. If `--apply` and `meta.status === "completed"`:
   - read the triage artifact from `join(meta.runDir, meta.artifacts?.triage ??
"factory-triage.json")`
   - use `readFileSync` from `node:fs` and `join` from `node:path`
   - parse it with `parseFactoryTriageOutput`
   - reconstruct `routePlan` with `buildFactoryRoutePlan(input.workItem, triage)`
   - call `linearAdapter.applyTriageCompleted(...)`
8. If `--apply` and `meta.status === "failed"`:
   - call `linearAdapter.applyTriageFailed(...)`
   - keep process exit code `1`
9. If Linear terminal update fails after a successful triage run, let the command
   fail with exit `1`. The run artifacts are still durable and the operator can
   inspect `summary.md`.

Avoid pushing Linear mutation into `workflows/factory-triage.workflow.ts`; that
workflow should stay tracker-agnostic.
The final `console.log(factoryTriageCliOutput(...))` call is updated in Step 4;
do not keep passing only `{ linearApplied: input.linearApplied }`, because that
value is always the read-only resolver flag.

**Verify**:

```bash
pnpm exec vitest run test/cli.test.ts --testNamePattern "Linear"
```

Expected: all matching tests pass. New tests cover option validation and CLI JSON
shape for apply success/failure using injected/faked adapter paths where
possible. If direct adapter injection into the CLI is not currently practical,
test pure functions and keep CLI tests to validation/help behavior.

### Step 4: Update CLI output shape

Update `bin/factory-triage-cli.ts`.

Current output only allows:

```ts
linearApplied?: false;
```

Change this to support:

```ts
linearApplied?: boolean;
linearUpdate?: {
  started?: LinearTriageUpdatePlan;
  terminal?: LinearTriageUpdatePlan;
};
```

Rules:

- Linear-backed read-only triage keeps `linearApplied: false`.
- Linear-backed apply success returns `linearApplied: true` and both update
  plans.
- Linear-backed apply failure returns `linearApplied: true` when the failure
  status/comment was applied; if applying the failure update itself fails, the
  command may fail before printing final JSON.
- Item-file triage omits Linear fields.

Do not include full Linear issue descriptions, comments, or raw API responses in
CLI output.

**Verify**:

```bash
pnpm exec vitest run test/cli.test.ts --testNamePattern "Linear"
pnpm exec vitest run test/factory-triage-cli.test.ts
```

Expected: CLI and output-shape assertions reflect the new `linearApplied`
boolean behavior.

### Step 5: Update docs and operator skill

Update docs to separate current read-only behavior from apply behavior.

Required updates:

- `README.md`
  - Keep concise. Mention `--apply` only if line budget allows; the README is
    capped by `test/docs-contracts.test.ts`, so any new line likely needs a
    compensating trim nearby.
- `docs/contributing/factory.md`
  - Add `harness factory triage --linear-issue TEAM-123 --apply`.
  - Document allowed entry statuses and terminal mapping.
  - State that planning apply is still future work.
  - Narrow the current blanket Triage Station statement "Triage does not mutate
    tracker state..." to default/read-only behavior and explicitly document the
    Linear `--apply` exception.
- `docs/contributing/script-command-surface.md`
  - Update mutability classification: Linear-backed triage with `--apply`
    mutates Linear status/comments and writes local artifacts.
  - Split table wording so read-only `harness factory triage --linear-issue ...
--dry-run` is distinct from mutating `harness factory triage --linear-issue
... --apply`. Do not leave wording that says every `--linear-issue` triage
    run is read-only.
  - Generated help list does not need duplicated flags beyond command ownership.
- `docs/contributing/setup-manifest.md`
  - Confirm `.harness/runs/factory/<run-id>/` remains the only local artifact.
  - Add note that Linear comments are external generated state when `--apply`
    runs.
- `docs/contributing/architecture.md`
  - If it still says Linear adapters are read-only, narrow that to "fetch and
    dry-run triage are read-only; triage apply mutates Linear".
- `skills/factory-operator/SKILL.md`
  - Add apply command, allowed statuses, stop conditions, and no-planning-apply
    boundary.
- `scripts/smoke-dist.ts`
  - Add or adjust help smoke only if `--apply` help is expected by the existing
    smoke pattern.
- `dev/plans/README.md`
  - Verify this plan is present in the active queue. During implementation,
    preserve the row as `in_progress`; when the PR lands, follow the repo's plan
    completion process.

**Verify**:

```bash
pnpm exec vitest run test/docs-contracts.test.ts
pnpm exec oxfmt --check README.md docs/contributing/*.md skills/factory-operator/SKILL.md dev/plans/README.md
```

Expected: docs contracts pass, and formatting is clean.

### Step 6: Add live smoke guidance and run a disposable test

After unit and CLI tests pass, run one live smoke against a disposable Linear
issue in the configured team.

Recommended sequence:

```bash
node bin/harness.ts factory linear fetch TEAM-123 --workspace /path/to/target-repo
node bin/harness.ts factory triage --workspace /path/to/target-repo --linear-issue TEAM-123 --dry-run
node bin/harness.ts factory triage --workspace /path/to/target-repo --linear-issue TEAM-123 --apply
```

Expected:

- First command prints a `FactoryWorkItem`.
- Dry-run creates local artifacts and does not mutate Linear.
- Apply moves the issue to `Triaging` while running, then to the terminal status
  from the route.
- Apply adds one concise comment with a hidden `harness-factory:triage:<run-id>`
  marker.
- Re-running the exact same terminal update helper in a test does not duplicate
  the same marker comment.

Partial failure recovery:

- If `applyTriageStarted` succeeds, the triage run fails, and
  `applyTriageFailed` also fails, the issue may remain in `Triaging`.
- The command should exit non-zero and preserve local run artifacts.
- Document this operator recovery path in `skills/factory-operator/SKILL.md`:
  inspect the run summary, then manually move the issue to `Triage Failed`,
  `Backlog`, or another intentional status before rerunning.

Do not run this smoke on a real product issue unless the user explicitly
approves that issue.

**Verify**:

```bash
pnpm check
```

Expected: full gate passes after the live smoke and no unwanted tracked files
remain.

## Test plan

New adapter tests in `test/factory-linear-adapter.test.ts`:

- `linearTriageTargetStatus` maps all four routes.
- Entry guard accepts Backlog, Needs Info, Triage Failed.
- Entry guard rejects Needs Plan, Ready to Implement, Parked, Triaging,
  Planning, Planning Failed.
- `applyTriageStarted` uses configured `Triaging` state ID.
- `applyTriageStarted` rejects disallowed current state before mutation.
- `applyTriageCompleted` updates to Needs Plan for `ready-to-plan`.
- `applyTriageCompleted` updates to Ready to Implement for
  `ready-to-implement`.
- `applyTriageCompleted` includes questions for `needs-info`.
- `applyTriageCompleted` includes reconsiderWhen for `wait-to-implement`.
- `applyTriageCompleted` skips duplicate comments for the same marker.
- `applyTriageFailed` updates to Triage Failed and comments with the error.

New or updated CLI tests in `test/cli.test.ts`:

- `harness factory triage --apply` requires `--linear-issue`.
- `--apply` with `--item-file` fails clearly.
- `--apply` with `--dry-run` fails clearly.
- Linear-backed read-only triage still returns `linearApplied: false`.
- Help output includes `--apply`.

If adding reliable CLI tests for successful live-like apply requires too much
test-only injection, STOP and report. Do not add broad dependency injection to
the CLI solely for one assertion; keep success behavior covered at adapter level.

Docs tests:

- `test/docs-contracts.test.ts` passes.
- README remains within its line budget.

## Done criteria

- [x] `harness factory triage --linear-issue TEAM-123 --apply` exists.
- [x] `--apply` mutates Linear only for Linear-backed triage.
- [x] `--apply` rejects item-file input and dry-run.
- [x] Entry guard accepts only Backlog, Needs Info, and Triage Failed.
- [x] Apply moves Linear to `Triaging` before running the triage agent.
- [x] Successful triage moves Linear to the route's terminal status.
- [x] Failed triage moves Linear to `Triage Failed`.
- [x] Completion/failure comments include hidden run-id markers and are
      idempotent for the same marker.
- [x] CLI output distinguishes `linearApplied: false` from `linearApplied: true`.
- [x] No planning apply behavior is added.
- [x] `pnpm exec vitest run test/factory-linear-adapter.test.ts` exits 0.
- [x] `pnpm exec vitest run test/cli.test.ts --testNamePattern "Linear"` exits 0.
- [x] `pnpm exec vitest run test/docs-contracts.test.ts` exits 0.
- [x] `pnpm check` exits 0.
- [ ] Live smoke result is documented in the PR body, including which disposable
      issue was used or why live smoke was skipped.
- [x] `dev/plans/README.md` row is updated.

## STOP conditions

Stop and report back if:

- Linear SDK mutation input does not accept `stateId` or equivalent state
  updates through `updateIssue`; do not guess a different mutation shape.
- The configured Linear team does not contain one of the statuses in
  `factory.linear.statuses`.
- A successful implementation requires changing `workflows/factory-triage.workflow.ts`
  to depend on Linear.
- A reliable implementation requires supporting `Triaging` reruns, locks, or
  crash recovery. That belongs to a later Inngest/retry slice.
- Tests require calling the real Linear API in CI.
- The plan appears to require adding planning `--apply`, backlog listing, or
  batch processing.

## Maintenance notes

- This is the first real Linear mutation path. Keep all Linear-specific behavior
  in adapter/CLI boundaries; workflows remain tracker-agnostic.
- Reviewers should scrutinize idempotency, entry guards, and failure behavior
  more than the happy path.
- Comment dedupe over the latest 20 comments is intentionally first-slice
  behavior. Future Inngest/webhook work may need stronger durable metadata.
- If a terminal Linear update fails after the issue moved to `Triaging`, the
  operator may need to manually reset the issue status before retrying. This is
  acceptable for this local CLI slice; Inngest/retry work owns automatic
  recovery later.
- Planning apply should build on the same adapter patterns, but it must remain a
  separate plan because its terminal state depends on plan PR publication and
  merge commit metadata.
