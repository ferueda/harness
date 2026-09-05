---
name: explain-change
description: Explain a diff, branch, commit range, or pull request through its behavior and tradeoffs. Use for walkthroughs and impact questions, not defect-finding or merge approval.
---

# Explain Change

Give the user an evidence-backed mental model. Stay read-only for explanation-
only work; a walkthrough is not permission to fix or publish.

Resolve the base, head, and scope. Refresh evidence for a named PR; include
relevant committed and working-tree changes for a local request. Ask only when
competing scopes would materially change the answer.

Read the diff and enough entrypoints, callers, tests, and decision records to
explain old and new behavior. Consult intent when rationale or a boundary matters,
not as a mandatory repository tour. Accepted decisions govern within host
permissions and explicit safety constraints; verify PR descriptions and handoffs.

Lead with changes for the user, developer, or operator. Group files conceptually
and use an example when it clarifies behavior. Explain material contract, data,
ownership, failure, compatibility, and operational consequences; omit irrelevant
surfaces unless asked about them.

For material primitives/boundaries, name what was reused, extended, added,
replaced, moved, or removed; its owner and source of truth; and the consumers or
contracts affected. Explain the implementation rather than re-running design
selection. Do not manufacture formal ledgers for a small change.

Distinguish accepted tradeoffs from inferred consequences. State the benefit,
cost, documented alternatives, and revisit conditions where known. For complexity
questions, map churn to behavior, compatibility, tests, docs, and incidental
complexity, then support a `proportional`, `mixed`, or `disproportionate` verdict.

Use adequate recorded verification. Run a narrow non-destructive check only for
an unresolved material claim. Return the smallest explanation that answers the
question with anchors and meaningful unknowns. Omit empty sections and repeated
summaries. Safety review belongs to an available reviewer; do not present an
explanation as merge approval.
