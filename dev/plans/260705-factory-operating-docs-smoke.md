# Plan 260705-factory-operating-docs-smoke: Document factory operation and smoke paths

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the next
> step. If anything in the "STOP conditions" section occurs, stop and report.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**:
  - `dev/plans/260705-factory-station-api-role-config.md`
  - `dev/plans/260705-agent-session-continuation.md`
  - `dev/plans/260705-factory-planning-station.md`
- **Category**: docs
- **Execution gate**: do not implement until all dependency plans are merged.

## Why this matters

After the factory station API and planning station land, users need one coherent
operating guide instead of scattered command examples from older slices. The
docs and packaged skill should explain the current explicit single-item flow,
the role config model, and what GitHub/Inngest will replace later. Smoke checks
should also protect the shipped command surface.

## Current state

Relevant files:

- `README.md` currently documents low-level `harness run factory-triage`,
  `harness factory status`, and stale batch `harness factory dispatch`
  examples. It does not yet document `harness factory triage`,
  `harness factory planning`, or role config.
- `docs/contributing/architecture.md` maps command ownership and artifact
  layout.
- `docs/contributing/script-command-surface.md` classifies command side effects.
- `docs/contributing/setup-manifest.md` documents `.harness` files.
- `docs/contributing/index.md` links contributor docs.
- `docs/project-intent.md` defines repo purpose.
- `scripts/smoke-dist.ts` checks the distributed CLI help surface.
- `test/docs-contracts.test.ts` and `test/skills.test.ts` protect docs/skill
  invariants.
- `skills/` contains packaged skills; each skill needs a `SKILL.md`.
- `dev/todo/260704-factory-planner-station.md` and
  `dev/todo/260704-factory-github-inngest-architecture.md` hold the design
  context this plan should preserve in public docs.

Known stale surfaces to reconcile after dependencies land:

- `README.md` factory dispatch section.
- `docs/contributing/architecture.md` dispatch command list and dispatch
  behavior.
- `docs/contributing/script-command-surface.md` dispatch side-effect rows.
- `docs/contributing/setup-manifest.md` inbox `processed/` / `failed/`
  dispatch rows.
- `scripts/smoke-dist.ts` dispatch help check.

Expected current command model after dependency plans:

```bash
harness run factory-triage --item-file work-item.json
harness run plan-review --plan dev/plans/example.md

harness factory status
harness factory triage --item-file work-item.json
harness factory planning --item-file work-item.json
```

Factory commands are station operators. `harness run ...` commands are low-level
workflow primitives.

## Commands you will need

| Purpose      | Command                                                                         | Expected on success |
| ------------ | ------------------------------------------------------------------------------- | ------------------- |
| Install      | `pnpm install`                                                                  | exit 0              |
| Typecheck    | `pnpm typecheck`                                                                | exit 0, no errors   |
| Lint         | `pnpm lint`                                                                     | exit 0              |
| Format check | `pnpm format:check`                                                             | exit 0              |
| Build        | `pnpm build`                                                                    | exit 0              |
| Docs tests   | `pnpm test -- test/docs-contracts.test.ts test/skills.test.ts test/cli.test.ts` | all pass            |
| Smoke        | `pnpm smoke:dist`                                                               | exit 0              |
| Full check   | `pnpm check`                                                                    | exit 0              |

## Suggested executor toolkit

| Skill                  | Use for                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| `node`                 | Smoke script updates and CLI help checks.                                                           |
| `vitest`               | Docs/skills/CLI contract tests.                                                                     |
| `writing-great-skills` | If available in the executor environment, use it when writing the packaged factory operating skill. |

## Scope

**In scope**:

- `README.md`
- `docs/contributing/architecture.md`
- `docs/contributing/script-command-surface.md`
- `docs/contributing/setup-manifest.md`
- `docs/contributing/index.md` if a new guide is added
- `docs/contributing/factory.md` (create if the factory section becomes too big
  for existing docs)
- `skills/factory-operator/SKILL.md` (create)
- `skills/factory-operator/agents/openai.yaml` only if matching local skill
  patterns require it
- `scripts/smoke-dist.ts`
- `test/docs-contracts.test.ts`
- `test/skills.test.ts`
- `test/cli.test.ts` only for docs/smoke-aligned help assertions
- `dev/todo/README.md` only to keep todo index links accurate

**Out of scope**:

- Runtime behavior changes to factory triage or planning.
- New provider/session behavior.
- GitHub, Linear, Jira, Inngest code.
- New tracker adapters.
- New implementation/review/PR stations.
- Reintroducing `harness factory dispatch`.

## Steps

### Step 1: Verify dependency command surface

Do not start this plan until all three dependency plans have merged. Re-run the
checks below against merged code before editing docs.

Preflight checklist:

- `dev/plans/260705-factory-station-api-role-config.md` has merged:
  - `bin/factory-commands.ts` registers `harness factory triage`;
  - `harness factory dispatch` is gone;
  - `lib/config.ts` exposes factory role/settings resolution.
- `dev/plans/260705-agent-session-continuation.md` has merged:
  - `lib/agents.ts` exposes `AgentSessionRef`;
  - provider tests no longer reference `sessionId`.
- `dev/plans/260705-factory-planning-station.md` has merged:
  - `bin/factory-commands.ts` registers `harness factory planning`;
  - `workflows/factory-planning.workflow.ts` exists;
  - `schemas/factory-planning-output.schema.json` exists.

Run:

```bash
node bin/harness.ts factory --help
node bin/harness.ts factory triage --help
node bin/harness.ts factory planning --help
node bin/harness.ts run factory-triage --help
node bin/harness.ts run plan-review --help
```

Expected:

- `factory --help` lists `status`, `triage`, and `planning`;
- `factory triage --help` has `--item-file`;
- `factory planning --help` has `--item-file`, `--output-plan`, and
  `--max-review-iterations`;
- no `factory dispatch` command exists;
- low-level `harness run` commands still exist.

**STOP if** any dependency command is missing or named differently. Update this
plan only if a prior merged plan intentionally changed the names.

### Step 1.5: Reconcile dependency doc changes

Before editing docs, inspect post-merge state from the dependency plans:

```bash
git diff -- README.md docs/contributing/architecture.md docs/contributing/script-command-surface.md docs/contributing/setup-manifest.md scripts/smoke-dist.ts
node bin/harness.ts factory --help
node bin/harness.ts factory triage --help
node bin/harness.ts factory planning --help
```

Treat this plan as the authoritative final pass. Preserve correct dependency
doc updates, but re-derive final wording from the merged CLI help and artifact
behavior. Do not duplicate factory sections across README and contributor docs.

Expected dependency-plan doc deltas:

- station API plan should already have removed current `dispatch` command docs;
- station API plan should already have documented `harness factory triage`;
- station API plan should already have updated basic smoke help checks.

This plan owns the remaining final pass:

- add `harness factory planning` docs;
- add role-config examples where useful;
- add/extend `docs/contributing/factory.md` if README would get too long;
- add `skills/factory-operator`;
- add plan-review smoke/help coverage;
- add negative dispatch smoke assertion;
- add future GitHub/Inngest boundaries as planned work only.

### Step 2: Update README factory section

Edit `README.md`.

Before editing, read `docs/project-intent.md`. Keep these invariants:

- README is a concise entrypoint; `test/docs-contracts.test.ts` enforces
  `README.md` at 250 lines or fewer.
- Use generic target-repo examples such as `/path/to/repo`.
- Present shipped behavior in present tense.
- Label GitHub/Inngest content as future planned integration.

If the factory section would push README over 250 lines, move detail to
`docs/contributing/factory.md` and link it from README and
`docs/contributing/index.md`.

Run before editing:

```bash
wc -l README.md
```

If README is already above ~230 lines after dependencies merge, default to a
short README pointer plus `docs/contributing/factory.md` for detail.

Document:

- `harness run factory-triage` for one low-level triage workflow run;
- `harness factory triage` for station-level one-item operation;
- `harness factory planning` for one ready-to-plan work item;
- `harness factory status` for local inbox visibility only;
- role config example:

```json
{
  "factory": {
    "triage": {
      "roles": {
        "triager": { "agent": "cursor", "model": "claude-opus-4-8" }
      }
    },
    "planning": {
      "maxReviewIterations": 3,
      "roles": {
        "planner": { "agent": "cursor", "model": "claude-opus-4-8" },
        "reviewer": { "agent": "codex", "model": "gpt-5.5" }
      }
    }
  }
}
```

Keep README concise. Link deeper details to contributor docs.

**Verify**: `pnpm test -- test/docs-contracts.test.ts` -> all pass or expected
failures identified for Step 4.

### Step 3: Update contributor docs

Update:

- `docs/contributing/architecture.md`
- `docs/contributing/script-command-surface.md`
- `docs/contributing/setup-manifest.md`

If the factory content becomes too long, create
`docs/contributing/factory.md` and link it from `docs/contributing/index.md`.

Required content:

- distinction between `harness run` and `harness factory`;
- station command list;
- role config vocabulary: station, role, agent;
- artifact locations:
  - triage and planning station run artifacts under
    `.harness/runs/factory/<run-id>/`;
  - planning station drafts under
    `.harness/runs/factory/<run-id>/iterations/<n>/plan.md`;
  - planning review references under
    `.harness/runs/factory/<run-id>/iterations/<n>/plan-review-ref.json`;
  - plan-review artifacts under `.harness/runs/reviews/<run-id>/`;
  - final approved plans under `dev/plans/`;
- current single-item operation; no batch dispatch;
- future GitHub/Inngest boundary:
  - GitHub replaces local visible tracker state;
  - Inngest replaces manual event triggering/orchestration;
  - harness station logic stays in this repo;
  - durable artifacts stay in repo/artifact storage, not full issue comments.

Avoid presenting future GitHub/Inngest behavior as shipped.

For `docs/contributing/architecture.md`, add or update a factory-planning
artifact subsection:

- public CLI list uses `harness factory status`, `harness factory triage`,
  `harness factory planning`, `harness run factory-triage`, and
  `harness run plan-review`;
- planning runs write `iterations/<n>/planner.*`, `plan.md`,
  `plan-review-ref.json`, and `review-findings.json`;
- planning statuses include `plan-approved`, `plan-needs-human`,
  `plan-review-unresolved`, and `planning-failed`.

For `docs/contributing/script-command-surface.md`, edit the command tables
explicitly:

- remove `harness factory dispatch` ownership and side-effect rows;
- add `harness factory triage` and `harness factory planning` to the CLI
  ownership row;
- classify triage/planning as factory artifact-writing commands;
- remove `harness factory dispatch --dry-run` from checking-with-artifacts;
- keep `harness factory status` read-only.

For `docs/contributing/setup-manifest.md`, update inbox semantics explicitly:

- `harness factory status` remains read-only over
  `.harness/inbox/factory/*.json`.
- pending files are the active local queue/state surface.
- `harness factory triage --item-file` and `harness factory planning
--item-file` do not move inbox files.
- `processed/` and `failed/` are legacy paths from the removed batch dispatch
  command. They may still appear in status output if present from previous
  local dispatch runs, but current triage/planning stations do not mutate them.
- Factory run artifacts are created by `harness factory triage`,
  `harness factory planning`, and low-level `harness run` commands.

**Verify**: `pnpm test -- test/docs-contracts.test.ts` -> all pass.

### Step 4: Add packaged factory operator skill

Create `skills/factory-operator/SKILL.md`.

Skill purpose:

- operate the current harness factory flow for one work item at a time;
- choose between triage and planning station commands;
- understand artifacts and exit statuses;
- avoid adding tracker/orchestrator behavior manually.

Required skill sections:

- When to use.
- Current command model:

```bash
harness factory triage --item-file work-item.json
harness factory planning --item-file work-item.json
harness factory status
```

- Low-level escape hatches:

```bash
harness run factory-triage --item-file work-item.json
harness run plan-review --plan dev/plans/example.md
```

- Role config example.
- Artifact locations.
  - triage/planning run root:
    `.harness/runs/factory/<run-id>/`;
  - planning iterations:
    `.harness/runs/factory/<run-id>/iterations/<n>/`;
  - review run references:
    `iterations/<n>/plan-review-ref.json`;
  - plan-review run root:
    `.harness/runs/reviews/<run-id>/`;
  - approved plan:
    `dev/plans/YYMMDD-short-slug.md`.
- STOP conditions:
  - do not run batch dispatch;
  - do not mutate GitHub/Linear/Inngest;
  - do not commit `.harness/runs/*`;
  - do not overwrite existing final plans.

Add `skills/factory-operator/agents/openai.yaml` if other workflow/operator
skills in `skills/` include it. Mirror their frontmatter/interface shape rather
than inventing a new one.

No `test/skills.test.ts` change is expected unless you intentionally add a new
packaged-skill invariant. Do not add speculative skill tests just because the
skill exists.

**Verify**: `pnpm test -- test/skills.test.ts` -> all pass.

### Step 5: Update smoke and CLI contract tests

Edit `scripts/smoke-dist.ts`.

Smoke should check:

- `harness run factory-triage --help`;
- `harness run plan-review --help`;
- `harness factory status --help`;
- `harness factory triage --help`;
- `harness factory planning --help`;
- no `harness factory dispatch --help` success path.

For removed `dispatch`, do not use the existing success-only `runHarness(...)`
helper. Use `spawnSync` or an equivalent non-throwing helper, call:

```bash
harness factory dispatch --help
```

Assert non-zero exit or unknown-command stderr/stdout.

Update `test/cli.test.ts` only if help assertions still mention dispatch or
miss planning.

**Verify**:

```bash
pnpm build
pnpm smoke:dist
pnpm test -- test/cli.test.ts
```

Expected: all pass.

### Step 6: Clean stale current-command references

Search current docs/skills/scripts/tests:

```bash
rg -n "harness factory dispatch|factory dispatch" README.md docs skills scripts test
```

Expected:

- no matches presenting `dispatch` as a current command;
- historical mentions are acceptable only in `dev/todo/` or old plan files, not
  current operating docs/skills/tests.

Search for role vocabulary drift:

```bash
rg -n "provider|agentProvider|reviewAgent|reviewModel" README.md docs skills
```

Expected:

- no public factory config examples use `provider`, `agentProvider`,
  `reviewAgent`, or `reviewModel`;
- non-factory internal architecture references may remain if accurate.

Search for station naming drift:

```bash
rg -n "harness factory plan(\\s|$)|factory plan --item-file" README.md docs skills scripts test
```

Expected: no matches. Use `harness factory planning`, not `harness factory
plan`, when copying context from `dev/todo`.

**Verify**: searches meet expected results.

### Step 7: Final verification

Run:

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
pnpm test -- test/docs-contracts.test.ts test/skills.test.ts test/cli.test.ts
pnpm smoke:dist
pnpm test
pnpm check
```

Expected:

- all commands exit 0;
- only docs, skill files, smoke script, and relevant tests changed;
- no generated `.harness/` artifacts are staged.

## Test plan

- `test/docs-contracts.test.ts`: docs index/current command contracts.
- `test/skills.test.ts`: packaged skill discovery/frontmatter.
- `test/cli.test.ts`: command help assumptions used by docs.
- `scripts/smoke-dist.ts`: installed/dist CLI command help surface.

## Done criteria

- [ ] README explains current factory triage and planning station usage.
- [ ] Contributor docs explain `harness run` vs `harness factory`.
- [ ] Current docs do not present `harness factory dispatch` as a valid command.
- [ ] Public factory config examples use `factory.<station>.roles.<role>.agent`.
- [ ] Packaged `factory-operator` skill exists and documents the one-item flow.
- [ ] Smoke checks include `factory triage` and `factory planning`.
- [ ] Future GitHub/Inngest architecture is described as future integration, not
      shipped runtime.
- [ ] `pnpm check` exits 0.

## STOP conditions

Stop and report if:

- Dependency plans have not landed or command names differ from this plan.
- You need runtime code changes beyond smoke/help/doc contract alignment.
- You need to add GitHub, Linear, Jira, Inngest, or tracker adapters.
- You need to reintroduce batch dispatch.
- A verification command fails twice after a focused fix attempt.

## Maintenance notes

This plan should run last in the four-plan sequence. If earlier implementation
changes the exact artifact layout or command output, update docs to match the
code rather than preserving this plan's examples verbatim.
