---
name: handoff-work
description: >
  Hand off work in progress or finished to another agent for continuation or review. Produce a
  structured summary with enough background context, what was worked on, how, why, files touched,
  and what remains. Trigger when the user says "hand off this work", "prepare a handoff",
  "document what was done for the next agent", or ending a session another agent should pick up.
---

# Handoff Work

Produce a handoff document so another agent can continue where you left off or review what was done — whether the work is finished or still in progress.

The handoff must stand alone: the next agent should not need to replay this session or re-read the entire diff to understand the goal, constraints, and current state.

## When to Use

- Ending a work session (done or not) and another agent will continue or review
- Work is partial — context needs to transfer before the next agent picks up
- Before requesting `review-implementation` or `code-quality-review` on recent changes
- The user says "hand off this work", "prepare a handoff", or "document what was done"

## Handoff Focus

Give the next agent enough context to continue or review without re-discovering background from scratch.

### Context (required)

Set the scene so the next agent understands the work in its broader setting:

- **Goal** — what problem is being solved or what outcome is expected
- **Source artifacts** — plan/spec/issue links or paths, acceptance criteria, relevant user requests
- **Starting point** — relevant baseline behavior or state before this work began
- **Constraints** — technical limits, conventions, deadlines, or non-negotiables that shaped decisions
- **Scope boundaries** — what is in scope, explicitly out of scope, and what was intentionally deferred

### Work done (required)

- **What was worked on** — progress made so far, decisions taken, behavior added or changed; call out what is done vs still pending
- **How it was done** — approach, patterns followed, key implementation choices
- **Why it was done** — intent, constraints, tradeoffs, deviations from the original plan
- **Files referenced** — paths touched, created, or deleted; call out the most important ones first and how they relate to each other

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

### Files referenced
- `path/to/file` — [brief note on what changed, why it matters, and how it connects to other touched files]

### Verification
[Commands run and results, or "not run" with reason]

### Next steps
[What the next agent should do first to continue or finish]

### Open items
[Blockers, unanswered questions, risks to review, or follow-ups]
```

Keep it factual and specific. Prefer file paths, concrete behavior, and decision rationale over vague summaries. If the next agent would need to ask "what was the goal?" or "why was it done this way?", the handoff is missing context.
