---
name: handoff-work
description: >
  Use when the user asks to hand off work, prepare a handoff, document work for another agent, or
  when another agent or session will continue or review the work.
---

# Handoff Work

Produce navigational context so another agent can continue or review work.

A handoff follows repository guidance and the original task or accepted plan
as its authority. Point to inspectable sources. Repeat only session-only or
otherwise load-bearing constraints and decisions. The next agent inspects those
sources and changed code.

## Required core

- **Status** — `complete`, `in_progress`, or `blocked`.
- **Authority and goal** — point to the authoritative request, accepted plan, or
  spec and state the intended outcome concisely.
- **Current state** — summarize what is complete, pending, or blocked without
  reproducing inspectable source content.
- **Verification** — list commands and results; when a relevant check was not
  run or is unavailable, name the exact check and reason.

## Add only when relevant

- **Material adaptations** — accepted deviations or decisions needed to explain
  the current state, with concise rationale.
- **Important files** — entry points needed for continuation and why they matter.
- **Next steps** — the first continuation action when work is incomplete or
  ordering matters.
- **Open items** — blockers, unanswered decisions, risks, or review focus.

## Output

Use this structure:

```markdown
## Work Handoff

**Status:** in_progress | complete | blocked

### Authority and goal
[Authoritative source pointer and concise intended outcome]

### Current state
[What is complete, pending, or blocked]

### Verification
[Commands and results, or exact unavailable checks and reasons]

<!-- Include only relevant optional sections: Material adaptations, Important files, Next steps, Open items. -->
```

Return the handoff inline. Create a repository artifact only when the user
explicitly requests one.
