# Plan 260711-factory-action-state-machine: Build manually stepped Factory actions

## Status

- **Priority**: P1
- **Effort**: L overall; four bounded PRs
- **Risk**: HIGH
- **State**: approved direction
- **Depends on**: PR 2 follows or explicitly supersedes
  `dev/plans/260711-factory-plan-simplicity.md`
- **Review note**: final automated plan review
  `20260712-041215-6cb58a` was triaged. Later human decisions deliberately
  replace its compatibility and synchronous-loop assumptions; do not run
  another plan review.

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
start with a new empty Factory state directory; existing Linear issues enter
through an explicit new phase command after satisfying that phase's entry
status.

Retain current phase command names and Linear status names because they are
useful operator interfaces, not because their old lifecycle representation is
supported.

### Domain events and state

Use one strict event union:

| Event                               | Owner / meaning                                               |
| ----------------------------------- | ------------------------------------------------------------- |
| `work_item.imported`                | command imports current work-item identity and source         |
| `triage.requested`                  | explicit triage phase start                                   |
| `triage.work_item.completed`        | `triageWorkItem` route result                                 |
| `planning.requested`                | explicit planning phase start and review ceiling              |
| `planning.candidate.produced`       | immutable plan candidate and effective session                |
| `planning.input.required`           | planner returned human questions                              |
| `planning.review.completed`         | aggregate plan-review verdict and evidence                    |
| `plan_pr.opened`                    | explicit publication command recorded the reviewed plan PR    |
| `plan_pr.merged`                    | explicit command recorded the matching merged commit          |
| `implementation.requested`          | explicit implementation phase start and review ceiling        |
| `implementation.candidate.produced` | immutable Git candidate and effective session                 |
| `implementation.review.completed`   | aggregate change-review verdict and evidence                  |
| `factory.action.failed`             | expected handler ended retryable, terminal, or human-required |

Request events contain deterministic ID, work-item key, phase run ID, input
refs, expected predecessor, and persisted policy such as review ceiling. Action
events add handler, handler version, positive attempt, causation event ID,
execution provenance, decisions, session when relevant, and portable artifact
refs. Events contain references and decisions, not full prompts, findings,
diffs, or transcripts.

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
prints why it cannot advance. Starting a new run after a terminal/human state
requires explicit restart/rerun intent; never silently replace an active phase
run.

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

### Transition contract

| Latest durable result                               | Next reaction                                      |
| --------------------------------------------------- | -------------------------------------------------- |
| `triage.requested`                                  | `triageWorkItem`, attempt 1                        |
| triage route ready to plan/implement                | wait for explicit phase command                    |
| `planning.requested`                                | `producePlanCandidate`, attempt 1                  |
| plan candidate                                      | `reviewPlanCandidate`, same attempt                |
| plan review `needs_changes` below ceiling           | producer, attempt + 1, caused by review            |
| plan review `pass`                                  | wait for local completion or tracker plan PR/merge |
| plan review blocked/exhausted                       | wait for human                                     |
| `plan_pr.merged`                                    | wait for explicit implementation command           |
| `implementation.requested`                          | `produceImplementationCandidate`, attempt 1        |
| implementation candidate                            | `reviewImplementationCandidate`, same attempt      |
| implementation review `needs_changes` below ceiling | producer, attempt + 1, caused by review            |
| implementation review `pass`                        | complete                                           |
| implementation review blocked/exhausted             | wait for human                                     |
| retryable action failure                            | same handler/attempt with retry scheduling         |
| human-required failure                              | wait for human                                     |
| terminal failure                                    | failed                                             |

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
persisted or inherited. A continuation command must not replay the phase-start
move. It validates that the issue remains in the projected phase status and
applies only a human/terminal boundary produced by its one action. Without
`--apply`, local Factory truth advances and stdout reports the intended
projection.

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
implementation execution lease from work item to canonical workspace and
acquire it inside `produceImplementationCandidate`. It is only a
single-machine safety guard. Future scheduled implementation uses dedicated
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

## PR 1 — New action kernel and manually run triage

Create the new-only domain foundation and prove it vertically with triage.

Changes:

- Add `lib/factory-store-format.ts`, `factory-lifecycle-events.ts`,
  `factory-action-contract.ts`, `factory-artifact-ref.ts`,
  `factory-action-result.ts`, `factory-phase-run.ts`, and
  `factory-state-machine.ts`.
- Replace lifecycle append/reduce behavior in `lib/factory-lifecycle.ts` and
  `factory-lifecycle-writes.ts`; do not retain old schemas or replay cases.
- Add the format marker, strict CAS/idempotency, portable refs, deterministic
  action result recovery, state projection, and pure reaction.
- Extract `triageWorkItem` from `workflows/factory-triage.workflow.ts` and wire
  `harness factory triage` through one request/reaction/handler result.
- Add the shared one-action stdout/progress/telemetry contract without a
  generic handler registry.
- Update `docs/contributing/factory.md` and `skills/factory-operator/SKILL.md`
  for the clean store cutover, synchronous wait behavior, triage result, and
  next-command output. Do not document planning/implementation behavior before
  those PRs ship.

Verify with focused lifecycle/state/action-result/triage CLI tests, including
stale cursor, divergent duplicate, crash-after-result recovery, path/hash
rejection, one handler call, no automatic follow-up, persisted heartbeat
telemetry, and explicit old-store rejection. Then run `pnpm check` and the
change-review workflow.

## PR 2 — Manually stepped planning candidate and review

Pass or explicitly supersede the active plan-simplicity prerequisite before
editing planning. Preserve minimum-sufficient prompts, blocking-only revision
input, and the configured completed-review ceiling.

Changes:

- Add `lib/factory-plan-candidate-action.ts` and
  `factory-plan-review-action.ts` around the existing `invokePlanner` and
  `runReview` seams.
- Split planning context creation from `openFactoryPlanningRunContext`; persist
  the phase context, effective session, immutable candidates, review refs, and
  blocking-finding refs.
- Replace `runPlanningLoop` with an explicit one-action planning coordinator.
  A fresh command appends `planning.requested` and runs only candidate attempt
  1. Every later command reopens the run and executes exactly the latest
     reaction. It recomputes `next` but never invokes it.
- On revision, restore the prior candidate to scratch, resume the effective
  provider session, and publish a new immutable candidate.
- Keep `planning publish` and `mark-plan-merged` separate. Route their existing
  event types through strict expected-cursor append and write lifecycle truth
  before run-meta/Linear projection.
- Apply Planning only on phase request; continuation actions leave Linear in
  Planning until a human/terminal/publication boundary.
- Update `skills/factory-operator/SKILL.md` in this PR with the repeated command
  sequence, how to read `next`, same-session behavior, `--apply` rules,
  heartbeat waiting, publication commands, and stop conditions.

Focused tests prove one provider/reviewer invocation per command, no hidden
loop, candidate -> review -> revision across separate processes, effective
session carry-forward, immutable scratch recovery, review ceiling, retry of the
same action, tracker publication/merge gate, and Linear mutation only at the
documented boundaries. Then run `pnpm check` and change-review.

## PR 3 — Manually stepped implementation candidate and one review

Introduce trusted implementation evidence and aggregate review without a
revision path yet.

Changes:

- Add implementation reviewer role configuration through the existing role
  resolver.
- Add `lib/factory-implementation-candidate-action.ts`,
  `factory-implementation-review-action.ts`, and
  `factory-implementation-review-evidence.ts`.
- Make the producer create an immutable
  `refs/harness/factory/<run>/<attempt>` commit without moving HEAD/index and
  record original base, ref, commit SHA, tree SHA, cumulative diff, workspace
  status, handoff, and effective session.
- Validate work-item/run/store/workspace identity, artifact digests, ref to
  commit, recorded tree, and base ancestry. Review the commit SHA, not a mutable
  ref or working tree.
- Run the existing three-reviewer `change-review` workflow as one handler and
  append one aggregate review event; never append per-reviewer Factory events.
- Replace the implementation workflow with a one-action coordinator. PR 3
  persists a review ceiling of 1, so pass completes and non-pass waits for a
  human; each candidate and review still requires a separate command.
- Rekey and internalize the existing workspace execution lease as specified
  above.
- Update run-meta/CLI/Linear projection and the operator skill. The skill must
  show candidate command, review command, evidence inspection, exact next
  output, synchronous/heartbeat behavior, attention/failure handling, and that
  no separate `harness run change-review` is now required.

Focused tests prove one handler per invocation, immutable commit/tree/ref
integrity, tamper rejection, review by SHA, one aggregate review invocation,
pass-only completion, no hidden revision, checkout contention, process restart,
and Linear remaining Implementing through internal actions. Then run
`pnpm check` and change-review.

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
- Reconcile `README.md`, contributor architecture/factory/command docs,
  `dev/plans/260621-agent-harness-handoff.md`,
  `dev/plans/260704-factory-intake-routing.md`, and `dev/plans/README.md`.
  Describe Inngest as a future consumer of reactions, not current behavior.
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
