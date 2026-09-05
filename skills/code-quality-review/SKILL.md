---
name: code-quality-review
description: Review changed code read-only for behavior-preserving clarity, simplicity, and maintainability. Not a second general correctness review or surrounding-code cleanup.
---

# Code Quality Review

Stay read-only. Preserve accepted behavior, scope, contracts, output shapes,
artifact paths, CLI behavior, validation boundaries, and regression coverage.
Do not apply fixes or publish without separate authority.

Read the full diff and nearby code needed to establish conventions. Consult
only relevant guidance and specialist skills at verified locations. Existing
intent is the baseline; accepted changes to it are not automatically defects.
Host permissions and explicit safety constraints still bind the work.

Look for materially smaller equivalent shapes: duplication, avoidable
indirection, speculative abstractions, unclear naming, or test complexity
introduced by the change. Industry preferences do not override working local
conventions. Do not perform a second general correctness review; report a
concrete defect when encountered during quality review.

### Primitive fit

When ownership or a building block changes, verify the existing owner, source
of truth, relevant consumers, lifecycle, and dependency direction. Prefer reuse,
then an extension of the same coherent contract, then the smallest new primitive
for a verified need. Future reuse alone does not justify more machinery.

## Findings and completion

Report only material issues in changed or directly affected code. Exclude
pre-existing debt, broad rewrites, surrounding cleanup, and equivalent style
choices. Use `must_fix` only for an applicable hard policy violation or verified
correctness, contract, or test-reliability risk preventing safe acceptance.
Optional simplifications remain advisory.

On follow-up, do not relitigate settled preferences. Report new evidence of a
material defect even when previously missed, explaining why it changes the
decision. Use narrow non-destructive checks only for unresolved material claims;
the validation stage owns the canonical gate.

Each finding has title, severity (`Critical`, `High`, `Medium`, `Low`), location,
issue, smallest correction, rationale, and `must_fix`. End with `pass`,
`needs_changes`, or `blocked` for no blockers, at least one blocker, or unavailable
required coverage respectively. A clean review is valid. Structured calls return
only the supplied JSON contract; reference formats are subordinate.
