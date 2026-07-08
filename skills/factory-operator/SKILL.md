---
name: factory-operator
description: Operate the current harness factory flow for one local work item through status, triage, or planning stations.
---

# Factory Operator

Operate the current local harness factory one work item at a time.

## When To Use

Use this skill when the user wants to inspect factory inbox state, triage a
factory work item, fetch a Linear issue as a factory work item, run the
planning station for a `ready-to-plan` item, or understand factory artifacts
and statuses.

## Command Model

Station commands:

```bash
harness factory status --workspace /path/to/repo
harness factory linear list --status intake --workspace /path/to/repo
harness factory linear fetch TEAM-123 --workspace /path/to/repo
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
```

Low-level workflow escape hatches:

```bash
harness run factory-triage --item-file work-item.json
harness run plan-review --plan path/to/implementation-plan.md
```

Use `--dry-run` to verify command wiring and artifact layout without provider
or reviewer calls. For `--linear-issue`, dry-run still performs the live Linear
read needed to build the work item; it does not mutate Linear.

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
    }
  }
}
```

- `station`: lifecycle step such as `triage` or `planning`.
- `role`: job inside a station such as `triager`, `planner`, or `reviewer`.
- `agent`: backend identity such as `cursor` or `codex`.

## Linear List And Fetch

Use Linear list for read-only backlog discovery by configured status key:

```bash
LINEAR_API_KEY=... harness factory linear list --status intake --workspace /path/to/repo
```

List validates configured Linear statuses and project scope, then prints
lightweight issue summaries. It does not fetch descriptions, labels, comments,
or mutate Linear.

Use Linear fetch to convert one issue into `FactoryWorkItem` JSON:

```bash
LINEAR_API_KEY=... harness factory linear fetch ENG-123 --workspace /path/to/repo
```

This command is read-only. It validates the configured Linear team statuses,
verifies the configured Linear project when `factory.linear.projectId` is set,
then prints a work item with issue description, labels, recent comments, and
tracker metadata. `teamKey` owns issue identifiers and statuses; `projectId`
scopes the target repo. Redirect the output to an item file before planning, or
pass the issue directly to triage with `--linear-issue`.

## Triage

Run:

```bash
harness factory triage --workspace /path/to/repo --item-file work-item.json
harness factory triage --workspace /path/to/repo --linear-issue TEAM-123 --dry-run
harness factory triage --workspace /path/to/repo --linear-issue TEAM-123 --apply
```

`--linear-issue` uses Linear as the input source by default. It requires
`LINEAR_API_KEY` and `factory.linear` config. Every `--linear-issue` triage run
performs a live Linear read before writing local factory artifacts, including
dry-runs. If `factory.linear.projectId` is set, the issue must belong to that
project before triage or apply can continue. Add `--apply` to move allowed entry
statuses to `Triaging`, then to the terminal triage status, and write one marker
comment. `--apply` cannot be combined with `--dry-run` or `--item-file`.
Comment dedupe checks the most recent Linear comments fetched by the adapter
(currently 20); older markers can be reposted on retry.

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
Linear statuses are rejected before creating a run directory. Add `--apply` to
move the issue to `Planning` before planner work, then post one marker comment
after the station finishes. Approved plans stay in `Planning`; human questions
move to `Needs Clarification`; unresolved reviews move to `Plan Needs Review`;
station/runtime failures move to `Planning Failed`. Planning apply never moves
the issue to `Ready to Implement`.

The planner writes `.harness/runs/factory/<run-id>/planning/draft.md`. Harness
snapshots the draft, runs `plan-review`, and reinvokes the same planner session
for review findings until the station reaches a terminal status.

Terminal statuses:

- `plan-approved`
- `plan-needs-human`
- `plan-review-unresolved`
- `planning-failed`

## Artifacts

Factory run root:

```text
.harness/runs/factory/<run-id>/
```

Read `summary.md` and `meta.json` first. Planning snapshots live under
`iterations/<n>/`, plan-review artifacts live under `.harness/runs/reviews/`,
and approved plans live under `dev/plans/`. Tracker-backed approved plans
should be published through a plan PR before the tracker moves to
`Ready to Implement`. During manual publication, `factoryStage: "plan-pr-open"`
can exist before `approvedPlanPrUrl`; record the URL when the plan PR exists.
Use `harness factory planning publish` to record the plan PR URL, then
`harness factory planning mark-plan-merged` to record the merge commit. These
commands update local run metadata and print suggested Linear comments by
default; they do not mutate Linear or GitHub unless `--linear-issue ... --apply`
is present. `publish --apply` moves Linear to `Plan Needs Review` and posts a
plan-PR marker comment. `mark-plan-merged --apply` moves Linear to
`Ready to Implement` and posts an approved-plan marker comment. Neither command
opens PRs or inspects GitHub merge state. Do not commit `.harness/runs/*`.

## Stop Conditions

Stop before proceeding if the task requires:

- running or restoring `harness factory dispatch`
- batch-moving every inbox item
- mutating GitHub, Jira, or Inngest
- mutating Linear outside explicit `harness factory triage --linear-issue ... --apply`
  or `harness factory planning run --linear-issue ... --apply`, or explicit
  planning publication commands with `--linear-issue ... --apply`
- committing `.harness/runs/*`
- overwriting an existing final plan
- letting planner agents write directly to tracked source files
