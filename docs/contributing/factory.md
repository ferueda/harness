# Factory Operation

## Factory action store

Factory action state uses a clean version-1 store rooted at the configured
durable `factory` directory. `store-format.json` is required. Harness creates
it only for an empty directory. A non-empty unmarked directory or a marker
with another version is rejected with archive/reset guidance; old lifecycle
logs are not parsed or migrated and data is never deleted automatically.

Factory commands are synchronous and manually stepped. One invocation runs at
most one action, waits for it to finish, persists its terminal event and state,
prints the next reaction, then exits. Planning is shipped as manually stepped
candidate, review, and publication commands. Implementation is shipped as one
candidate action followed by a full review action and, when review requires it,
later manual revision attempts. The CLI never invokes the next handler. An
already-waiting state invokes no handler.

Run only one Factory phase command at a time for a work item. Concurrent phase
commands for the same work item are unsupported and may fail.

Triage is the first action slice: `triage.requested` invokes
`triageWorkItem`; the terminal `triage.work_item.completed` event records the
route and durable evidence refs. Progress is always emitted to stderr after
the action is known. `step:start`, periodic `step:heartbeat`, and `step:end`
telemetry is always persisted in the action run; `--verbose` also forwards it
to stderr. Heartbeats are telemetry, not lifecycle events.

Use this guide when operating or changing the current factory flow. The factory
is local and explicit today: one command handles one work item. Future tracker
or event backends should call the same station code instead of replacing it.

## Command Model

`harness factory` commands are operator-facing station commands:

```bash
harness factory status --workspace /path/to/repo
harness factory linear list --status intake --workspace /path/to/repo
harness factory linear fetch TEAM-123 --workspace /path/to/repo
harness factory linear create --workspace /path/to/repo --title "Example" --body "Details"
harness factory triage --workspace /path/to/repo --item-file work-item.json
harness factory triage --workspace /path/to/repo --linear-issue TEAM-123
harness factory implementation run --workspace /path/to/repo --item-file work-item.json
```

There is no batch dispatch command. Run an explicit station for an explicit
work item while this surface is still local-first.

Live triage commands emit one always-on stderr JSON progress line after the
action identity is selected and before provider work:

```json
{
  "harnessFactory": "action-started",
  "phase": "triage",
  "phaseRunId": "...",
  "runDir": "...",
  "handler": "triageWorkItem",
  "attempt": 1
}
```

The line is CLI progress only; it is not a `WorkflowEvent` and is not appended
to `events.jsonl`. Dry-run has no durable action and instead emits the existing
context-only record:

```json
{
  "harnessFactory": "run-started",
  "station": "triage",
  "runId": "...",
  "runDir": "...",
  "workspace": "..."
}
```

Final stdout JSON stays the station contract.

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
    "linearStatus": "Backlog"
  },
  "title": "..."
}
```

These metadata keys are transport fields only. They are not Factory transition
inputs; the strict action event log is canonical.

## Lifecycle State

Live operator station commands write a harness-owned durable lifecycle log:

```text
${XDG_DATA_HOME:-~/.local/share}/harness/store/projects/<repo-id>/factory/events/<work-item>.jsonl
${XDG_DATA_HOME:-~/.local/share}/harness/store/projects/<repo-id>/factory/state/<work-item>.json
```

`events/*.jsonl` is the canonical action source of truth. Each work item has a
local-filesystem lock under `factory/locks/`; state JSON is an atomically
published, rebuildable strict projection. Dry-run and Linear fetch do not read,
initialize, or mutate Factory lifecycle state.

Linear status and comments are human board projections. Per-run `meta.json`
and durable `runs/factory/<run-id>/events.jsonl` are execution evidence. Git
remains source of truth for committed plans and code.

The workspace remains the sandbox: it owns source, tests, `harness.json`, the
shim, inbox, and committed `dev/plans/*.md`. Old Factory lifecycle state is
rejected with archive/reset guidance; it is never parsed or migrated.

New Factory state is projected only from the strict action event log. Triage
uses `work_item.imported`, `triage.requested`,
`triage.work_item.completed`, and `factory.action.failed`. Legacy station event
names and `factoryStage` fields are not transition inputs.

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
    "implementation": {
      "roles": {
        "implementer": { "agent": "codex", "model": "gpt-5.6-sol" },
        "reviewer": { "agent": "codex", "model": "gpt-5.6-sol" }
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
    }
  }
}
```

Optional terminal keys `done`, `canceled`, and `duplicate` may be added under
`statuses` when operator tools like `linear-cli` or `factory linear list`
should target those board states by key; factory stations do not require them.

The schema requires the downstream status names shown above. Planning and
implementation use configured statuses for explicit Linear boundary projections.

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

- `station`: the current lifecycle step, `triage`.
- `role`: a job inside a station, currently `triager`.
- `agent`: backend identity such as `cursor` or `codex`.

Keep factory config role-based. Do not add per-role CLI flag sprawl.
Codex roles may use optional provider policy fields such as `executable`,
`sandboxMode`, `approvalPolicy`, and `modelReasoningEffort`.

Linear status config is a coordinated board/config contract. Commands fail
fast if a configured status does not exist on the Linear team.

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
recent comments, then prints JSON suitable for `--item-file`. Tracker status
remains tracker metadata; fetch and list never derive Factory machine state.

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

When `projectId` is configured, Linear-backed list, fetch, triage input, and
triage apply reject issues outside that project before running
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
`triage.work_item.completed` blocks normal live triage before run artifacts,
lifecycle writes, provider calls, or Linear mutations. Use `--rerun` only for
intentional re-triage. Apply still accepts only an allowed entry status or an
already-idempotent matching terminal status; it never overwrites unrelated
human or external state.

Linear status is human board state, not Factory machine state. The action log
alone drives Factory transitions.

## Triage Station

Use triage to classify an idea or issue into one deterministic route:

```bash
harness factory triage --workspace /path/to/repo --item-file work-item.json
harness factory triage --workspace /path/to/repo --linear-issue ENG-123
harness factory triage --workspace /path/to/repo --linear-issue ENG-123 --apply
```

Routes:

- `ready-to-implement`: small and scoped enough for direct implementation.
- `ready-to-plan`: planning is required; start it with `harness factory planning run`.
- `needs-info`: requires human answers before rerun.
- `wait-to-implement`: valid but parked until `reconsiderWhen`.

Triage artifacts under the durable factory `runs/factory/<run-id>/` include:

- `context/work-item.json`
- `context/phase-run.json` with immutable work-item, workspace, store, project,
  phase, and phase-run identity
- `factory-triage.prompt.md`
- `factory-triage.raw.json`
- `factory-triage.json`
- `factory-route.json`
- `factory-route.md`
- `summary.md`
- `meta.json`
- `events.jsonl` for live runs
- `actions/<attempt>/triageWorkItem/<action-key>/action-result.json` as the
  immutable terminal result used for crash recovery

Live triage appends `work_item.imported`, `triage.requested`, and one terminal
action event. Dry-run does not write lifecycle events. A prior terminal triage
requires explicit `--rerun` intent for another live phase run.

Triage does not mutate tracker state, labels, branches, or source files unless
`--apply` is used with `--linear-issue`. Apply mode mutates Linear status and
comments only; it does not mutate source files.

## Planning

`harness factory planning run` executes one pending action and exits with
`next`; repeat the printed command to alternate candidate and fixed one-step
plan review actions. Revisions resume the original planner session and receive
only the latest `must_fix` findings. `--rerun` starts a fresh phase only after
needs-human or failure. Item files publish approved plans locally; Linear
starts and reruns require `--apply`, then wait for explicit `planning publish`
and `mark-plan-merged`. Factory validates and appends the planning request
before projecting Linear to Planning; a failed projection leaves that one
request pending for the next explicit `--apply` invocation and never reaches
the provider. Later human, failure, and publication waits may persist Factory
truth without `--apply` and repair their Linear projection later. `--apply`
authorizes only that invocation's projection.

## Implementation

`harness factory implementation run` executes exactly one pending action.
Start requires an attached branch, a clean workspace, and durable accepted
direct or planned input. Planned input must match the reviewed candidate bytes
committed at the original HEAD; pull-request planning also requires the
recorded merge commit to be present and pulled.

The candidate invocation runs the snapshotted implementer with no output
schema and no timer by default. The implementer may edit and validate, but may
not stage, commit, mutate refs, push, update trackers, review, or write Factory
state. Harness captures the tree through a temporary index, creates one
deterministic commit parented to the persisted base, and publishes a
create-only `refs/harness/factory/<phase-run>/<attempt>` ref. HEAD and the real
index do not move.

Run the exact printed command again. The review invocation verifies the
candidate evidence and live tree, then runs the fixed full implementation and
quality reviewers once with the phase's persisted
`factory.implementation.maxReviewIterations` ceiling (default 3). Reviewers
are read-only and review the cumulative original-base-to-candidate diff. A
`needs_changes` verdict below the ceiling prints the next producer command and
exits. Its later invocation reopens the phase, verifies the complete digested
blockers and prior candidate, resumes the effective implementer session, and
publishes a new tree/ref still parented to the original base. Pass CAS-advances
only the exact reviewed candidate and leaves a clean worktree. Blocked or
exhausted review waits for a human; no non-pass advances the branch. There is no
separate accept command or standalone post-candidate `harness run change-review`
step. Use `--rerun` only from human/failed state; it starts a fresh phase.

Linear starts and reruns require `--apply`. A failed start projection repairs
the same durable request on the next explicit apply without provider work.
Candidate/review keep Implementing; pass adds a deduplicated reviewed-candidate
comment, non-pass adds an attention comment, and terminal failure projects
Implementation Failed. A later explicit apply repairs a missing projection.

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
  `harness factory triage --linear-issue ... --apply`
- committing `.harness/runs/*`
- overwriting an existing final plan
