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
harness factory linear fetch TEAM-123 --workspace /path/to/repo
harness factory triage --workspace /path/to/repo --item-file work-item.json
harness factory triage --workspace /path/to/repo --linear-issue TEAM-123 --dry-run
harness factory planning --workspace /path/to/repo --item-file work-item.json
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
      "statuses": {
        "intake": "Backlog",
        "parked": "Parked",
        "needsInfo": "Needs Info",
        "needsPlan": "Needs Plan",
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

## Linear Fetch

Use Linear fetch to convert one issue into `FactoryWorkItem` JSON:

```bash
LINEAR_API_KEY=... harness factory linear fetch ENG-123 --workspace /path/to/repo
```

This command is read-only. It validates the configured Linear team statuses,
then prints a work item with issue description, labels, recent comments, and
tracker metadata. Redirect the output to an item file before planning, or pass
the issue directly to triage with `--linear-issue`.

## Triage

Run:

```bash
harness factory triage --workspace /path/to/repo --item-file work-item.json
harness factory triage --workspace /path/to/repo --linear-issue TEAM-123 --dry-run
```

`--linear-issue` uses Linear as the input source only. It requires
`LINEAR_API_KEY` and `factory.linear` config. Every `--linear-issue` triage run
performs a live Linear read before writing local factory artifacts, including
dry-runs. It does not mutate Linear.

Routes:

- `ready-to-implement`
- `ready-to-plan`
- `needs-info`
- `wait-to-implement`

Read the run `summary.md`, `factory-triage.json`, and `factory-route.md` before
deciding the next station.

## Planning

Run planning only for a work item routed to `ready-to-plan`:

```bash
harness factory planning --workspace /path/to/repo --item-file work-item.json
```

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
Do not commit `.harness/runs/*`.

## Stop Conditions

Stop before proceeding if the task requires:

- running or restoring `harness factory dispatch`
- batch-moving every inbox item
- mutating GitHub, Linear, Jira, or Inngest
- committing `.harness/runs/*`
- overwriting an existing final plan
- letting planner agents write directly to tracked source files
