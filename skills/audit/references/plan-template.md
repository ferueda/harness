# Audit Plan Template

Write for a capable, context-limited executor with repository access but without
prior context about the task at hand. Record decisions, audit provenance, and
durable source references; the executor inspects the named code.

File naming: `dev/plans/YYMMDD-short-slug.md` (`YYMMDD` is the plan date).

## Plan shape

```markdown
# <Outcome-oriented title>

> Planned at `<short SHA>` on <YYYY-MM-DD>. Depends on: <plan paths or none>.

## Goal

The verified problem, intended outcome, acceptance criteria, and material
project constraints.

## Changes

1. `path/to/file.ts:symbol` — the implementation decision and intended
   behavior. Name the existing test seam that proves it when relevant.
2. ...

## Verify

- `git diff --stat <planned-at SHA>..HEAD -- <named paths>` when drift could
  invalidate a decision.
- The smallest focused behavioral check.
- The repository's canonical validation command.

## Boundaries

Only concrete non-goals or STOP conditions that prevent a likely scope mistake.
Omit this section when none exist.
```

## Authoring rules

- Confirm cited evidence yourself; subagent findings are leads, not facts.
- Inline a current-state fact only beside the decision it justifies.
- Verify repository commands and external contracts before prescribing them.
- Prefer the highest existing stable test seam proving acceptance; use a lower
  seam only for a distinct invariant or failure mode unobservable there.
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
- Keep priority, effort, category, status, and cross-plan ordering in the index;
  do not repeat them in every plan.
- Add another section only when migration, rollout, public-contract, security,
  or named operational risk cannot be understood safely in the default shape.
- Prune repeated criteria, commands covered by the canonical repository gate,
  duplicated context, and empty optional sections.

## Index file: `dev/plans/README.md`

Maintain one portfolio index after all selected plans:

```markdown
# Implementation Plans

## Execution order and status

| Plan | Outcome | Priority | Effort | Depends on | Status |
|------|---------|----------|--------|------------|--------|
| 260621-fix-n-plus-one | ... | P1 | S | — | TODO |

Status: TODO | IN PROGRESS | DONE | BLOCKED | REJECTED

## Dependency notes

- `<dependent>` requires `<dependency>` because <reason>.

## Findings considered and rejected

- <finding>: <why it is not worth doing or was fixed independently>.
```

## Quality bar

- Every change and test traces to the finding, an invariant, or a verified risk.
- Exact files or symbols make ownership clear.
- The plan contains no unresolved implementation decision.
- Provenance and dependencies are accurate without duplicating index metadata.
- Boundaries are specific, not boilerplate.
- No secrets appear; cite only location and credential type.
