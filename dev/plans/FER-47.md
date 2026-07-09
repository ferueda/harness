# Plan 260708-factory-implementation-station-shell: Add dry-run implementation station shell

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the next
> step. If a STOP condition occurs, stop and report. Do not improvise.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: FER-32 implementation input resolver already shipped in this tree.
- **Category**: dx, direction
- **Linear issue**: FER-47

## Why this matters

The factory can triage work and approve plans, and FER-32 added the readiness
resolver that separates planned implementation from direct implementation. The
operator still has no implementation station command that materializes the
resolved implementation input, prompt, and review handoff in the standard
factory run directory. This plan adds only that dry-run shell. It intentionally
does not invoke an implementer, create branches, run change-review, create PRs,
or mutate Linear.

## Requirements

- Add `harness factory implementation run --workspace <repo> --linear-issue FER-123 --dry-run`.
- Add `harness factory implementation run --workspace <repo> --item-file work-item.json --dry-run`.
- Validate `--item-file` and `--linear-issue` with the existing mutually
  exclusive one-source guard.
- Keep FER-47 dry-run/shell-only: require `--dry-run` for v1 and fail if it is
  omitted.
- Resolve the work item through `resolveFactoryWorkItemInput`.
- Resolve implementation readiness through `resolveFactoryImplementationInput`.
- For Linear-backed input, pass configured
  `factory.linear.statuses.readyToImplement` as `linearReadyStatus`.
- Preserve FER-32 publication-signal precedence. Any planned publication signal
  must keep planned validation ahead of direct markers; partial handoffs fail
  closed.
- Add config shape `factory.implementation.roles.implementer` using the same
  role fields as triage/planning: `agent`, `model`, and optional Codex-only
  fields such as `executable`, `sandboxMode`, `approvalPolicy`, and
  `modelReasoningEffort`.
- Resolve/render the implementer role into `meta.json`, CLI output, and the
  generated implementation prompt. Do not create an agent provider or invoke it.
- Create normalized dry-run artifacts:
  - `context/work-item.json`
  - `context/implementation-input.json`
  - `context/plan-ref.json` for planned mode only
  - `context/source-material.json` for direct mode only
  - `implementation/prompt.md`
  - `implementation/change-review-handoff.md`
  - `summary.md`
  - `meta.json`
- Planned mode artifacts must include `approvedPlanPath`, absolute `planPath`,
  and `approvedPlanCommit`. Treat the commit only as provenance/readiness in v1;
  do not add Git object checkout or verification.
- Direct mode artifacts must include title, body, labels, url, tracker metadata,
  and source material from the resolved work item.
- The prompt must tell a future implementer:
  - planned mode: follow the approved plan at `planPath`;
  - direct mode: implement only the direct scoped request;
  - no tracker mutation, PR creation, branch/worktree orchestration, or review
    loop is owned by this station.
- `implementation/change-review-handoff.md` must reuse the existing
  `change-review-workflow` handoff section model exactly: Goal, Scope, Files
  changed, Implementation notes, Verification, Risks to scrutinize, Open items.
  Prefill only what the station knows; use explicit placeholders such as
  `_To be filled after implementation._` and `_Not run yet._`.
- Dry-run v1 must not append lifecycle events and must not write `events.jsonl`.
- Update operator docs, command-surface docs, README command examples, and
  dist smoke/help coverage.

## Current state

- `package.json` uses Node 24, pnpm 11.9.0, TypeScript 6.0.3, Vitest 4.1.9, and
  Zod 4.4.3. Useful scripts are `pnpm typecheck`, `pnpm lint`, `pnpm test`,
  `pnpm build`, `pnpm smoke:dist`, and `pnpm check`.
- `README.md:85-98` lists factory triage and planning commands. There is no
  implementation command in the public example block.
- `README.md:121-123` says factory station agent/model selection comes from
  `harness.json` role config under `factory.<station>.roles`.
- `docs/contributing/factory.md:104-163` documents role-based station config for
  triage and planning, and says to keep factory config role-based instead of
  adding per-role CLI flag sprawl.
- `docs/contributing/factory.md:413-430` explicitly says there is no
  implementation station CLI yet, and that the future station should call
  `resolveFactoryWorkItemInput` then `resolveFactoryImplementationInput`.
- `docs/contributing/factory.md:470-481` lists factory stop conditions,
  including no GitHub/Jira/Inngest mutation from current station commands, no
  committing `.harness/runs/*`, and no hidden tracker mutation.
- `docs/contributing/script-command-surface.md:14-18` lists source CLI commands.
  It does not include `harness factory implementation run`.
- `docs/contributing/script-command-surface.md:31-35` classifies dry-run factory
  commands as ignored-artifact writers and says dry-runs do not invoke
  providers; this wording must include the implementation shell after it exists.
- `lib/factory-implementation-input.ts:42-92` already implements the FER-32
  resolver. It parses metadata, applies the Linear ready-status projection
  guard, validates planned handoffs before direct mode when any publication
  signal exists, and returns either planned input or direct source material.
- `lib/factory-implementation-input.ts:107-137` defines the key readiness rules:
  planned publication signals include `plan-approved`, `plan-pr-open`,
  `approvedPlanPath`, `approvedPlanPrUrl`, or `approvedPlanCommit`; direct mode
  requires `factoryStage: "ready-to-implement"`,
  `factoryRoute: "ready-to-implement"`, and
  `factoryNextAction: "implement-directly"`.
- `test/factory-implementation-input.test.ts:28-318` covers the resolver:
  planned success, missing plan file, plan-pr-open fail-closed behavior, direct
  readiness, stale Linear status, missing Linear ready-status config, planned
  precedence over direct markers, lifecycle overlay, invalid metadata, and
  planned handoff error propagation.
- `lib/factory-triage-input.ts:39-80` is the shared work-item input resolver for
  item-file and Linear sources. `lib/factory-triage-input.ts:101-110` already
  throws the desired one-source errors.
- `bin/factory-commands.ts:131-137` registers factory status, Linear, triage,
  and planning commands. No implementation command is registered.
- `bin/factory-commands.ts:233-390` is the best command pattern for a nested
  station: validate source/apply flags first, resolve station settings/roles,
  resolve Linear settings only for `--linear-issue`, fetch/merge the work item,
  create a run context, run the station, print JSON output, and set exit code.
- `bin/factory-commands.ts:685-790` is the triage command pattern for
  role-backed factory run artifacts. It resolves `factory.triage.roles.triager`
  and writes lifecycle events only when not dry-run.
- `lib/config.ts:70-98` currently only models factory stations `triage` and
  `planning` with roles `triager`, `planner`, and `reviewer`.
- `lib/config.ts:128-160` resolves a factory role to agent/model/Codex policy
  fields and applies a `workspace-write` Codex sandbox default only to the
  planning planner.
- `lib/config.ts:284-291` selects triage or planning role config; there is no
  implementation role path.
- `lib/schemas.ts:21-68` defines strict factory role/config Zod schemas for
  triage, planning, and Linear. `factory.implementation` is currently rejected.
- `lib/schemas.ts:124-137` validates only triager, planner, and reviewer roles
  with the Codex-only field guard.
- `lib/factory-planning-run-context.ts:58-82` is a useful meta shape example:
  `workflow`, `status`, `workspace`, `runDir`, compact `workItem`, agent meta,
  artifact paths, `startedAt`, `durationMs`, and optional `eventsFile`.
- `lib/factory-planning-run-context.ts:192-315` creates run directories,
  writes `context/work-item.json`, suppresses events in dry-run, and writes
  `summary.md` plus `meta.json` on export.
- `lib/factory-run-context.ts:142-283` is the simpler triage run-context pattern
  for a single station run. It creates the run directory, writes context, builds
  agent metadata, writes artifacts, and cleans up orphaned run dirs on bootstrap
  failure.
- `workflows/factory-planning.workflow.ts:223-235` proves dry-run station runs
  should write placeholder artifacts without provider or reviewer calls.
- `test/factory-planning.workflow.test.ts:24-61` and
  `test/factory-triage.workflow.test.ts:35-66` are the nearest dry-run artifact
  tests. Both assert no `events.jsonl` in dry-run.
- `test/config.test.ts:349-392` currently asserts `factory.implementation` is an
  unknown station. That test must be updated when the implementation role config
  becomes valid.
- `scripts/smoke-dist.ts:95-146` checks factory triage/planning help surfaces.
  Add implementation help checks there.
- `test/cli.test.ts` is already very large. Prefer a focused new
  `test/factory-implementation-cli.test.ts` for implementation CLI behavior
  instead of adding more station cases to that file, except for any small help
  assertion if the existing command-surface tests require it.

## Commands you will need

| Purpose                          | Command                                                                                                                                                              | Expected on success                                                              |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Install                          | `pnpm install --frozen-lockfile`                                                                                                                                     | exit 0                                                                           |
| Existing resolver baseline       | `pnpm test -- test/factory-implementation-input.test.ts`                                                                                                             | exit 0; all existing implementation-input tests pass                             |
| Config tests                     | `pnpm test -- test/config.test.ts`                                                                                                                                   | exit 0; implementation role config tests pass                                    |
| New implementation station tests | `pnpm test -- test/factory-implementation-run-context.test.ts test/factory-implementation-cli.test.ts`                                                               | exit 0; planned and direct artifact tests pass                                   |
| CLI help smoke from source       | `node bin/harness.ts factory implementation run --help`                                                                                                              | exit 0; help includes `--item-file`, `--linear-issue`, `--runs-dir`, `--dry-run` |
| Focused factory tests            | `pnpm test -- test/factory-implementation-input.test.ts test/factory-implementation-run-context.test.ts test/factory-implementation-cli.test.ts test/config.test.ts` | exit 0                                                                           |
| Typecheck                        | `pnpm typecheck`                                                                                                                                                     | exit 0, no TypeScript errors                                                     |
| Lint                             | `pnpm lint`                                                                                                                                                          | exit 0, no lint errors                                                           |
| Dist smoke                       | `pnpm smoke:dist`                                                                                                                                                    | exit 0; built CLI help includes factory implementation                           |
| Full local gate                  | `pnpm check`                                                                                                                                                         | exit 0; format, lint, typecheck, tests, build, smoke-dist pass                   |

## Skills for the executor

| Step                          | Skill/tool               | Why                                                                                                                            |
| ----------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| All steps                     | `implement-plan`         | Execute this approved plan phase by phase, preserving scope boundaries and updating plan checkboxes if copied to `dev/plans/`. |
| Type/config/run-context steps | `typescript-refactor`    | Keep new discriminated unions, exported meta types, and command option types idiomatic for strict TypeScript.                  |
| Config/schema step            | `zod`                    | Extend strict Zod config schemas and validation errors without weakening existing boundary checks.                             |
| Test steps                    | `vitest`                 | Add isolated station and CLI regression tests matching the repo's Vitest style.                                                |
| After implementation          | `change-review-workflow` | Prepare/run the repository's standard review handoff after code changes, using the generated handoff model as reference.       |

## Scope

**In scope - modify only these files unless a STOP condition says to ask:**

- `bin/factory-commands.ts`
- `bin/factory-implementation-cli.ts` (new)
- `lib/config.ts`
- `lib/schemas.ts`
- `lib/factory-implementation-run-context.ts` (new)
- `lib/prompts/factory-implementation.ts` (new)
- `lib/prompts/index.ts`
- `workflows/factory-implementation.workflow.ts` (new)
- `README.md`
- `docs/contributing/factory.md`
- `docs/contributing/script-command-surface.md`
- `scripts/smoke-dist.ts`
- `test/config.test.ts`
- `test/factory-implementation-run-context.test.ts` (new)
- `test/factory-implementation-cli.test.ts` (new)
- `test/factory-implementation-input.test.ts` only if a small regression assertion is needed for shell integration

**Out of scope - do not touch:**

- Live implementer/provider invocation.
- `providers/*` and provider SDK behavior.
- Change-review execution loop.
- PR creation, GitHub mutation, Linear mutation, Jira/Inngest work.
- Branch/worktree orchestration, Git checkout, commit verification, or Git object
  reads for `approvedPlanCommit`.
- Lifecycle event appends or durable implementation stage transitions.
- Generic factory station framework abstractions.
- Moving/processing inbox files.
- Changing FER-32 readiness semantics except for a targeted regression test.
- Editing unrelated plans or shipped-plan history.

## Implementation steps

### Step 1: Add implementation role config support

Update `lib/schemas.ts`:

- Add optional `implementation` under `FactoryConfigSchema`.
- Shape:

```ts
implementation: z.object({
  roles: z
    .object({
      implementer: FactoryRoleSchema.optional(),
    })
    .strict()
    .optional(),
})
  .strict()
  .optional();
```

- Add `validateFactoryRole(config, ctx, ["factory", "implementation", "roles", "implementer"], config.factory?.implementation?.roles?.implementer)`.
- Preserve `.strict()` at each station object so unknown role/station fields
  still fail.

Update `lib/config.ts`:

- Extend `FactoryStationName` to include `"implementation"`.
- Extend `FactoryStationRole` to include `"implementer"`.
- Extend `ResolveFactoryRoleAgentInput` with
  `{ station: "implementation"; role: "implementer" }`.
- Update `factoryRoleConfig` to return
  `config.factory?.implementation?.roles?.implementer` for implementation.
- Do not add a `workspace-write` default for implementation. The command is
  dry-run only and should use the same role fallback chain as triage unless
  explicitly configured: role -> provider config -> default model.

Update `test/config.test.ts`:

- Change the unknown-station case so it still checks a truly unknown station,
  not `implementation`.
- Add a test that `resolveFactoryRoleAgent({ station: "implementation", role:
"implementer" })` reads a configured Cursor role.
- Add a test that a Codex implementation role preserves optional fields:
  `model`, `executable`, `sandboxMode`, `approvalPolicy`,
  `modelReasoningEffort`.
- Add a test that Codex-only fields on an effective Cursor implementation role
  are rejected with the existing "applies only when role agent is codex" message.

**Verify**: `pnpm test -- test/config.test.ts` -> exit 0.

### Step 2: Add implementation prompt and handoff renderers

Create `lib/prompts/factory-implementation.ts` and export it from
`lib/prompts/index.ts`.

Define render helpers that accept the resolved implementation input and
implementer agent metadata:

- `renderFactoryImplementationPrompt(input)` returns markdown for
  `implementation/prompt.md`.
- `renderFactoryImplementationChangeReviewHandoff(input)` returns markdown for
  `implementation/change-review-handoff.md`.

Prompt content requirements:

- Include a clear title: `# Factory Implementation`.
- Include `Mode: planned` or `Mode: direct`.
- Include implementer role/provider/model and Codex policy fields when present.
- Planned prompt includes `approvedPlanPath`, absolute `planPath`, and
  `approvedPlanCommit`, and instructs the implementer to follow the approved
  plan. It must explicitly say the commit is a provenance/readiness marker in
  this v1 shell and that the station has not checked out or verified that Git
  object.
- Direct prompt includes source title, body, labels, url, tracker metadata, and
  instructs the implementer to implement only that scoped request.
- Both modes state the station does not own tracker mutation, PR creation,
  branch/worktree orchestration, change-review execution, or lifecycle updates.

Handoff content requirements:

- Use exactly these level-2 section headings:
  - `## Goal`
  - `## Scope`
  - `## Files changed`
  - `## Implementation notes`
  - `## Verification`
  - `## Risks to scrutinize`
  - `## Open items`
- Prefill known goal/scope/mode/provenance/source facts.
- Put `_To be filled after implementation._` under Files changed,
  Implementation notes, and Open items.
- Put `_Not run yet._` under Verification.

**Verify**: `pnpm typecheck` -> exit 0.

### Step 3: Add dry-run implementation run context and workflow

Create `lib/factory-implementation-run-context.ts`.

Target exported types:

- `FactoryImplementationRunStatus = "dry_run"`.
- `FactoryImplementationAgentMeta` with `name`, `model`, optional
  `sandboxMode`, `approvalPolicy`, `modelReasoningEffort`.
- `FactoryImplementationRunMeta` with:
  - `runId`
  - `workflow: "factory-implementation"`
  - `status: "dry_run"`
  - `mode: "planned" | "direct"`
  - `workspace`
  - `runDir`
  - compact `workItem: { id; source; title }`
  - `implementerAgent`
  - `artifacts` with relative paths for written files
  - `summaryPath`
  - `metaPath`
  - `startedAt`
  - `durationMs`
- `FactoryImplementationRunContextOptions` with `workspace`, optional
  `runsDir`, `workItem`, resolved `implementationInput`, `implementerRole`,
  and `dryRun`.
- `createFactoryImplementationRunContext` and
  `createFactoryImplementationRunContextForTest`.

Behavior:

- Resolve `workspace`; fail if it does not exist.
- Build `runId` with existing `buildRunId`.
- Default `runDir` to `<workspace>/.harness/runs/factory/<run-id>`.
- Create `context/` and `implementation/`.
- Write `context/work-item.json` from the resolved work item.
- Write `context/implementation-input.json` from the resolved
  `FactoryImplementationInput`.
- Planned mode: write `context/plan-ref.json` containing only
  `approvedPlanPath`, absolute `planPath`, `approvedPlanCommit`, and optional
  tracker metadata from resolved metadata.
- Direct mode: write `context/source-material.json` containing only
  `sourceMaterial`.
- Do not write `events.jsonl`.
- Do not create an agent provider.
- Clean up orphaned run dirs on bootstrap failure unless `meta.json` already
  exists, matching the triage/planning pattern.
- Export `FACTORY_IMPLEMENTATION_STEP_OUTPUTS` if useful for workflow tests,
  but do not add lifecycle events in this issue.

Create `workflows/factory-implementation.workflow.ts`:

- Export `meta = { name: "factory-implementation" }`.
- Export `run(ctx)` that only supports dry-run for v1. If `ctx.dryRun` is not
  true, throw a clear error such as
  `Factory implementation station only supports --dry-run in v1`.
- Write `implementation/prompt.md` using the prompt renderer.
- Write `implementation/change-review-handoff.md` using the handoff renderer.
- Write `summary.md`.
- Write `meta.json`.
- Return `FactoryImplementationRunMeta`.

Summary requirements:

- Include run id, status, mode, work item id/title, implementer role, and
  artifact paths.
- Planned summary includes approved plan path and commit.
- Direct summary includes source title/url/tracker when present.
- State no provider, reviewer, lifecycle, Linear, GitHub, PR, branch, or
  worktree action was run.

**Verify**: `pnpm typecheck` -> exit 0.

### Step 4: Add CLI output helper and command wiring

Create `bin/factory-implementation-cli.ts`:

- Export `factoryImplementationCliOutput(meta)` similar to
  `factoryPlanningCliOutput` and `factoryTriageCliOutput`.
- Include at least: `runId`, `workflow`, `status`, `mode`, `workspace`,
  `runDir`, `workItem`, `implementerAgent`, and `artifacts`.

Update `bin/factory-commands.ts`:

- Import `resolveFactoryImplementationInput`.
- Import `createFactoryImplementationRunContext`.
- Import `run as runFactoryImplementation`.
- Import `factoryImplementationCliOutput`.
- Add option type:

```ts
type FactoryImplementationStationOptions = {
  workspace?: string;
  itemFile?: string;
  linearIssue?: string;
  runsDir?: string;
  dryRun: boolean;
};
```

- Register a nested command:

```text
harness factory implementation run
```

Make `run` the default subcommand for `implementation`, matching planning.

Command behavior order:

1. Validate `--dry-run` is present. Throw the v1 dry-run-only error before
   resolving role/config or Linear.
2. Call `validateFactoryWorkItemInput(options)` so one-source errors win before
   role/config resolution.
3. Resolve implementer role with
   `resolveFactoryRoleAgent({ workspace: options.workspace, station:
"implementation", role: "implementer" })`.
4. Resolve Linear settings only when `options.linearIssue` is present.
5. Resolve the work item through `resolveFactoryWorkItemInput`.
6. Resolve implementation input through `resolveFactoryImplementationInput`,
   passing `linearReadyStatus: linearSettings?.statuses.readyToImplement`.
7. Create the implementation run context with the resolved workspace, runs dir,
   work item, implementation input, implementer role, and `dryRun: true`.
8. Run the workflow.
9. Print `factoryImplementationCliOutput(meta)` as pretty JSON.
10. Set exit code 0 on success.

Do not add `--apply`, provider/model flags, lifecycle events, Linear apply
adapter calls, agent provider creation, or branch/worktree flags.

**Verify**: `node bin/harness.ts factory implementation run --help` -> exit 0;
help includes `--workspace`, `--item-file`, `--linear-issue`, `--runs-dir`, and
`--dry-run`.

### Step 5: Add implementation station tests

Create `test/factory-implementation-run-context.test.ts` with Vitest tests for
library/workflow behavior:

- Planned dry-run writes the exact artifact set:
  - `context/work-item.json`
  - `context/implementation-input.json`
  - `context/plan-ref.json`
  - no `context/source-material.json`
  - `implementation/prompt.md`
  - `implementation/change-review-handoff.md`
  - `summary.md`
  - `meta.json`
  - no `events.jsonl`
- Planned artifacts include relative `approvedPlanPath`, absolute `planPath`,
  and `approvedPlanCommit`; prompt says to follow the approved plan and says the
  commit is provenance/readiness only.
- Direct dry-run writes `context/source-material.json`, not `context/plan-ref.json`,
  and the prompt includes title/body/labels/url/tracker metadata.
- Handoff draft contains the seven required headings and expected placeholders.
- Meta includes `workflow: "factory-implementation"`, `status: "dry_run"`,
  `mode`, compact work item, implementer agent, relative artifact paths, summary
  path, and meta path.
- A non-dry-run context/workflow attempt throws the v1 dry-run-only error and
  does not imply provider invocation.

Create `test/factory-implementation-cli.test.ts` with focused CLI coverage:

- Item-file direct dry-run succeeds in a non-git workspace, writes artifacts,
  prints `workflow: "factory-implementation"`, `status: "dry_run"`,
  `mode: "direct"`, and leaves `.harness/factory` absent.
- Item-file planned dry-run succeeds when the plan file exists and metadata has
  `factoryStage: "plan-approved"`, `approvedPlanPath`, and
  `approvedPlanCommit`.
- Missing `--dry-run` fails with the v1 dry-run-only message before role/config
  resolution.
- Missing input source fails with existing
  `one of --item-file or --linear-issue is required`.
- Multiple input sources fail with existing
  `--item-file and --linear-issue are mutually exclusive`.
- Invalid implementation readiness fails closed through
  `resolveFactoryImplementationInput`.
- Configured implementer role appears in `meta.json` and CLI output.

Use small local test helpers in the new file rather than expanding
`test/cli.test.ts`.

**Verify**:

```bash
pnpm test -- test/factory-implementation-run-context.test.ts test/factory-implementation-cli.test.ts
```

Expected: exit 0.

### Step 6: Update docs and smoke coverage

Update `README.md`:

- Add the two command examples under "Run Factory Intake":

```bash
harness factory implementation run --workspace /path/to/repo --linear-issue TEAM-123 --dry-run
harness factory implementation run --workspace /path/to/repo --item-file .harness/inbox/factory/item.json --dry-run
```

- Add implementation role config to the sample:

```json
"implementation": {
  "roles": {
    "implementer": {
      "agent": "cursor",
      "model": "composer-2.5"
    }
  }
}
```

- State implementation is currently dry-run only and writes prompt/handoff
  artifacts without provider invocation.

Update `docs/contributing/factory.md`:

- Add implementation command examples near the existing station commands.
- In "Station Config", add the `factory.implementation.roles.implementer`
  example, including optional Codex policy fields in prose.
- Replace "There is no implementation station CLI yet" with present-tense dry-run
  behavior:
  - The implementation station first calls `resolveFactoryWorkItemInput`, then
    `resolveFactoryImplementationInput`.
  - Planned mode records plan ref/provenance and does not verify or checkout the
    commit in v1.
  - Direct mode records source material.
  - The station is dry-run only and writes `implementation/prompt.md` plus
    `implementation/change-review-handoff.md`.
- Document the artifact tree.
- Keep non-goals explicit: no provider invocation, no change-review loop, no PR,
  no Linear mutation, no lifecycle events, no branch/worktree orchestration.

Update `docs/contributing/script-command-surface.md`:

- Add `harness factory implementation run` to Source CLI.
- Add implementation dry-run to ignored-artifact factory command notes.
- State implementation dry-run writes local artifacts and does not invoke
  providers or mutate Linear/lifecycle state.

Update `scripts/smoke-dist.ts`:

- Add help checks for:
  - `harness factory implementation --help`
  - `harness factory implementation run --help`
- Assert implementation run help includes `--item-file`, `--linear-issue`,
  `--runs-dir`, and `--dry-run`.

**Verify**:

```bash
pnpm smoke:dist
```

Expected: exit 0.

### Step 7: Run final gates and inspect diff

Run:

```bash
pnpm typecheck
pnpm lint
pnpm test -- test/factory-implementation-input.test.ts test/factory-implementation-run-context.test.ts test/factory-implementation-cli.test.ts test/config.test.ts
pnpm check
git diff -- README.md docs/contributing/factory.md docs/contributing/script-command-surface.md bin/factory-commands.ts bin/factory-implementation-cli.ts lib/config.ts lib/schemas.ts lib/factory-implementation-run-context.ts lib/prompts/factory-implementation.ts lib/prompts/index.ts workflows/factory-implementation.workflow.ts scripts/smoke-dist.ts test/config.test.ts test/factory-implementation-run-context.test.ts test/factory-implementation-cli.test.ts
```

Expected:

- All commands exit 0.
- Diff only touches the in-scope files or a documented STOP-approved addition.
- No provider invocation code exists for implementation.
- No lifecycle append code exists for implementation.
- No `--apply` flag exists for implementation.

## Test plan

- Config:
  - `factory.implementation.roles.implementer` accepts Cursor role config.
  - Codex implementation role accepts provider-specific fields.
  - Codex-only fields are rejected for effective Cursor implementation roles.
  - Unknown factory stations/roles remain rejected.
- Run context/workflow:
  - Planned dry-run writes `plan-ref.json`, prompt, handoff, summary, meta, and
    no events.
  - Direct dry-run writes `source-material.json`, prompt, handoff, summary, meta,
    and no events.
  - Handoff headings and placeholders match the existing change-review handoff
    model.
  - Meta and CLI output include implementer role metadata.
- CLI:
  - `--item-file` direct dry-run succeeds.
  - `--item-file` planned dry-run succeeds with an existing approved plan file.
  - Missing dry-run fails before role/config resolution.
  - Missing/multiple input sources use existing validation errors.
  - Invalid readiness fails closed.
  - Help output exposes only the intended v1 flags.
- Docs/smoke:
  - README and contributor docs include command examples, role config, artifacts,
    and non-goals.
  - `pnpm smoke:dist` validates built CLI help.

## Done criteria

All must hold:

- [x] `harness factory implementation run --help` exists and exposes
      `--workspace`, `--item-file`, `--linear-issue`, `--runs-dir`, and
      `--dry-run`.
- [x] `harness factory implementation run` without `--dry-run` fails with a
      clear v1 dry-run-only error before role/config/Linear resolution.
- [x] `--item-file` and `--linear-issue` are mutually exclusive and exactly one
      is required.
- [x] The command calls `resolveFactoryWorkItemInput` and
      `resolveFactoryImplementationInput`.
- [x] Linear implementation input passes configured
      `factory.linear.statuses.readyToImplement` as `linearReadyStatus`.
- [x] Planned mode writes `context/plan-ref.json` with relative
      `approvedPlanPath`, absolute `planPath`, and `approvedPlanCommit`.
- [x] Direct mode writes `context/source-material.json` with title, body,
      labels, url when present, tracker metadata when present, and source
      material.
- [x] Both modes write `context/work-item.json`,
      `context/implementation-input.json`, `implementation/prompt.md`,
      `implementation/change-review-handoff.md`, `summary.md`, and `meta.json`.
- [x] Dry-run implementation writes no `events.jsonl` and appends no lifecycle
      events.
- [x] No implementation provider/agent is invoked.
- [x] No `--apply`, PR creation, Linear mutation, branch/worktree orchestration,
      Git checkout, Git object verification, or change-review loop is added.
- [x] `factory.implementation.roles.implementer` validates and resolves through
      the existing role config pattern.
- [x] `implementation/change-review-handoff.md` uses the exact seven required
      sections and placeholders for post-implementation fields.
- [x] README, factory docs, script-command-surface docs, and smoke-dist help
      coverage are updated.
- [x] `pnpm typecheck`, `pnpm lint`, focused tests, `pnpm smoke:dist`, and
      `pnpm check` exit 0.

## STOP conditions

Stop and report if:

- `lib/factory-implementation-input.ts` no longer matches the current-state
  behavior above, especially planned publication-signal precedence.
- Implementing the command requires changing provider SDKs or invoking Cursor,
  Codex, or another implementer.
- Implementing planned mode appears to require Git checkout, commit existence
  verification, worktree orchestration, or branch creation.
- Implementing direct mode requires changing triage route semantics.
- Linear support appears to require any mutation or `--apply` behavior.
- You need lifecycle events or durable implementation stage transitions to make
  the dry-run shell work.
- You need to touch files outside the in-scope list.
- A verification command fails twice after a reasonable fix attempt.
- Generated docs/tests imply `.harness/runs/*` artifacts should be committed.

## Maintenance notes

- Future live implementation can build on the run context and prompt artifacts,
  but should be planned separately after provider write policy is documented.
- When live invocation is added, revisit Codex sandbox defaults for the
  implementation role. Do not infer them from this dry-run shell.
- When lifecycle implementation stages are added, keep dry-run behavior free of
  durable events and add separate tests for non-dry-run transitions.
- Reviewers should scrutinize fail-closed readiness, exact artifact paths, role
  config validation, and absence of hidden mutations.
