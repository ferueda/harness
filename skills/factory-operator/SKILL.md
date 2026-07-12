---
name: factory-operator
description: Operate the current harness factory flow for one local work item through status, triage, planning, or implementation stations.
---

# Factory Operator

## Manually stepped triage

The new Factory action store requires `store-format.json` version 1. Harness
initializes an empty state directory. It rejects old, unmarked, or differently
versioned state with archive/reset instructions and never migrates or deletes
it.

`harness factory triage ...` blocks until its one `triageWorkItem` action ends.
Wait for process exit; do not poll or start a second action. The command
persists progress heartbeats in the action run (`--verbose` also emits them to
stderr), writes a terminal event/state, and prints durable evidence plus the
next reaction and exact command. Run that command manually. The invocation
never executes a second handler. If `next.kind` is `wait`, stop and follow its
reason.

Operate the current local harness factory one work item at a time.

## When To Use

Use this skill when the user wants to inspect factory inbox state, triage a
factory work item, fetch or create a Linear intake issue, run the planning
station for a `ready-to-plan` item, run implementation for a
`ready-to-implement` item, or understand factory artifacts and statuses.

## Waiting For Station Runs

Factory station commands (`harness factory triage|planning|implementation`)
stay synchronous. Prefer one Shell invocation with a long enough
`block_until_ms`, then wait for process exit. Do **not** poll with repeated
AwaitShell or status checks while the command is running.

After run context creation, those station commands emit exactly one always-on
stderr JSON progress line so operators can learn `runDir` before exit:

```json
{
  "harnessFactory": "run-started",
  "station": "triage",
  "runId": "...",
  "runDir": "...",
  "workspace": "..."
}
```

PR-1 live triage emits one action-aware progress record containing phase,
phase-run id, run directory, handler, and attempt. It is CLI progress only —
not a lifecycle event. Final stdout adds `outcome`, `phase`, `phaseRunId`, the
completed `action`, and `next`; dry-run omits the durable action.
Low-level `harness run factory-triage` / `harness run plan-review` escape
hatches do not emit this progress line.

Optional: background the command only when needed, parse that one progress
line, then wait once for completion. After exit, trust stdout JSON and read
`summary.md` / `meta.json` for narrative. Do not treat mid-run `runDir`
contents as terminal success.

## Durable Store

Factory lifecycle JSONL, rebuildable state, station evidence, and nested
factory plan-review evidence default to
`${XDG_DATA_HOME:-~/.local/share}/harness/store/projects/<repo-id>/`. The
workspace remains the sandbox for source, tests, `harness.json`, inbox, and
committed plans/code. Use the reported `runDir`, not an assumed workspace path.

Override the store with `--factory-store-root`, `--factory-store-project-id`,
`HARNESS_FACTORY_STORE_ROOT`, `HARNESS_FACTORY_STORE_PROJECT_ID`, or
`factory.store` in `harness.json`. After upgrade, an empty durable store is
expected until a station writes new events; legacy workspace `.harness/factory`
state is reported and ignored, never silently imported.

## Command Model

Station commands:

```bash
harness factory status --workspace /path/to/repo
harness factory linear list --status intake --workspace /path/to/repo
harness factory linear fetch TEAM-123 --workspace /path/to/repo
harness factory linear create --workspace /path/to/repo --title "Example" --body "Details"
harness factory triage --workspace /path/to/repo --item-file work-item.json
harness factory triage --workspace /path/to/repo --linear-issue TEAM-123
harness factory triage --workspace /path/to/repo --linear-issue TEAM-123 --apply
harness factory triage --workspace /path/to/repo --linear-issue TEAM-123 --rerun --apply
```

Low-level workflow escape hatches:

```bash
harness run factory-triage --item-file work-item.json
harness run plan-review --plan path/to/implementation-plan.md
```

Live is the default. Use `--dry-run` only to verify command wiring and artifact
layout — not for classification or planning. Dry-run skips the triager/planner
and writes placeholders; for `--linear-issue` it still does the live Linear
read needed to build the work item, without mutating Linear.

## Role Config

Factory station roles come from `harness.json`, under
`factory.<station>.roles.<role>`.

Minimal shape:

```json
{
  "factory": {
    "triage": {
      "roles": {
        "triager": { "agent": "cursor", "model": "grok-4.5" }
      }
    },
    "linear": {
      "teamKey": "ENG",
      "projectId": "00000000-0000-0000-0000-000000000000",
      "statuses": {
        "intake": "Backlog",
        "parked": "Parked",
        "needsInfo": "Needs Clarification",
        "needsPlan": "Needs Plan",
        "needsPlanReview": "Plan Needs Review",
        "readyToImplement": "Ready to Implement",
        "implementing": "Implementing",
        "implementationFailed": "Implementation Failed",
        "triaging": "Triaging",
        "planning": "Planning",
        "triageFailed": "Triage Failed",
        "planningFailed": "Planning Failed"
      }
    },
    "planning": {
      "maxReviewIterations": 3,
      "roles": {
        "planner": { "agent": "cursor", "model": "grok-4.5" },
        "reviewer": { "agent": "codex", "model": "gpt-5.6-sol" }
      }
    },
    "implementation": {
      "roles": {
        "implementer": { "agent": "cursor", "model": "grok-4.5" }
      }
    }
  }
}
```

Optional terminal keys (`done`, `canceled`, `duplicate`) may be added under
`factory.linear.statuses` when operator list/move tools need those board
states; stations do not require them.

`needsPlanReview`, `implementing`, and `implementationFailed` are a required
upgrade migration for the whole `factory.linear` config, including read-only
and no-apply use. Add the corresponding Linear team statuses and config
mappings together.

- `station`: lifecycle step such as `triage`, `planning`, or `implementation`.
- `role`: job inside a station such as `triager`, `planner`, `reviewer`, or
  `implementer`.
- `agent`: backend identity such as `cursor` or `codex`.

## Linear List, Fetch, And Create

Use Linear list for read-only backlog discovery by configured status key:

```bash
LINEAR_API_KEY=... harness factory linear list --status intake --workspace /path/to/repo
LINEAR_API_KEY=... harness factory linear list --status done --workspace /path/to/repo
```

List validates configured Linear statuses and project scope, then prints
lightweight issue summaries. It does not fetch descriptions, labels, comments,
or mutate Linear. Terminal keys such as `done` work only when mapped in
`factory.linear.statuses`.

Use Linear fetch to convert one issue into `FactoryWorkItem` JSON:

```bash
LINEAR_API_KEY=... harness factory linear fetch ENG-123 --workspace /path/to/repo
```

This command is read-only. It validates the configured Linear team statuses,
verifies the configured Linear project when `factory.linear.projectId` is set,
then prints a work item with issue description, labels, recent comments, and
tracker metadata. Fetch merges durable lifecycle state in inspect-only mode;
it does not wait on a lock or rebuild state, and reports stale-state warnings.
`teamKey` owns issue identifiers and
statuses; `projectId` scopes the target repo. Redirect the output to an item
file before planning, or pass the issue directly to triage with
`--linear-issue`.

Use Linear create only for Harness backlog intake when the target repo's
`factory.linear` config should own team, project, and intake status:

```bash
LINEAR_API_KEY=... harness factory linear create --workspace /path/to/repo --title "Example" --body "Details"
```

Create is not a station. It requires `factory.linear.projectId`, a non-empty
title, and a non-empty body from exactly one of `--body`, `--body-file`, or
stdin. It prints compact JSON and does not write lifecycle or run artifacts.
Prefer Linear UI or chief tooling for rich editing outside this constrained
intake path.

## Triage

Run:

```bash
harness factory triage --workspace /path/to/repo --item-file work-item.json
harness factory triage --workspace /path/to/repo --linear-issue TEAM-123
harness factory triage --workspace /path/to/repo --linear-issue TEAM-123 --apply
```

`--linear-issue` uses Linear as the input source by default. It requires
`LINEAR_API_KEY` and `factory.linear` config. Every `--linear-issue` triage run
performs a live Linear read before writing local factory artifacts. If
`factory.linear.projectId` is set, the issue must belong to that project before
triage or apply can continue.

Live triage invokes the triager and writes a real route. Add `--apply` to move
allowed entry statuses to `Triaging`, then to the terminal triage status, and
write one marker comment. `--apply` cannot be combined with `--dry-run` or
`--item-file`. Comment dedupe checks the most recent Linear comments fetched
by the adapter (currently 20); older markers can be reposted on retry.

Durable lifecycle event history is canonical. A prior
`triage.work_item.completed` blocks normal live triage before run creation,
lifecycle writes,
provider calls, or Linear mutation. Use `--rerun` only for intentional
re-triage. Normal apply accepts Backlog, Needs Clarification, or Triage Failed;
`--rerun --apply` accepts any present status after the same issue and configured
team/project scope checks. A new completion clears prior approved-plan path,
PR URL, and commit metadata. A first dry-run writes no completion and its next
live command needs no override; an overridden dry-run over completed history
still requires `--rerun` for the later live command.

If an apply run leaves Linear in `Triaging`, inspect `summary.md` and
`meta.json`, then manually move the issue to `Triage Failed`, `Backlog`, or
another intentional status before rerunning.

Routes:

- `ready-to-implement`
- `ready-to-plan`
- `needs-info`
- `wait-to-implement`

Read the run `summary.md`, `factory-triage.json`, and `factory-route.md` before
deciding the next station.

Live triage appends `work_item.imported`, `triage.requested`, and one terminal
action event in the durable factory store. Dry-run does not mutate lifecycle
state. The strict state projection and pure next-reaction function own machine
progress; Linear status/comments remain human board projections.

## Unshipped phases

Planning and implementation commands are intentionally unavailable in PR 1. Wait for their dedicated action-coordinator PRs; do not invoke legacy station flows or infer progress from tracker state.

## Artifacts

Factory run root:

```text
${XDG_DATA_HOME:-~/.local/share}/harness/store/projects/<repo-id>/runs/factory/<run-id>/
```

Read `summary.md` and `meta.json` first. Planning snapshots live under
`iterations/<n>/`, nested plan-review artifacts live under durable
`runs/reviews/`, and approved plans live under `dev/plans/`. Lifecycle truth
lives under durable `factory/events/*.jsonl`; `factory/state/*.json` is a
rebuildable cache. Tracker-backed approved plans should be published through a
plan PR before the tracker moves to `Ready to Implement`. During manual
publication, `factoryStage: "plan-pr-open"` can exist before
`approvedPlanPrUrl`; record the URL when the plan PR exists. Use
`harness factory planning publish` to record the plan PR URL, then
`harness factory planning mark-plan-merged` to record the merge commit. These
commands update local run metadata and lifecycle state, and print suggested
Linear comments by default; they do not mutate Linear or GitHub unless
`--linear-issue ... --apply` is present. `publish --apply` moves Linear to
`Plan Needs Review` and posts a plan-PR marker comment.
`mark-plan-merged --apply` moves Linear to `Ready to Implement` and posts an
approved-plan marker comment. Neither command opens PRs or inspects GitHub
merge state. Durable store contents are user data; do not commit workspace
`.harness/runs/*` or legacy `.harness/factory/*`.

### Linear PR linking

Linear links GitHub PRs to issues via branch name, PR title, or magic-word +
issue id ([Linear GitHub docs](https://linear.app/docs/github)). Operators own
linking at PR creation time; harness stations do not mutate GitHub.

Put the issue id in **both** branch and title:

- Plan PR: branch `plan/<ISSUE>-<short-slug>`; title includes `<ISSUE>`; prefer
  **no** closing magic words (`Fixes`, `Closes`, …).
- Implementation PR: branch `feat/<ISSUE>-...` or `fix/<ISSUE>-...`; title
  includes `<ISSUE>`; use closing words only when merge should complete the
  issue.

```bash
git checkout -b plan/TEAM-123-short-slug
git push -u origin plan/TEAM-123-short-slug
gh pr create --title "plan: TEAM-123 short description" --body "..."
```

Repair an unlinked open PR with `gh pr edit <number> --title "..."` (or a
branch rename). Prerequisite: Linear↔GitHub integration enabled for the repo.
See [docs/contributing/factory.md](../../docs/contributing/factory.md) (Linear
PR linking).

## Stop Conditions

Stop before proceeding if the task requires:

- running or restoring `harness factory dispatch`
- batch-moving every inbox item
- mutating GitHub, Jira, or Inngest
- mutating Linear outside documented `harness factory linear create` or explicit
  `harness factory triage --linear-issue ... --apply`,
  `harness factory planning run --linear-issue ... --apply`, or explicit
  planning publication commands with `--linear-issue ... --apply`
- committing `.harness/runs/*`
- overwriting an existing final plan
- letting planner agents write directly to tracked source files
