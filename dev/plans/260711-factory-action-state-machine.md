# Plan 260711-factory-action-state-machine: Build manually stepped Factory actions

## Status

- **Priority**: P1
- **Effort**: M remaining; two bounded PRs
- **Risk**: HIGH
- **State**: in progress
- **Progress**: PR 1 shipped in PR #127; PR 2 shipped in PR #129; PR 3 is next
- **Prerequisite**: minimum-sufficient Factory planning shipped in PRs #123
  and #125. PR #130 is the planning, implementation, and review authority
  baseline for the remaining work.
- **Review note**: the overall review `20260712-041215-6cb58a` and scoped PR 3
  review `20260713-021014-ecd300` were triaged into this plan. The accepted
  manual-action architecture remains unchanged; do not run another plan review
  before implementation.

## Goal

Replace the coarse Factory station lifecycle with one clean action-level
domain model. Harness owns the event log, state projection, transition rules,
sessions, and evidence. The initial CLI executes the model manually: one
invocation runs at most one pending action, blocks until that action finishes,
then exits with the next action and exact command. A human decides when to run
that command. A later Inngest adapter may schedule the same reactions without
owning Factory state or transition logic.

The finished flow has exactly five handler functions:

1. `triageWorkItem`
2. `producePlanCandidate`
3. `reviewPlanCandidate`
4. `produceImplementationCandidate`
5. `reviewImplementationCandidate`

Acceptance:

- every handler validates current state, performs one action, writes immutable
  evidence, appends one terminal event with an expected cursor, and returns
  `{ event, state }`;
- the reducer and pure reaction function are the only transition authority;
- `harness factory planning run` and `implementation run` execute one reaction
  per invocation and never loop to the next handler;
- planning and implementation revisions use the original provider session;
- Linear remains a coarse, explicit `--apply` projection; no new statuses;
- implementation completes only after aggregate change-review passes;
- old Factory lifecycle data is not parsed, migrated, or used to recover state.

## Grounded decisions

### Clean cutover

Do not preserve the current lifecycle contract. Introduce one coherent new
event schema at version 1 and a required Factory store-format marker. An empty
state root may initialize the marker. A non-empty lifecycle directory without
the marker, or with another version, fails with explicit archive/reset
instructions. Never delete user data automatically.

Old `runs/factory/*` directories may remain as inert evidence. Old lifecycle
JSONL, state caches, absolute artifact paths, `factoryStage` compatibility
projections, and Linear status/comment-derived recovery are not read. Operators
start with a new empty Factory state directory. An existing Linear issue may
start planning directly through the explicit planning command after its live
status satisfies the configured planning entry gate; a new triage
`ready-to-plan` route may start it the same way. Both paths append new Factory
events and never infer progress from Linear.

Retain current phase command names and Linear status names because they are
useful operator interfaces, not because their old lifecycle representation is
supported.

### Domain events and state

Use one strict event union:

| Event                               | Owner / meaning                                                   |
| ----------------------------------- | ----------------------------------------------------------------- |
| `work_item.imported`                | command imports current work-item identity and source             |
| `triage.requested`                  | explicit triage phase start                                       |
| `triage.work_item.completed`        | `triageWorkItem` route result                                     |
| `planning.requested`                | explicit planning start/restart, review ceiling, publication mode |
| `planning.candidate.produced`       | immutable plan candidate and effective session                    |
| `planning.input.required`           | planner returned human questions                                  |
| `planning.review.completed`         | aggregate plan-review verdict and evidence                        |
| `plan_pr.opened`                    | explicit publication command recorded the reviewed plan PR        |
| `plan_pr.merged`                    | explicit command recorded the matching merged commit              |
| `implementation.requested`          | explicit implementation phase start and review ceiling            |
| `implementation.candidate.produced` | immutable Git candidate and effective session                     |
| `implementation.review.completed`   | aggregate change-review verdict and evidence                      |
| `factory.action.failed`             | expected handler ended retryable, terminal, or human-required     |

Request events contain deterministic ID, work-item key, phase run ID, input
refs, expected predecessor, and persisted policy such as review ceiling. Action
events add handler, handler version, positive attempt, causation event ID,
execution provenance, decisions, session when relevant, and portable artifact
refs. Events contain references and decisions, not full prompts, findings,
diffs, or transcripts.

`planning.requested` uses `intent: start | restart` and snapshots
`publicationMode: local | pull-request`. The planning state carries that mode
so a review pass has one deterministic transition without consulting live
tracker or configuration state. `--item-file` selects `local`;
`--linear-issue` selects `pull-request`.

`FactoryLifecycleState` is a strict discriminated projection:

- idle;
- triage: awaiting result, routed, needs human, parked, or failed;
- planning: awaiting candidate, awaiting review, needs revision, needs human,
  awaiting plan merge, approved, or failed;
- implementation: awaiting candidate, awaiting review, needs revision, needs
  human, complete, or failed.

Keep event-schema and projection versions independent so reducer-only changes
rebuild caches. Do not expose legacy stage fields as transition inputs.

Add pure
`decideNextFactoryAction(state, latestEvent): FactoryReaction`. A reaction is:

- `invoke`: concrete handler, phase, attempt, causation ID, and scheduling class
  `immediate` or `retry`;
- `wait`: phase command, human, plan merge, complete, failed, or stale event.

It first requires `state.lastEventId === latestEvent.id`; replaying an older
duplicate cannot schedule work after a successor exists.

### Strict append and action recovery

The append API requires `expectedLastEventId`, including explicit `null` for an
empty log. Under the existing short per-work-item lifecycle lock it:

1. reloads and reduces the log;
2. returns an existing deterministic event only when canonical content matches,
   ignoring only `occurredAt`;
3. rejects the same ID with different content;
4. rejects a stale expected cursor;
5. validates the new transition;
6. appends, fsyncs, reduces, and atomically writes the state cache;
7. returns `{ event, state }`.

Never hold the lifecycle lock while an agent or reviewer runs.

New artifact refs are relative to `factory-store` or `repository`, reject
absolute/traversal paths, and carry SHA-256. Each action has a deterministic
directory and writes an atomic terminal `action-result.json` after its evidence.
If a process dies before lifecycle append, the next invocation validates this
result and appends it without repeating provider work. Divergent recovered
content is a hard conflict.

### Manual one-action CLI coordinator

Handlers are library functions, not user-facing commands. Keep the phase CLI:

```text
harness factory triage ...
harness factory planning run ...
harness factory implementation run ...
```

Each invocation:

1. imports/refreshes work-item input without deriving Factory progress from
   Linear;
2. creates a phase run and request event only when no active run exists;
3. otherwise reopens the persisted active phase run;
4. computes the latest reaction;
5. invokes at most one handler;
6. waits for that handler to finish;
7. persists its terminal event/state;
8. recomputes but does not execute the next reaction;
9. prints the completed action, durable evidence, next reaction, and exact next
   command, then exits.

If the latest reaction is already `wait`, the command invokes no handler and
prints why it cannot advance. Planning `start` is valid from a newly imported
item that passes the external entry gate or from a new `ready-to-plan` triage
route. `--rerun` is valid only from planning `needs-human` or `failed`; it
creates a new phase run from current input and configuration.
Never silently replace an active phase run.

The stdout JSON contract contains:

```json
{
  "outcome": "action-completed | waiting | complete | failed",
  "phase": "planning",
  "phaseRunId": "...",
  "action": {
    "handler": "reviewPlanCandidate",
    "attempt": 1,
    "eventId": "..."
  },
  "next": {
    "kind": "invoke | wait",
    "handler": "producePlanCandidate",
    "attempt": 2,
    "reason": "review-needs-changes",
    "command": "harness factory planning run ..."
  },
  "linearApplied": false
}
```

`action` or invoke-only `next` fields may be absent when waiting. The command
must not put secrets in the echoed command.

Station commands remain synchronous. Emit one always-on stderr progress record
when the phase/action is known, including run directory, handler, and attempt.
Reuse run-local `WorkflowEvent` telemetry for `step:start`, periodic
`step:heartbeat`, and `step:end`; forward it to stderr with `--verbose` and
always persist it in the action run. Heartbeats are execution telemetry, never
Factory lifecycle events. Operators wait once for process exit and do not poll
the state while an action owns the terminal result.

Manual planning example:

```text
planning run #1 -> producePlanCandidate attempt 1 -> exits: next review
planning run #2 -> reviewPlanCandidate attempt 1 -> exits: next revision
planning run #3 -> producePlanCandidate attempt 2 -> exits: next review
planning run #4 -> reviewPlanCandidate attempt 2 -> exits: wait plan publication
```

Implementation follows the same shape. The CLI never executes #2 from #1.
Future Inngest calls the reaction named in `next` instead of asking the CLI to
loop.

### Session continuation and phase recovery

Creation and recovery are separate APIs. `create*RunContext` writes immutable
`context/phase-run.json`; `open*RunContext` accepts its phase run ID and
factory-store ref, validates work-item/workspace/store/phase identity, and never
allocates or overwrites a run.

The context records phase, work item, canonical workspace/store identity,
inputs, provider/model/policy snapshot, review ceiling, and no credentials.
Actions write under `actions/<attempt>/<handler>/<action-key>/`.

Every successful producer event stores the effective session:

```text
effectiveSession = providerResult.session ?? resumedInputSession
```

After `needs_changes`, the review event references the complete review and a
small artifact containing only `must_fix` findings. The next producer action:

1. reopens the same phase run;
2. verifies the causation review and attempt;
3. loads the effective session from the latest candidate;
4. loads and verifies blocking findings through their digested ref;
5. restores the prior immutable candidate to non-authoritative scratch when
   necessary;
6. invokes the provider with the saved session and revision prompt;
7. publishes a new immutable candidate and event.

If a required revision lacks a valid same-provider session, return
human-required. Never silently start a new conversation.

After a human-required result, the operator updates the source work item and
uses `--rerun`; this starts a new phase run and producer session. The
same-session guarantee applies to review-driven `needs_changes` revisions
inside one phase run, not to a human restart.

### Transition contract

| Latest durable result                               | Next reaction                                 |
| --------------------------------------------------- | --------------------------------------------- |
| `triage.requested`                                  | `triageWorkItem`, attempt 1                   |
| triage route ready to plan/implement                | wait for explicit phase command               |
| imported item + explicit planning start             | `planning.requested` in a new phase run       |
| `planning.requested`                                | `producePlanCandidate`, attempt 1             |
| plan candidate                                      | `reviewPlanCandidate`, same attempt           |
| plan review `needs_changes` below ceiling           | producer, attempt + 1, caused by review       |
| plan review `pass`, local publication               | materialize reviewed plan; approved           |
| plan review `pass`, pull-request publication        | wait for plan PR/merge                        |
| plan review blocked/exhausted                       | wait for human                                |
| planning human/failure wait + `--rerun`             | `planning.requested` in a new phase run       |
| `plan_pr.opened`                                    | wait for matching merge                       |
| `plan_pr.merged`                                    | wait for explicit implementation command      |
| `implementation.requested`                          | `produceImplementationCandidate`, attempt 1   |
| implementation candidate                            | `reviewImplementationCandidate`, same attempt |
| implementation review `needs_changes` below ceiling | producer, attempt + 1, caused by review       |
| implementation review `pass`                        | complete                                      |
| implementation review blocked/exhausted             | wait for human                                |
| implementation human/failure wait + `--rerun`       | `implementation.requested` in a new phase run |
| retryable action failure                            | same handler/attempt with retry scheduling    |
| human-required failure                              | wait for human                                |
| terminal failure                                    | failed                                        |

The manual coordinator treats both immediate and retry reactions as guidance
for a later invocation. It never automatically follows either.

### Linear boundary

Keep the current `factory.linear.statuses` schema and configured team statuses.
Candidate/review/revision actions never become Linear board columns.

| Factory boundary                           | Linear `--apply` projection                                |
| ------------------------------------------ | ---------------------------------------------------------- |
| triage starts/result                       | existing Triaging and route statuses                       |
| planning request                           | move accepted entry to Planning                            |
| planning candidate/review/revision         | remain Planning; no intermediate mutation                  |
| planning needs human                       | Needs Clarification                                        |
| planning blocked/exhausted                 | Plan Needs Review                                          |
| terminal planning failure                  | Planning Failed                                            |
| plan PR opened                             | Plan Needs Review                                          |
| plan PR merged                             | Ready to Implement                                         |
| implementation request                     | Ready to Implement -> Implementing                         |
| implementation candidate/review/revision   | remain Implementing                                        |
| implementation review passes               | remain Implementing; idempotent reviewed-candidate comment |
| implementation blocked/exhausted/uncertain | remain Implementing; idempotent attention comment          |
| retryable implementation failure           | remain Implementing                                        |
| terminal implementation failure            | Implementation Failed                                      |

Every invocation with `--linear-issue` performs a live read. Only that
invocation's explicit `--apply` authorizes a mutation; authorization is not
persisted or inherited. A Linear-backed new or restarted planning phase
requires `--apply` and accepts only the configured Needs Plan, Needs
Clarification, Plan Needs Review, or Planning Failed entry status. The
coordinator validates and durably appends `planning.requested` before projecting
Planning, and it never invokes the provider until that projection succeeds. A
failed start projection leaves that one request pending; the next explicit
`--apply` repairs the same projection without appending another request. Later
continuations validate Planning without repeating the start move and apply only
a human/terminal/publication boundary produced by their one action. Those wait
boundaries may persist Factory truth without `--apply` and repair their Linear
projection on a later explicit `--apply` invocation.

A Linear-backed implementation start or `--rerun` requires `--apply`. Append
one `implementation.requested` before projecting Ready to Implement or
Implementation Failed to Implementing; an already-Implementing human restart
is an idempotent start projection. Provider work cannot begin until that
projection succeeds. A retry repairs the same pending request and never appends
another request or invokes a second handler. Active continuations require live
Implementing. Candidate and review actions do not change the status. Review
pass adds the idempotent reviewed-candidate comment; non-pass adds an idempotent
attention comment while remaining Implementing; terminal failure projects
Implementation Failed. A later explicit `--apply` repairs a missing terminal
projection without rerunning its handler.

Remove status/comment-to-Factory-stage bootstrap. Linear validates a new phase
entry and receives projections; the Factory log exclusively owns active run,
handler, attempt, session, and next reaction.

No new Linear status is required. If operator experience later demonstrates a
need for an Implementation Needs Attention column, add it as a separate product
change, not as state-machine correctness.

### Failure and checkout safety

Keep provider adapters unchanged. Factory classifies at the action boundary
from structured facts, never arbitrary error-message matching:

- provider/review failure with no caller abort and proven unchanged workspace:
  retryable;
- caller abort, review workspace mutation, or uncertain implementation
  post-state: human-required;
- invalid output/evidence/artifact/state/transition, dirty base, or successful
  implementation with no tree change: terminal;
- questions, `needs_changes`, blocked, and exhausted ceilings: normal domain
  outcomes.

Do not add a claim store or distributed lock. Rekey the existing local
implementation execution lease from work item to canonical workspace. Hold it
for the complete producer critical section and for the complete review critical
section, including their terminal action append. It is only a single-machine
safety guard. Future scheduled implementation uses dedicated
checkouts/worktrees.

### Configuration decision: roles resolve to immutable action profiles

User configuration remains role-based. Runtime handlers map to roles exactly:
`triageWorkItem` -> `factory.triage.roles.triager`, `producePlanCandidate` ->
`factory.planning.roles.planner`, `reviewPlanCandidate` ->
`factory.planning.roles.reviewer`, `produceImplementationCandidate` ->
`factory.implementation.roles.implementer`, and `reviewImplementationCandidate`
-> `factory.implementation.roles.reviewer` (introduced in PR 3). Do not add a
`factory.actions` tree, handler registry, compatibility layer, or Factory
per-review-step model hierarchy.

Creating a phase reads and validates configuration once, resolves the
invocation-effective action profiles including action defaults, and snapshots
them by handler in `context/phase-run.json`. A profile contains provider,
model, executable override when present, sandbox, approval policy, and
reasoning effort. It excludes credentials, environment authentication,
signals, telemetry, `--apply` authorization, and invocation timeout.
Continuations and retries use the snapshot and never silently re-resolve from
current configuration; an explicit new phase run uses current configuration.

`plan-review` uses one planning-reviewer profile for its fixed steps.
`change-review` uses one implementation-reviewer profile for all its fixed
steps. PR 1 establishes and uses the snapshot contract for triage. PR 2
consumes the existing planning planner/reviewer roles. PR 3 adds the
implementation reviewer role.

## Shipped foundation

- PR 1 shipped the action kernel, clean store cutover, and manually run triage
  in PR #127.
- PR 2 shipped manually stepped planning candidates, reviews, revisions, and
  publication in PR #129.
- PR #130 aligned planning, implementation, and review authority across Factory
  prompts, workflows, and manually invoked skills.

The remaining executor scope starts with PR 3. Use the shipped implementations
and their tests as the source of truth for PR 1 and PR 2 behavior.

## PR 3 — Manually stepped implementation candidate and one review

Ship the first complete implementation vertical slice: one invocation produces
an immutable candidate, a later invocation reviews it, pass completes, and
non-pass waits for a human. Review-driven same-session revision remains PR 4;
`--rerun` is a fresh human restart, not that revision path.

Changes:

- Extend `lib/schemas.ts` and `lib/config.ts` with
  `factory.implementation.roles.reviewer`; keep role fallback and validation
  identical to the existing role resolver. Extend
  `FactoryPhaseRunIdentitySchema` with an implementation branch containing the
  implementer and reviewer profiles, review ceiling 1, original base HEAD, and
  a strict direct/planned input snapshot. Extend `implementation.requested`
  with `intent: start | restart`. Direct input is the immutable imported work
  item plus its durable `ready-to-implement` triage result. Planned input is the
  immutable imported work item plus the exact reviewed planning candidate and
  its output path; pull-request mode also records the matching `plan_pr.merged`
  URL/commit. Put those refs in the request and phase context. Never derive
  readiness, mode, retry, or progress from `factoryStage`, route metadata,
  Linear comments, or status.
- Gate phase creation before provider work. Require a clean workspace and
  snapshot its HEAD once as the original base. For planned input, require the
  plan bytes at that base/output path to equal the reviewed candidate. In
  pull-request mode, also require the recorded merge commit to exist, contain
  those bytes, and be an ancestor of the base. A local operator therefore
  commits the reviewed local plan; a pull-request operator pulls the recorded
  merge before implementation. Reopen validates the persisted base and input
  refs instead of adopting current Git/config state. `--rerun` is valid only
  from implementation `needs-human` or `failed`; it creates a new phase with
  current source/config, a fresh producer session, and the same readiness gates.
- Make the clean cutover explicit instead of adding parallel versions. Replace
  the legacy allocator/meta/dry-run contract in
  `lib/factory-implementation-run-context.ts` with separate create/open action
  context APIs. Replace metadata-derived logic in
  `lib/factory-implementation-input.ts` with the event-derived input contract.
  Replace `bin/factory-implementation-cli.ts` legacy output with the one-action
  coordinator and shared `bin/factory-action-output.ts` contract, wired from
  `bin/factory-commands.ts`. Adapt `lib/factory-review-head.ts`,
  `factory-implementation-policy.ts`, `factory-linear-implementation-apply.ts`,
  and `lib/prompts/factory-implementation.ts`; remove obsolete exports, tests,
  standalone-review guidance, and unused station compatibility. There is no
  implementation workflow left to wrap or replace.
- Add `lib/factory-implementation-candidate-action.ts`. Under the canonical
  workspace lease, revalidate clean status and original HEAD, run the
  snapshotted implementer with the accepted work item/plan authority, and keep
  the provider schema-free. After provider return, durably stage action
  identity, completion/session, raw/stream refs, and before/after workspace
  facts. A successful changed tree is published through a temporary index as a
  commit parented to the original base and a create-only
  `refs/harness/factory/<phase-run>/<attempt>` ref without moving HEAD or the
  real index. Then write immutable candidate evidence containing the base, ref,
  commit, tree, cumulative diff, workspace status, handoff, effective session,
  and artifact digests; write the atomic action result; append with CAS; release
  the lease. Matching staged evidence/ref is recoverable. A divergent ref or
  evidence conflict is terminal. Workspace changes without a valid staged
  provider completion are human-required and never trigger blind provider
  re-execution.
- Add `lib/factory-implementation-review-action.ts` and
  `factory-implementation-review-evidence.ts`. Validate action/work-item/run/
  store/workspace identity, all artifact digests, original-base ancestry, the
  candidate ref/commit/tree, and that the live workspace tree still equals the
  candidate through a temporary index. Hold the same workspace lease across
  that check, the review, the post-review tree check, action result, and append.
  Run `change-review` with original base and the immutable commit SHA, the fixed
  full `implementation` + `quality` set, the snapshotted reviewer profile, the
  accepted work item as handoff authority, and the reviewed plan as plan
  authority when present. Do not pass partial steps or invoke its outer
  remediation loop.
- Publish one immutable `review-evidence.json` manifest with candidate
  base/commit/tree, `partial: false`, refs to both schema-validated reviewer
  outputs, and the verdict recomputed through existing aggregation. For
  `needs_changes`, publish every `must_fix` finding with stable
  reviewer-prefixed IDs in `blocking-findings.json`. The lifecycle event
  references the manifest, both reviewer outputs, and optional blocking digest;
  it never appends per-reviewer events. Missing/partial/mismatched evidence or a
  verdict contract violation is terminal; a failed reviewer produces
  `factory.action.failed`, not `implementation.review.completed`. Stage the
  completed review-run identity/result before final evidence so restart can
  validate and finalize one existing run without invoking reviewers again.
- Implement `harness factory implementation run` as the implementation-specific
  one-action coordinator. Create/repair a request only when appropriate,
  otherwise reopen its phase, compute one reaction, invoke exactly its named
  handler, recompute `next`, and exit. Review ceiling 1 makes pass complete and
  all non-pass verdicts wait for human; it never runs a revision in the same
  command. Use the Linear start/continuation/terminal repair contract above and
  retain one always-on action-start record plus persisted/optional verbose
  workflow telemetry.
- Resolve an omitted `--max-runtime-ms` from the current reaction: producer uses
  internal `0`; reviewer uses the positive shared review default; an explicit
  positive value overrides only that invocation. In `lib/agent-signals.ts`, `0`
  creates no timer while external cancellation and cleanup remain active.
  Triage, planning, and reviews retain their positive defaults. Add no
  heartbeat/inactivity abort or provider-specific timeout branch.
- Update `README.md`, `docs/contributing/{architecture,factory,script-command-surface,setup-manifest}.md`,
  `scripts/smoke-dist.ts`, and `skills/factory-operator/SKILL.md` for only the
  shipped PR 3 surface: clean/committed-plan gate, candidate command, review
  command, exact next output, evidence inspection, synchronous/heartbeat
  behavior, Linear apply/repair boundaries, human restart, pass/failure stops,
  and no separate `harness run change-review`. Leave automatic review-driven
  implementation revisions labeled as PR 4 work.

Verify through one coordinator sequence that runs candidate and pass review in
separate invocations with one handler each. Add focused direct/planned input and
committed-plan gates; dirty-base/no-provider; same-workspace contention with
distinct-workspace independence; provider-stage/ref/action-result recovery with
no second provider call; create-only ref/tamper rejection; pre/post-review
workspace drift; full aggregate evidence and all blocking findings; failed or
partial reviewer rejection; Linear request/projection/terminal repair; human
`--rerun`; and fake-timer coverage for zero, positive, and external cancellation.
Use CLI help/distribution smoke for the public surface. Rely on PR 1/2 tests for
generic CAS, artifact-ref, and one-action behavior instead of duplicating those
matrices. Run `pnpm check` and the change-review workflow.

## PR 4 — Manually stepped implementation revisions and final docs

Complete the symmetric implementation revision path without changing the
manual CLI model.

Changes:

- Add `factory.implementation.maxReviewIterations`, default 3, and persist it
  in `implementation.requested`.
- For attempt > 1, load the prior aggregate review's blocking findings, resume
  the effective implementer session, retain the original base, require a new
  tree, and create a new immutable attempt ref.
- Review every candidate against the cumulative original-base-to-current-tree
  diff. Pass completes; blocked/exhausted waits for human; `needs_changes`
  produces a `next` producer reaction but never runs it in the same command.
- Keep implementation truth in Git evidence and aggregate review; do not add a
  model-authored implementation output schema.
- Reconcile `README.md`, contributor architecture/factory/command docs, and
  `dev/plans/README.md`. Describe Inngest as a future consumer of reactions,
  not current behavior.
- Finish `skills/factory-operator/SKILL.md` with the full manual attempt/review
  sequence, continuation after restarts, same-session guarantees, inspection
  paths, `--verbose` heartbeats, Linear projections, plan merge gate, and
  explicit stop conditions. Keep it one-action-at-a-time; do not mention a CLI
  loop or dispatch command.

Focused tests prove revision across separate CLI processes, effective-session
continuation, complete blocking-finding input, cumulative diffs, distinct
attempt refs, later-attempt pass, blocked/exhausted waits, retryable action
guidance, and no second handler call. Run `pnpm check`, `pnpm test`, and the
change-review workflow.

## Boundaries and STOP conditions

Out of scope:

- parsing or migrating old lifecycle logs;
- the deleted planning workflow loop, legacy planning dry-run/output contract,
  or a separate simplify reviewer;
- automatic CLI loops, generic dispatch, batch inbox processing, or automatic
  phase starts;
- Inngest, webhooks, queues, polling, cron, or retry timing;
- a DAG, station/handler registry, event bus, or workflow engine;
- new Linear statuses or Linear mutation without `--apply`;
- PR creation/merge automation, branch checkout, or worktree provisioning;
- per-reviewer lifecycle events;
- provider-wide failure-result redesign.

Stop and report if:

- a handler needs live Linear/config/filesystem data to decide the next domain
  transition rather than persisted event/state data;
- a phase command would need to execute a second handler before returning;
- same-session revision cannot be recovered from persisted candidate evidence;
- implementation revision requires resetting, checking out, or committing the
  target working tree;
- review cannot run against a recorded commit SHA;
- correct local safety requires a second claim store or distributed lock;
- active concurrent work changes the same lifecycle/action contracts.
