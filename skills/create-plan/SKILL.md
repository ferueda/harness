---
name: create-plan
description: Write a plan when explicitly requested or when safe execution needs durable sequencing, cutover, risk controls, or an executor handoff. File count alone does not justify planning.
---

# Create Plan

Write the minimum sufficient plan for a capable, context-limited executor with
repository access but without prior context about the task at hand.

## Entry and authority

Use for a requested plan or an established execution need. Clear build/fix work
may proceed directly; no router is needed to obtain permission. Planning does
not authorize implementation or publication.

Accepted requirements govern within host permissions and explicit safety
constraints. Repository intent is the baseline, not a veto on an approved change
to it. Explain such changes and their review boundaries. Proposals are context.

## Make the plan executable

Inspect relevant code, callers, contracts, tests, and current documentation.
Read intent sources when direction or ownership matters. Separate existing and
requested behavior; resolve material design choices. Ask only for a human
prerequisite preventing a useful plan. Routine execution-time discovery belongs
to the executor.

Choose the smallest coherent change. Preserve accepted owners, removals,
cutover order, and compatibility. Prefer vertical outcome slices that can be
verified, reviewed, and landed independently. Explain an indivisible migration
or minimum shared prerequisite when horizontal delivery is necessary.

Use [the plan template](references/plan-template.md). Keep evidence and proof
beside their change. Name verified paths or symbols instead of copying source
or prescribing shell choreography. Name a verified executor skill only when it
adds non-obvious guidance for a concrete decision; do not assume sibling installs.

Connect each material outcome or forbidden effect to an exact proof action and
expected observable evidence. Prefer the highest existing stable test seam;
another seam needs a distinct failure mode. Separate acceptance evidence from
the repository gate and avoid duplicate commands. State mock/source-check limits.
Async work needs terminal evidence, not only acceptance or enqueueing. Live proof
needs explicit authority, prerequisites, assertions, stop conditions, redaction,
disposable data, cleanup, and stated uncertainty.

## Deliver

Write under `dev/plans/` using the target repository's naming, index, and
retirement policy. Prune repeated context, empty sections, speculative hardening,
and tests unrelated to acceptance or verified risk. Report unavailable proof.

For plan-only work, finish with the reviewable plan. Continue further review or
execution only when already authorized, rather than stopping after naming it.
