---
name: planning-workflow
description: >
  Route non-trivial, unclear, or explicitly planning-oriented work to the next
  useful action: direct implementation, requirements shaping, diagnosis, spec
  review, plan creation or review, handoff, and close. Use when the user invokes
  planning-workflow, asks what should happen before implementation, or repository
  guidance requires this coordinator. Do not force a plan for clear bounded work.
---

# Planning Workflow

Chat coordinator for intent → next useful action → implementation or an approved
planning artifact. Not a `harness run` target.

`architect` is manual-only. When the user explicitly invokes it for
repo-grounded ideation or solution design, run it before later planning or
implementation; do not auto-route generic work to it.

## 1. Triage intake

Respect the user's explicit requested deliverable. An explicit interview,
diagnosis, architecture, audit, plan, plan review, or approved-plan
implementation request takes its named route. Invoking `planning-workflow`
alone requests routing; it does not require a plan.

When the route is not explicit, use a small read-only repository check when it
can settle the decision. Then apply this rubric in order:

1. **Check outcome scope.** A bounded item has one coherent, observable outcome
   and one acceptance boundary. Outcomes that can be accepted, shipped,
   deferred, or rolled back independently need separate work or one chosen
   slice. Files, layers, questions, and implementation steps do not define
   scope.
2. **Check for a human prerequisite.** Ask for input only when a missing decision
   blocks every useful route, including investigation. Gate when the requested
   outcome, acceptance boundary, safety constraint, or project direction is
   materially unknown or contradictory. Do not ask what repository evidence or
   established defaults can answer.
3. **Choose the next useful action.** Implement directly when the bounded outcome
   is clear enough for one safe implementation pass. Normal repository
   inspection, test writing, and local technical discovery are part of
   implementation. Route to pre-edit work only when investigation, validation,
   risk reduction, or sequencing must finish before editing can safely begin.

Do not infer the route from task nouns such as bug, ticket, feature, brief, or
spec. A clear bug may go directly to its repository's test-first fix path; an
uncertain bug may need diagnosis. A detailed cross-area spec may be direct-ready;
a short local request may still need a product decision.

| Need | Route |
|------|-------|
| Clear bounded outcome; one safe implementation pass | implementation in the current or delegated session |
| Desired outcome or acceptance boundary materially unclear | `shape-requirements` **gate** |
| Explicit interview or idea-shaping request | `shape-requirements` **interview** |
| Current-code truth, cause, or risk could invalidate the request or change direction | `diagnose-issue` |
| Existing brief, spec, or plan has material claims that need codebase validation | `review-spec` or `harness run plan-review --plan <path>` for an implementation plan |
| Explicit plan request, or durable sequencing, cutover, risk control, or executor handoff is needed | `create-plan` |
| Explicit codebase or workflow audit request | `audit` |
| Approved plan ready to execute | implementation in the current or delegated session |
| Explicit `$architect` / "use architect" request | `architect` |

Direct implementation may span several files or areas. Require a clear outcome
and acceptance boundary, no unresolved material product or architecture choice,
one coherent direction after the initial read, and a focused proof path.

Treat a selected child route as an executable handoff. Read the sibling skill's
`SKILL.md` completely and follow it in the current workflow; resolve sibling
paths from this skill's directory (for example,
`../diagnose-issue/SKILL.md`). Do not imitate the child skill's output without
loading its instructions.

**Done when:** the next useful action is chosen and either begins or waits on one
true prerequisite.

## 2. Re-triage planning outputs

Do not make a plan inevitable because shaping, diagnosis, or review occurred.
Apply the intake rubric again after each planning output.

| Output | Next |
|--------|------|
| Gate-cleared interpretation, validated brief/spec, or confirmed diagnosis with one safe implementation pass | implement directly |
| Ambiguous outcome or multiple directions needing a product or priority choice | `shape-requirements` **gate** |
| Unverified current-code claim that could change direction | `diagnose-issue` or `review-spec` |
| Explicit plan request or durable sequencing, cutover, risk control, or executor handoff need | `create-plan` |
| Created non-trivial implementation plan | `harness run plan-review --plan <path>`; direct `review-spec` fallback when harness is unavailable or durable review artifacts are unnecessary |
| Inline architecture memo from `architect` | stop if design was the requested deliverable; otherwise re-triage for direct implementation, validation, or planning |

Cross-area reach, multiple files, and several implementation steps are risk
signals, not automatic reasons to create a plan. Run `review-spec` before
`create-plan` only when the plan would depend on unverified material claims.
When work affects product direction, architecture boundaries,
docs-architecture, data or tenancy, provider contracts, public APIs, or
workflow-wide behavior, validate it against the target repository's intent
source before accepting a direction.

After `create-plan`, prefer `plan-review` for non-trivial or handoff-ready plans.
The planning agent owns finding triage: accept, adapt, or decline reviewer
findings, edit the plan, and rerun review after material plan changes. Harness
does not edit plans automatically.

Plans target a capable, context-limited executor with repository access. Keep
facts and tests beside the change they justify, prefer the highest existing
stable test seam, and connect each material outcome to an exact proof action and
expected observable evidence. Return material unresolved choices or unavailable
proof to the user instead of preserving ambiguity in the plan.

**Done when:** direct implementation is confirmed, a plan is approved, or one
material prerequisite is returned to the user.

## 3. Hand off between agents

Use `handoff-work` when a different agent or session continues:

- After `plan-review` → executor implements the plan in the current or delegated session
- After `create-plan` → executor implements the plan only when `plan-review` is skipped per routing
- After partial implementation → reviewer or continuation agent
- Before `change-review-workflow` when the implementer is not the reviewer

**Done when:** handoff written or explicitly skipped (same agent, same session).

## 4. Implement

| Authority | Path |
|-----------|------|
| Original clear request or validated brief/problem definition | implement directly |
| Approved `dev/plans/*.md` | implement the plan in the current or delegated session |

Before edits, reconcile three sources: repository guidance constrains the work;
the original request or approved plan defines the intended outcome; verified
current code is the implementation baseline. Historical branches and
superseded implementations are context only. Carry forward named ownership,
removal, cutover, and compatibility decisions.

Before review or handoff, reconcile the resulting diff with that outcome and
those decisions. Perform both checks in session; create no new alignment
artifact, checklist, or plan rewrite.

**Done when:** the accepted outcome is implemented; relevant non-destructive
validation is complete, or the exact unavailable checks are reported; and the
resulting diff is reconciled with accepted decisions. A material conflict or
required scope expansion stops implementation and returns to planning or the
user; planning starts by triaging the new information.

## 5. Close

| Outcome | Next |
|---------|------|
| Code changed, review needed | `change-review-workflow` |
| Plan-only session | update plan status; stop |

**Done when:** next workflow named or user stops.

## Reference

- [references/routing.md](references/routing.md) — skip rules, fixtures, and pass criteria
