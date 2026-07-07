# Plan 260707-linear-planning-input: Run planning from Linear issues

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report - do not improvise.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: PR #74 / shipped Linear triage apply on `main`
- **Category**: workflow

## Why this matters

The factory can now take a Linear issue from `Backlog` through triage and land
it in `Needs Plan`, `Needs Info`, `Ready to Implement`, or `Parked`. The
`Needs Plan` path still drops back to file-only planning: an operator must fetch
the Linear issue manually, save an item file, then run the planning station.

This plan adds the next small station slice:

```text
Linear issue in Needs Plan or Planning Failed
  -> harness factory planning --linear-issue FER-123
  -> existing planning/review loop
  -> approved plan written to dev/plans/FER-123.md
```

It does **not** mutate Linear. Linear planning `--apply`, `Planning` status
transitions, and `Ready to Implement` after plan PR merge remain later slices.

## Current state

Relevant files:

- `bin/factory-commands.ts` - owns `harness factory planning run`,
  `harness factory triage --linear-issue`, and planning publication commands.
- `lib/factory-triage-input.ts` - resolves either `--item-file` or
  `--linear-issue` into a `FactoryWorkItem` for triage only.
- `lib/factory-linear-adapter.ts` - fetches a Linear issue as a
  `FactoryWorkItem`, validates status map config, maps Linear status to
  `metadata.factoryStage`, and owns explicit triage `--apply` mutations.
- `lib/factory-planning-run-context.ts` - owns planning run directories, draft
  snapshots, final plan copying, tracker-key plan path derivation, and metadata.
- `workflows/factory-planning.workflow.ts` - runs the planner/reviewer loop and
  requires `metadata.factoryRoute === "ready-to-plan"` when route metadata is
  present.
- `test/cli.test.ts` - covers planning CLI help, item-file planning dry-run,
  planning publication commands, and Linear triage validation.
- `test/factory-triage-input.test.ts` - covers the existing triage input
  resolver and Linear fake-adapter seam.
- `test/factory-linear-adapter.test.ts` - covers Linear fetch/status mapping
  and triage apply helpers.
- `docs/contributing/factory.md`, `docs/contributing/architecture.md`,
  `docs/contributing/script-command-surface.md`,
  `docs/contributing/setup-manifest.md`, `README.md`, and
  `skills/factory-operator/SKILL.md` document the current factory command
  surface.

Current planning command shape in `bin/factory-commands.ts`:

```ts
type FactoryPlanningStationOptions = {
  workspace?: string;
  itemFile: string;
  runsDir?: string;
  outputPlan?: string;
  maxReviewIterations?: number;
  maxRuntimeMs: number;
  dryRun: boolean;
  verbose: boolean;
};
```

```ts
.requiredOption("--item-file <path>", "factory work item JSON file")
```

Current triage input resolver in `lib/factory-triage-input.ts`:

```ts
export async function resolveFactoryTriageWorkItem(
  input: ResolveFactoryTriageWorkItemInput,
): Promise<FactoryTriageWorkItemInput> {
  validateFactoryTriageWorkItemInput(input);
  // item file or Linear fetch
}
```

Planning run context already supports tracker-key plan filenames. In
`lib/factory-planning-run-context.ts`, `resolveOutputPlan` falls back to
`deriveTrackerPlanPath`, and `parseTrackerPlanRef` maps Linear tracker metadata
to `dev/plans/<TEAM>-<number>.md`:

```ts
if (tracker.source === "linear") {
  const parsed = parseLinearIssueIdentifier(tracker.id);
  if (!parsed) {
    throw new FactoryPlanningError(`Invalid Linear tracker id for plan path: ${tracker.id}`);
  }
  return { fileName: `${parsed.teamKey}-${parsed.number}.md` };
}
```

The Linear adapter already maps configured statuses to factory stages:

```text
Backlog              -> incoming
Needs Info           -> needs-info
Needs Plan           -> ready-to-plan
Ready to Implement   -> ready-to-implement
Parked               -> wait-to-implement
Planning             -> planning
Planning Failed      -> planning-failed
```

Live smoke after PR #74 proved the upstream path:

```text
FER-9: Backlog -> Triaging -> Needs Plan
metadata.factoryStage: ready-to-plan
```

Project constraints to keep while editing contributor docs:

- Source of truth: follow `docs/project-intent.md` and `AGENTS.md` for durable
  repo examples, contributor docs, and plan hygiene.
- Keep durable examples generic. Do not add user-specific absolute paths to docs
  or plans; use `/path/to/repo` and tell operators to substitute their
  workspace.
- Label current behavior and future behavior separately. In this slice,
  Linear-backed planning input is current; Linear planning `--apply`, status
  mutation, and comment publishing remain future.
- Keep this repo standalone. Do not reference private downstream repos or
  fixtures.

## Commands you will need

| Purpose                | Command                                                                                            | Expected on success               |
| ---------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------- |
| Focused planning tests | `pnpm exec vitest run test/factory-planning*.test.ts test/cli.test.ts`                             | exit 0, matching tests pass       |
| Linear input tests     | `pnpm exec vitest run test/factory-triage-input.test.ts test/cli.test.ts --testNamePattern Linear` | exit 0, matching tests pass       |
| Docs contracts         | `pnpm exec vitest run test/docs-contracts.test.ts`                                                 | exit 0                            |
| Typecheck              | `pnpm typecheck`                                                                                   | exit 0, no errors                 |
| Full gate              | `pnpm check`                                                                                       | exit 0, lint/test/type/build pass |
| Plan review            | `node bin/harness.ts run plan-review --plan dev/plans/260707-linear-planning-input.md --verbose`   | verdict `pass`                    |

Do not print `LINEAR_API_KEY`. For live smoke, use a disposable Linear issue in
the configured `factory.linear.teamKey` team.

## Suggested executor toolkit

| Skill                                                                       | Use for                                                                          |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `typescript-refactor` (`.agents/skills/typescript-refactor/SKILL.md`)       | Type-safe option/input resolver changes, especially discriminated input sources. |
| `vitest` (`.agents/skills/vitest/SKILL.md`)                                 | Add CLI and resolver regression tests using fake adapters and temp workspaces.   |
| `zod` (`.agents/skills/zod/SKILL.md`)                                       | Preserve schema validation boundaries if metadata parsing changes.               |
| `factory-operator` (`skills/factory-operator/SKILL.md`)                     | Run dry-run and live Linear planning input smoke tests and inspect artifacts.    |
| `change-review-workflow` (`.agents/skills/change-review-workflow/SKILL.md`) | Review the implementation before opening the PR.                                 |

## Scope

**In scope**:

- Add `--linear-issue <issue>` to `harness factory planning run`.
- Make planning input source validation mirror triage:
  - exactly one of `--item-file` or `--linear-issue`
  - mutually exclusive
  - Linear input requires `factory.linear` config and `LINEAR_API_KEY`
- Reuse or extract the existing Linear work-item resolver so triage and planning
  do not duplicate API-key/config/fetch behavior.
- Add a planning entry guard:
  - apply it only when the resolved input source is `linear`
  - accept fetched Linear issues whose metadata has `factoryStage:
"ready-to-plan"` or `factoryStage: "planning-failed"`
  - reject other fetched Linear statuses before creating a planning run
- Keep `--dry-run` read-only toward Linear. It may perform the live Linear read
  needed to build the work item, but it must not mutate Linear.
- Preserve existing item-file planning behavior.
- Ensure tracker-backed Linear plans still default to `dev/plans/<issue-key>.md`
  for live approved planning runs, e.g. `dev/plans/FER-9.md`.
- Update command help, docs, smoke checks, and operator skill.
- Add fake-client tests and at least one live dry-run smoke with a disposable
  Linear issue in `Needs Plan`.

**Out of scope**:

- Linear planning `--apply`.
- Moving Linear to `Planning`.
- Moving Linear to `Ready to Implement`.
- Posting live Linear planning comments.
- Automatically opening, merging, or inspecting plan PRs.
- Implementation station.
- Backlog listing or batch processing.
- Inngest/webhooks/retries/locks.
- GitHub/Jira adapters.
- Direct commits to `main`.

## Steps

### Step 1: Extract a shared factory work-item input resolver

Create a shared resolver module or widen the existing one so both triage and
planning can resolve file-backed and Linear-backed work items without duplicating
the Linear fetch logic.

Recommended shape:

- Prefer the lower-churn path: add generic exports in the existing
  `lib/factory-triage-input.ts` and update call sites to use the shared names.
  Rename to `lib/factory-work-item-input.ts` only if that is simpler after
  reading imports. If renaming, update all imports and contributor docs that
  reference `lib/factory-triage-input.ts`.
- Prefer generic names:

```ts
export type FactoryWorkItemInputSource = "item-file" | "linear";

export type FactoryResolvedWorkItemInput = {
  source: FactoryWorkItemInputSource;
  workItem: FactoryWorkItem;
  linearApplied?: false;
};

export async function resolveFactoryWorkItemInput(...): Promise<FactoryResolvedWorkItemInput>;
export function validateFactoryWorkItemInput(...): asserts input is ...;
```

Either update all current imports in this step or keep triage-named exports as
thin aliases to the generic resolver so existing call sites do not break during
the transition.

Keep the current behavior:

- file input reads JSON with `assertFactoryItemFileExists` and
  `readFactoryWorkItemFile`
- Linear input requires `factory.linear` settings and `LINEAR_API_KEY`
- Linear input uses the adapter factory seam for tests
- Linear input returns `linearApplied: false`

Update triage command imports to use the shared names. Do not change triage
behavior.

**Verify**:

```bash
pnpm exec vitest run test/factory-triage-input.test.ts test/cli.test.ts --testNamePattern "Linear"
```

Expected: all existing Linear triage input tests pass before planning command
changes.

### Step 2: Add planning input source validation

Update `bin/factory-commands.ts`.

Change `FactoryPlanningStationOptions` from required `itemFile: string` to
optional file/Linear inputs:

```ts
type FactoryPlanningStationOptions = {
  workspace?: string;
  itemFile?: string;
  linearIssue?: string;
  runsDir?: string;
  outputPlan?: string;
  maxReviewIterations?: number;
  maxRuntimeMs: number;
  dryRun: boolean;
  verbose: boolean;
};
```

Update command options:

```ts
.option("--item-file <path>", "factory work item JSON file")
.option("--linear-issue <issue>", "Linear issue identifier, e.g. TEAM-123")
```

Do not add `--apply` in this plan.

Validation order should match triage:

1. move input-source validation to the top of the planning action and validate
   exactly one input source before role/config resolution
2. resolve planning settings and roles
3. resolve Linear settings only when `--linear-issue` is present
4. resolve the work item through the shared resolver
5. when resolved source is `linear`, validate Linear planning entry status
   before creating the planning context

The current planning action resolves `resolveFactoryPlanningSettings`, planner
roles, reviewer roles, and item-file input before input-source validation. Move
the new `validateFactoryWorkItemInput(options)` call ahead of those steps so the
handler mirrors triage's validation order.

Add tests in `test/cli.test.ts`:

- `harness factory planning requires one input source`
- `harness factory planning rejects multiple input sources`
- `harness factory planning with Linear input requires Linear config`
- `harness factory planning with Linear input requires LINEAR_API_KEY`
- planning help includes `--linear-issue <issue>` and does not include direct
  agent/model flags
- existing item-file planning dry-run still passes

**Verify**:

```bash
pnpm exec vitest run test/cli.test.ts --testNamePattern "planning"
```

Expected: planning CLI tests pass.

### Step 3: Guard Linear planning entry status

Add a small helper near the planning command or in a factory planning input
module. Keep it deterministic and metadata-driven.

Recommended contract:

```ts
function assertFactoryPlanningLinearEntry(input: FactoryResolvedWorkItemInput): void {
  if (input.source !== "linear") return;
  const metadata = parseFactoryWorkItemMetadata(input.workItem.metadata);
  if (metadata.factoryStage === "ready-to-plan" || metadata.factoryStage === "planning-failed") {
    return;
  }
  const status = metadata.linearStatus ? ` (${metadata.linearStatus})` : "";
  throw new FactoryPlanningError(
    `Linear issue is in ${String(metadata.factoryStage ?? "unknown")}${status}; planning accepts Needs Plan or Planning Failed.`,
  );
}
```

Important details:

- Use `FactoryPlanningError` from `lib/factory-planning-schemas.ts` for the
  thrown error.
- Use `parseFactoryWorkItemMetadata` from `lib/factory-schemas.ts`; do not
  inspect raw JSON by hand.
- Include the current Linear status if available in metadata for clearer
  messages, e.g. `linearStatus`.
- Only apply this guard to `--linear-issue` inputs. Do not key solely off
  `metadata.tracker.source === "linear"` because item-file handoffs can carry
  Linear tracker metadata and must retain current manual/local planning
  behavior.
- Guard before `createFactoryPlanningRunContext` so rejected Linear issues do
  not create run directories.
- Existing workflow handoff validation remains a second gate after run
  directory creation for item-file inputs. This plan does not move those
  existing item-file failures earlier.

Add tests:

- accepts `metadata.factoryStage: "ready-to-plan"`
- accepts `metadata.factoryStage: "planning-failed"`
- rejects `incoming`, `ready-to-implement`, `needs-info`,
  `wait-to-implement`, `triaging`, `planning`, and missing stage for Linear
  tracker input
- rejects a fake Backlog issue (`factoryStage: "incoming"`) before
  `createFactoryPlanningRunContext`
- item-file/manual input with Linear tracker metadata and no `factoryStage` is
  not rejected by the Linear guard

**Verify**:

```bash
pnpm exec vitest run test/cli.test.ts --testNamePattern "Linear input"
```

Expected: Linear planning input guard tests pass.

### Step 4: Wire planning command to Linear work items

Update `addFactoryPlanningRunCommand` in `bin/factory-commands.ts`:

- Resolve roles exactly as today.
- For `--item-file`, keep current read behavior through the shared resolver.
- For `--linear-issue`, fetch via the Linear adapter.
- Pass the resolved `workItem` into `createFactoryPlanningRunContext`.
- Preserve `options.outputPlan` override.
- Do not mutate Linear.

Expected dry-run behavior:

```bash
LINEAR_API_KEY=... node bin/harness.ts factory planning \
  --workspace /path/to/repo \
  --linear-issue FER-9 \
  --dry-run
```

Should:

- perform a live Linear read
- create `.harness/runs/factory/<run-id>/`
- write `context/work-item.json`
- write dry-run plan placeholder artifacts
- print JSON with `workflow: "factory-planning"` and `status: "dry_run"`
- leave Linear status unchanged

Expected live behavior:

```bash
LINEAR_API_KEY=... node bin/harness.ts factory planning \
  --workspace /path/to/repo \
  --linear-issue FER-9
```

Should:

- run the existing planner/reviewer loop
- after approval, write `dev/plans/FER-9.md` unless `--output-plan` was provided
- for tracker-backed Linear planning runs, emit metadata with
  `approvedPlanPath: "dev/plans/FER-9.md"` and `factoryStage: "plan-pr-open"`
- not post Linear comments and not move Linear status

Add tests:

- In a unit/integration test with a fake adapter, Linear planning dry-run uses
  the fetched work item and writes context artifacts.
- In a unit/integration test with a fake adapter, Linear planning dry-run
  rejects a fetched issue in `Ready to Implement`.
- Keep `test/cli.test.ts` subprocess coverage to help text, mutual exclusion,
  config errors, and API-key errors. The CLI subprocess cannot inject the fake
  Linear adapter seam, so do not require live Linear API calls in Vitest.
- Follow the existing `test/factory-triage-input.test.ts` pattern for fake
  adapter coverage: test `resolveFactoryWorkItemInput`,
  `assertFactoryPlanningLinearEntry`, and the planning run context/workflow
  directly rather than trying to inject `linearAdapterFactory` through a spawned
  CLI process.
- a narrow Linear-input CLI or planning-context test proves a Linear work item
  writes default output plan `dev/plans/FER-123.md`. Do not duplicate existing
  tracker path coverage already present in
  `test/factory-planning.workflow-failures.test.ts`.

**Verify**:

```bash
pnpm exec vitest run test/factory-planning*.test.ts test/cli.test.ts --testNamePattern "planning"
```

Expected: all planning tests pass.

### Step 5: Update docs, operator skill, and smoke checks

Update these docs:

- `README.md`
  - Mention `harness factory planning --linear-issue TEAM-123 --dry-run` only if
    it fits the README line budget.
- `docs/contributing/factory.md`
  - Add Linear planning input examples.
  - State that `--linear-issue` planning is read-only toward Linear in this
    slice.
  - State accepted Linear statuses: `Needs Plan` and `Planning Failed`.
  - State that Linear planning `--apply` remains future work.
- `docs/contributing/script-command-surface.md`
  - Classify `harness factory planning --linear-issue ... --dry-run` as checking
    with ignored artifacts plus a live Linear read.
  - Keep mutation wording clear: no Linear mutation for planning yet.
- `docs/contributing/setup-manifest.md`
  - Add `harness factory planning --linear-issue TEAM-123` as a
    `LINEAR_API_KEY` consumer.
- `docs/contributing/architecture.md`
  - Update current map: Linear-backed planning input is current; planning apply
    remains future.
  - If `lib/factory-triage-input.ts` is renamed, update the existing source-area
    reference to the new module name.
- `skills/factory-operator/SKILL.md`
  - Add the command and status guard.
  - Keep stop conditions aligned.
- `scripts/smoke-dist.ts`
  - Add help assertion that `harness factory planning run --help` includes
    `--linear-issue <issue>`.

Update `dev/todo/260704-factory-adapters-orchestration.md`:

- Verify the Linear implementation split remains current:
  - read-only adapter, triage input, and triage apply are shipped/current
  - planning input is this plan
  - planning apply remains future
  - backlog listing remains later

Update `dev/plans/README.md`:

- Verify this plan is listed as active. After the implementation lands, remove
  this plan file and move the shipped work to the history-only table.

**Verify**:

```bash
pnpm exec vitest run test/docs-contracts.test.ts
pnpm exec oxfmt --check README.md docs/contributing/*.md skills/factory-operator/SKILL.md scripts/smoke-dist.ts dev/todo/260704-factory-adapters-orchestration.md dev/plans/README.md
```

Expected: docs contracts and formatting pass.

### Step 6: Run live dry-run smoke

Use a disposable Linear issue in the configured factory team that is already in
`Needs Plan`. If one exists from prior smoke, it can be reused.

Recommended smoke:

```bash
node bin/harness.ts factory linear fetch FER-9 --workspace /path/to/repo
node bin/harness.ts factory planning --workspace /path/to/repo --linear-issue FER-9 --dry-run --verbose
node bin/harness.ts factory linear fetch FER-9 --workspace /path/to/repo
```

Substitute `/path/to/repo` with the target workspace when running the smoke.

Expected:

- first fetch reports `metadata.linearStatus: "Needs Plan"` and
  `metadata.factoryStage: "ready-to-plan"`
- planning dry-run exits 0 and writes ignored factory run artifacts
- second fetch still reports `metadata.linearStatus: "Needs Plan"`

Do not run a live non-dry-run planning station against a real issue unless the
user explicitly approves creating a plan file and provider/reviewer calls for
that issue.

**Verify**:

```bash
pnpm check
```

Expected: full gate passes after smoke and no unwanted tracked files remain.

## Test plan

New or updated tests:

- `test/factory-triage-input.test.ts` or a new
  `test/factory-work-item-input.test.ts`
  - shared resolver reads item files
  - shared resolver fetches Linear with fake adapter
  - resolver preserves config/API-key error ordering
- `test/cli.test.ts`
  - planning help includes `--linear-issue`
  - planning requires exactly one input source
  - planning rejects `--item-file` + `--linear-issue`
  - planning Linear input requires config and API key
- a unit/integration planning-input test using a fake Linear adapter
  - planning Linear input accepts `Needs Plan` and `Planning Failed`
  - planning Linear input rejects non-planning statuses
  - item-file planning with Linear tracker metadata and no `factoryStage` still
    works
  - planning Linear dry-run writes context artifacts from fetched Linear item
- `test/cli.test.ts`, `test/factory-planning.workflow-failures.test.ts`, or a
  similarly narrow planning-context test
  - Linear tracker-backed planning input defaults final plan path to
    `dev/plans/FER-123.md` without duplicating existing tracker path coverage

Existing tests to keep passing:

- `test/factory-linear-adapter.test.ts`
- `test/factory-planning-handoff.test.ts`
- `test/factory-planning.workflow-failures.test.ts`
- `test/factory-triage-input.test.ts`
- `test/docs-contracts.test.ts`

## Done criteria

- [x] `harness factory planning run --help` includes `--linear-issue <issue>`.
- [x] `harness factory planning --linear-issue FER-123 --dry-run` performs a
      live Linear read and writes planning dry-run artifacts.
- [x] Planning command rejects missing input source and multiple input sources.
- [x] Linear planning input requires `factory.linear` config and
      `LINEAR_API_KEY`.
- [x] Linear planning input accepts `Needs Plan` / `ready-to-plan`.
- [x] Linear planning input accepts `Planning Failed` / `planning-failed`.
- [x] Linear planning input rejects non-planning statuses before creating a run.
- [x] Linear planning input does not mutate Linear status or comments.
- [x] Tracker-backed live approved Linear planning runs default to
      `dev/plans/<issue-key>.md` and emit `factoryStage: "plan-pr-open"`.
- [x] Item-file planning behavior remains unchanged.
- [x] Docs and factory-operator skill describe Linear planning input as current
      and planning apply as future.
- [x] `pnpm exec vitest run test/factory-planning*.test.ts test/cli.test.ts`
      exits 0.
- [x] `pnpm exec vitest run test/docs-contracts.test.ts` exits 0.
- [x] `pnpm check` exits 0.
- [ ] Live dry-run smoke result is documented in the PR body.
- [ ] `dev/plans/README.md` active row exists during implementation and is
      moved to the shipped table when this plan lands.

Implementation smoke notes:

- `node bin/harness.ts factory linear fetch FER-9 --workspace /path/to/repo`
  confirmed `linearStatus: "Needs Plan"` and `factoryStage: "ready-to-plan"`.
- `node bin/harness.ts factory planning --workspace /path/to/repo --linear-issue FER-9 --dry-run --verbose`
  exited 0 with run `20260707-193726-d6c7aa`.
- Fetching `FER-9` again confirmed `linearStatus: "Needs Plan"` and unchanged
  `linearUpdatedAt`.
- `FER-10` in `Ready to Implement` was rejected with no new run directory:
  `Linear issue is in ready-to-implement (Ready to Implement); planning accepts
Needs Plan or Planning Failed.`

## STOP conditions

Stop and report back if:

- The executor discovers planning already accepts `--linear-issue` on `main`.
- A reliable implementation requires adding Linear planning `--apply`.
- A reliable implementation requires moving Linear to `Planning` or
  `Ready to Implement`.
- The planning command must mutate Linear to pass tests.
- The current `FactoryWorkItem` metadata does not contain enough Linear status
  information to guard `Needs Plan` / `Planning Failed`.
- The change requires altering `workflows/factory-planning.workflow.ts` to know
  about Linear.
- Live smoke would mutate a non-disposable issue or create a tracked plan file
  without explicit user approval.

## Maintenance notes

- This is the planning equivalent of triage input integration, not planning
  apply. Keep mutations out of this slice.
- The future planning apply slice should reuse the same Linear work-item
  resolver and add deterministic status/comment mutation around the existing
  planning station.
- The implementation station should wait until planned Linear work can move to
  `Ready to Implement` only after a merged plan PR records
  `approvedPlanCommit`.
- Reviewers should scrutinize validation order, no-mutation guarantees, and
  whether rejected Linear statuses avoid creating partial run artifacts.
