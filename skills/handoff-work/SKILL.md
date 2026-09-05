---
name: handoff-work
description: Transfer work context to another agent or session when continuation or review needs it. Return an inline handoff unless an artifact is requested.
---

# Handoff Work

Leave enough context to continue without replaying the conversation. No handoff
is needed when the same agent can finish in the same session.

Include status (`complete`, `in_progress`, or `blocked`), the authoritative goal
or plan pointer, current state, and verification commands with observed results.
Name skipped required checks and concrete reasons. Do not label unverified work
complete or infer a pass from an unsupported executor claim.

Add only material session-only decisions, adaptations, entrypoints, blockers,
and the next action when ordering matters. Point to inspectable sources rather
than copying them. Distinguish accepted decisions from proposals and inferred
rationale; a handoff cannot grant permissions the task did not grant.

Return inline. Create a file only when requested. A handoff transfers context,
not automatically control: continue work still assigned to you and authorized.
