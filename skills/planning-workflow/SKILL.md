---
name: planning-workflow
description: >
  Coordinate planning from intent to implementation. Route through shape-requirements,
  diagnose-issue, review-spec, create-plan, plan-review, and handoff-work.
  Use when starting feature work, fixing a non-trivial issue, or running the full
  plan-build cycle.
---

# Planning Workflow

Chat coordinator for intent → validated plan → implementation. Not a `harness run` target.

`architect` is manual-only. When the user explicitly invokes it for
repo-grounded ideation or solution design, run it before `create-plan`; do not
auto-route generic planning prompts to it.

## 1. Route intake

| Signal | Start with |
|--------|------------|
| Vague idea, no brief | `shape-requirements` **interview** |
| Build/fix/plan now but scope or done-ness unclear | `shape-requirements` **gate** |
| Symptom, bug, ticket, or design concern about current code | `diagnose-issue` |
| Explicit `$architect` / "use architect" design request | `architect` |
| Written brief/spec/plan already exists | `harness run plan-review --plan <path>` for existing implementation plans; otherwise `review-spec` or `create-plan` (see step 2) |
| Approved plan ready to execute | implementation in the current or delegated session |

**diagnose-issue** when the question is what is true in the repo. **shape-requirements** when the question is what the user wants.

Too vague to investigate → `shape-requirements` **gate** only (not interview), then `diagnose-issue`.

**Done when:** starting skill chosen.

## 2. Shape and validate

| Artifact | Next |
|----------|------|
| Brief or problem definition | `review-spec` when claims must match the codebase |
| Inline architecture memo from `architect` | `create-plan` when the user asks to build from it; `review-spec` first when claims need validation |
| Problem definition with multiple directions | `shape-requirements` **gate** to pick one |
| Validated spec or brief | `create-plan` when work is multi-step, cross-area, or needs executor handoff |
| Created non-trivial implementation plan | `harness run plan-review --plan <path>`; direct `review-spec` fallback when harness is unavailable or durable artifacts are unnecessary |
| Small scoped change after gate | implement directly or skip to step 4 |

Run `review-spec` before `create-plan` when the plan would depend on unverified assumptions.
When a brief, problem definition, or plan affects product direction,
architecture boundaries, docs-architecture, data/tenancy, provider contracts,
public APIs, or workflow-wide behavior, have `review-spec` validate it against
the target repo's intent source (`docs/project-intent.md`, root `VISION.md`, or
explicit intent docs linked from repo guidance).
After `create-plan`, prefer `plan-review` for non-trivial, cross-area, or
handoff-ready plans. The planning agent owns triage: accept, adapt, or decline
reviewer findings, edit the plan, and rerun `plan-review` after material plan
changes. Harness does not edit plans automatically.

Plans target a capable, context-limited executor with repository access. The
default shape is `Goal`, `Changes`, and `Verify`, with `Boundaries` only for a
concrete scope risk. Keep facts and tests beside the change they justify,
prefer the highest existing stable test seam, and return material unresolved
choices to the user instead of preserving them in the plan. Review content and
decisions, not template completeness.

**Done when:** plan approved or direct-implement path confirmed.

## 3. Hand off between agents

Use `handoff-work` when a different agent or session continues:

- After `plan-review` → executor implements the plan in the current or delegated session
- After `create-plan` → executor implements the plan only when `plan-review` is skipped per routing
- After partial implementation → reviewer or continuation agent
- Before `change-review-workflow` when the implementer is not the reviewer

**Done when:** handoff written or explicitly skipped (same agent, same session).

## 4. Implement

| Path | Skill |
|------|-------|
| Approved `dev/plans/*.md` | Implement in the current or delegated session |
| Gate-cleared small change | implement in session |

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
user.

## 5. Close

| Outcome | Next |
|---------|------|
| Code changed, review needed | `change-review-workflow` |
| Plan-only session | update plan status; stop |

**Done when:** next workflow named or user stops.

## Reference

- [references/routing.md](references/routing.md) — intake, handoffs, skip rules, fixtures, pass criteria
