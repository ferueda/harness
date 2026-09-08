---
name: triage
description: Triage an issue or work item read-only against repository evidence. Use when asked to assess scope, readiness, duplicates, blockers, or the next agent action; not for routing work already assigned for execution.
---

# Triage

Decide whether an agent can take the next useful action on the item. Readiness
is broader than readiness to edit code: investigation or specification can be
the right next action.

A triage request authorizes inspection, classification, and a recommendation.
Keep it read-only: do not implement, edit the item, change repository state, or
publish comments unless the surrounding request separately authorizes that work.

## Inspect the available context

Read the supplied description and discussion, linked or related work, active
work when available, and the repository evidence needed for the decision. Start
with repository guidance and follow its pointers to current intent, invariants,
ownership, and source-of-truth boundaries.

Treat roadmaps, proposals, and archived plans as context unless current guidance
marks them as authoritative. Current intent is the baseline, while an explicitly
accepted change to that intent is a direction change to surface rather than a
reason to reject the item.

Record material context limits. A truncated or inaccessible collection cannot
prove that a duplicate, dependency, or related item is absent. Missing an intent
document alone does not block narrow work whose outcome and acceptance boundary
are clear.

## Apply the rubric

### 1. Check outcome scope

A bounded item has one coherent, observable outcome and one acceptance boundary.
It may span several files or layers. An item is too broad when it contains
outcomes that could be accepted, shipped, deferred, or rolled back independently.
Count independent outcomes, not open questions or implementation steps.

Keep scope separate from delivery shape. Prefer vertical slices that complete an
observable behavior across the boundaries it needs, with only the shared setup
required by the first slice. Favor slices that can be verified, reviewed,
landed, or rolled back independently and owned with limited overlap. A horizontal
breakdown does not by itself make the item broad or require human input; recommend
reshaping ready work during delivery. An indivisible migration, cross-cutting
safety fix, or smallest shared prerequisite may remain horizontal when its
boundary and proof are clear.

For a broad item, recommend **Rescope**. Name the independent outcome seams,
recommend the smallest useful first slice, and ask whether to narrow the item to
that slice while tracking the other outcomes separately. Finish triage at this
scope decision; do not route the whole bundle to implementation or investigation.

### 2. Choose the next useful action for bounded work

- **Implement** when the observable outcome, constraints, and acceptance boundary
  support one safe implementation pass. Normal repository inspection, following
  existing patterns, writing tests, and resolving technical details within that
  pass are implementation work.
- **Investigate/specify** when diagnosis, design, migration sequencing, or risk
  reduction must produce an evidence-backed artifact before edits can safely
  begin. A later human choice does not make input a prerequisite when an agent can
  first develop options and a recommendation.
- **Needs input** only when a genuine prerequisite blocks both implementation and
  useful investigation: the desired outcome or success boundary is unknown or
  contradictory; a human must establish, reconcile, or explicitly override
  project direction; or missing access or external facts prevent useful research.
  Ask only the smallest concrete questions that unblock work.
- **Duplicate** only when evidence shows another work item represents the same
  outcome. Identify that item and explain the overlap.
- **Already shipped** when repository or release evidence proves the outcome is
  present but no duplicate item represents it. Present the evidence and recommend
  that the owner decide whether to close the item.

Record unresolved dependencies separately from the recommendation. A dependency
can block execution while the item remains ready for an agent to investigate,
specify, or prepare unblocked work.

## Report the assessment

Return a concise report with the recommendation, bounded or broad scope,
decision rationale, and supporting evidence. Include questions, the duplicate or
shipped reference, unresolved dependencies, and context limits only when they
apply.

Explain why the recommendation follows from the outcome, acceptance boundary,
material intent constraints, and uncertainty. Do not merely restate the item.
Use repository-relative paths and line references for code, docs, and tests;
identify discussion or work-item evidence by its portable reference. Distinguish
observed facts, supported inferences, and unknowns, and base the recommendation
on that evidence rather than self-reported confidence.
