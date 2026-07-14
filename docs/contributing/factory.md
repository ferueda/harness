# Factory Operation

## Factory action store

Factory action state uses a clean version-3 store rooted at the configured
durable `factory` directory. `store-format.json` is required. Harness creates
it only for an empty directory. A non-empty unmarked directory or a marker
with another version is rejected with archive/reset guidance; old lifecycle
logs are not parsed or migrated and data is never deleted automatically.

Factory commands are synchronous and manually stepped. One invocation runs at
most one action, waits for it to finish, persists its terminal event and state,
prints the next reaction, then exits. Planning is shipped as manually stepped
candidate, review, and publication commands. Implementation is shipped as one
candidate action followed by a full review action and an explicit continuation
choice when a human response is required. The CLI never invokes the next handler. An
already-waiting state invokes no handler.

Factory does not enforce a review-round ceiling. A caller may cap automated
continuation by reading the durable `reviewRound`; a limit of three means three
completed review rounds total, not three revisions. Retryable action failures
and repeated CLI invocations do not increment it. Reaching a caller limit stops
that caller from recording or scheduling another continuation. It does not
invalidate the retained candidate or prevent a later explicitly authorized
human continuation.

Run only one Factory phase command at a time for a work item. Concurrent phase
commands for the same work item are unsupported and may fail.

Use one stable Harness controller checkout for every manual invocation in an
active phase. The target workspace may change; the controller must not. When
Harness dogfoods itself, run the controller from a separate fixed checkout (or
the shim that points to that checkout) and treat the implementation checkout
as the mutable target. Upgrade the controller only between phases or after the
active phase is explicitly closed.

Triage is the first action slice: `triage.requested` invokes
`triageWorkItem`; the terminal `triage.work_item.completed` event records the
route and durable evidence refs. Progress is always emitted to stderr after
the action is known. `step:start`, periodic `step:heartbeat`, and `step:end`
telemetry is always persisted in the action run; `--verbose` also forwards it
to stderr. Heartbeats are telemetry, not lifecycle events.

Use this guide when operating or changing the current factory flow. The factory
is local and explicit today: one command handles one work item. Future tracker
or event backends should call the same typed action coordinator instead of
replacing its state or transition logic.

## Command Model

`harness factory` commands are operator-facing station commands:

```bash
harness factory status --workspace /path/to/repo
harness factory inspect --workspace /path/to/repo --linear-issue TEAM-123
harness factory linear list --status intake --workspace /path/to/repo
harness factory linear fetch TEAM-123 --workspace /path/to/repo
harness factory linear create --workspace /path/to/repo --title "Example" --body "Details"
harness factory triage --workspace /path/to/repo --item-file work-item.json
harness factory triage --workspace /path/to/repo --linear-issue TEAM-123
harness factory planning continue --workspace /path/to/repo --item-file work-item.json --decision revise --response-file /absolute/path/response.md
harness factory implementation run --workspace /path/to/repo --item-file work-item.json
harness factory implementation continue --workspace /path/to/repo --item-file work-item.json --decision re-review --response-file /absolute/path/response.md
```

There is no batch dispatch command. Run an explicit station for an explicit
work item while this surface is still local-first.

## Durable work-item inspection

Use `harness factory inspect` to reconstruct one work item without advancing
it:

```bash
harness factory inspect --workspace /path/to/repo --linear-issue TEAM-123
harness factory inspect --workspace /path/to/repo --item-file work-item.json
```

Exactly one selector is required. Item files are parsed only to derive the
durable key; their mutable fields never replace lifecycle truth. Linear input
accepts human identifiers such as `TEAM-123`, normalizes the durable key, and
performs no Linear request or API-key/configured-tracker lookup. Opaque Linear
UUIDs are rejected with a store-only explanation.

The output is one deterministic JSON object in this order:

```json
{
  "workItemKey": "linear:TEAM-123",
  "artifactRoots": {
    "repository": "/path/to/repo",
    "factory-store": "/path/to/factory-project"
  },
  "state": {},
  "latestEvent": {},
  "reaction": {}
}
```

`state` is reduced from canonical lifecycle JSONL. `latestEvent` is the
verbatim latest event, including every artifact reference as `{ base, path,
sha256 }`; inspection does not crawl or inline those artifacts. With no
history, `state`, `latestEvent`, and `reaction` are all `null`. The two roots
resolve `repository` and `factory-store` references once. Unchanged repeated
inspection produces byte-identical stdout, with no volatile fields, and does
not create markers, locks, projections, or lifecycle events.

The reaction is the same pure Factory decision used by station commands. When
the next station is mechanically selectable, it includes the exact command
with the original selector, workspace, and explicit store overrides. Linear
commands include `--apply` because they must preserve the station's projection
boundary. Human, plan-merge, complete, failed, stale-event, and null reactions
remain commandless.

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
  "labels": ["bug"]
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

New Factory state is projected only from the strict action event log. Triage,
planning, and implementation append their request, candidate, review,
continuation, and publication events; `factory.action.failed` records action failure. Legacy
station event names and `factoryStage` fields are not transition inputs.

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
    "planning": {
      "roles": {
        "planner": { "agent": "codex", "model": "gpt-5.6-sol" },
        "reviewer": { "agent": "codex", "model": "gpt-5.6-sol" }
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
        "readyForReview": "Ready for Review",
        "implementationFailed": "Implementation Failed",
        "done": "Done",
        "triaging": "Triaging",
        "planning": "Planning",
        "triageFailed": "Triage Failed",
        "planningFailed": "Planning Failed"
      }
    }
  }
}
```

`done` is required for implementation merge completion. Optional terminal keys
`canceled` and `duplicate` may be added under `statuses` when operator tools
like `linear-cli` or `factory linear list` should target those board states by
key.

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

- `phase`: the current lifecycle slice: `triage`, `planning`, or `implementation`.
- `role`: configured responsibility such as `triager`, `planner`, `reviewer`, or
  `implementer`.
- `handler`: one action selected by the persisted Factory reaction.
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

When `projectId` is configured, list, fetch, and every Linear-backed Factory
phase reject issues outside that project before running action work or mutating
Linear. Local `--item-file` inputs are not revalidated against Linear.

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
- `factory-triage.stream.jsonl`: raw provider telemetry; may contain provisional or
  schema-shaped progress messages
- `factory-triage.raw.json`: complete provider result, including stream summary
- `factory-triage.json`: canonical, validated triage decision; only this artifact
  drives routing
- `factory-route.json`: canonical deterministic reaction to the validated decision
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
plan review actions. Before the first review, `revise` is the only continuation
choice and replaces the candidate through the original producer session. A
non-pass review, or a non-retryable action failure that retains a valid
candidate, waits for `planning continue`. Choose `revise` to resume the original
planner session from that candidate, or `re-review` to run the reviewer again
against the same bytes without invoking the planner. The required absolute
response file must be nonblank UTF-8 of at most 32 KiB; Harness copies and
hashes it under the phase run and binds it to the exact candidate and optional
review. Recording the continuation invokes no handler and makes no Linear
projection. Run the printed `planning run` command later to execute exactly the
chosen action. `--rerun` starts a fresh phase only after a failure with no
reusable candidate. Item files publish approved plans locally; Linear
starts and reruns require `--apply`, then wait for explicit `planning publish`
and `mark-plan-merged`. Publish derives the reviewed plan and deterministic
branch; it accepts no PR URL or plan path. It pushes the exact commit, finds or
creates the PR, and records `plan_pr.opened`. Merge acknowledgement requires a
local commit containing that head before recording `plan_pr.merged`. Factory validates and appends the planning request
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

Before the first review, `revise` is the only continuation choice and replaces
the candidate through the original implementer session. Run the exact printed
command again to review instead. The review invocation verifies the
candidate evidence and live tree, then runs the fixed full implementation and
quality reviewers once. Reviewers are read-only and review the cumulative
original-base-to-candidate diff. A non-pass result preserves the candidate and
waits at `awaiting-continuation`; a non-retryable action failure with a valid
retained candidate uses the same wait. Neither schedules a producer by itself.
Record the operator decision explicitly:

```bash
harness factory implementation continue \
  --workspace /path/to/repo \
  --linear-issue TEAM-123 \
  --decision revise \
  --response-file /absolute/path/response.md
```

Use `revise` when code or plan bytes must change. Its later `implementation
run` invocation verifies the prior candidate and complete digested findings,
resumes the effective implementer session, retains the original base, and
publishes a distinct immutable candidate. Use `re-review` when accepted
operator or live evidence resolves the review without a source change. Its
later invocation runs the reviewers against the exact existing commit/tree and
does not invoke the implementer. Both choices use a nonblank absolute UTF-8
response file of at most 32 KiB; Harness copies its exact bytes into the durable
store and hashes and binds it to the candidate and optional review. `continue`
itself invokes no provider/reviewer and performs no Linear projection.
The response may supply accepted clarification or evidence within the immutable
work item; it cannot expand or override that authority.

Pass CAS-advances only the exact reviewed candidate, leaves a clean worktree, and enters
`awaiting-pr-publication`. `implementation publish` pushes that unchanged
branch, finds or creates its PR, and records `implementation_pr.opened`.
`awaiting-pr-merge` is a hard human gate: stop and report the PR. Opening or
delivering a PR never authorizes merge. After a human merge is available
locally, `implementation mark-pr-merged --url <url> --commit <sha>` requires the
reviewed head as an ancestor, records `implementation_pr.merged`, and completes
the phase. Neither command runs providers, reviewers, polling, or merge. Blocked or
failed review waits for a human; no non-pass advances the branch. There is no
separate accept command or standalone post-candidate `harness run change-review`
step. `--rerun` may start a fresh phase only after human/failed state when no
valid candidate is retained. It is not a continuation or candidate-abandonment
mechanism.

Linear starts and reruns require `--apply`. A failed start projection repairs
the same durable request on the next explicit apply without provider work.
Candidate, review, and continuation keep Implementing. Publication `--apply` moves Implementing to
Ready for Review and writes one PR comment. Merge acknowledgement `--apply`
repairs a missing publication projection first, then moves Ready for Review to
Done and writes one completion comment. Non-pass adds an attention comment;
terminal failure projects Implementation Failed. Retries deduplicate lifecycle
facts and comments.

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
- mutating GitHub outside explicitly authorized plan/implementation publication,
  or mutating Jira or Inngest from current station commands
- mutating Linear outside documented `harness factory linear create` or an
  explicitly authorized `--linear-issue ... --apply` invocation of Factory
  triage, planning run/publication/merge acknowledgement, or implementation
  run/publication/merge acknowledgement
- committing `.harness/runs/*`
- overwriting an existing final plan
