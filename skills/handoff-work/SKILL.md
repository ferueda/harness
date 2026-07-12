---
name: handoff-work
description: >
  Hand off work in progress or finished to another agent for continuation or review. Produce a
  structured summary with enough background context, what was worked on, how, why, files touched,
  and what remains. Trigger when the user says "hand off this work", "prepare a handoff",
  "document what was done for the next agent", or ending a session another agent should pick up.
---

# Handoff Work

Produce navigational context so another agent can continue or review work.

A handoff is subordinate to repository guidance and the original task or
accepted plan; it never becomes another source of authority. Point to
inspectable sources. Repeat only session-only or otherwise load-bearing
constraints and decisions. The next agent inspects those sources and changed
code.

## When to Use

- Ending a work session (done or not) and another agent will continue or review
- Work is partial — context needs to transfer before the next agent picks up
- Before requesting `review-implementation` or `code-quality-review` on recent changes
- The user says "hand off this work", "prepare a handoff", or "document what was done"

## Handoff Focus

Give enough context to continue or review without rediscovering session-only
background. Preserve important file entry points and material adaptations; do
not reproduce the plan, diff, or an exhaustive inspectable file inventory.

### Context (required)

Set the scene so the next agent understands the work in its broader setting:

- **Goal** — concise intended outcome and its authoritative request or accepted plan
- **Source artifacts** — inspectable repository guidance, plan/spec/issue paths, acceptance criteria, or user-request references
- **Starting point** — relevant baseline behavior or state before this work began
- **Constraints** — only session-only or load-bearing limits and non-negotiables not clear from the sources
- **Scope boundaries** — material adaptations, deferrals, or deviations needed for continuation

### Work done (required)

- **What was worked on** — progress made so far, decisions taken, behavior added or changed; call out what is done vs still pending
- **How it was done** — approach, key implementation choices, and material adaptations
- **Why it was done** — rationale for tradeoffs or deviations from the accepted plan
- **Important files** — only entry points needed for continuation, why they matter, and how they relate

### Continuation (required when work is not complete)

- **Status** — `complete`, `in_progress`, or `blocked`
- **Next steps** — what the next agent should do first
- **Open items** — blockers, unanswered questions, or follow-ups

### Also include when relevant

- Verification run (commands, pass/fail)
- Assumptions the next agent should not re-litigate
- Risks, edge cases, or areas that need extra scrutiny on review

## Output

Use this structure:

```markdown
## Work Handoff

**Status:** in_progress | complete | blocked

### Context
[Goal, source artifacts, starting point, constraints, and scope boundaries — enough background
for the next agent to understand why this work exists and what "done" looks like]

### What was worked on
[Progress so far — what is done and what is still pending]

### How it was done
[Approach, patterns, key implementation choices]

### Why it was done
[Intent, constraints, tradeoffs, deviations from plan]

### Important files
- `path/to/file` — [brief note on why this is an important continuation entry point]

### Verification
[Commands run and results, or "not run" with reason]

### Next steps
[What the next agent should do first to continue or finish]

### Open items
[Blockers, unanswered questions, risks to review, or follow-ups]
```

Keep it factual and specific. Point to inspectable sources; capture only the
session context and decisions needed to explain the current state and material
adaptations.
