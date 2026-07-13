---
name: orchestrate-work
description: Manual-only orchestration of substantial work in a separate Codex executor task while the current task stays the orchestrator. Use only when the user explicitly invokes `$orchestrate-work` or explicitly requests an isolated executor task with checkpoints, consultation, steering, review triage, and final handoff.
---

# Orchestrate Work

Coordinate one substantial Codex executor task from the current Codex task. Keep
the orchestrator responsible for authority and decisions; give the executor sole
ownership of implementation in an isolated worktree.

## 1. Gate and divide ownership

Run only after the user explicitly requests this skill or a separate Codex task
with the current task acting as orchestrator. For an ordinary implementation
request, work in the current task.

Define before delegation:

- one bounded goal and its authoritative request, plan, or spec;
- the exact repository, expected baseline, and material non-goals;
- executor ownership of edits, commits, tests, and requested review work;
- orchestrator ownership of scope, product and architecture decisions, review
  triage, steering, and acceptance;
- whether push, pull-request creation, merge, or other external actions are
  authorized.

An explicit request to open a pull request also authorizes the branch push it
requires. It does not authorize merge.

Use `handoff-work` for the initial context shape: status, authority and goal,
current state, verification, then only relevant adaptations, files, next steps,
and open items. Point to durable sources instead of copying them.

**Done when:** worktree ownership and publication authority are unambiguous.

## 2. Establish the callback channel

A Codex-created executor receives the initial prompt inside a
`<codex_delegation>` envelope. Instruct the executor to copy the envelope's
verified `<source_thread_id>` exactly: that is the parent/orchestrator task ID.
The executor sends checkpoints to it with
`codex_app__send_message_to_thread`. If the envelope or ID is absent, stop and
obtain a verified ID from Codex task metadata; never guess one or promise
callbacks without it. The orchestrator can repair the channel by sending that
verified ID to the stopped executor task.

Keep the two directions distinct:

| Direction | Verified destination |
|---|---|
| Executor to orchestrator | Parent ID from the executor's delegation envelope |
| Orchestrator to executor | Executor ID returned by task creation, listing, or reading |

A callback displayed in the parent carries the executor's ID as its source.
That confirms the sender; it is not the parent ID. Use a `hostId` only when a
Codex result verifies it and the destination requires it. Do not infer it from
`source_host_id`.

**Done when:** both sides know their verified destination ID and callback tool.

## 3. Create and verify the executor task

1. Use `codex_app__list_projects`; select the project matching the repository.
   Stop if project identity is missing or ambiguous. Do not silently use a
   projectless task or the current checkout.
2. Use `codex_app__create_thread` with that project and a fresh worktree. Omit a
   starting state unless the user explicitly names an existing Git state. Omit
   model and reasoning overrides unless the user explicitly requests them.
3. Include the handoff, ownership split, callback instructions, checkpoint
   contract below, verification gates, and publication authority in the initial
   prompt.
4. Record the returned executor task ID. If creation returns only a queued
   client ID, resolve the actual task through verified task results before
   steering it. Use `codex_app__set_thread_title` for a useful title, then
   `codex_app__read_thread` or `codex_app__list_threads` to verify that it
   started in the intended project/worktree.

**Done when:** the executor is running from the intended project and can report
to the orchestrator.

## 4. Use decision checkpoints

Every checkpoint carries:

- verified facts and inspectable evidence;
- reconciliation with the accepted authority and boundaries;
- one recommended next action;
- the smallest alternatives only when a decision exists;
- an explicit `proceeding` or `paused for decision` state.

Use these checkpoints:

| Boundary | Required evidence | Default |
|---|---|---|
| Before edits | Clean isolated baseline; authority/code reconciliation; proposed file surface; existing seams to reuse; removals; conflicts | Report and proceed when no material conflict exists |
| Coherent implementation | Diff/stat; behavior now working; focused verification; adaptations, risks, and remaining work | Report and proceed with remaining gates when no decision changes |
| Review | Run IDs and requested roles; complete findings with evidence; proposed `Implement`, `Adapt`, or `Decline` triage | Report partial results without editing; wait for all requested roles; pause when findings need triage |
| Final | Branch and exact tip; cleanliness; completed and pending work; all verification; review runs and caveats; publication state | Send a `handoff-work` handoff and stop |

Pause early when the next action could change authority or scope: a plan/code
conflict, a new product or architecture choice, a new contract or persistent
mechanism, destructive or unauthorized external action, ambiguous review
finding, overlapping unrecognized changes, unexpected routing, or an
operational blocker. Include facts, recommendation, and smallest alternatives.
Partial review evidence may trigger an immediate safety stop; otherwise wait
for the complete requested role set before fixing findings.

Prefer milestone and exception checkpoints. Time-based, file-by-file, and
"still working" updates add noise.

**Done when:** every decision-changing boundary reaches the orchestrator before
the executor commits to it.

## 5. Inspect and steer

At a checkpoint, independently verify the important claims through
`codex_app__read_thread` and read-only inspection of the executor worktree.
Avoid concurrent edits in that worktree.

Reply with one bounded direction: approve, correct, pause, or stop. State the
accepted constraint and the proof expected at the next checkpoint. Send it to
the verified executor ID with `codex_app__send_message_to_thread`. Let the
executor own the implementation details that remain inside the accepted
boundary.

Monitor at checkpoints or when expected progress stops; avoid polling unchanged
state. Preserve the same model and reasoning settings on follow-up messages
unless the user explicitly changes them.

**Done when:** the executor has an actionable decision without expanded scope.

## 6. Supersede or close

For cancellation or supersession, discover the interruption controls available
on the current host. When no supported interrupt is available, send an explicit
stop message: stop after the current safe atomic operation, make no further
writes or external publications, and report branch, tip, and worktree status.
Verify the executor stopped before starting replacement work. Archiving alone
does not prove execution stopped.

At normal completion, reconcile the final handoff and actual diff with the
accepted authority. Request missing proof or corrections through the same task.
Publish only within the authority fixed at delegation; merging always requires
separate user authority unless already explicit.

**Done when:** the result is accepted or the stopped task's exact recoverable
state is known.

## Compact delegation block

```markdown
Implement [bounded goal] in this isolated worktree.

Authority: [request/plan/spec]
Baseline: [verified branch or commit]
Boundaries: [material constraints and non-goals]
Ownership: you own implementation, commits, verification, and requested review
work; the parent owns scope, decision feedback, review triage, and acceptance.
[Publication authority.]

Callback: read the parent task ID from this prompt's outer
<codex_delegation>/<source_thread_id>. Send checkpoints with
codex_app__send_message_to_thread. If it is absent, stop rather than guessing.

Checkpoints: before edits; coherent implementation; complete review evidence
and proposed triage; final handoff. Report and proceed at evidence-only
milestones. Pause for authority, scope, architecture, external-action,
destructive-action, or review-triage decisions.
```
