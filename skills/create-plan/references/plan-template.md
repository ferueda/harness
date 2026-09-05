# Plan template

Use repository naming and lifecycle rules; otherwise use
`dev/plans/YYMMDD-short-slug.md`. The plan must work without prior chat.

```markdown
# <Observable outcome>

## Goal

The intended behavior, acceptance criteria, and material constraints.

## Changes

- `path/to/file.ts:symbol`: decision, behavior, and evidence that justify it.
  Include affected owners, cutover, and compatibility only when material.

## Verify

- `<focused proof action>`: `<expected observable evidence and material limits>`.
- `<canonical repository gate>`.

## Boundaries

Only concrete exclusions or stop conditions. Omit when none are needed.
```

Use independently verifiable vertical outcomes for multi-unit work. Explain a
necessary horizontal migration or shared prerequisite rather than forcing a
mechanical layer-by-layer itinerary. Existing source and tests are inspectable;
link them rather than copying them. Include a verified executor aid only when
it changes an execution decision.

Require terminal proof for asynchronous outcomes and explicit authority, safe
data, assertions, stop conditions, redaction, and cleanup for live checks.
Record unavailable checks and uncertainty. Never copy secrets into the plan.
Omit duplicate proof layers, covered commands, empty sections, and unresolved
material implementation choices. A plan is a decision record, not a tutorial.
