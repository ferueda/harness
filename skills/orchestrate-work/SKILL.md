---
name: orchestrate-work
description: Delegate one scoped implementation to an isolated executor while the parent retains authority and review control.
disable-model-invocation: true
---

# Orchestrate Work

Delegate one bounded implementation to one isolated Codex executor. The
executor is the **single writer**. This parent stays read-only and owns authority,
decision steering, review dispositions, and acceptance.

Success means the executor starts from the verified repository and exact
baseline, both callback directions work before mutation, decision-changing work
reaches the parent before action, and the user receives either an accepted
result or an exact recoverable state.

## Invariants

- The accepted request, plan, or spec defines authority. Steer within it; pause
  the executor and return to the user for new authority.
- Each destination owns its `model` and `thinking`. Omit both by default; apply
  only explicit, schema-valid overrides to the named destination. Never copy
  settings from the sender.
- Publication is explicit: none, commit, push, pull request, or merge. Opening a
  pull request includes its required push. Merge requires user authority.
- Readiness is explicit: use the target repository's command or `none`; never
  infer package-manager setup.
- Keep one writer: the executor owns its worktree, edits, commits, verification,
  and requested review mechanics. The parent inspects read-only.

## 1. Delegate and verify

1. Fill the executor contract below. Use `handoff-work` for concise context and
   point to durable sources instead of copying them.
2. Use `codex_app__list_projects`; select the project matching the repository.
   Stop when project identity is missing or ambiguous.
3. Inspect the live `codex_app__create_thread` schema, then create one isolated
   worktree with the minimal project target:

   ```ts
   {
     prompt: "[completed delegation and handoff]",
     target: {
       type: "project",
       projectId: "[discovered project ID]",
       environment: { type: "worktree" }
     }
   }
   ```

   Add only explicit, schema-valid destination overrides. Use a starting state
   only when the accepted task selects one.
4. Create once. A validation rejection created no task: correct the request from
   the live schema and resubmit it. After an ambiguous result, use
   `codex_app__list_threads` and `codex_app__read_thread` to match the project,
   prompt, and creation window; retry only when discovery proves none exists.
5. Record the executor task ID. Resolve a queued `clientThreadId` through list or
   read before steering. Set a useful title with `codex_app__set_thread_title`,
   then verify the intended project and fresh worktree.
6. Require a before-edit checkpoint with actual worktree, branch or detached-HEAD
   state, exact `git rev-parse HEAD`, cleanliness, the exact readiness command,
   intended file surface, existing seams, and material conflicts. Pause on
   baseline mismatch.
7. Verify both callback directions before mutation:
   - executor to parent: parent ID from the outer `<source_thread_id>`;
   - parent to executor: `{ threadId, hostId }` route returned by
     `codex_app__list_threads` or `codex_app__read_thread`.

   A callback's source identifies the executor, not the parent. Omit `hostId` for
   a verified local task when the live schema permits it; otherwise use the
   discovered routing `hostId`. `source_host_id` and title-update output are not
   steering routes.
8. Require the executor to inspect `codex_app__send_message_to_thread` before its
   first checkpoint; do the same before the first parent reply. Prove delivery
   with a successful send plus read-back or acknowledgement.
9. Parent acknowledgement authorizes the reported readiness command as bounded
   setup. The executor runs it before source edits or provider work. Failure
   pauses with exact evidence; success needs no second approval.

Bootstrap is complete only when repository identity, exact baseline, isolation,
both callback directions, and readiness are verified. Otherwise report
`blocked`.

## 2. Decision checkpoints

The executor reports before edits, at coherent implementation, at requested
review, and at final handoff. It may consult the parent whenever a decision or
blocker appears. Each checkpoint includes evidence, boundary impact, one
recommendation, and `proceeding` or `paused`.

Pause for scope or authority changes, product or architecture choices,
destructive or unauthorized external actions, review dispositions, unsafe
overlap, unexpected routing, or operational blockers. Only decisions requiring
new authority return to the user.

At each checkpoint, independently inspect material claims and send one bounded
direction: proceed, correct, pause, or stop, plus the proof expected next. Keep
routine in-scope implementation with the executor. Update at decisions,
exceptions, and milestones; do not poll unchanged state.

When review is requested, the executor follows `change-review-workflow`, reports
every role and underlying issue, proposes issue-local dispositions, and pauses
before fixes. The parent approves or adjusts dispositions. Record current-head
review as approved, unresolved, or `not requested`.

A checkpoint is complete when material evidence is verified, one direction is
delivered and acknowledged, and the next proof is explicit.

## 3. Close or stop

At normal completion, require a `handoff-work` handoff with exact branch and tip,
cleanliness, diff, verification, current-head review, publication, caveats, and
open decisions. Verify the evidence and current accepted publication authority,
then ensure the executor stops.

For cancellation or supersession, interrupt when supported. Otherwise direct
the executor to finish its current safe atomic operation, stop mutation and
publication, and report exact recoverable Git/worktree state. Verify it stopped
before replacement work.

Return status, branch/tip or pull request, verification, review result, caveats,
and open decisions. Completion requires an accepted result or exact unresolved
state reported to the user, with the executor stopped.

## Executor contract

```markdown
Implement [bounded goal] in this isolated worktree.

Authority: [request/plan/spec]
Repository: [repository and isolated-worktree requirement]
Baseline: [verified exact commit; branch only when selected]
Readiness: [target-repo command or none]
Settings: preserve destination settings; use only explicit schema-valid
overrides for the named destination.
Single writer: own changes only in this worktree; treat other worktrees as
read-only.
Boundaries: [material constraints and non-goals]
Verification: [exact commands/gates and evidence required]
Done: [checkable behavior, clean state, and current-head review requirement]
Publication: [none, commit, push, pull request, or merge authority]

Callback: read the parent ID from the outer
<codex_delegation>/<source_thread_id>. Inspect the live
codex_app__send_message_to_thread schema, preserve the parent's settings unless
an explicit override names it, and prove the first delivery. Stop if the parent
ID is absent.

Checkpoints:

- Before edits: prove worktree, Git state, exact HEAD, cleanliness, readiness,
  scope, seams, and conflicts.
- Coherent implementation: report diff, behavior, verification, adaptations,
  risks, and remaining gates.
- Review when requested: follow change-review-workflow, propose dispositions,
  and pause before fixes.
- Final: send a handoff-work handoff with exact recoverable state, then stop.

Consult the parent on demand for decisions or blockers. Pause for new authority.
```
