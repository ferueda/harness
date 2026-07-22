# Plan Template

Write for a capable, context-limited executor with repository access but without
prior context about the task at hand. The plan records decisions and durable
source references; the executor inspects the named code.

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
- Organize multiple changes as vertical outcome slices that can be verified and
  that separate agents can own with limited overlap. Prefer slices that can be
  reviewed, landed, or rolled back independently and can proceed in parallel
  after the minimum shared setup. Expand shared setup only when a later slice
  proves the need.
- Do not divide a plan mechanically by repository layer or component type. If
  an indivisible migration, cross-cutting safety fix, or minimum shared
  prerequisite must remain horizontal, name its bounded scope and state briefly
  why vertical delivery is impractical or unsafe.
- Include excerpts only when the exact target shape is load-bearing.
- Mention a verified executor skill beside a change only when it adds
  non-obvious guidance. Do not add a skills table by default.
- When work replaces, redirects, splits, deprecates, or removes an existing
  behavior, name its post-change owner, exact removals and cutover order, and
  required compatibility beside the change. Omit this lifecycle detail for
  ordinary additive work.
- When work materially changes failure handling, state or data flow, privacy, or
  security behavior, state the required behavior beside the affected change.
  Omit this detail when that behavior is unchanged or irrelevant.
- Add another section only when a migration, rollout, public contract, or named
  risk cannot be understood safely in the default shape.
- Prune repeated criteria, commands covered by the canonical repository gate,
  duplicated context, and empty optional sections.

## Quality bar

- Every change and test traces to acceptance, an invariant, or a verified risk.
- Exact files or symbols make the intended ownership clear.
- No material implementation choice remains unresolved.
- Boundaries are specific, not boilerplate.
- Durable repository references replace copied context when practical.
- No secrets appear in the plan.
