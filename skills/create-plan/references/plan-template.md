# Plan Template

Write for a capable, context-limited executor with repository access but no
prior conversation. The plan records decisions and durable source references;
the executor inspects the named code.

File naming: `dev/plans/YYMMDD-short-slug.md` (`YYMMDD` is the plan date).

## Default shape

```markdown
# <Outcome-oriented title>

## Goal

The problem, intended outcome, acceptance criteria, and material project
constraints.

## Changes

1. `path/to/file.ts:symbol` — the implementation decision and intended
   behavior. Name the existing test seam that proves it when relevant.
2. ...

## Verify

- The smallest focused behavioral check.
- The repository's canonical validation command.

## Boundaries

Only concrete non-goals or STOP conditions that prevent a likely scope mistake.
Omit this section when none exist.
```

## Authoring rules

- Inline a current-state fact only beside the decision it justifies.
- Prefer the highest existing stable test seam proving acceptance; use a lower
  seam only for a distinct invariant or failure mode unobservable there.
- Include excerpts only when the exact target shape is load-bearing.
- Mention a verified executor skill beside a change only when it adds
  non-obvious guidance. Do not add a skills table by default.
- Add another section only when a migration, rollout, public contract, or named
  risk cannot be understood safely in the default shape.
- Do not duplicate acceptance criteria as done criteria or repeat checks covered
  by the canonical repository gate.

## Quality bar

- Every change and test traces to acceptance, an invariant, or a verified risk.
- Exact files or symbols make the intended ownership clear.
- The plan contains no unresolved implementation decision.
- Boundaries are specific, not boilerplate.
- Durable repository references replace copied context when practical.
- No secrets appear in the plan.
