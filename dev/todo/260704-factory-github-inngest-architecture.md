# Factory GitHub and Inngest architecture context

**Status:** open  
**Related todo:** [`dev/todo/260704-factory-adapters-orchestration.md`](./260704-factory-adapters-orchestration.md)  
**Related todo:** [`dev/todo/260704-factory-planner-station.md`](./260704-factory-planner-station.md)

## Purpose

Preserve the future architecture for using GitHub Issues as the tracker and
Inngest as the orchestrator backend.

This is not the next implementation slice. The next slice should stay focused
on provider session reuse and the single-item planner station. This document
describes how the factory can later move from local CLI dispatch to an
event-backed tracker/orchestrator setup without replacing the core harness
logic.

## Ownership model

Keep the split explicit:

```text
GitHub Issues = tracker / human surface
Inngest       = durable orchestrator / event backend
Harness       = factory brain / station logic
Agents        = reasoning workers
Repo          = durable implementation artifacts
```

GitHub owns visible work state:

- incoming ideas and issues
- labels or project status
- human questions and answers
- comments with summaries and links
- PR links
- discussion/history

Inngest owns execution:

- webhook event ingestion
- durable station runs
- retries
- concurrency and idempotency
- waits for human events
- resume signals when labels, comments, or PRs change

Harness owns factory logic:

- `FactoryWorkItem`
- `FactoryTriageOutput`
- `FactoryRoutePlan`
- route validation
- station transitions
- planner/reviewer/implementation schemas
- prompts
- provider/session handling
- artifact layout

Agents own reasoning:

- triage recommendation
- plan text
- review finding decisions
- implementation output
- review output

Agents should not directly move issues. They output structured results. Harness
validates those results. Adapter code applies deterministic tracker updates.

```text
Agent JSON -> Zod parse -> route/transition plan -> deterministic adapter update
```

## What GitHub replaces

GitHub replaces the local file-backed source and visible state surface.

Current local surface:

```text
.harness/inbox/factory/*.json
.harness/inbox/factory/processed/*
.harness/inbox/factory/failed/*
harness factory status
harness factory dispatch
```

Future GitHub-backed surface:

```text
GitHub issue opened/labeled
  -> GitHub adapter builds FactoryWorkItem
  -> harness station runs
  -> GitHub adapter applies labels/comments/project updates
```

GitHub should not replace:

- `FactoryWorkItem`
- `FactoryTriageOutput`
- `FactoryRoutePlan`
- `factory-triage` prompt/workflow
- planner station logic
- review workflows
- deterministic transition logic

GitHub adapter responsibilities:

- read issue title/body/labels/comments/project state
- build a `FactoryWorkItem`
- map harness station state to issue labels or project fields
- write comments with concise summaries and artifact links
- link plans, branches, and PRs back to the issue
- avoid duplicate comments through idempotency keys or hidden markers

## What Inngest replaces

Inngest replaces manual polling/dispatch, not harness workflows.

Today:

```bash
harness factory dispatch
```

Future:

```text
github.issue.opened webhook
  -> inngest event
  -> run factory triage station
  -> emit next event
  -> run planner station if ready-to-plan
```

The low-level primitives should still exist:

```bash
harness run factory-triage --item-file item.json
harness factory plan --item-file item.json
harness run plan-review --plan dev/plans/example.md
```

Inngest calls the same internal code behind those commands from a durable
backend. It should not own business rules about whether an issue is ready to
plan, ready to implement, needs info, or parked.

Inngest responsibilities:

- receive GitHub webhook events
- enqueue station runs
- enforce one active station per work item
- retry transient failures
- record durable run ids and status
- wait for human input events
- resume the next station after labels/comments/PR events
- emit audit events for observability

## Artifact ownership

Keep durable artifacts in the repo or harness artifact storage. GitHub comments
should point to artifacts, not become the artifact store.

Plan artifacts:

```text
draft iterations:
  .harness/runs/factory/<run-id>/iterations/*

final approved plan:
  dev/plans/YYMMDD-<tracker-key>-short-slug.md
  dev/plans/YYMMDD-short-slug.md              # local/manual fallback

plan-review artifacts:
  .harness/runs/reviews/<run-id>/
```

The repo file is the canonical approved plan. The tracker issue is an index and
state surface. Do not make a GitHub issue body/comment the source of truth for
the full plan.

Implementation artifacts:

```text
branch:
  factory/<issue-number>-short-slug

PR:
  links issue
  includes plan link
  includes review summary
```

GitHub issue comments should contain concise status summaries:

```text
Factory plan approved.

Plan: dev/plans/260707-gh-123-export-shortcut.md
Run: .harness/runs/factory/20260704-...
Next: ready-to-implement
```

## Metadata contract

Before adding tracker adapters or Inngest functions, keep one metadata contract
that connects tracker item -> factory station -> approved plan ->
implementation. This belongs on `FactoryWorkItem.metadata` and run `meta.json`.
Adapters may add provider-specific keys, but these names are reserved:

```json
{
  "tracker": {
    "source": "github",
    "id": "owner/repo#123",
    "url": "https://github.com/owner/repo/issues/123"
  },
  "factoryRoute": "ready-to-plan",
  "factoryNextAction": "create-plan",
  "factoryStage": "plan-approved",
  "factoryRunId": "20260707-120000",
  "approvedPlanPath": "dev/plans/260707-gh-123-export-shortcut.md",
  "approvedPlanCommit": "abc1234"
}
```

Field meaning:

- `tracker`: original external work item identity. This is optional for local
  file/manual items.
- `factoryRoute`: triage route such as `ready-to-plan`.
- `factoryNextAction`: deterministic next action such as `create-plan`.
- `factoryStage`: current station stage, independent of tracker labels/status.
- `factoryRunId`: latest harness factory run that changed the item.
- `approvedPlanPath`: canonical repo-relative plan path after approval.
- `approvedPlanCommit`: optional commit pin once the plan is committed.

Implementation should resolve `approvedPlanPath`, verify the file exists, and
prefer `approvedPlanCommit` when present. If the tracker says a plan is approved
but the path is missing or stale, fail closed instead of guessing.

If factory workers run outside the developer machine, `.harness/runs/*` needs a
durable backend. Options:

- upload run artifacts to CI/Inngest object storage
- commit selected artifacts only when useful
- attach small summaries to GitHub comments and keep large logs elsewhere

Do not put full run logs, full plans, or reviewer transcripts into issue
comments by default.

## Issue movement

Harness computes state transitions. GitHub applies them.

Initial issue triage:

```text
issue opened or labeled factory:inbox
  -> factory:triaging
  -> one of:
       factory:ready-to-implement
       factory:ready-to-plan
       factory:needs-info
       factory:wait-to-implement
```

Suggested label mapping:

```text
ready-to-implement -> factory:ready-to-implement
ready-to-plan      -> factory:ready-to-plan
needs-info         -> factory:needs-info
wait-to-implement  -> factory:wait-to-implement
```

Suggested comment behavior:

- `ready-to-implement`: post triage summary and expected next action
- `ready-to-plan`: post triage summary and planner station link when started
- `needs-info`: post required questions and wait for human response
- `wait-to-implement`: post rationale and `reconsiderWhen`

Planner station movement:

```text
factory:ready-to-plan
  -> factory:planning
  -> factory:plan-reviewing
  -> one of:
       factory:plan-approved
       factory:plan-needs-human
       factory:plan-review-unresolved
       factory:planning-failed
```

On `factory:plan-approved`, the next transition is:

```text
factory:plan-approved
  -> factory:ready-to-implement
```

If GitHub Projects is available, project status can own the canonical stage and
labels can be reduced to routing/filtering labels. Without Projects, labels are
enough for a first GitHub adapter.

## Human input flow

`needs-info` and `plan-needs-human` are wait states.

Example:

```text
factory:needs-info
  -> GitHub comment asks questions
  -> Inngest waits for issue_comment.created or label change
  -> GitHub adapter rebuilds FactoryWorkItem with new comments
  -> triage reruns
```

Do not let Inngest infer answer quality. It should resume the appropriate
harness station. The station decides whether the new information is enough.

## Idempotency

Every external update should be idempotent.

Use stable keys:

```text
workItemId: github:<owner>/<repo>#<issue-number>
station: factory-triage | factory-plan | implementation | review
runId: harness run id
transitionId: <workItemId>:<station>:<source-event-id>
```

GitHub comments should include a hidden marker or stored metadata equivalent:

```html
<!-- harness-factory:triage:20260704-123456 -->
```

This prevents duplicate comments on retries.

## Local fallback

Keep the local inbox path useful even after GitHub/Inngest exists:

```text
file inbox adapter -> FactoryWorkItem -> same harness stations
GitHub adapter     -> FactoryWorkItem -> same harness stations
Linear adapter     -> FactoryWorkItem -> same harness stations
```

This keeps development, tests, and recovery simple. The factory should not
require GitHub or Inngest to run one work item end to end.

## Open questions

1. Should GitHub labels or GitHub Projects be the canonical issue stage?
2. Where should cloud-run `.harness/runs/*` artifacts live: object storage, CI
   artifacts, or selected repo commits?
3. What is the minimum comment policy that keeps humans informed without noisy
   issue spam?
4. Should approved plans be committed directly to the implementation branch, a
   separate planning PR, or both depending on task size?
5. How should Inngest lock a work item so two events do not run competing
   stations?
6. What is the retry policy for failed agent/provider runs vs deterministic
   schema failures?
7. Which tracker fields/comments should map back into the reserved
   `FactoryWorkItem.metadata` keys on reruns?
8. Should `ready-to-implement` automatically start implementation, or should it
   wait for a human/applied label in early versions?
