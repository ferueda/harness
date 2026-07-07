# Factory planning station context

**Status:** open  
**Related plan:** [`dev/plans/260704-factory-intake-routing.md`](../plans/260704-factory-intake-routing.md)  
**Related todo:** [`dev/todo/260704-factory-adapters-orchestration.md`](./260704-factory-adapters-orchestration.md)

## Purpose

Preserve the design decisions for the next factory slice before implementation.
The target slice is the planning station that consumes a `ready-to-plan` work
item, produces an approved implementation plan, and keeps the original planner
agent responsible for responding to plan-review feedback.

This document is context, not an implementation plan. Convert it into a scoped
`dev/plans/` artifact before coding.

## Factory boundary and naming

Keep this mental model:

```text
harness run     = low-level workflow primitive
harness factory = operator / queue / station orchestration
```

Use "station" for lifecycle places where agent work happens:

```text
triage station
planning station
implementation station
review station
PR station
```

`harness run <workflow>` names low-level executable workflows. These workflows
do not all need a `factory-` prefix because not every workflow is a factory
station:

```text
factory-triage = low-level workflow backing the triage station
plan-review    = reusable review gate used by the planning station
change-review  = reusable review gate used outside and inside factory flows
```

`plan-review` and `change-review` are gates/coordinators, not station names.
The future factory review station can call `change-review`, but the workflow
itself should stay reusable.

`harness factory <...>` should name station operations explicitly. During this
initial development phase, run stations for one work item at a time:

```bash
harness factory status

harness factory triage --item-file item.json
harness factory planning run --item-file item.json
```

Rules:

- Use station nouns under `harness factory`: `triage`, `planning`,
  `implementation`, `review`, `pr`.
- Use `harness factory <station> --item-file ...` for one item through one
  station.
- Keep `harness factory status` for current local factory visibility. Let it
  evolve later when there is a broader backend/state index.
- Do not add local inbox batch station commands for now. Be explicit while the
  station contracts are still being shaped.
- Avoid generic verbs like `dispatch`. They hide which work item and which
  station are involved.
- Avoid `harness factory plan`; use `harness factory planning` so the command
  names the station, not just the artifact produced by the station.

Current `harness factory dispatch` should be replaced, not extended. It was the
PR 2 local-inbox batch command for:

```text
run all pending local inbox items through the triage station
```

Do not maintain legacy aliases while the API is still early. Prefer a clean
surface now over compatibility with an experimental command.

## Current shipped state

PR 1 and PR 2 shipped the intake and local inbox foundation:

- `FactoryWorkItem`
- `FactoryTriageOutput`
- `FactoryRoutePlan`
- `harness run factory-triage`
- `harness factory status`
- `harness factory dispatch` for local inbox triage batch processing
- local inbox state:
  - pending: `.harness/inbox/factory/*.json`
  - processed: `.harness/inbox/factory/processed/*`
  - failed: `.harness/inbox/factory/failed/*`

The factory triage routes are:

```text
ready-to-implement
ready-to-plan
needs-info
wait-to-implement
```

`processed/` means the current `dispatch` command ran the triage station for
this inbox file. It does not mean implementation is complete. The next API
cleanup should remove or replace this batch concept instead of building on it.

## Problem to solve next

Today, when an agent writes a plan manually, the same agent:

1. Understands the request.
2. Writes a `dev/plans/` artifact in the plan format.
3. Runs `harness run plan-review --plan <path>`.
4. Reads findings.
5. Decides which findings to implement, adapt, or decline.
6. Revises the plan.
7. Reruns plan review until satisfied.

That works because the planner keeps the task context. A factory design that
splits "write plan," "review plan," and "fix plan" into unrelated stateless
stations would lose that benefit.

The next slice should preserve planner ownership while making the loop
deterministic and durable.

## Desired planning station

The factory planning station should handle:

```text
ready-to-plan work item
  -> planner writes initial plan
  -> harness runs plan-review
  -> planner receives review findings
  -> planner decides implement/adapt/decline for each finding
  -> planner edits draft in place + outputs decision rationale
  -> harness runs plan-review again when needed
  -> plan-approved | plan-needs-human | plan-review-unresolved | planning-failed
```

Initial CLI shape:

```bash
harness factory planning run --workspace /path/to/repo --item-file work-item.json
```

Likely options:

```bash
--max-review-iterations 3
--output-plan dev/plans/YYMMDD-short-slug.md
--max-runtime-ms <ms>
--dry-run
--verbose
```

Do not add inbox batch planning. First make one explicit work item work end to
end. Later, GitHub/Linear/Inngest can trigger the same station per event/work
item.

## Agent and model selection

Factory stations should be config-first for agent/model selection. Do not add
per-role CLI flags like `--planner-agent`, `--planner-model`,
`--review-agent`, or `--review-model` in the first implementation. Keep factory
station commands focused on operational inputs:

```bash
--workspace
--item-file
--max-review-iterations
--output-plan
--max-runtime-ms
--dry-run
--verbose
```

Low-level workflow primitives can keep their existing direct overrides:

```bash
harness run plan-review --agent codex --model gpt-5.5
harness run factory-triage --agent cursor --model claude-opus-4-8
```

That preserves the escape hatch for direct workflow execution without making the
station API flag-heavy.

Use role blocks under `factory` in `harness.json`:

```json
{
  "defaultAgent": "cursor",
  "agents": {
    "cursor": {
      "model": "composer-2.5"
    },
    "codex": {
      "model": "gpt-5.5",
      "modelReasoningEffort": "high",
      "sandboxMode": "read-only",
      "approvalPolicy": "never"
    }
  },
  "factory": {
    "triage": {
      "roles": {
        "triager": {
          "agent": "cursor",
          "model": "claude-opus-4-8"
        }
      }
    },
    "planning": {
      "maxReviewIterations": 3,
      "roles": {
        "planner": {
          "agent": "cursor",
          "model": "claude-opus-4-8"
        },
        "reviewer": {
          "agent": "codex",
          "model": "gpt-5.5",
          "modelReasoningEffort": "high"
        }
      }
    }
  }
}
```

Naming rules:

- `agent` = executable backend identity, currently `cursor` or `codex`.
- `role` = job inside a station, such as `triager`, `planner`, `reviewer`, or
  later `implementer`.
- `station` = lifecycle step, such as `triage`, `planning`, `implementation`,
  `review`, or `pr`.
- Keep existing top-level `defaultAgent` and `agents.*` names.
- Use `roles` for every station, even single-role stations. This avoids a
  special case where triage uses `agent` as a role while planning uses
  `planner` / `reviewer`.
- Use `triager` for the triage role. Do not use `agent`, because `agent` is the
  backend selection field inside every role. Do not use `triage`, because that
  is the station name.
- Use `provider` or `agentProvider` only internally if needed. The public config
  should consistently use `agent`.

Resolution per role:

```text
role.agent
  -> defaultAgent
  -> cursor

role.<field>
  -> agents.<role.agent>.<field>
  -> selected agent hardcoded defaults
```

Important detail: when a role sets `agent`, that role inherits from
`agents.<agent>`, not from `agents.<defaultAgent>`. For example, if
`factory.planning.roles.reviewer.agent` is `codex`, the reviewer inherits
`agents.codex.modelReasoningEffort` even when `defaultAgent` is `cursor`.
`defaultAgent` is used only when the role omits `agent`.

Codex planning has one special default: `factory.planning.roles.planner` needs
to write `planning/draft.md`, so a Codex planner defaults to
`sandboxMode: "workspace-write"` unless the planner role explicitly sets a
different sandbox. Codex reviewers and other Codex roles can remain read-only.

Do not overload current `resolveHarnessOptions` for this. Add a small per-role
resolver that returns one resolved bundle per station role:

```ts
type FactoryRoleAgent = {
  agent: AgentProviderName;
  model?: string;
  codexPathOverride?: string;
  sandboxMode?: AgentSandboxMode;
  approvalPolicy?: AgentApprovalPolicy;
  modelReasoningEffort?: AgentReasoningEffort;
};
```

The resolver may map config `agent` to the internal `agentProvider` field, but
that mapping should not leak into public config.

Schema rules:

- Add a typed `factory` schema. Do not rely on broad `.passthrough()` for
  factory station config.
- Enumerate station role keys explicitly under `roles`:
  - `triage.roles`: `triager`
  - `planning.roles`: `planner`, `reviewer`
- Treat station-level settings like `maxReviewIterations` as reserved siblings
  of `roles`.
- Reject unknown role keys such as `reviwer`.
- Reject unknown station keys, unknown role keys, and unknown fields in the
  `factory` block.
- Reject invalid agents.
- Reject Codex-only fields on non-Codex roles:
  - `executable`
  - `sandboxMode`
  - `approvalPolicy`
  - `modelReasoningEffort`
- Preserve current behavior when `factory` is absent. Existing repos should
  still resolve from `defaultAgent` and `agents.*`.
- Prefer early validation for Cursor models against `CURSOR_SDK_MODEL_MODES`.
  Codex model validation can remain permissive because availability is external.

## What harness owns vs what planner owns

Harness owns deterministic loop control:

- invoke planner provider turn
- write plan artifacts
- run `plan-review`
- parse reviewer verdict and findings
- pass review findings back to the planner
- persist events and per-iteration artifacts
- enforce max review iterations
- stop on pass, human-needed, provider failure, invalid output, or max
  iterations

Planner owns judgment:

- plan content
- whether a reviewer finding should be implemented, adapted, or declined
- rationale for declined or adapted findings
- whether human input is needed

Reviewers provide evidence; they do not directly mutate the plan. Harness should
not blindly apply every review finding.

## Loop control

Harness should make only mechanical decisions:

```text
if plan-review verdict == pass:
  stop as plan-approved

if plan-review verdict == needs_changes:
  call the same planner session with review findings

if plan-review verdict == blocked:
  stop as plan-needs-human

if plan-review workflow fails:
  stop as planning-failed

if planner outcome == needs-human:
  stop as plan-needs-human

if planner outcome == draft-ready:
  run plan-review again

if max iterations reached:
  stop as plan-review-unresolved

if planner output invalid or provider fails:
  stop as planning-failed
```

`--max-review-iterations` should count plan-review executions, not planner
turns. Iteration `001` is the first draft plan plus first plan-review run. When
the iteration budget is exhausted and the latest completed plan-review verdict
is still `needs_changes`, stop as `plan-review-unresolved`.

The planner should be required to respond to review findings on revision
iterations:

```json
{
  "findingId": "spec-001",
  "decision": "implement",
  "rationale": "Added explicit verification gates for the changed CLI behavior."
}
```

Allowed decisions:

```text
implement
adapt
decline
```

If the planner declines an advisory finding, it must explain why. The next
`plan-review` sees the revised plan and rationale and can either pass or keep
objecting.

## Finding identity

Current review findings do not include ids. `ReviewOutputSchema` findings use:

```text
title
severity: Critical | High | Medium | Low
location
issue
recommendation
rationale
must_fix
```

The planning station should synthesize stable finding ids before sending
findings back to the planner. For `plan-review`, use the single review step name
plus the ordered finding index:

```text
spec-001
spec-002
spec-003
```

The synthetic id exists only in the factory planning loop. Do not change the
review schema in the first slice unless implementation proves local ids are too
fragile.

## Planner output contract

Decision after review: planning is a document workflow, not a pure structured
output workflow. Triage should stay structured JSON because it is
classification/routing. Planning should use a draft file for the markdown plan
and structured JSON only for small metadata.

The old design required the planner to return full `planMarkdown` and a
`shortSlug` on every pass. Decline that design:

- It makes long markdown a JSON payload.
- It forces the revision pass to reserialize the full plan.
- It tempts the harness to resend the previous full plan even though the same
  planner session already has context.
- It does not match the manual planning workflow, where the planner edits the
  plan file in place.

The better boundary:

- Harness creates one draft path per factory planning run:

  ```text
  .harness/runs/factory/<run-id>/planning/draft.md
  ```

- Planner writes/edits only that draft path.
- Planner returns only small structured metadata.
- Harness snapshots the draft after every planner turn.
- `plan-review` reviews the snapshot, not the live draft.
- Harness owns the final copy to `dev/plans/`. Tracker-backed planning should
  publish that copy through a plan PR before the tracker item is considered
  ready to implement.
- Harness derives the default final filename slug from the work item title/id;
  the planner does not output filenames.

Initial planner input:

- Work item JSON.
- Draft path to write.
- Current date.
- Planning instructions and output schema.

Initial planning output:

```json
{
  "outcome": "draft-ready",
  "summary": "Created an implementation plan for the work item.",
  "humanQuestions": [],
  "findingDecisions": []
}
```

Revision planner input:

- Draft path to edit in place.
- Latest review findings with synthetic ids.
- Output schema.
- No previous full plan markdown.
- No repeated full work item JSON unless we later find provider session reuse is
  unreliable.

Revision output:

```json
{
  "summary": "Addressed review findings around session reuse.",
  "outcome": "draft-ready",
  "humanQuestions": [],
  "findingDecisions": [
    {
      "findingId": "spec-001",
      "decision": "adapt",
      "rationale": "Kept session reuse in scope but deferred portable replay fallback."
    },
    {
      "findingId": "spec-002",
      "decision": "decline",
      "rationale": "The abstraction has one caller in this slice; adding a registry now is premature."
    }
  ]
}
```

Possible planner statuses:

```text
draft-ready
needs-human
```

The factory station translates those into station states.

Minimum guardrails for letting the planner write the draft:

- Prompt says to mutate only the draft path.
- Harness validates the draft exists, is a file, and is non-empty before each
  snapshot.
- Harness snapshots to `iterations/<n>/plan.md` before review.
- Harness compares tracked Git status before and after each planner turn, when
  the workspace is a Git repository, and fails if tracked source changes.
- Harness final `dev/plans` write is a deterministic copy after approval, not a
  planner write.

Defer hard provider-level writable-root enforcement to a separate slice. It is
desirable, but the first PR can use post-turn validation and Git status checks.

## Station states

Keep the first planning station state set small:

```text
planning
plan-reviewing
plan-needs-revision
plan-approved
plan-needs-human
plan-review-unresolved
planning-failed
```

Plan-review outcome mapping:

| Outcome                                    | Harness action                              | Station state            |
| ------------------------------------------ | ------------------------------------------- | ------------------------ |
| `pass`                                     | Stop                                        | `plan-approved`          |
| `needs_changes` and iterations remain      | Reinvoke same planner session with findings | `plan-needs-revision`    |
| `needs_changes` and max iterations reached | Stop                                        | `plan-review-unresolved` |
| `blocked`                                  | Stop for human input                        | `plan-needs-human`       |
| workflow/provider/schema failure           | Stop as failed                              | `planning-failed`        |

Do not add implementation, code review, PR, Linear, GitHub, or Inngest state in
this slice.

## Session reuse

We want the same planner agent to handle the initial plan and revisions.

Current harness reality:

- `AgentRunResult` has `sessionId`.
- Cursor adapter returns `sessionId: sdkAgent.agentId`.
- Codex adapter returns `sessionId: thread.id`.
- `AgentRunInput` does not accept a session/thread id.
- Cursor adapter currently creates a fresh SDK agent for every run and disposes
  it.
- Codex adapter currently starts a fresh thread for every run.

Provider capabilities confirmed from SDK docs:

- Cursor TypeScript SDK:
  - An `Agent` is a durable container for conversation state.
  - `agent.agentId` is populated immediately.
  - Local agents use `agent-` ids; cloud agents use `bc-` ids.
  - `agent.send()` preserves conversation context across runs on the same
    handle.
  - `Agent.resume(agentId)` returns a fresh handle to an existing agent.
  - Runtime is inferred from the id prefix.
  - Local agents persist metadata, conversation checkpoints, runs, and run
    events to an on-disk store by default, so `Agent.resume(agentId)` can work
    from a new process.
  - `AgentOptions.agentId` can be passed to keep a stable id across invocations.
- Codex TypeScript SDK:
  - `thread.run(...)` can be called repeatedly on the same `Thread` instance to
    continue the conversation.
  - Threads are persisted in `~/.codex/sessions`.
  - `codex.resumeThread(savedThreadId)` reconstructs a lost in-memory thread.
  - Codex requires the working directory to be a Git repository by default;
    `skipGitRepoCheck` can bypass that check when starting a thread.

Both providers support the session-resume model we need. Harness has not wired
that capability into the shared `AgentRunInput` abstraction yet.

Required harness abstraction before the planning station:

```ts
type AgentSessionRef = {
  provider: "cursor" | "codex";
  id: string;
};

type AgentRunInput = {
  // existing fields...
  session?: AgentSessionRef;
};

type AgentRunResult = {
  // existing fields...
  session?: AgentSessionRef;
};
```

This should replace result-level `sessionId?: string`, not create a second
source of truth. If compatibility requires an intermediate step, keep that step
small and remove `sessionId` once adapters and callers return `session`.

Provider mapping:

- Codex:
  - no session -> `codex.startThread(...)`
  - session -> `codex.resumeThread(session.id)`
  - expose `resumeThread` through the local `CodexClient` wrapper first
  - preserve existing thread options such as `workingDirectory`, model,
    sandbox, approval policy, and reasoning effort on resumed turns where the
    SDK accepts them
  - keep the Git repository requirement by default; only expose
    `skipGitRepoCheck` later if the factory intentionally supports non-Git
    scratch workspaces
- Cursor:
  - no session -> create new local SDK agent
  - session -> `Agent.resume(session.id, ...)`
  - pass the same local store/default configuration used when the agent was
    created, if harness ever moves away from the SDK default store
  - keep disposing handles after each run; the durable state lives in the SDK
    checkpoint store, not in the JavaScript object

The planner workflow should persist the planner session ref in run artifacts:

```json
{
  "plannerSession": {
    "provider": "cursor",
    "id": "agent-123"
  }
}
```

If the first planner turn returns no session id, or if session resume fails,
fail clearly as `planning-failed`. Do not implement context replay fallback in
the first slice unless provider resume proves unreliable and we intentionally
change scope.

## Artifact layout

Candidate layout:

```text
.harness/runs/factory/<run-id>/
  context/work-item.json
  planning/
    draft.md
  planner-session.json
  iterations/
    001/
      planner.prompt.md
      planner.raw.json
      planner.json
      plan.md
      plan-review/
        meta.json
        summary.md
        spec-review.json
    002/
      planner.prompt.md
      planner.raw.json
      planner.json
      plan.md
      plan-review/
        meta.json
        summary.md
        spec-review.json
  plan.md
  meta.json
  summary.md
```

Open decision: whether `plan-review` should support nested run directories
directly, or whether the factory planning station should copy/point to normal
`.harness/runs/reviews/<run-id>/` artifacts.

Preference: start by referencing normal plan-review run directories. Copying
review artifacts can come later if needed.

## Plan file location

The final approved plan should be written to:

```text
dev/plans/<tracker-key>.md                    # tracker-backed default, e.g. FER-123.md
dev/plans/YYMMDD-short-slug.md
dev/plans/YYMMDD-<tracker-key>-short-slug.md  # optional explicit override
```

For tracker-backed work, the default filename should be the tracker key so the
artifact is stable and obvious, for example `dev/plans/FER-123.md`. For local
or manual work, default `short-slug` is harness-derived from the work item
title, falling back to the work item id. `--output-plan` remains the explicit
operator override.

The approved plan path is the canonical implementation input only after it is
committed/merged. Tracker issues should point to the path and plan PR through
comments/fields; they should not store the full plan as the source of truth.
Linear should move planned work to `Ready to Implement` only after the plan PR
has merged.

Open decision: whether draft iterations should write directly to `dev/plans/`
or stay only under `.harness/runs/factory/<run-id>/` until approved.

Preference for first slice:

- Keep iterations under `.harness/runs/factory/<run-id>/`.
- Pass `harness run plan-review --plan` the iteration snapshot under
  `.harness/runs/factory/<run-id>/iterations/<n>/plan.md`.
- Write final plan to `dev/plans/` only after `plan-approved`.
- For tracker-backed runs, open a plan PR and wait for merge before treating
  the work item as `Ready to Implement`.

This avoids leaving unapproved plan churn in tracked source.

Provider workspace guards should run around agent turns, not around harness
artifact writes. The planning station must write `.harness` iteration artifacts
outside the guarded provider call so those writes do not make the provider run
look like it mutated the workspace.

## Station metadata contract

The planner station should preserve and update reserved factory metadata in run
`meta.json` so future tracker adapters and implementation stations can continue
without reinterpreting comments or filenames:

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
  "approvedPlanPath": "dev/plans/GH-123.md",
  "approvedPlanPrUrl": "https://github.com/owner/repo/pull/123",
  "approvedPlanCommit": "abc1234"
}
```

`approvedPlanPrUrl` is present while the plan PR is open. `approvedPlanCommit`
is required before planned work moves to `Ready to Implement`. The
implementation station should fail closed when metadata points to a missing
plan, and should prefer the commit pin when it exists.

## Dry-run behavior

Dry-run should not call providers and should not run live plan-review providers.
It can create placeholder planner output and show the intended artifact layout.

Dry-run should not write a final plan to `dev/plans/` unless explicitly forced
by a future option.

## Relation to Warp/Oz factory demo

The Warp/Oz demo skill models:

```text
new issue -> Oz triage -> Ready to spec label -> Oz spec -> PRODUCT.md + TECH.md PR -> Oz implementation -> pull request
```

Important patterns to preserve:

- triage is read-only
- deterministic code applies labels/comments
- spec/planning is a separate station after triage
- implementation reads the approved spec/plan
- implementation opens a PR but does not merge it

Our equivalent differs intentionally:

- Use `ready-to-plan`, not `ready-to-spec`, because this harness already has a
  broader planning workflow.
- Use one `dev/plans/*.md` implementation plan first, not `PRODUCT.md` +
  `TECH.md`.
- Use `harness run plan-review` as the review gate.
- Keep planner ownership of reviewer-finding decisions.

## Proposed implementation sequence

Do not jump straight to a full planning station. Build the enabling slices:

1. **Factory role config**
   - Add typed `factory` config schema with `triage.roles.triager` and
     `planning.roles.planner` / `planning.roles.reviewer`.
   - Add a per-role resolver instead of overloading flat `resolveHarnessOptions`.
   - Validate Codex-only fields only appear on Codex roles.
   - Preserve current fallback behavior when `factory` is absent.
   - Keep agent/model selection config-first for factory stations.

2. **Provider session continuation**
   - Add `AgentSessionRef` to `AgentRunInput` and `AgentRunResult`.
   - Replace or migrate result-level `sessionId` so there is one session field.
   - Implement Codex `resumeThread`.
   - Implement Cursor `Agent.resume`.
   - Add tests proving a second run passes the same provider session.
   - Add at least one live smoke test for each provider proving follow-up
     context survives a fresh harness run/process when credentials are present.

3. **Factory planning station, one item**
   - Add `harness factory planning run --item-file`.
   - Add planner output schema.
   - Add planner prompt based on `create-plan` principles.
   - Write per-iteration artifacts.
   - Invoke `plan-review`.
   - Reinvoke the same planner session when review needs changes.
   - Stop on `plan-approved`, `plan-needs-human`, `plan-review-unresolved`, or
     `planning-failed`.

4. **Operating skill**
   - Only after runtime behavior exists, package a skill explaining how to run
     factory intake and factory planning.

5. **Event-backed station triggering**
   - After single-item stations work, GitHub/Linear/Inngest can trigger
     stations per work item. Do not add local inbox batch planning first.

## Explicit non-goals for this slice

- Do not add GitHub/Linear/Jira adapters.
- Do not add Inngest.
- Do not add implementation station.
- Do not add PR creation station.
- Do not add code review station.
- Do not build a full lifecycle state machine.
- Do not add PRODUCT.md/TECH.md split unless a later plan chooses that model.
- Do not let planner agents mutate tracked files directly.

## Open questions for review

1. Should provider session continuation be implemented as a generic agent
   abstraction before the planning station, or should the planning station call
   provider-specific APIs directly?
2. How much plan PR automation belongs in the first Linear planning apply slice?
3. Should `plan-review` artifacts remain in normal review run directories, or
   be nested/copied under the factory run directory?
4. What should happen when the planner declines a must-fix finding and the
   reviewer keeps returning `needs_changes` until max iterations?
5. Should live factory planning runs keep Codex's default Git workspace
   requirement, or expose `skipGitRepoCheck` for non-Git scratch workspaces?

## Cursor review triage

Cursor reviewed this artifact in session
`86c00b75-1d45-40b4-a0a9-a95dfd2df69d` with model
`claude-opus-4-8-thinking-high`.

Accepted findings:

- Add `blocked` and workflow-failed outcomes to loop control.
- Add synthetic finding ids because reviewer findings do not currently include
  ids.
- Reconcile `sessionId` with the proposed `AgentSessionRef`.
- Confirm Cursor local session resume through SDK docs and implement with
  `Agent.resume`.
- Define no-session-id handling for Codex and Cursor.
- State that plan-review reads draft plans from `.harness` iteration artifacts.
- Define max-iteration counting.

Declined or deferred findings:

- Do not add ids to `ReviewOutputSchema` in this slice. Synthetic ids are enough
  for the planner loop and avoid changing all reviewers now.
- Do not add context-replay fallback yet. The current direction is to prove
  provider session reuse first and fail clearly if it is unavailable.

## Cursor role-config review triage

Cursor reviewed the agent/model selection direction in session
`16460a23-f9a5-4cf3-be9e-d1dd183420a1` with model
`claude-opus-4-8-thinking-high`.

Accepted findings:

- Use config-first role blocks and avoid per-role factory CLI flags.
- Use `factory.<station>.roles.<role>.agent` instead of the older
  `provider`-based shape.
- Use `triager` as the triage role name.
- Keep station settings like `maxReviewIterations` as strict siblings of
  `roles`; do not add a `settings` wrapper yet.
- Add typed `factory` config validation; do not let misspelled station/role
  keys silently fall through `.passthrough()`.
- Add a per-role resolver instead of overloading current flat
  `resolveHarnessOptions`.
- Resolve each role through its own selected agent's `agents.*` config.
- Reject Codex-only fields on non-Codex roles during config validation.
- Enumerate role keys per station so station-level settings cannot be confused
  with roles.
- Preserve current behavior when the `factory` block is absent.

Declined or deferred findings:

- Do not add per-role CLI agent/model overrides now. Low-level `harness run`
  workflows keep their existing overrides as the escape hatch.
- Do not build a generic profile or policy system yet. Role blocks are enough
  for triage and planning.
- Cursor model enum validation is useful, but can be handled as part of the
  typed config slice rather than blocking this context document.
