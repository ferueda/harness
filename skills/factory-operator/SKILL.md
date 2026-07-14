---
name: factory-operator
description: Operate the manually stepped harness Factory flow through status, Linear intake, triage, planning, implementation candidates, aggregate review, projection repair, and human restarts. Use for running or inspecting one Factory work item, its next reaction, durable evidence, Linear boundary, or stop condition.
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
next reaction. Planning is shipped as separately invoked candidate, review,
and publication commands. Implementation is separately invoked candidate,
review, and (when needed) same-session revision; repeat only the exact printed
command. Routed
triage can return a wait reaction without a command. The invocation never
executes a second handler. If `next.kind` is `wait`, stop and follow its reason.

Operate the current local harness factory one work item at a time.

Use the same fixed Harness controller checkout for every command in one active
phase. When dogfooding Harness itself, invoke the controller from a separate
fixed checkout (or its shim) and pass the mutable implementation checkout as
`--workspace`. Do not let changes in the target replace the running CLI between
manual actions. Upgrade the controller only after the phase closes or before a
new phase starts.

## Waiting For Station Runs

Factory triage commands
stay synchronous. Prefer one Shell invocation with a long enough
`block_until_ms`, then wait for process exit. Do **not** poll with repeated
AwaitShell or status checks while the command is running.

After action identity selection, live triage emits exactly one always-on stderr
JSON progress line:

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

It is CLI progress only — not a lifecycle event. Final stdout adds `outcome`,
`phase`, `phaseRunId`, the completed `action`, and `next`. Dry-run has no
durable action and emits a separate context-only record:

```json
{
  "harnessFactory": "run-started",
  "station": "triage",
  "runId": "...",
  "runDir": "...",
  "workspace": "..."
}
```

Optional: background the command only when needed, parse that one progress
line, then wait once for completion. After exit, trust stdout JSON and read
`summary.md` / `meta.json` for narrative. Do not treat mid-run `runDir`
contents as terminal success.

## Durable Store

Factory lifecycle JSONL, rebuildable state, and triage action evidence default
to
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
harness factory implementation run --workspace /path/to/repo --item-file work-item.json
harness factory implementation run --workspace /path/to/repo --linear-issue TEAM-123 --apply
```

Live is the default. Use `--dry-run` only to verify command wiring and artifact
layout — not for classification. Dry-run skips the triager
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
    "implementation": {
      "maxReviewIterations": 3,
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
(`canceled`, `duplicate`) may be added under `factory.linear.statuses` when
operator list/move tools need those board states.

The schema requires the downstream status names shown above. Planning and
implementation use configured statuses for explicit Linear boundary projections.

- `station`: the current lifecycle step, `triage`, `planning`, or `implementation`.
- `role`: the configured station job, including implementation `implementer` and `reviewer`.
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
tracker metadata. Fetch does not read or initialize Factory state. Linear
status never becomes a Factory transition input.
`teamKey` owns issue identifiers and
statuses; `projectId` scopes the target repo. Redirect the output to an item
file for inspection, or pass the issue directly to triage with
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
terminal projection recovery also accepts the already-idempotent matching
terminal status. Apply never overwrites an intervening human or external
status. A first dry-run writes no completion and its next live command needs no
override; an overridden dry-run over completed history still requires
`--rerun` for the later live command.

If terminal projection fails after the local terminal event, inspect
`summary.md` and `meta.json`, then invoke triage again with explicit `--apply`.
Harness validates durable terminal evidence and retries only the idempotent
projection; it does not rerun the provider.

Routes:

- `ready-to-implement`
- `ready-to-plan`
- `needs-info`
- `wait-to-implement`

Read the run `summary.md`, `factory-triage.json`, and `factory-route.md` before
acting on the reaction.

Live triage appends `work_item.imported`, `triage.requested`, and one terminal
action event in the durable factory store. Dry-run does not mutate lifecycle
state. The strict state projection and pure next-reaction function own machine
progress; Linear status/comments remain human board projections.

## Planning

Run `harness factory planning run` once per printed reaction. Stop on human,
failed, plan-publication, plan-merge, or approved waits. Invoke `planning
publish` only after explicit publication authorization; planner sessions stay
credential-free. Stop and report the PR. Opening or delivering a PR never
authorizes merge. Only after a human merges that recorded PR, fetch the merge
commit and run `mark-plan-merged --url <url> --commit <sha>`. Review-driven revisions stay in the
phase and resume the saved planner session; use `--rerun` only after human or
failed waits. Item files materialize locally after review pass. Linear issues
require `--apply` for planning start and rerun, then explicit `planning publish`
and `mark-plan-merged`. The durable planning request precedes its Linear
projection; if projection fails, repeat that command with `--apply` to repair
the same request before provider work. Pass `--apply` on each later command
that should project a wait boundary. Never infer action progress from Linear
status or comments.

## Implementation

Run `harness factory implementation run` once. A new phase requires a clean
attached branch and durable direct readiness or an approved plan already
committed at HEAD. For pull-request plans, pull the recorded merge first.

The first invocation runs only `produceImplementationCandidate`. Wait for
process exit; provider completion has no default timer, so heartbeat telemetry
can continue while the synchronous command is healthy. Harness records one
immutable candidate commit and attempt ref without moving HEAD or the real
index. Inspect `candidate-evidence.json`, the diff, workspace facts, and
`action-result.json` under the reported action directory.

Run the exact command printed in `next` again. That invocation runs only
`reviewImplementationCandidate`: the fixed implementation and quality
reviewers, read-only, once, against the cumulative original-base diff. Do not
run a separate `harness run change-review`. Pass promotes the exact reviewed
candidate, finishes clean, and waits at `awaiting-pr-publication`. Invoke
`implementation publish` only with explicit phase publication authority. It
pushes the exact reviewed branch and finds or creates one PR; the implementer
session receives no GitHub credentials. Stop at `awaiting-pr-merge` and report
the PR. Do not merge it. Only after a human explicitly merges that recorded PR,
fetch the merge commit and run `implementation mark-pr-merged --url <url>
--commit <sha>`. A `needs_changes`
verdict below the persisted `maxReviewIterations` ceiling prints a later
`produceImplementationCandidate` command; it does not run it. That producer
reopens the same phase, verifies `review-evidence.json` and
`blocking-findings.json`, resumes the effective implementer session, retains
the original base, and publishes a new immutable attempt ref. Inspect those
files plus each `candidate-evidence.json`, diff, `action-result.json`, and
`context/phase-run.json` before intervening. Blocked or exhausted review waits
for a human. Before review, `--rerun` may intentionally abandon the produced
candidate only with accepted bounded clarification:

```bash
harness factory implementation run --workspace /path/to/repo --linear-issue TEAM-123 --apply --rerun --rerun-guidance-file /absolute/path/restart-guidance.md
```

The UTF-8 file must be nonblank and at most 32 KiB. Keep it outside the target
workspace. Harness copies the exact bytes into
`context/restart-guidance.md`, binds its hash to the durable restart request,
and gives the same clarification to the fresh producer and all later
reviewers/revisions in that phase. Guidance may clarify acceptance or
verification but cannot override or materially expand the work item; retriage
a scope change instead. The abandoned ref and evidence remain immutable. Rerun
after human/failed state uses no guidance and rejects the guidance option.
Every rerun creates a fresh phase/profile/session/input snapshot; it is not a
revision path.

Linear implementation start/restart requires `--apply`. Repeat an explicit
apply command to repair a failed start or terminal/comment projection; after a
guided restart request is durable, omitted guidance reuses the persisted
artifact and supplied guidance must match it exactly. Harness reuses durable
state and never appends a duplicate request or reruns the prior handler.
Candidate/review remain Implementing. Publication `--apply` moves to
Ready for Review; merge acknowledgement `--apply` moves to Done. Non-pass adds
an attention comment, and terminal failure moves to Implementation Failed.

## Artifacts

Factory run root:

```text
${XDG_DATA_HOME:-~/.local/share}/harness/store/projects/<repo-id>/runs/factory/<run-id>/
```

Read `summary.md` and `meta.json` first. Lifecycle truth lives under durable
`factory/events/*.jsonl`; `factory/state/*.json` is a rebuildable cache.
`context/phase-run.json` fixes the work-item, workspace, store/project, phase,
and phase-run identity. The hashed
`actions/<attempt>/triageWorkItem/<action-key>/action-result.json` is immutable
terminal recovery evidence; do not edit either file.
Durable store contents are user data; do not commit workspace `.harness/runs/*`
or legacy `.harness/factory/*`.

## Stop Conditions

Stop before proceeding if the task requires:

- running or restoring `harness factory dispatch`
- batch-moving every inbox item
- mutating GitHub except through an explicitly authorized phase publication
  command; mutating Jira or Inngest
- mutating Linear outside documented `harness factory linear create` or explicit
  `harness factory <triage|planning|implementation> ... --linear-issue ... --apply`
- committing `.harness/runs/*`
