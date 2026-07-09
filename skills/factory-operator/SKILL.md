---
name: factory-operator
description: Operate the current harness factory flow for one local work item through status, triage, planning, or implementation stations.
---

# Factory Operator

Operate the current local harness factory one work item at a time.

## When To Use

Use this skill when the user wants to inspect factory inbox state, triage a
factory work item, fetch or create a Linear intake issue, run the planning
station for a `ready-to-plan` item, run implementation dry-run or live mode for
a `ready-to-implement` item, or understand factory artifacts and statuses.

## Waiting For Station Runs

Factory station commands (`harness factory triage|planning|implementation`)
stay synchronous. Prefer one Shell invocation with a long enough
`block_until_ms`, then wait for process exit. Do **not** poll with repeated
AwaitShell or status checks while the command is running.

After run context creation, those station commands emit exactly one always-on
stderr JSON progress line so operators can learn `runDir` before exit:

```json
{"harnessFactory":"run-started","station":"triage","runId":"...","runDir":"...","workspace":"..."}
```

`station` is `triage`, `planning`, or `implementation`. This line is CLI
progress only — not a `WorkflowEvent`, not written to `events.jsonl`, and not
lifecycle/Linear source of truth. Final stdout JSON contracts stay unchanged.
Low-level `harness run factory-triage` / `harness run plan-review` escape
hatches do not emit this progress line.

Optional: background the command only when needed, parse that one progress
line, then wait once for completion. After exit, trust stdout JSON and read
`summary.md` / `meta.json` for narrative. Do not treat mid-run `runDir`
contents as terminal success.

## Command Model

Station commands:

```bash
harness factory status --workspace /path/to/repo
harness factory linear list --status intake --workspace /path/to/repo
harness factory linear fetch TEAM-123 --workspace /path/to/repo
harness factory linear create --workspace /path/to/repo --title "Example" --body "Details"
harness factory triage --workspace /path/to/repo --item-file work-item.json
harness factory triage --workspace /path/to/repo --linear-issue TEAM-123 --dry-run
harness factory triage --workspace /path/to/repo --linear-issue TEAM-123 --apply
harness factory planning run --workspace /path/to/repo --item-file work-item.json
harness factory planning run --workspace /path/to/repo --linear-issue TEAM-123 --dry-run
harness factory planning run --workspace /path/to/repo --linear-issue TEAM-123 --apply
harness factory planning publish --run-dir .harness/runs/factory/<run-id> --pr-url https://github.com/owner/repo/pull/123
harness factory planning mark-plan-merged --run-dir .harness/runs/factory/<run-id> --commit abc1234
harness factory planning publish --run-dir .harness/runs/factory/<run-id> --pr-url https://github.com/owner/repo/pull/123 --linear-issue TEAM-123 --apply
harness factory planning mark-plan-merged --run-dir .harness/runs/factory/<run-id> --commit abc1234 --linear-issue TEAM-123 --apply
harness factory implementation run --workspace /path/to/repo --item-file work-item.json --dry-run
harness factory implementation run --workspace /path/to/repo --linear-issue TEAM-123
```

Low-level workflow escape hatches:

```bash
harness run factory-triage --item-file work-item.json
harness run plan-review --plan path/to/implementation-plan.md
```

Use `--dry-run` only to verify command wiring and artifact layout without
provider or reviewer calls. Factory dry-run skips the triager/planner and
writes placeholder artifacts — it is not a real classification or plan.
For `--linear-issue`, dry-run still performs the live Linear read needed to
build the work item; it does not mutate Linear. When the chief wants a real
route or authorizes `--apply`, run live triage/planning (with `--apply` when
authorized) instead of dry-run first.

## Role Config

Factory station roles come from `harness.json`, under
`factory.<station>.roles.<role>`.

Minimal shape:

```json
{
  "factory": {
    "triage": {
      "roles": {
        "triager": { "agent": "cursor", "model": "composer-2.5" }
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
        "triaging": "Triaging",
        "planning": "Planning",
        "triageFailed": "Triage Failed",
        "planningFailed": "Planning Failed"
      }
    },
    "planning": {
      "maxReviewIterations": 3,
      "roles": {
        "planner": { "agent": "cursor", "model": "composer-2.5" },
        "reviewer": { "agent": "codex", "model": "gpt-5.5" }
      }
    },
    "implementation": {
      "roles": {
        "implementer": { "agent": "cursor", "model": "composer-2.5" }
      }
    }
  }
}
```

Optional terminal keys (`done`, `canceled`, `duplicate`) may be added under
`factory.linear.statuses` when operator list/move tools need those board
states; stations do not require them.

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
tracker metadata. If lifecycle state exists under `.harness/factory`, fetch
merges it into the printed work item. `teamKey` owns issue identifiers and
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
harness factory triage --workspace /path/to/repo --linear-issue TEAM-123 --dry-run
```

`--linear-issue` uses Linear as the input source by default. It requires
`LINEAR_API_KEY` and `factory.linear` config. Every `--linear-issue` triage run
performs a live Linear read before writing local factory artifacts, including
dry-runs. If `factory.linear.projectId` is set, the issue must belong to that
project before triage or apply can continue.

Live triage (no `--dry-run`) invokes the triager and writes a real route.
Add `--apply` to move allowed entry statuses to `Triaging`, then to the
terminal triage status, and write one marker comment. When the chief
authorizes apply, run `--apply` directly — do not burn a dry-run first for
classification. `--apply` cannot be combined with `--dry-run` or
`--item-file`. Comment dedupe checks the most recent Linear comments fetched
by the adapter (currently 20); older markers can be reposted on retry.

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

Live triage appends lifecycle events under `.harness/factory`. Dry-run does not.
The lifecycle read model owns machine fields such as `factoryStage`,
`factoryRoute`, `factoryNextAction`, and `factoryRunId`; Linear status/comments
are human board projections.

## Planning

Run planning only for allowed planning entry stages: `ready-to-plan`,
`plan-needs-human`, `plan-review-unresolved`, or `planning-failed`.

```bash
harness factory planning run --workspace /path/to/repo --item-file work-item.json
harness factory planning run --workspace /path/to/repo --linear-issue TEAM-123 --dry-run
harness factory planning run --workspace /path/to/repo --linear-issue TEAM-123 --apply
```

`--linear-issue` planning requires `LINEAR_API_KEY` and `factory.linear` config.
Every Linear-backed planning run performs a live Linear read before writing
local factory artifacts, including dry-runs. If `factory.linear.projectId` is
set, the issue must belong to that project. It accepts `Needs Plan`,
`Planning Failed`, `Plan Needs Review`, plus planning-attention
`Needs Clarification` identified from the latest factory planning marker; other
Linear statuses are rejected before creating a run directory.

Live planning (no `--dry-run`) runs the planner/reviewer loop. Add `--apply` to
move the issue to `Planning` before planner work, then post one marker comment
after the station finishes. When the chief authorizes apply, run `--apply`
directly rather than a wiring-only dry-run first. Approved plans stay in
`Planning`; human questions move to `Needs Clarification`; unresolved reviews
move to `Plan Needs Review`; station/runtime failures move to `Planning Failed`.
Planning apply never moves the issue to `Ready to Implement`.

The planner writes `.harness/runs/factory/<run-id>/planning/draft.md`. Harness
snapshots the draft, runs `plan-review`, and reinvokes the same planner session
for review findings until the station reaches a terminal status.

Terminal statuses:

- `plan-approved`
- `plan-needs-human`
- `plan-review-unresolved`
- `planning-failed`

Live planning appends lifecycle events under `.harness/factory`. Future station
decisions should use the lifecycle read model when present instead of parsing
recent Linear marker comments.

## Implementation

Run implementation only for work items already ready to implement:

```bash
harness factory implementation run --workspace /path/to/repo --item-file work-item.json --dry-run
harness factory implementation run --workspace /path/to/repo --linear-issue TEAM-123
```

Dry-run prepares prompt and handoff artifacts without invoking a provider or
writing lifecycle state. Live mode resolves direct or planned implementation
input, validates readiness, resolves `factory.implementation.roles.implementer`,
invokes one implementer, writes candidate change artifacts, creates
`refs/harness/factory/<run-id>/implementation`, and appends lifecycle events.
It does not run change-review, mutate Linear, create human branches/worktrees,
or open PRs. After `implementation-complete`, run
`harness run change-review --base <reviewBase> --head <reviewHead>` separately.

Planned mode requires `factoryStage: "plan-approved"`, `approvedPlanPath`, and
`approvedPlanCommit`; the approved plan file must exist in the workspace. Direct
mode requires `factoryStage: "ready-to-implement"`,
`factoryRoute: "ready-to-implement"`, and
`factoryNextAction: "implement-directly"`. For Linear-backed input, Linear
`Ready to Implement` is a projection consistency guard; lifecycle metadata is
the source of truth.

Live implementation artifacts:

```text
.harness/runs/factory/<run-id>/
  context/
    work-item.json
    implementation-input.json
    plan-ref.json              # planned only
    source-material.json       # direct only
  implementation/
    prompt.md
    implementer.raw.json
    implementer.stream.jsonl   # when provider streams
    workspace-status.json
    diff.patch
    change-review-handoff.md
  events.jsonl
  summary.md
  meta.json
```

## Artifacts

Factory run root:

```text
.harness/runs/factory/<run-id>/
```

Read `summary.md` and `meta.json` first. Planning snapshots live under
`iterations/<n>/`, plan-review artifacts live under `.harness/runs/reviews/`,
and approved plans live under `dev/plans/`. Lifecycle truth lives under
`.harness/factory/events/*.jsonl`; `.harness/factory/state/*.json` is a
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
merge state. Do not commit `.harness/runs/*` or `.harness/factory/*`.

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
