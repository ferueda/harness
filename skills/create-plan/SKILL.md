---
name: create-plan
description: Create a scoped, code-backed implementation plan from a todo, spec, issue, review notes, or raw instructions. Use for multi-step work, cross-area changes, executor handoffs, or a reviewable plan before coding.
---

# Create Plan

Write the minimum sufficient plan for a capable, context-limited executor with
repository access but without prior context about the task at hand. Resolve
implementation decisions; do not teach inspectable repository basics.

## Principles

- Follow repository invariants and project intent, then explicit requirements
  and accepted decisions, then verified codebase facts.
- Choose the smallest coherent change that satisfies the acceptance criteria.
- For multi-unit work, prefer vertical slices: each unit completes one coherent,
  observable behavior across the boundaries it needs and can be verified when
  it lands. Prefer units that separate agents can own with limited overlap and
  that can be reviewed, landed, or rolled back independently. Keep shared setup
  to the minimum required by the first slice so later units can proceed in
  parallel where practical.
- Do not divide work mechanically by repository layer or component type. When
  an indivisible migration, cross-cutting safety fix, or minimum shared
  prerequisite must remain horizontal, state briefly why vertical delivery is
  impractical or unsafe.
- Prefer concise durable paths and symbols over copied source.
- Prefer the highest existing stable test seam that proves acceptance. Add a
  lower seam only for a distinct invariant or failure mode unobservable there.
- Ask the user before writing when a missing decision materially changes scope
  or architecture. Do not carry unresolved implementation choices into a plan.

## Workflow

### 1. Ground the work

- Read the source request and repository guidance, including the project intent
  source when the work affects direction or boundaries.
- Inspect only the relevant code, callers, contracts, tests, and current docs.
- Verify repository commands and external contracts before prescribing them.

**Done when:** acceptance criteria, relevant invariants, current behavior, and
the smallest credible solution are known.

### 2. Reconcile requirements with reality

- Separate current behavior from requested behavior.
- Resolve stale claims, conflicts, implemented baseline, and real gaps.
- Reject speculative hardening, future-proofing, and unrelated cleanup.
- Ask only questions whose answers change the implementation direction.

**Done when:** the plan has one coherent direction and no material open choice.

### 3. Discover executor aids

Inspect available skill descriptions and repository guidance. Read only skills
that match a concrete change. Mention a verified skill beside that change only
when it adds non-obvious execution guidance; do not add a skills table by
default.

**Done when:** every named aid exists and changes how a step should be executed.

### 4. Write the plan

Use [references/plan-template.md](references/plan-template.md). Name exact files
or symbols and the decisions that matter. Keep relevant facts and tests beside
the change they justify. Add a section, excerpt, checklist, or command only when
it changes an executor decision or proves a distinct criterion, invariant, or
verified regression risk.

**Done when:** a capable executor can implement the outcome from the plan and
repository without prior chat.

### 5. Prune

- Trace every change and test to acceptance, an invariant, or a verified risk.
- Remove repeated criteria, covered commands, duplicated context, and empty
  optional sections.
- Keep verification to focused behavioral checks and the canonical repository
  gate.

**Done when:** removing any remaining material would make execution less safe or
leave a decision ambiguous.

## Output

Write one plan under `dev/plans/` and reconcile `dev/plans/README.md` according
to repository guidance. State findings plainly; plan length follows decision
and change-surface complexity, not a target.
