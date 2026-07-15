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
- Preserve each destination's current settings by leaving optional profile
  fields unset. Apply only explicit, schema-valid overrides to the named
  destination.
- Publication is explicit: none, commit, push, pull request, or merge. Opening a
  pull request includes its required push. Merge requires user authority.
- Use live tool schemas. Create once; after an ambiguous result, discover an
  existing matching task before retrying creation.
- Keep one writer: the executor owns its worktree, edits, commits, verification,
  and requested review mechanics. The parent inspects read-only.

## 1. Delegate and verify

1. Fill the executor contract below. Use `handoff-work` for concise context and
   point to durable sources instead of copying them.
2. Discover the repository project and current task-tool schemas. Create one
   project-scoped isolated worktree from the verified exact baseline; require a
   branch only when the accepted task selects one.
3. Resolve the executor's actual task route through task discovery or reading.
   Treat validation rejection as no creation. Treat an ambiguous transport
   result as unknown until discovery proves whether creation succeeded.
4. Require a before-edit checkpoint with actual worktree, branch or detached-HEAD
   state, exact `HEAD`, cleanliness, intended file surface, existing seams, and
   material conflicts. Pause on baseline mismatch.
5. Verify both callback directions before mutation:
   - executor to parent: parent ID from the outer `<source_thread_id>`;
   - parent to executor: executor route returned by task discovery or reading.
6. Inspect the live messaging schema before first use. Prove delivery with a
   successful send plus read-back or acknowledgement.

Bootstrap is complete only when repository identity, exact baseline, isolation,
and both callback directions are verified. Otherwise report `blocked`.

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
Settings: preserve destination settings; use only explicit schema-valid
overrides for the named destination.
Single writer: own changes only in this worktree; treat other worktrees as
read-only.
Boundaries: [material constraints and non-goals]
Verification: [exact commands/gates and evidence required]
Done: [checkable behavior, clean state, and current-head review requirement]
Publication: [none, commit, push, pull request, or merge authority]

Callback: read the parent ID from the outer
<codex_delegation>/<source_thread_id>. Inspect the live messaging schema, preserve
the parent's settings unless an explicit override names it, and prove the first
delivery. Stop if the parent ID is absent.

Checkpoints:

- Before edits: prove worktree, Git state, exact HEAD, cleanliness, scope, seams,
  and conflicts.
- Coherent implementation: report diff, behavior, verification, adaptations,
  risks, and remaining gates.
- Review when requested: follow change-review-workflow, propose dispositions,
  and pause before fixes.
- Final: send a handoff-work handoff with exact recoverable state, then stop.

Consult the parent on demand for decisions or blockers. Pause for new authority.
```
