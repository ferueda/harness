# Factory Contributor Guide

## Purpose and audience

Factory is Harness's durable, action-driven software-delivery flow. This guide
is for contributors changing its lifecycle, actions, evidence, projections, or
host boundary. It explains the model and invariants that must survive a change.

It is not the operator runbook. Agents executing Factory should use
[`$factory-operator`](../../skills/factory-operator/SKILL.md); humans should use
the README quickstart and generated `harness factory ... --help`. See
[Script and command surface](./script-command-surface.md) for command ownership
and [Setup manifest](./setup-manifest.md) for auth and generated paths.

## Mental model

```text
work item
  -> durable phase request
  -> reduced Factory state
  -> pure next reaction
  -> at most one action handler
  -> immutable evidence and action result
  -> compare-and-append terminal event
  -> rebuildable state projection
  -> optional Linear or GitHub projection
```

Each CLI invocation reads durable state, executes at most one selected action,
persists the result, prints the next reaction, and exits. A wait reaction invokes
nothing.

Factory vocabulary:

- **phase**: `triage`, `planning`, or `implementation`;
- **role**: configured responsibility such as planner, reviewer, or implementer;
- **handler**: one action selected by the persisted reaction;
- **agent**: provider backend such as Cursor or Codex;
- **projection**: retryable human-facing state in Linear or GitHub.

## Core invariants

1. **The event log is machine truth.** Durable `factory/events/*.jsonl` is
   canonical. `factory/state/*.json` is an atomically published, rebuildable
   projection.
2. **One reaction selects at most one action.** CLI retries converge through the
   same reducer and reaction logic.
3. **Action identity is stable.** Phase, attempt, handler, and causation identity
   bind staged provider output, immutable evidence, action result, and terminal
   event so crash recovery does not repeat completed provider work.
4. **Inputs and evidence are immutable.** Work-item, candidate, review,
   continuation, and publication references carry content hashes. Mutable
   tracker fields never replace lifecycle truth.
5. **Git owns committed plans and code.** Harness creates and reviews immutable
   candidate commits, then promotes only the exact reviewed candidate through
   compare-and-swap guards.
6. **External systems are projections.** Linear describes human board state;
   GitHub exposes reviewed pull requests. Projection failure must be repairable
   without repeating the underlying action.
7. **Human gates remain explicit.** A non-pass review waits for a recorded
   continuation. Publication never implies merge, and merge acknowledgement
   requires the recorded reviewed head in local history.
8. **Providers stay bounded.** Producers may edit the target workspace under
   Harness validation. Reviewers are read-only. Provider sessions, models, and
   policies are snapshotted for the phase responsibility.
9. **Grove workspaces keep one stable phase lease.** Revisions, retries, and
   publication reuse its path.

Run only one phase command for a work item at a time. When Harness dogfoods
itself, use a dedicated clean detached controller checkout pinned to one SHA
for the active phase and a separate mutable target worktree. The target's
`main` may advance after the phase captures its base; the controller may not.

## Phase model

| Phase          | Actions and durable outcomes                                                                                                                                                                                                                                      | Human or publication waits                                                                                                                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Triage         | `triageWorkItem` validates one immutable work item and records one route: direct implementation, planning, needs information, or park                                                                                                                             | Needs-information and parked routes wait without a runnable action                                                                                                                                              |
| Planning       | `producePlanCandidate` and `reviewPlanCandidate` alternate through explicit reactions; pass retains reviewed plan bytes                                                                                                                                           | `revise` resumes the planner session; `re-review` keeps candidate bytes; publication and merge acknowledgement are separate                                                                                     |
| Implementation | `produceImplementationCandidate` creates an immutable candidate; `reviewImplementationCandidate` authenticates cumulative implementation/quality evidence, asks change-review to run only missing roles, and promotes the exact commit only after a complete pass | `revise` resumes the implementer session; retry preserves completed roles for the exact candidate and reviewer contract; `re-review` keeps the candidate; PR publication and merge acknowledgement are separate |

Before the first review, only `revise` can replace a candidate. After a review,
`revise` changes candidate bytes through the original producer session;
`re-review` supplies accepted clarification or evidence and reviews the same
candidate without invoking the producer. Recording a continuation invokes no
handler. The next CLI invocation executes the selected reaction.

Factory does not enforce a review-round ceiling. A caller may stop automated
continuation by comparing its policy with durable `reviewRound`. That policy
must not alter Factory state or prevent a later explicitly authorized human
continuation.

## State and evidence ownership

| Owner                 | Authoritative content                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Target workspace      | Source, tests, `harness.json`, shim, inbox, transient planning draft, and Git materialization                                         |
| Durable Factory store | Work-item lifecycle JSONL, locks, rebuildable state, phase contexts, action evidence, results, prompts, streams, and review manifests |
| Git                   | Committed plans, implementation candidates, promoted branch history, and merge ancestry                                               |
| Linear                | Retryable issue statuses and concise marker comments for human coordination                                                           |
| GitHub                | Retryable pull-request publication for an already reviewed plan or implementation                                                     |

The default durable root is
`${XDG_DATA_HOME:-~/.local/share}/harness/store/projects/<repo-id>/`. Store
format markers reject incompatible or unmarked non-empty state; Harness does
not silently migrate or delete user data. Artifact refs are store-relative
paths plus SHA-256 hashes. Read `summary.md` and `meta.json` first, then follow
the referenced evidence rather than editing store contents.

## Projection boundaries

Linear-backed phase commands read the live issue but mutate Linear only when
that invocation carries explicit `--apply` authority. Durable state is written
before the corresponding status or comment projection so a later authorized
invocation can repair the projection without rerunning a provider.

Planning and implementation publication use a bounded Git/`gh` publisher only
after explicit publication authority. It pushes the reviewed branch and finds
or creates one pull request; it cannot merge. Merge acknowledgement verifies the
recorded URL and local ancestry before completing the phase. Plan publication
canonicalizes its generated Active queue entry and verifies the prepared commit
before calling GitHub.

PR-backed phases snapshot the target workspace's exact `HEAD` and attached
branch at phase start. The configured base ref names the pull-request target; it
is not re-resolved as execution authority. The caller must provision and verify
the accepted baseline before starting the phase.

Factory implementation review owns cumulative role checkpoints. Each retained
role is bound to the phase run, review round, candidate identity, snapshotted
reviewer profile, rendered prompt/output hashes, and current role contract.
`change-review` remains the subset executor and reports subset runs honestly as
partial; Factory publishes a complete review manifest only after both fixed
roles authenticate.

The constrained `factory linear create` command is intake, not a phase action.
Read-only list, fetch, status, and inspect surfaces do not derive or advance
Factory machine state.

## Grove workspace boundary

`lib/factory-grove-workspace.ts` owns Grove lease intent, acquisition, release,
and bounded repair. Factory remains Grove-agnostic and receives a workspace
path.

The caller supplies the exact base commit and a stable phase generation. Triage
uses a detached lease; planning and implementation use separate branches.
Compatible reacquisition reruns repository setup and returns the same path while
preserving Factory commits and candidate bytes.

Leases survive nonterminal waits and open pull requests. Release requires the
matching terminal Factory event and performs a non-forced reset to the recorded
base. Conflicts or uncertain cleanup require explicit repair or quarantine.

## Code ownership map

| Responsibility                      | Primary sources                                                                                                                     |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Command shells and manual reactions | `bin/factory-commands.ts`, `bin/factory-*-cli.ts`, `bin/factory-manual-command.ts`                                                  |
| Lifecycle contract and decisions    | `lib/factory-lifecycle-events.ts`, `lib/factory-lifecycle-kernel.ts`, `lib/factory-state-machine.ts`, `lib/factory-continuation.ts` |
| Durable identity and evidence       | `lib/factory-action-*.ts`, `lib/factory-artifact-ref.ts`, `lib/factory-phase-run.ts`, phase run-context modules                     |
| Planning actions                    | `lib/factory-plan-candidate-action.ts`, `lib/factory-plan-review-action.ts`, planning input/context modules                         |
| Implementation actions              | `lib/factory-implementation-candidate-action.ts`, `lib/factory-implementation-review-action.ts`, revision and Git-authority modules |
| Linear projections                  | `lib/factory-linear-adapter.ts`, `lib/factory-linear-*-apply.ts`, `lib/factory-linear-*-handoff.ts`                                 |
| Pull-request publication            | `lib/factory-*-publication*.ts`, `lib/factory-publication-git.ts`, `lib/factory-pull-request-publisher.ts`                          |
| Hosted workspace leases             | `lib/factory-grove-workspace.ts`                                                                                                    |
| Provider execution and prompts      | `providers/`, `workflows/`, `lib/prompts/factory-*.ts`                                                                              |

Keep lifecycle decisions in the reducer/reaction boundary, external mutations in
projection or publication adapters, and provider-specific behavior behind
provider adapters. Do not add a second workflow counter, scheduler, handler
registry, or tracker-derived state machine.

## Contributor checklist

When changing Factory:

- preserve one-action execution semantics;
- add focused lifecycle, recovery, Git-authority, or projection regressions at
  the smallest stable boundary;
- verify generated help when command options change;
- update `$factory-operator` only when agent operating behavior changes;
- update this guide only when the domain model or contributor ownership changes;
- update [Architecture](./architecture.md) only when subsystem relationships or
  repository boundaries change.
