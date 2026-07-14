# Architecture

## Runtime flow

```text
CLI (bin/harness.ts)
  -> workspace/config resolution (lib/config.ts, harness.json)
  -> workflow context (lib/workflow-context.ts or lib/factory-run-context.ts)
  -> provider selection (providers/registry.ts and provider adapters)
  -> workflow definition (workflows/*.workflow.ts)
  -> artifacts (.harness/runs/reviews/<run-id>/ or durable factory store runs/<run-id>/)
```

Current public CLI surfaces:

- `harness init`
- `harness factory status`
- `harness factory inspect`
- `harness factory linear list`
- `harness factory linear fetch`
- `harness factory linear create`
- `harness factory triage`
- `harness factory planning run`
- `harness factory planning publish`
- `harness factory planning mark-plan-merged`
- `harness factory implementation run`
- `harness factory implementation publish`
- `harness factory implementation mark-pr-merged`
- `harness run change-review`
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
- `skills/` - packaged skills that can be installed into target repos,
  including manual-only design/research helpers such as `architect`.
- `.agents/skills/` - repo-local development skills for this checkout.
- `automations/` - background task definitions.
- `schemas/` - exported JSON schema artifacts.
- `scripts/` - local helper scripts such as the dist smoke test and Make gate
  output runner (`scripts/run-gate-step.ts`).
- `dev/plans/` - active plans and handoffs.

Prompt templates live under `lib/prompts/`. Review prompts are loaded through
`lib/workflow-context.ts`; Factory actions use immutable phase contexts and the
durable action kernel. Implementation candidates materialize through a
temporary Git index and are reviewed by recorded commit SHA.
Phase-specific publication handlers share a bounded Git/`gh` publisher. Git
commits remain artifact truth; Factory opened/merged events remain lifecycle
truth; GitHub and Linear are retryable human-facing projections. Publication
may push/find-or-create one deterministic PR but cannot merge it.

Runtime Zod validation lives in `lib/schemas.ts` for reviews and
`lib/factory-schemas.ts` for factory intake and triage. `schemas/` owns
exported JSON schema artifacts such as `factory-triage-output.schema.json`.
Changes to one side may require checking the other.

## Target repo responsibilities

Target repositories own their local harness state:

- `harness.json` for repo-local defaults.
- `.harness/bin/harness` as an ignored shim written by `harness init`.
- `.harness/inbox/factory/*.json` for local factory intake queue items.
- `.harness/runs/reviews/<run-id>/` for review artifacts.
- local `.agents/skills/` installs when a target repo chooses to install skills.

The durable factory store owns
`${XDG_DATA_HOME:-~/.local/share}/harness/store/projects/<repo-id>/factory/`
for lifecycle JSONL/state/locks and its `runs/factory/` and `runs/reviews/`
directories for factory-owned evidence. Existing workspace-local
`.harness/factory` is legacy state: status reports it, but v1 does not merge it.

Target repositories also own their project docs, source code, tests, CI, and
final gates. Harness can invoke workflows against them, but it does not own
their product decisions.

### Durable factory-store boundary

Factory lifecycle JSONL/read-model state and factory-owned run evidence live in
`${XDG_DATA_HOME:-~/.local/share}/harness/store/projects/<repo-id>/` by
default. The target repository remains the execution sandbox and Git
materialization point: it will continue to own its shim, inbox, source, tests,
`harness.json`, and committed plans/code.

Standalone `harness run change-review` and `harness run plan-review` artifacts
remain workspace-local by default under `.harness/runs/reviews/`. The durable
store applies only to factory continuity and factory-owned evidence.

## Major source areas

`bin/harness.ts` defines the CLI and routes commands into runtime helpers.

`lib/factory-inspect.ts` is the reusable Harness-owned read boundary for one
canonical work-item key. It reads canonical lifecycle JSONL in an explicit
non-mutating mode, reduces state with the Factory state machine, selects the
latest event, and computes the existing pure reaction. `bin/factory-manual-command.ts`
adds selector-aware manual commands to that reaction and to station output;
it does not alter state or events.

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
reads or Linear fetches after station settings are known. Linear tracker
metadata is input only; fetch never derives Factory state.

`lib/factory-lifecycle-events.ts`, `lib/factory-lifecycle-kernel.ts`, and
`lib/factory-state-machine.ts` own the strict action event contract, expected-
cursor append, and rebuildable state/reaction projection. Durable-store
`factory/events/*.jsonl` is canonical machine state; `factory/state/*.json` is
an atomically published projection protected by per-work-item locks. Triage,
planning, and implementation append strict request and terminal action events;
`factory.action.failed` records action failure.

Planning candidate/review/publication and implementation candidate/review
actions use this kernel through manually stepped CLI commands. No current CLI
path falls back to the removed lifecycle.

`lib/factory-inbox.ts` owns local factory inbox inspection. `lib/factory-status.ts`
composes that inbox data with durable-store, lock, and legacy-state inspection
for `harness factory status`; status remains read-only and never creates runs.
`lib/factory-store.ts` resolves project-scoped durable paths and store
provenance, while `lib/factory-locks.ts` owns lifecycle lock acquisition and
non-blocking inspection.

`lib/factory-linear-adapter.ts` owns Linear issue import, constrained intake
create, and explicit station apply updates. `lib/factory-linear-list.ts` owns
read-only status-key listing, query pagination, and lightweight summary mapping
behind the adapter facade. `lib/factory-linear-create.ts` owns constrained
intake issue creation behind the same adapter facade.
`harness factory linear list --status intake` validates `factory.linear` status
mapping, queries the configured team and optional project scope, and prints
lightweight issue summaries for configured status keys. `harness factory linear
fetch TEAM-123` reads one Linear issue through `@linear/sdk` and prints a
normalized `FactoryWorkItem` JSON object with description, labels, and recent
comments. `harness factory linear create` creates one configured-project intake
issue and prints compact JSON; it does not write lifecycle events or factory
run artifacts. Linear team owns the issue key and workflow statuses;
`factory.linear.projectId`, when set, scopes issues to the target repo project
and is required for create. Linear status and recent comments remain tracker
metadata; fetch does not derive Factory state.
`harness factory triage --linear-issue TEAM-123` uses the same adapter as an
input source before running the station. List, fetch, and default Linear-backed
triage do not mutate Linear. Create is the only non-station Linear
issue-creation path; other Linear writes stay on explicit phase-command
`--apply` boundaries.
`harness factory triage --linear-issue TEAM-123 --apply` additionally moves the
issue to `Triaging`, then to the terminal triage status, and writes a marker
comment.
Apply retains its entry-status allowlist and permits only an already-idempotent
matching terminal state during recovery. It does not overwrite an intervening
human or external status.

`harness factory triage --item-file ...` or
`harness factory triage --linear-issue ...` runs one work item through the
station-level triage command and uses `factory.triage.roles.triager` config for
agent and model selection.

Planning and implementation candidate/review commands consume the same action
kernel, one handler per invocation. Review-driven revisions reuse the
snapshotted producer profile and original session, retain the original base,
and publish a new immutable attempt ref. The next producer reaction is guidance
for a later manual invocation. A pre-review `--rerun` instead creates a fresh
phase and requires accepted restart guidance. The CLI file is only transport:
Harness copies its bounded bytes into the phase, binds the artifact ref to the
existing `implementation.requested` restart event, and supplies the verified
artifact to both producer and reviewers. Future Inngest execution can provide
the same domain artifact without copying CLI semantics. Human/failed reruns do
not add guidance. Inngest remains only a future consumer of these reactions.

`workflows/change-review.workflow.ts` runs the default review set:
implementation and quality. The quality reviewer covers behavior-preserving
clarity, simplicity, conventions, and maintainability. Full default runs execute these
reviewers in parallel, then results are aggregated in workflow order. Callers
may request a subset of reviewers. Reviewer blockers stay tied to the original
task: acceptance gaps, hard-invariant violations, regressions introduced or
worsened by the diff, or required behavioral proof. Pre-existing debt and
nearby cleanup do not block acceptance. Every reviewer must pair
`needs_changes` with a `must_fix` finding and `pass` with no `must_fix`
findings. The coordinator owns targeted follow-ups and the three-run limit; a
partial run covers only its requested roles.

`workflows/factory-triage.workflow.ts` runs one factory triage step. The agent
returns structured triage JSON; deterministic harness code maps that output to
one route plan. Current input is `--item-file` or `--linear-issue`; future
GitHub, Jira, or orchestrator adapters should feed the same `FactoryWorkItem`
contract.

`workflows/plan-review.workflow.ts` runs one fixed spec-review step. The
plan-review command/runtime omits git diff scope and relies on `context/plan.md`
plus optional `context/handoff.md`.

`workflows/review-steps.ts` is the shared review runner for workflow steps,
current parallel review execution, test-only serial execution, step events,
failure aggregation, and export metadata.

`providers/registry.ts` creates the selected provider adapter. Provider
adapters under `providers/cursor/` and `providers/codex/` implement invocation.
Workflows should stay provider-agnostic. Provider runs default to enforced
workspace guarding, which records before/after git status and rejects tracked
workspace mutations. Planning and implementation producer actions use `record`
mode so provider raw artifacts capture workspace changes while Harness owns
their validation and publication.

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

Each `harness factory triage` run creates
`${XDG_DATA_HOME:-~/.local/share}/harness/store/projects/<repo-id>/runs/factory/<run-id>/`
by default. `--runs-dir` is available only for dry-run triage.

Factory triage artifacts include:

- `context/work-item.json`
- `context/phase-run.json`
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

Artifact refs in action events use store-relative `/` paths plus SHA-256
content hashes. The CLI validates terminal evidence before recovery or Linear
projection. Planning reactions may name the next manually invoked planning
command. Implementation waits have no executable downstream command.

`harness factory inspect` reports the same durable state boundary without
acquiring a lifecycle lock or reading the rebuildable state projection. Its
stable output contains `workItemKey`, `artifactRoots`, reduced `state`, the
verbatim `latestEvent`, and `reaction`; missing history is represented by three
`null` values. It never fetches Linear, runs a provider, crawls evidence, or
appends lifecycle state.

`--dry-run` writes placeholder triage and route artifacts but does not invoke a
provider, does not write run `events.jsonl`, and does not write lifecycle
events in the durable factory store.

Planning run artifacts are part of the shipped manually stepped surface.
Implementation candidate, review, and revision artifacts are also shipped and
live in the same durable Factory run boundary.

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

Standalone review resumability, `steps.json`, deterministic graders,
General GitHub/Jira adapters, hosted trigger inboxes, and Inngest remain future
work. The bounded Factory pull-request publisher is current.
Linear-backed triage, planning, and implementation input/projections via
explicit `--apply` are current. Future items should be added to this map only
after they describe current behavior in the repo.
