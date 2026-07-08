# Architecture

## Runtime flow

```text
CLI (bin/harness.ts)
  -> workspace/config resolution (lib/config.ts, harness.json)
  -> workflow context (lib/workflow-context.ts, lib/factory-run-context.ts, or lib/factory-planning-run-context.ts)
  -> provider selection (providers/registry.ts and provider adapters)
  -> workflow definition (workflows/*.workflow.ts)
  -> artifacts (.harness/runs/reviews/<run-id>/ or .harness/runs/factory/<run-id>/)
```

Current public CLI surfaces:

- `harness init`
- `harness factory status`
- `harness factory linear list`
- `harness factory linear fetch`
- `harness factory triage`
- `harness factory planning`
- `harness run change-review`
- `harness run factory-triage`
- `harness run plan-review`
- `harness runs prune`
- `harness models`
- `harness skills install`

## Harness repo responsibilities

The harness repo owns the reusable workflow system:

- `bin/` - CLI entrypoints.
- `lib/` - config, context, schemas, prompts, aggregation, events, runs, and
  skill installation helpers.
- `providers/` - Cursor and Codex provider adapters plus `providers/registry.ts`.
- `workflows/` - callable workflow definitions and shared review-step execution.
- `skills/` - packaged skills that can be installed into target repos.
- `.agents/skills/` - repo-local development skills for this checkout.
- `automations/` - background task definitions.
- `schemas/` - exported JSON schema artifacts.
- `scripts/` - local helper scripts such as the dist smoke test and Make gate
  output runner (`scripts/run-gate-step.ts`).
- `dev/plans/` - active plans and handoffs.

Prompt templates live under `lib/prompts/`. Review prompts are loaded through
`lib/workflow-context.ts`; factory triage uses `lib/factory-run-context.ts`;
factory planning uses `lib/factory-planning-run-context.ts`.

Runtime Zod validation lives in `lib/schemas.ts` for reviews and
`lib/factory-schemas.ts` for factory intake and
`lib/factory-planning-schemas.ts` for factory planning. `schemas/` owns
exported JSON schema artifacts such as `factory-triage-output.schema.json` and
`factory-planning-output.schema.json`. Changes to one side may require checking
the other.

## Target repo responsibilities

Target repositories own their local harness state:

- `harness.json` for repo-local defaults.
- `.harness/bin/harness` as an ignored shim written by `harness init`.
- `.harness/inbox/factory/*.json` for local factory intake queue items.
- `.harness/runs/reviews/<run-id>/` for review artifacts.
- `.harness/runs/factory/<run-id>/` for factory intake artifacts.
- local `.agents/skills/` installs when a target repo chooses to install skills.

Target repositories also own their project docs, source code, tests, CI, and
final gates. Harness can invoke workflows against them, but it does not own
their product decisions.

## Major source areas

`bin/harness.ts` defines the CLI and routes commands into runtime helpers.

`lib/config.ts` resolves the workspace, reads `harness.json`, defaults base to
`main`, defaults the provider to Cursor, resolves provider config, and writes
target-repo shims during `harness init`.

`lib/context.ts` supplies git-scope and context-artifact helpers invoked by the
workflow context. When git scope is included, it prepares the merge-base diff
and writes `context/diff.patch`. It also copies plan and handoff inputs under
`context/` and builds prompt reference sections for plan, diff, and handoff
inputs.

`lib/aggregate.ts` computes aggregate review verdicts from reviewer outputs.

`lib/workflow-context.ts` creates run directories, honors the caller's
`includeGitScope` setting, wires providers, selects reviewer prompts, exports
prompts and reviewer JSON, writes metadata and summaries, emits events, and
cleans up orphaned run directories. CLI and workflow entrypoints choose whether
git scope is included for each workflow.

`lib/factory-run-context.ts` creates local file-backed factory triage runs,
copies `context/work-item.json`, resolves the harness-owned factory triage JSON
schema, invokes the selected provider, and writes route artifacts. It does not
include git diff scope and does not mutate trackers.

`lib/factory-triage-input.ts` owns shared factory work-item input handling.
Station commands use it to validate the mutually exclusive `--item-file` and
`--linear-issue` input contract before role/config resolution, then resolve file
reads or Linear fetches after station settings are known.

`lib/factory-planning-input.ts` owns planning-specific work-item input guards.
Linear-backed planning input accepts issues mapped to `ready-to-plan`,
`plan-needs-human`, `plan-review-unresolved`, or `planning-failed` before
creating a planning run. Planning-attention `Needs Clarification` issues are
identified by the latest factory planning marker. Item-file planning remains
manual/local and is not gated by Linear tracker metadata.

`lib/factory-planning-run-context.ts` creates local file-backed factory planning
runs, copies `context/work-item.json`, resolves the harness-owned planning JSON
schema, prepares `planning/draft.md` for planner writes, snapshots
per-iteration planner artifacts, writes `factoryMetadata` into `meta.json`, and
writes an approved final plan under `dev/plans/` when the planning station
finishes successfully. Tracker-backed plans should be published through a plan
PR before tracker status moves to `Ready to Implement`.

`lib/factory-planning-handoff.ts` owns planning handoff metadata helpers:
loading validated planning `meta.json`, rendering planning summaries, patching
plan PR and merge metadata, and validating approved-plan metadata for future
implementation stations.

`lib/factory-inbox.ts` owns local factory inbox inspection. `harness factory
status` reads `.harness/inbox/factory/` without moving files or creating runs.

`lib/factory-linear-adapter.ts` owns Linear issue import and explicit station
apply updates. `lib/factory-linear-list.ts` owns read-only status-key listing,
query pagination, and lightweight summary mapping behind the adapter facade.
`lib/factory-linear-planning-apply.ts` owns planning run apply markers,
target-status mapping, comments, and mutation helpers.
`lib/factory-linear-planning-handoff.ts` owns planning publication apply
guards, comments, and status movement for plan PR and merge handoff commands.
`harness factory linear list --status intake` validates `factory.linear` status
mapping, queries the configured team and optional project scope, and prints
lightweight issue summaries for configured status keys. `harness factory linear
fetch TEAM-123` reads one Linear issue through `@linear/sdk` and prints a
normalized `FactoryWorkItem` JSON object with description, labels, and recent
comments. Linear team owns the issue key and workflow statuses;
`factory.linear.projectId`, when set, scopes issues to the target repo project.
`harness factory triage --linear-issue TEAM-123` uses the same adapter as an
input source before running the station. List, fetch, and default Linear-backed
triage do not mutate Linear. `harness factory triage --linear-issue TEAM-123
--apply` additionally moves the issue to `Triaging`, then to the terminal
triage status, and writes a marker comment.

`harness factory triage --item-file ...` or
`harness factory triage --linear-issue ...` runs one work item through the
station-level triage command and uses `factory.triage.roles.triager` config for
agent and model selection.

`harness factory planning run --item-file ...` or
`harness factory planning run --linear-issue ...` runs one work item through the
station-level planning command and uses `factory.planning.roles.planner` and
`factory.planning.roles.reviewer` config for agent and model selection.
Linear-backed planning input performs a live read. With `--apply`, it moves
`Needs Plan`, planning-attention `Needs Clarification`, `Plan Needs Review`, or
`Planning Failed` to `Planning`, runs the planning loop, then posts one outcome
comment. Human questions move to `Needs Clarification`, unresolved reviews move
to `Plan Needs Review`, and station/runtime failures move to `Planning Failed`.
It does not move issues to `Ready to Implement`.
`harness factory planning --item-file ...` and
`harness factory planning --linear-issue ...` remain default-subcommand aliases
for the run command. `harness factory planning publish` and
`harness factory planning mark-plan-merged` update local planning run metadata.
Without `--apply`, they print suggested Linear comment text only. With
`--linear-issue ... --apply`, they validate the Linear issue and configured
status, post marker comments, and move `publish` to `Plan Needs Review` or
`mark-plan-merged` to `Ready to Implement`. They do not open PRs or inspect
GitHub merge state.

`workflows/change-review.workflow.ts` runs the default review set:
implementation, quality, and simplify. Full default runs execute these
reviewers in parallel, then results are aggregated in workflow order. Callers
may request a subset of reviewers.

`workflows/factory-triage.workflow.ts` runs one factory triage step. The agent
returns structured triage JSON; deterministic harness code maps that output to
one route plan. Current input is `--item-file`; future GitHub, Linear, Jira, or
orchestrator adapters should feed the same `FactoryWorkItem` contract.

`workflows/factory-planning.workflow.ts` runs one planning station loop. The
planner writes/edits the run draft file and returns small structured metadata.
Harness snapshots the draft, runs `plan-review` against that snapshot, guards
against tracked source edits during planner turns, and reuses the captured
planner session for revisions until the plan is approved, needs human input,
fails, or reaches the review-iteration limit.

`workflows/plan-review.workflow.ts` runs one fixed spec-review step. The
plan-review command/runtime omits git diff scope and relies on `context/plan.md`
plus optional `context/handoff.md`.

`workflows/review-steps.ts` is the shared review runner for workflow steps,
current parallel review execution, test-only serial execution, step events,
failure aggregation, and export metadata.

`providers/registry.ts` creates the selected provider adapter. Provider
adapters under `providers/cursor/` and `providers/codex/` implement invocation.
Workflows should stay provider-agnostic.

## Review artifact lifecycle

Each review run creates `.harness/runs/reviews/<run-id>/` under the selected
workspace or explicit runs directory.

Common artifacts include:

- `summary.md`
- `meta.json`
- reviewer prompt files
- structured reviewer JSON
- raw provider artifacts
- stream artifacts when the provider emits them
- `events.jsonl` when events are available

Context artifacts live under `context/`:

- `context/plan.md` when a plan is supplied.
- `context/handoff.md` when a handoff file path or stdin handoff text is
  supplied via CLI options.
- `context/diff.patch` for `change-review` when git diff scope is included.

`plan-review` depends on `context/plan.md`. `change-review` includes git diff
scope by default and may also include a plan or handoff.

## Factory artifact lifecycle

Each factory station run creates `.harness/runs/factory/<run-id>/` under the
selected workspace or explicit runs directory.

Factory triage artifacts include:

- `context/work-item.json`
- `factory-triage.prompt.md`
- `factory-triage.raw.json`
- `factory-triage.json`
- `factory-route.json`
- `factory-route.md`
- `summary.md`
- `meta.json`
- `events.jsonl` for live runs

`--dry-run` writes placeholder triage and route artifacts but does not invoke a
provider and does not write `events.jsonl`.

Factory planning artifacts include:

- `context/work-item.json`
- `planning/draft.md`
- `iterations/<n>/planner.prompt.md`
- `iterations/<n>/planner.raw.json`
- `iterations/<n>/planner.json`
- `iterations/<n>/plan.md` when the planner produced a draft
- `iterations/<n>/plan-review-ref.json` when a review ran
- `iterations/<n>/review-findings.json` when review findings need revision
- `summary.md`
- `meta.json`
- `events.jsonl` for live runs

Live planning runs create nested plan-review runs under
`.harness/runs/reviews/<run-id>/`. When a plan is approved, the station writes
the final tracked plan file under `dev/plans/`. Tracker-backed flows should
publish that file through a plan PR before implementation starts. `--dry-run`
writes placeholder planning artifacts but does not invoke providers or reviewers
and does not write `events.jsonl`.

Planning `meta.json` includes `factoryMetadata` with reserved handoff keys such
as `tracker`, `factoryRoute`, `factoryNextAction`, `factoryStage`,
`factoryRunId`, `approvedPlanPath`, `approvedPlanPrUrl`, and
`approvedPlanCommit`. Tracker-backed approved plan filenames should use the
tracker key, for example `dev/plans/FER-123.md`; local/manual items fall back to
title-derived slugs. Tracker-backed planning approval records
`factoryStage: "plan-pr-open"` until the plan PR URL and merge commit are
registered through the planning publication commands.

## Factory inbox lifecycle

Local factory inbox items live under `.harness/inbox/factory/*.json`. Each
pending file must parse as a `FactoryWorkItem`.

Current inbox paths:

- `.harness/inbox/factory/*.json` for pending items.
- `.harness/inbox/factory/processed/*.json` for historical processed items from
  earlier experimental batch runs.
- `.harness/inbox/factory/failed/*.json` for historical failed items.
- `.harness/inbox/factory/failed/<run-id>-<basename>.error.json` for failure
  summaries.

`harness factory status` is read-only and reports pending, processed, and failed
state as JSON. Current factory station commands do not batch-process every inbox
file or move inbox files.

See [Factory operation](./factory.md) for the current one-item operator flow,
role config examples, artifact references, and future GitHub/Linear/Inngest
boundary.

## Provider boundary

Provider-specific auth, model, streaming, and sandbox behavior should stay in
provider adapters or provider-scoped config. Workflow definitions should depend
on the shared review interface, not on provider implementation details.
`lib/config.ts` resolves provider selection and defaults. Factory station roles
use `harness.json` `factory.<station>.roles` config with the same provider
identifiers as top-level harness config, such as `cursor` and `codex`.
`resolveFactoryRoleAgent` falls back through `defaultAgent` and
`agents.<provider>`, and `providers/registry.ts` instantiates the selected
adapter.

## What is not in this map yet

Active runtime roadmap items such as `steps.json`, graders, tracker mutation
beyond explicit Linear triage/planning apply modes, GitHub/Jira adapters,
hosted trigger inboxes, and Inngest are future work. Linear-backed triage and
planning input plus their explicit status/comment mutation via `--apply` are
current. Future items should be added to this map only after they describe
current behavior in the repo.
