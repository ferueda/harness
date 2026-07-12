# Review Handoff

Write only context the plan and diff cannot provide.

## Default shape

```markdown
## Goal

The original requested outcome and plan/spec reference when available.

## Decisions and boundaries

Accepted decisions, intentional deviations, and concrete non-goals. Omit when
none exist.

## Verification

Commands run and results. Name skipped verification and why.

## Scrutiny

Known risks, unresolved concerns, or non-inspectable warnings. Omit when none
exist.
```

For a follow-up, add:

```markdown
## Follow-up focus

Resolved blockers:

- <finding and decision>

Settled decisions:

- <accepted or declined review decision>

Keep the original task scope. Add a new blocker only for a regression introduced
by remediation or a problem made newly observable by it.
```

Use status only when the implementation is incomplete or blocked. Cite paths and
commands where useful, but do not repeat the changed-file inventory, diff,
provider telemetry, or long logs.
