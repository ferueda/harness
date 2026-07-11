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
harness factory linear list --status intake --workspace /path/to/repo
harness factory linear fetch TEAM-123 --workspace /path/to/repo
harness factory linear create --workspace /path/to/repo --title "Example" --body "Details"
harness factory triage --workspace /path/to/repo --item-file work-item.json
harness factory triage --workspace /path/to/repo --linear-issue TEAM-123
harness factory planning run --workspace /path/to/repo --item-file work-item.json
harness factory planning run --workspace /path/to/repo --linear-issue TEAM-123
harness factory planning run --workspace /path/to/repo --linear-issue TEAM-123 --apply
harness factory planning publish --run-dir /path/to/store/projects/<repo-id>/runs/factory/<run-id> --pr-url https://github.com/owner/repo/pull/123
harness factory planning mark-plan-merged --run-dir /path/to/store/projects/<repo-id>/runs/factory/<run-id> --commit abc1234
harness factory implementation run --workspace /path/to/repo --linear-issue TEAM-123
harness factory implementation run --workspace /path/to/repo --linear-issue TEAM-123 --apply
harness factory implementation run --workspace /path/to/repo --item-file work-item.json
```

There is no batch dispatch command. Run an explicit station for an explicit
work item while this surface is still local-first.

Triage, planning, and implementation station commands emit one always-on
stderr JSON progress line after run context creation and before provider work
or Linear `--apply` started mutations:

```json
{
  "harnessFactory": "run-started",
  "station": "triage",
  "runId": "...",
  "runDir": "...",
  "workspace": "..."
}
```

The line is CLI progress only so operators can learn `runDir` early; it is not
a `WorkflowEvent` and is not appended to `events.jsonl`. Final stdout JSON
stays the station contract.

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

These metadata keys are transport fields. When a lifecycle log exists, the
canonical machine state is the durable factory-store lifecycle read model;
work-item metadata is the resolved view passed to stations.
`approvedPlanPath` is the implementation input after the plan PR has merged.
`approvedPlanPrUrl` links the publication PR while it is open.
`approvedPlanCommit` pins the merged plan version.

## Lifecycle State

Live operator station commands write a harness-owned durable lifecycle log:

```text
${XDG_DATA_HOME:-~/.local/share}/harness/store/projects/<repo-id>/factory/events/<work-item>.jsonl
${XDG_DATA_HOME:-~/.local/share}/harness/store/projects/<repo-id>/factory/state/<work-item>.json
```

`events/*.jsonl` is the canonical lifecycle source of truth. Each work item has
a local-filesystem lock under `factory/locks/`; state JSON is an atomically
published, rebuildable projection. Dry-run stations and Linear fetch inspect
state without acquiring locks or rebuilding it; they report warnings for stale,
missing, corrupt, or held lifecycle state. Live stations rebuild projections
under lock when required.
`state/*.json` is a rebuildable read-model cache. The read model owns durable
machine fields such as `factoryStage`, `factoryRoute`, `factoryNextAction`,
`factoryRunId`, `approvedPlanPath`, `approvedPlanPrUrl`, and
`approvedPlanCommit`.

Linear status and comments are human board projections. Per-run `meta.json`
and durable `runs/factory/<run-id>/events.jsonl` are execution evidence. Git
remains source of truth for committed plans and code.

The workspace remains the sandbox: it owns source, tests, `harness.json`, the
shim, inbox, and committed `dev/plans/*.md`. Legacy workspace-local
`.harness/factory` state is detected by `factory status` and ignored; it is not
silently imported into the durable store.

`triage.started`, `planning.started`, and `implementation.started` events are
audit history only; they do not move durable `factoryStage`. Terminal events
such as `triage.completed`, `planning.completed`, `planning.failed`,
`implementation.completed`, `implementation.failed`, `plan_pr.opened`, and
`plan_pr.merged` own durable transitions.

## Station Config

Factory station roles use `harness.json`:

```json
{
  "defaultAgent": "cursor",
  "agents": {
    "cursor": { "model": "grok-4.5" },
    "codex": {
      "model": "gpt-5.6-sol",
      "modelReasoningEffort": "high",
      "sandboxMode": "read-only",
      "approvalPolicy": "never"
    }
  },
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
      "maxReviewIterations": 2,
      "roles": {
        "planner": { "agent": "cursor", "model": "grok-4.5" },
        "reviewer": {
          "agent": "codex",
          "model": "gpt-5.6-sol",
          "modelReasoningEffort": "high"
        }
      }
    },
    "implementation": {
      "roles": {
        "implementer": {
          "agent": "cursor",
          "model": "grok-4.5"
        }
      }
    }
  }
}
```

Optional terminal keys `done`, `canceled`, and `duplicate` may be added under
`statuses` when operator tools like `linear-cli` or `factory linear list`
should target those board states by key; factory stations do not require them.

### Durable Store Overrides

Factory station commands default to
`${XDG_DATA_HOME:-~/.local/share}/harness/store/projects/<repo-id>/`. Override
the store root or project id with `--factory-store-root` /
`--factory-store-project-id`, `HARNESS_FACTORY_STORE_ROOT` /
`HARNESS_FACTORY_STORE_PROJECT_ID`, or `factory.store.root` /
`factory.store.projectId` in `harness.json`. Precedence is CLI, environment,
config, then the default. The workspace still owns its shim, inbox, source, and
committed plans; workspace-local `.harness/factory` lifecycle files are legacy.

Vocabulary:

- `station`: lifecycle step such as `triage`, `planning`, or `implementation`.
- `role`: job inside a station such as `triager`, `planner`, `reviewer`, or `implementer`.
- `agent`: backend identity such as `cursor` or `codex`.

Keep factory config role-based. Do not add per-role CLI flag sprawl.
Codex implementation roles may use the same optional provider policy fields as
other Codex roles: `executable`, `sandboxMode`, `approvalPolicy`, and
`modelReasoningEffort`.

Linear status config is a coordinated board/config contract. When upgrading an
existing repo, rename the old human-input status to `Needs Clarification`, add
`Plan Needs Review`, `Implementing`, and `Implementation Failed`, then add the
matching `needsPlanReview`, `implementing`, and `implementationFailed` mappings
to `harness.json` in the same change. These mappings are a required config
migration, including for observe-only commands; they are not enabled lazily by
`--apply`. Commands fail fast if a configured status does not exist on the
Linear team.

## Linear Adapter

Use Linear list to scan issues in configured factory statuses:

```bash
LINEAR_API_KEY=... harness factory linear list --status intake --workspace /path/to/repo
LINEAR_API_KEY=... harness factory linear list --status intake --status needsPlan --all --workspace /path/to/repo
LINEAR_API_KEY=... harness factory linear list --status done --workspace /path/to/repo
```

The list command is read-only. It accepts keys from
`factory.linear.statuses`, such as `intake`, `needsPlan`, or optional terminal
keys like `done` when mapped in `harness.json`, rather than raw Linear status
names. It validates the configured Linear team statuses, applies
the configured `factory.linear.projectId` filter when present, and prints
lightweight issue summaries for backlog discovery. Pagination defaults to the
first page; use generated help for cursor and all-pages options. Large
all-pages scans may take longer because each summary verifies issue team,
project, status, and assignee relations for scope-safe output.

List output deliberately omits descriptions, labels, and comments. Use Linear
fetch to normalize one selected issue into a full `FactoryWorkItem`:

```bash
LINEAR_API_KEY=... harness factory linear fetch ENG-123 --workspace /path/to/repo
```

The fetch command is read-only. It verifies the issue belongs to the configured
`factory.linear.projectId` when set, fetches the issue description, labels, and
recent comments, merges lifecycle state when present, then prints JSON suitable
for `--item-file`. Comment-derived planning-attention stages such as
`plan-needs-human` require fetch; list mode does not read comments and omits
`factoryStage` for the configured `needsInfo` status.

### Linear Create

Use Linear create to author one intake issue in the configured factory project:

```bash
LINEAR_API_KEY=... harness factory linear create --workspace /path/to/repo --title "Example intake" --body "Details"
LINEAR_API_KEY=... harness factory linear create --workspace /path/to/repo --title "Example intake" --body-file notes.md
printf '%s\n' "Details" | LINEAR_API_KEY=... harness factory linear create --workspace /path/to/repo --title "Example intake"
```

Create is a constrained intake helper, not a station. It requires
`factory.linear.projectId`, a non-empty title, and a non-empty body from exactly
one of `--body`, `--body-file`, or stdin. It always uses configured
`factory.linear.teamKey`, `projectId`, and `statuses.intake`. It prints compact
JSON with `identifier`, `url`, and `id: "linear:<identifier>"`. Create does not
append lifecycle events, write factory run artifacts, or accept `--dry-run` /
`--apply`. Use Linear fetch afterward when you need a full `FactoryWorkItem`.

Linear team and project serve different purposes:

- `teamKey` owns the issue key namespace and workflow statuses, such as
  `ENG-123` and `Needs Plan`.
- `projectId` scopes the target repo. Use it when multiple repo projects share
  one Linear team.

When `projectId` is configured, Linear-backed list, fetch, triage, planning
input, and triage apply reject issues outside that project before running
station work or mutating Linear. Local `--item-file` inputs are not revalidated
against Linear.

The triage station can also fetch Linear directly:

```bash
LINEAR_API_KEY=... harness factory triage --workspace /path/to/repo --linear-issue ENG-123
LINEAR_API_KEY=... harness factory triage --workspace /path/to/repo --linear-issue ENG-123 --apply
LINEAR_API_KEY=... harness factory triage --workspace /path/to/repo --linear-issue ENG-123 --rerun --apply
```

`--linear-issue` and `--item-file` are mutually exclusive. Every
`--linear-issue` triage invocation performs a live Linear read before creating
local factory artifacts. Linear-backed triage currently uses Linear only as the
input source unless `--apply` is passed.

The planning station can fetch Linear directly too:

```bash
LINEAR_API_KEY=... harness factory planning run --workspace /path/to/repo --linear-issue ENG-123
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

Durable lifecycle history is authoritative for triage eligibility. Any prior
`triage.completed` blocks normal live and dry-run triage before run artifacts,
lifecycle writes, provider calls, or Linear mutations. Use `--rerun` only for
intentional re-triage. Normal apply retains the three entry statuses above;
`--rerun --apply` accepts any present status after the existing issue and
team/project scope checks. The new completion invalidates prior approved plan
path, PR URL, and commit metadata.

Comment dedupe and planning-attention detection check the most recent Linear
comments fetched by the adapter (currently 20). If the relevant marker is older
than that window, a retry may post another marker comment or classify
`Needs Clarification` as generic human input instead of a planning re-entry
state.

Linear status is human board state. The adapter maps statuses as a bootstrap
fallback when no lifecycle log exists:

- `Backlog` -> `incoming`
- `Triaging` -> `triaging`
- `Needs Clarification` -> `needs-info`
- `Plan Needs Review` -> `plan-review-unresolved`
- `Needs Plan` -> `ready-to-plan`
- `Ready to Implement` -> `ready-to-implement`
- `Implementing` -> `implementation-started`
- `Implementation Failed` -> `implementation-failed`
- `Parked` -> `wait-to-implement`
- `Planning` -> `planning`
- `Planning Failed` -> `planning-failed`

When `Needs Clarification` carries the latest factory planning marker for
`plan-needs-human`, the adapter preserves that planning-attention stage in
metadata as a bootstrap fallback. When lifecycle state exists, planning uses
the lifecycle read model instead of recent marker comments.

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

Triage artifacts under the durable factory `runs/factory/<run-id>/` include:

- `context/work-item.json`
- `factory-triage.prompt.md`
- `factory-triage.raw.json`
- `factory-triage.json`
- `factory-route.json`
- `factory-route.md`
- `summary.md`
- `meta.json`
- `events.jsonl` for live runs

Live triage appends lifecycle events for work-item import, station start, and
terminal completion/failure. Dry-run does not write lifecycle events. Both
modes enforce prior-completion history before creating a run; an eligible
first dry-run needs no `--rerun`, while a dry-run over completed history does.

Triage does not mutate tracker state, labels, branches, or source files unless
`--apply` is used with `--linear-issue`. Apply mode mutates Linear status and
comments only; it does not mutate source files.

## Planning Station

Use planning for work items that need a new plan, revised plan, or failed
planning retry:

```bash
harness factory planning run --workspace /path/to/repo --item-file work-item.json
harness factory planning run --workspace /path/to/repo --linear-issue ENG-123
harness factory planning run --workspace /path/to/repo --linear-issue ENG-123 --apply
```

`--item-file` and `--linear-issue` are mutually exclusive. Linear-backed
planning requires `LINEAR_API_KEY` and `factory.linear` config. It accepts
issues in `Needs Plan`, `Needs Clarification` when the latest factory planning
marker identifies `plan-needs-human`, `Plan Needs Review`, or
`Planning Failed`; other Linear statuses are rejected before a factory run
directory is created.

With `--apply`, planning moves the Linear issue to `Planning` before planner
work starts. Terminal outcomes post one marker comment: approved plans stay in
`Planning`, human questions move to `Needs Clarification`, unresolved reviews
move to `Plan Needs Review`, and station/runtime failures move to
`Planning Failed`.

Live planning appends lifecycle events for work-item import, station start, and
terminal completion/failure. The lifecycle read model is what future stations
should use for readiness; Linear comments remain human context and dedupe.

Factory plans are minimum-sufficient: preserve the explicit task and project
intent, choose the smallest coherent change, and include only implementation
decisions and verification tied to a requirement, invariant, or demonstrated
risk. The default of two completed reviews allows the initial review and one
revision; `factory.planning.maxReviewIterations` may override it. All findings
remain durable evidence, but only `must_fix` findings enter a revision.

The planner writes only to the ignored workspace-local
`.harness/factory-drafts/<run-id>/draft.md`. Harness validates and reads that
draft once, publishes identical bytes to canonical
`<runDir>/planning/draft.md` and immutable
`<runDir>/iterations/<n>/plan.md`, then `plan-review` reviews the immutable
snapshot. Revisions edit the same scratch path and add a new immutable
snapshot. Scratch is retained as non-authoritative agent state; it is never
used for recovery or copied directly to `dev/plans/`.

Planning statuses:

- `plan-approved`
- `plan-needs-human`
- `plan-review-unresolved`
- `planning-failed`

Planning artifacts under the durable factory `runs/factory/<run-id>/` include:

- `context/work-item.json`
- `planning/draft.md` (canonical latest successful draft)
- `iterations/<n>/planner.prompt.md`
- `iterations/<n>/planner.raw.json`
- `iterations/<n>/planner.json` when structured planner output parses
- `iterations/<n>/planner.failure.json` for failed or non-publishable turns
- `iterations/<n>/planner.stream.jsonl` when the provider streams output
- `iterations/<n>/plan.md`
- `iterations/<n>/plan-review-ref.json`
- `iterations/<n>/review-findings.json`
- `summary.md`
- `meta.json`
- `events.jsonl` for live runs

`planner.failure.json` records the classified failure. If structured output
parsed before a later validation or publication failure, `planner.json` may
also remain alongside it.

Planning scratch is intentionally retained under the workspace and ignored by
Git. Manual cleanup is an operator action: first verify that the path still
resolves inside the workspace and does not overlap the durable run. Live
planning rejects a workspace-local `--runs-dir`; local run roots remain a
dry-run-only compatibility mode.

Nested factory plan-review artifacts live under durable `runs/reviews/<run-id>/` and are
referenced from `iterations/<n>/plan-review-ref.json`. The final approved plan
is copied under `dev/plans/` only after approval. Tracker-backed plans should
use stable tracker-key names such as `dev/plans/FER-123.md` and be published
through a plan PR before the tracker moves to `Ready to Implement`. During the
manual publication handoff, `factoryStage: "plan-pr-open"` may exist before
`approvedPlanPrUrl`; the URL is recorded when the operator registers the plan
PR.

Manual publication commands update local run metadata, summary files, and the
lifecycle log by default:

```bash
harness factory planning publish --run-dir /path/to/store/projects/<repo-id>/runs/factory/<run-id> --pr-url https://github.com/owner/repo/pull/123
harness factory planning mark-plan-merged --run-dir /path/to/store/projects/<repo-id>/runs/factory/<run-id> --commit abc1234
```

They print `factoryMetadata` plus suggested Linear comment text. They do not
open PRs or inspect GitHub merge state.

### Linear PR linking

Linear's native GitHub integration links a PR to an issue when the issue id
appears in the **branch name**, the **PR title**, or a magic word plus issue id
in the title or body. See [Linear's GitHub docs](https://linear.app/docs/github).
Harness does not PATCH GitHub PR bodies or verify linking.

**Prerequisite:** the target repo must have Linear's GitHub integration enabled
and the repo connected in Linear settings. Harness does not configure or check
this.

House rule for tracker-backed factory work: put the normalized issue id (for
example `ENG-123`) in **both** the branch name and the PR title before or when
opening the PR.

| PR kind        | Branch                                                    | Title             | Magic words                                                                                                             |
| -------------- | --------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Plan           | `plan/<ISSUE>-<short-slug>`                               | include `<ISSUE>` | Prefer **no** closing words (`Fixes`, `Closes`, `Implements`, …). A bare issue id in branch or title is enough to link. |
| Implementation | `feat/<ISSUE>-<short-slug>` or `fix/<ISSUE>-<short-slug>` | include `<ISSUE>` | Use `Fixes <ISSUE>.` (or another closing phrase) in title or body **only** when merge should complete the Linear issue. |

Example plan PR flow:

```bash
git checkout -b plan/ENG-123-short-slug
# ... commit plan ...
git push -u origin plan/ENG-123-short-slug
gh pr create --title "plan: ENG-123 short description" --body "..."
LINEAR_API_KEY=... harness factory planning publish \
  --run-dir /path/to/store/projects/<repo-id>/runs/factory/<run-id> \
  --pr-url https://github.com/owner/repo/pull/123 \
  --linear-issue ENG-123 --apply
```

If an already-open PR is not linked, repair as an operator — rename the branch
and/or edit the title to match the PR kind (for example
`gh pr edit <number> --title "plan: ENG-123 short description"` for a plan PR).
Do not add or expect a harness repair command.

`planning publish` records the PR URL and may apply Linear status/comments; it
does not edit GitHub PRs or verify that Linear attached the PR.

Add `--linear-issue` and `--apply` to mutate Linear:

```bash
LINEAR_API_KEY=... harness factory planning publish --run-dir /path/to/store/projects/<repo-id>/runs/factory/<run-id> --pr-url https://github.com/owner/repo/pull/123 --linear-issue ENG-123 --apply
LINEAR_API_KEY=... harness factory planning mark-plan-merged --run-dir /path/to/store/projects/<repo-id>/runs/factory/<run-id> --commit abc1234 --linear-issue ENG-123 --apply
```

`publish --apply` validates the issue belongs to the configured Linear
team/project, accepts `Needs Plan`, `Planning`, or `Plan Needs Review`, moves
the issue to `Plan Needs Review`, and posts one plan-PR marker comment.
`mark-plan-merged --apply` accepts `Plan Needs Review` or
`Ready to Implement`, moves the issue to `Ready to Implement`, and posts one
approved-plan marker comment. Both commands reject mismatched issue ids and
non-Linear tracker metadata before local metadata writes.

## Implementation Station

Run one live implementer pass:

```bash
harness factory implementation run --workspace /path/to/repo --item-file work-item.json
harness factory implementation run --workspace /path/to/repo --linear-issue ENG-123 --apply
```

Entry modes:

| Input        | Flags               | Accepted entry                                                  | Linear writes             |
| ------------ | ------------------- | --------------------------------------------------------------- | ------------------------- |
| item file    | live or `--dry-run` | normal direct/planned readiness                                 | none                      |
| Linear issue | live or `--dry-run` | `Ready to Implement` first run                                  | none                      |
| Linear issue | live `--apply`      | `Ready to Implement` first run or `Implementation Failed` retry | status and marker comment |

`--apply` requires `--linear-issue` and `LINEAR_API_KEY`; it rejects
`--item-file` and `--dry-run`. Linear retries require `--apply`. Item-file
retries remain rejected because an item file cannot provide a fresh tracker
projection.

The station first calls `resolveFactoryWorkItemInput`, then
`resolveFactoryImplementationInput`. Linear-backed first runs require `Ready to
Implement`; applied retries require `Implementation Failed`. Lifecycle metadata
remains authoritative and the Linear state is a fail-closed projection guard.

Planned mode requires lifecycle/factory metadata with
`factoryStage: "plan-approved"`, `approvedPlanPath`, `approvedPlanCommit`, and
the approved plan file present in the current workspace. The station records the
relative plan path, absolute workspace plan path, and commit provenance. In v1,
the commit is a readiness marker only; the station does not check out or verify
the Git object.

Direct mode requires explicit factory readiness markers:
`factoryStage: "ready-to-implement"`,
`factoryRoute: "ready-to-implement"`, and
`factoryNextAction: "implement-directly"`. Linear `Ready to Implement` is only
a projection consistency guard for Linear-backed input; it is not the source of
truth for direct or planned readiness.

Live mode requires a clean workspace porcelain status (excluding `.harness/`),
invokes one configured implementer with `workspaceGuard: "record"`, writes
candidate change artifacts, and materializes an internal review ref:

- `reviewBase` is the `HEAD` commit captured before the implementer runs
- `reviewHead` is `refs/harness/factory/<run-id>/implementation`
- `reviewCommitSha` is the internal commit object behind that ref
- `implementation-complete` means candidate changes and that review ref exist;
  it does not mean reviewed, approved, PR-ready, or merged

Optional `--dry-run` prepares prompt and handoff drafts without invoking a
provider or writing lifecycle state.

Every live implementation acquires a per-work-item execution lease before its
final item/lifecycle read and readiness validation. The lease is held through
the provider run, local terminal event, and requested Linear terminal
projection, so two implementations cannot race the same item. Contention fails
immediately. A same-host lease whose process is dead can be recovered; a lease
owned by another hostname never becomes stale by age. Inspect the reported
owner and remove a remote lease only after independently proving that owner is
gone.

Apply order is fail closed:

1. Re-fetch and validate the issue while holding the execution lease.
2. Append imported/started lifecycle audit evidence.
3. Re-fetch Linear immediately before moving the issue from `Ready to
Implement` (or retry `Implementation Failed`) to `Implementing`.
4. Invoke the implementer and append the local terminal lifecycle event.
5. Re-fetch Linear before the terminal projection. Success posts a
   marker-deduped review handoff comment while leaving the issue in
   `Implementing`; failure moves it to `Implementation Failed` and posts a
   marker-deduped retry comment.

The implementer prompt forbids tracker mutation. The station command owns all
requested Linear writes.

Live artifacts:

```text
${XDG_DATA_HOME:-~/.local/share}/harness/store/projects/<repo-id>/runs/factory/<run-id>/
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

`implementation/change-review-handoff.md` uses the same handoff section model as
`change-review-workflow`. After `implementation-complete`, run
`harness run change-review --base <reviewBase> --head <reviewHead>` separately.

Lifecycle: `implementation.started` is audit-only;
`implementation.completed` / `implementation.failed` move durable stage while
preserving plan/direct retry metadata. With `--apply`, eligible Ready or
Implementation Failed work moves through Implementing; without it, Linear is
not mutated.

Failure recovery:

- Start projection failure: the provider is not invoked. `meta.json` records
  `implementation-failed` and omits prompt/handoff/events paths; local lifecycle
  has only imported/started audit evidence. Correct the Linear state or mutation
  failure, then rerun.
- Provider or local implementation failure after start: local lifecycle moves
  to `implementation-failed`; successful terminal apply moves Linear to
  `Implementation Failed`. Inspect the run, correct the cause, and rerun the
  same Linear issue with `--apply`.
- Terminal Linear projection failure: local terminal lifecycle and run
  artifacts remain authoritative; stdout reports `linearApplied: false` and
  the command exits non-zero. Do not rerun the provider merely to repair the
  tracker. Inspect `meta.json` and `linearUpdate`; partial terminal progress
  records `statusMutationCompleted`, `statusPostconditionVerified`,
  `commentPresent`, and the intended marker/body. Manually finish only the
  missing status/comment projection from that evidence. This initial slice
  intentionally has no comment-only replay command.

Non-goals: nested change-review execution; PR creation; Linear mutation without
`--apply`; terminal-projection replay; human branch/worktree orchestration; and
Git checkout or commit verification of `approvedPlanCommit`. The implementer
agent must not mutate refs; the harness command owns the internal review ref.

## Local Inbox

Local inbox files live under `.harness/inbox/factory/*.json`.

`harness factory status` reads pending, historical processed, and historical
failed files, then reports the active durable store, lifecycle locks, ignored
legacy workspace-local state, and any warnings. It is read-only. Current
station commands do not move inbox files or batch-process every pending item.

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
truth. Inngest should call station helpers or CLI commands that append
lifecycle events; it should not become the factory lifecycle database.

## Stop Conditions

Stop and re-check scope if the work requires:

- reviving `harness factory dispatch`
- moving every inbox item in a batch
- mutating GitHub, Jira, or Inngest from current station commands
- mutating Linear outside documented `harness factory linear create` or explicit
  `harness factory triage --linear-issue ... --apply`,
  `harness factory planning run --linear-issue ... --apply`, or explicit
  planning publication commands with `--linear-issue ... --apply`
- committing `.harness/runs/*`
- overwriting an existing final plan
- letting planner agents write directly to tracked files
