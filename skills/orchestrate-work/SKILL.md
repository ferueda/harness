---
name: orchestrate-work
description: Delegate substantial work to an isolated Codex executor while the current task retains user-authorized scope and review control.
disable-model-invocation: true
---

# Orchestrate Work

Coordinate one substantial Codex executor task from the current Codex task. The
executor owns implementation inside its isolated worktree. The orchestrator
stays read-only there and steers within the user's accepted authority.

## 1. Gate and divide ownership

Run only after the user explicitly requests this skill or a separate Codex task
with the current task acting as orchestrator. For an ordinary implementation
request, work in the current task.

Fill every bracketed field in the canonical delegation block before creating the
executor. The user authorizes the goal, material boundaries, product and
architecture changes, destructive actions, and external publication. The
orchestrator may steer and triage only inside that accepted authority; any new
authority returns to the user.

The executor owns edits, commits, verification, and requested review work in
its isolated worktree and branch. The orchestrator owns read-only inspection,
in-bound steering, review triage, and acceptance recommendations.

An explicit request to open a pull request also authorizes the branch push it
requires. It does not authorize merge.

Use `handoff-work` for the initial context shape: status, authority and goal,
current state, verification, then only relevant adaptations, files, next steps,
and open items. Point to durable sources instead of copying them.

**Done when:** the goal, authority, repository, expected branch and exact commit,
mutation sandbox, non-goals, verification, completion criteria, and publication
authority are explicit.

## 2. Bootstrap and verify the executor

Confirm that project discovery, task creation, task inspection, and task
messaging are available. Report `blocked` when the host cannot provide this
minimum channel.

1. Use `codex_app__list_projects`; select the project matching the repository.
   Report `blocked` if project identity is missing or ambiguous.
2. Resolve the expected branch and exact commit from the authoritative
   repository state. Use `codex_app__create_thread` with the matching project, a
   fresh worktree, the completed canonical delegation block, and the
   `handoff-work` handoff. Omit a starting state unless the user explicitly
   names an existing Git state. Omit model and reasoning overrides unless the
   user explicitly requests them.
3. Record the returned executor task ID. If creation returns only a queued
   client ID, resolve the actual task through verified task results before
   steering it. Use `codex_app__set_thread_title` for a useful title, then
   `codex_app__read_thread` or `codex_app__list_threads` to verify the intended
   project and worktree.
4. Require the first before-edit checkpoint to report its actual branch and
   `git rev-parse HEAD`. Pause on any mismatch with the expected baseline rather
   than changing Git state implicitly.
5. Prove both callback directions. A Codex-created executor receives the prompt
   inside a `<codex_delegation>` envelope; its verified `<source_thread_id>` is
   the parent task ID. The executor sends its first checkpoint there with
   `codex_app__send_message_to_thread`; the orchestrator replies to the verified
   executor task ID. If the parent ID is absent, obtain it from verified Codex
   task metadata before continuing.

Keep the two directions distinct:

| Direction                | Verified destination                                       |
| ------------------------ | ---------------------------------------------------------- |
| Executor to orchestrator | Parent ID from the executor's delegation envelope          |
| Orchestrator to executor | Executor ID returned by task creation, listing, or reading |

A callback displayed in the parent carries the executor's ID as its source.
That confirms the sender; it is not the parent ID. Use a `hostId` only when a
Codex result verifies it and the destination requires it. Do not infer it from
`source_host_id`.

**Done when:** the host channel, project, worktree, branch, exact commit, and both
callback routes are verified.

## 3. Use decision checkpoints

The completed canonical delegation block is the executor's checkpoint contract.
At each callback, require:

- verified facts and inspectable evidence;
- reconciliation with the accepted authority and boundaries;
- one recommended next action;
- the smallest alternatives only when a decision exists;
- an explicit `proceeding` or `paused for decision` state.

Pause early when the next action could change authority or scope: a plan/code
conflict, a new product or architecture choice, a new contract or persistent
mechanism, destructive or unauthorized external action, ambiguous review
finding, overlapping unrecognized changes, unexpected routing, or an
operational blocker. Keep the executor paused and ask the user when resolution
needs new authority. Include facts, recommendation, and smallest alternatives.

When review is requested, use `change-review-workflow` as the single source of
truth. Wait until every requested role completes or terminally fails or blocks;
account for every underlying issue with an issue-local `Implement`, `Adapt`, or
`Decline`; and require the prescribed follow-up review after accepted fixes.
Report failed, blocked, or exhausted review as unresolved. When review is not
requested, record `not requested` instead of inventing a gate.

Prefer milestone and exception checkpoints. Time-based, file-by-file, and
"still working" updates add noise.

**Done when:** every decision-changing boundary reaches the orchestrator before
the executor commits to it, and review is approved for the current head,
reported unresolved, or recorded as not requested.

## 4. Inspect and steer

At a checkpoint, independently verify the important claims through
`codex_app__read_thread` and read-only inspection of the executor worktree.
Avoid concurrent edits in that worktree.

Reply with one bounded direction: proceed, correct, pause, or stop. State the
accepted constraint and the proof expected at the next checkpoint. Send it to
the verified executor ID with `codex_app__send_message_to_thread`. Let the
executor own the implementation details that remain inside the accepted
boundary. Keep the executor paused and ask the user when the decision requires
new authority.

Monitor at checkpoints or when expected progress stops; avoid polling unchanged
state. Preserve the same model and reasoning settings on follow-up messages
unless the user explicitly changes them.

**Done when:** the executor has an actionable direction tied to accepted user
authority and the next proof is explicit.

## 5. Supersede or close

For cancellation or supersession, discover the interruption controls available
on the current host. When no supported interrupt is available, send an explicit
stop message: stop after the current safe atomic operation, make no further
writes or external publications, and report branch, tip, and worktree status.
Verify the executor stopped before starting replacement work. Archiving alone
does not prove execution stopped.

At normal completion, reconcile the final handoff, actual diff, exact tip,
verification, and current-head review outcome with the accepted authority.
Request missing proof or corrections through the same task. The executor
performs only the publication authorized at delegation and reports the resulting
branch or pull request; the orchestrator verifies it. Merging always requires
separate user authority unless already explicit.

Return the final outcome to the user: status, branch and exact tip or pull
request, verification, review result, caveats, and any open decision.

**Done when:** the user receives an accepted result or the stopped/unresolved
task's exact recoverable state, and the executor has stopped.

## Canonical delegation block

```markdown
Implement [bounded goal] in this isolated worktree.

Authority: [request/plan/spec]
Repository/worktree: [repository and fresh isolated worktree requirement]
Baseline: [verified branch at exact commit]
Sandbox: write only inside this worktree and branch; treat other repositories
and worktrees as read-only. Perform external mutations only under Publication.
Boundaries: [material constraints and non-goals]
Ownership: you own implementation, commits, verification, and requested review
work. The parent inspects read-only and owns in-bound steering, review triage,
and acceptance recommendations. New authority returns to the user.
Verification: [exact commands/gates and evidence required]
Done: [checkable behavior, artifacts, clean state, and review requirement]
Publication: [none, commit, push, or pull request; merge requires separate authority]

Callback: read the parent task ID from this prompt's outer
<codex_delegation>/<source_thread_id>. Send checkpoints with
codex_app__send_message_to_thread. If it is absent, stop rather than guessing.

Checkpoints:

- Before edits: prove the clean worktree, actual branch and exact HEAD, authority
  reconciliation, proposed file surface, existing seams, removals, and conflicts.
- Coherent implementation: report diff/stat, behavior working, focused
  verification, adaptations, risks, and remaining gates.
- Review, when requested: follow change-review-workflow; report the current tip,
  every requested role's terminal status, every underlying issue and proposed
  issue-local triage, then pause. After fixes, obtain the required current-head
  follow-up review. Report blocked, failed, or exhausted coverage as unresolved.
- Final: send a handoff-work handoff with branch and exact tip, cleanliness,
  completed and pending work, verification, review outcome or `not requested`,
  caveats, and publication state; then stop.

Report and proceed at evidence-only milestones. Pause for authority, scope,
architecture, external-action, destructive-action, or review-triage decisions.
The parent returns to the user for any new authority.
```
