# Factory Operation

Use this guide when operating or changing the current factory flow. The factory
is local and explicit today: one command handles one work item. Future tracker
or event backends should call the same station code instead of replacing it.

## Command Model

`harness run` commands are low-level workflow primitives:

```bash
harness run factory-triage --item-file work-item.json
harness run plan-review --plan path/to/implementation-plan.md
```

`harness factory` commands are operator-facing station commands:

```bash
harness factory status --workspace /path/to/repo
harness factory linear fetch TEAM-123 --workspace /path/to/repo
harness factory triage --workspace /path/to/repo --item-file work-item.json
harness factory triage --workspace /path/to/repo --linear-issue TEAM-123 --dry-run
harness factory planning run --workspace /path/to/repo --item-file work-item.json
harness factory planning run --workspace /path/to/repo --linear-issue TEAM-123 --dry-run
harness factory planning run --workspace /path/to/repo --linear-issue TEAM-123 --apply
harness factory planning publish --run-dir .harness/runs/factory/<run-id> --pr-url https://github.com/owner/repo/pull/123
harness factory planning mark-plan-merged --run-dir .harness/runs/factory/<run-id> --commit abc1234
```

There is no batch dispatch command. Run an explicit station for an explicit
work item while this surface is still local-first.

## Work Items

Local work items are JSON files shaped as `FactoryWorkItem`:

```json
{
  "id": "local-1",
  "source": "file",
  "title": "Fix export crash",
  "body": "Export crashes when the output directory is missing.",
  "labels": ["bug"],
  "metadata": {
    "factoryRoute": "ready-to-plan",
    "factoryNextAction": "create-plan"
  }
}
```

Tracker adapters can attach reserved metadata under `metadata`:

```json
{
  "metadata": {
    "tracker": {
      "source": "github",
      "id": "owner/repo#123",
      "url": "https://github.com/owner/repo/issues/123"
    },
    "factoryRoute": "ready-to-plan",
    "factoryNextAction": "create-plan",
    "factoryStage": "plan-pr-open",
    "factoryRunId": "20260707-120000",
    "approvedPlanPath": "dev/plans/GH-123.md",
    "approvedPlanPrUrl": "https://github.com/owner/repo/pull/123",
    "approvedPlanCommit": "abc1234"
  },
  "title": "..."
}
```

`approvedPlanPath` is the canonical implementation input after the plan PR has
merged. `approvedPlanPrUrl` links the publication PR while it is open.
`approvedPlanCommit` pins the merged plan version.

## Station Config

Factory station roles use `harness.json`:

```json
{
  "defaultAgent": "cursor",
  "agents": {
    "cursor": { "model": "composer-2.5" },
    "codex": {
      "model": "gpt-5.5",
      "modelReasoningEffort": "high",
      "sandboxMode": "read-only",
      "approvalPolicy": "never"
    }
  },
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
        "reviewer": {
          "agent": "codex",
          "model": "gpt-5.5",
          "modelReasoningEffort": "high"
        }
      }
    }
  }
}
```

Vocabulary:

- `station`: lifecycle step such as `triage` or `planning`.
- `role`: job inside a station such as `triager`, `planner`, or `reviewer`.
- `agent`: backend identity such as `cursor` or `codex`.

Keep factory config role-based. Do not add per-role CLI flag sprawl.

Linear status config is a coordinated board/config contract. When upgrading an
existing repo, rename the old human-input status to `Needs Clarification`, add
`Plan Needs Review`, and update `factory.linear.statuses.needsPlanReview` in
`harness.json` in the same change. Commands fail fast if the configured status
does not exist on the Linear team.

## Linear Adapter

Use Linear fetch to normalize one issue into a `FactoryWorkItem`:

```bash
LINEAR_API_KEY=... harness factory linear fetch ENG-123 --workspace /path/to/repo
```

The fetch command is read-only. It validates `factory.linear.statuses` against
the configured team workflow, verifies the issue belongs to the configured
`factory.linear.projectId` when set, fetches the issue description, labels, and
recent comments, then prints JSON suitable for `--item-file`.

Linear team and project serve different purposes:

- `teamKey` owns the issue key namespace and workflow statuses, such as
  `ENG-123` and `Needs Plan`.
- `projectId` scopes the target repo. Use it when multiple repo projects share
  one Linear team.

When `projectId` is configured, Linear-backed fetch, triage, planning input, and
triage apply reject issues outside that project before running station work or
mutating Linear. Local `--item-file` inputs are not revalidated against Linear.

The triage station can also fetch Linear directly:

```bash
LINEAR_API_KEY=... harness factory triage --workspace /path/to/repo --linear-issue ENG-123 --dry-run
LINEAR_API_KEY=... harness factory triage --workspace /path/to/repo --linear-issue ENG-123 --apply
```

`--linear-issue` and `--item-file` are mutually exclusive. Every
`--linear-issue` triage invocation performs a live Linear read before creating
local factory artifacts, including dry-runs. Linear-backed triage currently
uses Linear only as the input source unless `--apply` is passed.

The planning station can fetch Linear directly too:

```bash
LINEAR_API_KEY=... harness factory planning run --workspace /path/to/repo --linear-issue ENG-123 --dry-run
LINEAR_API_KEY=... harness factory planning run --workspace /path/to/repo --linear-issue ENG-123 --apply
```

Linear-backed planning performs a live Linear read, validates configured project
scope when set, validates that the issue maps to `Needs Plan` or
`Planning Failed`, `Needs Clarification`, or `Plan Needs Review`, then runs the
existing planning station from the fetched `FactoryWorkItem`. It writes local
factory artifacts and, for live approved runs, the reviewed plan under
`dev/plans/<issue-key>.md`.

Planning `--apply` is Linear-only and cannot be combined with `--item-file` or
`--dry-run`. It moves allowed entry statuses (`Needs Plan`,
`Needs Clarification`, `Plan Needs Review`, or `Planning Failed`) to
`Planning`, runs the station, posts one deterministic planning outcome comment,
and moves human questions to `Needs Clarification`, unresolved reviews to
`Plan Needs Review`, and station/runtime failures to `Planning Failed`.
It never moves Linear to `Ready to Implement`; that happens only after the plan
PR is opened, merged, and recorded by the plan-merge handoff.

Triage `--apply` is also Linear-only and cannot be combined with `--item-file`
or `--dry-run`. It moves allowed entry statuses (`Backlog`,
`Needs Clarification`, or `Triage Failed`) to `Triaging`, runs the station,
then moves to the terminal status and writes one marker comment:

- `ready-to-implement` -> `Ready to Implement`
- `ready-to-plan` -> `Needs Plan`
- `needs-info` -> `Needs Clarification`
- `wait-to-implement` -> `Parked`
- triage failure -> `Triage Failed`

Comment dedupe and planning-attention detection check the most recent Linear
comments fetched by the adapter (currently 20). If the relevant marker is older
than that window, a retry may post another marker comment or classify
`Needs Clarification` as generic human input instead of a planning re-entry
state.

Linear status is human board state. Harness metadata is finer-grained factory
state. The adapter maps:

- `Backlog` -> `incoming`
- `Triaging` -> `triaging`
- `Needs Clarification` -> `needs-info`
- `Plan Needs Review` -> `plan-review-unresolved`
- `Needs Plan` -> `ready-to-plan`
- `Ready to Implement` -> `ready-to-implement`
- `Parked` -> `wait-to-implement`
- `Planning` -> `planning`
- `Planning Failed` -> `planning-failed`

When `Needs Clarification` carries the latest factory planning marker for
`plan-needs-human`, the adapter preserves that planning-attention stage in
metadata so planning can rerun from the issue.

`Triage Failed` is kept as `metadata.linearStatus`; it is not a `factoryStage`
today.

## Triage Station

Use triage to classify an idea or issue into one deterministic route:

```bash
harness factory triage --workspace /path/to/repo --item-file work-item.json
harness factory triage --workspace /path/to/repo --linear-issue ENG-123
harness factory triage --workspace /path/to/repo --linear-issue ENG-123 --apply
```

Routes:

- `ready-to-implement`: small and scoped enough for direct implementation.
- `ready-to-plan`: should go through the planning station first.
- `needs-info`: requires human answers before rerun.
- `wait-to-implement`: valid but parked until `reconsiderWhen`.

Triage artifacts under `.harness/runs/factory/<run-id>/` include:

- `context/work-item.json`
- `factory-triage.prompt.md`
- `factory-triage.raw.json`
- `factory-triage.json`
- `factory-route.json`
- `factory-route.md`
- `summary.md`
- `meta.json`
- `events.jsonl` for live runs

Triage does not mutate tracker state, labels, branches, or source files unless
`--apply` is used with `--linear-issue`. Apply mode mutates Linear status and
comments only; it does not mutate source files.

## Planning Station

Use planning for a `ready-to-plan` work item:

```bash
harness factory planning run --workspace /path/to/repo --item-file work-item.json
harness factory planning run --workspace /path/to/repo --linear-issue ENG-123 --dry-run
harness factory planning run --workspace /path/to/repo --linear-issue ENG-123 --apply
```

`--item-file` and `--linear-issue` are mutually exclusive. Linear-backed
planning requires `LINEAR_API_KEY` and `factory.linear` config. It accepts
issues in `Needs Plan`, `Needs Clarification` when the latest factory planning
marker identifies `plan-needs-human`, `Plan Needs Review`, or
`Planning Failed`; other Linear statuses are rejected before a factory run
directory is created. Dry-run still performs the live Linear read but does not
mutate Linear.

With `--apply`, planning moves the Linear issue to `Planning` before planner
work starts. Terminal outcomes post one marker comment: approved plans stay in
`Planning`, human questions move to `Needs Clarification`, unresolved reviews
move to `Plan Needs Review`, and station/runtime failures move to
`Planning Failed`.

The planner writes a draft file, the harness snapshots it, `plan-review`
reviews the snapshot, and the same planner session handles review findings
until the station finishes.

Planning statuses:

- `plan-approved`
- `plan-needs-human`
- `plan-review-unresolved`
- `planning-failed`

Planning artifacts under `.harness/runs/factory/<run-id>/` include:

- `context/work-item.json`
- `planning/draft.md`
- `iterations/<n>/planner.prompt.md`
- `iterations/<n>/planner.raw.json`
- `iterations/<n>/planner.json`
- `iterations/<n>/plan.md`
- `iterations/<n>/plan-review-ref.json`
- `iterations/<n>/review-findings.json`
- `summary.md`
- `meta.json`
- `events.jsonl` for live runs

Plan-review artifacts live under `.harness/runs/reviews/<run-id>/` and are
referenced from `iterations/<n>/plan-review-ref.json`. The final approved plan
is copied under `dev/plans/` only after approval. Tracker-backed plans should
use stable tracker-key names such as `dev/plans/FER-123.md` and be published
through a plan PR before the tracker moves to `Ready to Implement`. During the
manual publication handoff, `factoryStage: "plan-pr-open"` may exist before
`approvedPlanPrUrl`; the URL is recorded when the operator registers the plan
PR.

Manual publication commands update local run metadata and summary files only:

```bash
harness factory planning publish --run-dir .harness/runs/factory/<run-id> --pr-url https://github.com/owner/repo/pull/123
harness factory planning mark-plan-merged --run-dir .harness/runs/factory/<run-id> --commit abc1234
```

They print `factoryMetadata` plus suggested Linear comment text. They do not
open PRs, post comments, or move Linear statuses.

## Local Inbox

Local inbox files live under `.harness/inbox/factory/*.json`.

`harness factory status` reads pending, historical processed, and historical
failed files. It is read-only. Current station commands do not move inbox files
or batch-process every pending item.

## Future Tracker And Orchestrator Boundary

GitHub or Linear should replace the visible tracker surface:

- incoming issue state
- labels or project status
- human questions and answers
- comments with concise summaries and artifact links

Inngest should replace manual event triggering:

- webhook ingestion
- retries
- one-active-station locks
- waits for human events
- durable station run scheduling

Harness keeps the station logic:

- schemas and prompts
- provider/session handling
- route and stage validation
- artifact layout
- deterministic transitions

Durable artifacts should stay in the repo or artifact storage. Tracker comments
should contain summaries and links, not full plans or logs as the source of
truth.

## Stop Conditions

Stop and re-check scope if the work requires:

- reviving `harness factory dispatch`
- moving every inbox item in a batch
- mutating GitHub, Jira, or Inngest from current station commands
- mutating Linear outside explicit `harness factory triage --linear-issue ... --apply`
  or `harness factory planning run --linear-issue ... --apply`
- committing `.harness/runs/*`
- overwriting an existing final plan
- letting planner agents write directly to tracked files
