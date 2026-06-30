---
name: planning-workflow
description: >
  Coordinate planning from intent to implementation. Route through shape-requirements,
  diagnose-issue, review-spec, create-plan, implement-plan, and handoff-work. Use when
  starting feature work, fixing a non-trivial issue, or running the full plan-build cycle.
---

# Planning Workflow

Chat coordinator for intent → validated plan → implementation. Not a `harness run` target.

## 1. Route intake

| Signal | Start with |
|--------|------------|
| Vague idea, no brief | `shape-requirements` **interview** |
| Build/fix/plan now but scope or done-ness unclear | `shape-requirements` **gate** |
| Symptom, bug, ticket, or design concern about current code | `diagnose-issue` |
| Written brief/spec/plan already exists | `harness run plan-review --plan <path>` for existing implementation plans; otherwise `review-spec` or `create-plan` (see step 2) |
| Approved plan ready to execute | `implement-plan` |

**diagnose-issue** when the question is what is true in the repo. **shape-requirements** when the question is what the user wants.

Too vague to investigate → `shape-requirements` **gate** only (not interview), then `diagnose-issue`.

**Done when:** starting skill chosen.

## 2. Shape and validate

| Artifact | Next |
|----------|------|
| Brief or problem definition | `review-spec` when claims must match the codebase |
| Problem definition with multiple directions | `shape-requirements` **gate** to pick one |
| Validated spec or brief | `create-plan` when work is multi-step, cross-area, or needs executor handoff |
| Created non-trivial implementation plan | `harness run plan-review --plan <path>`; direct `review-spec` fallback when harness is unavailable or durable artifacts are unnecessary |
| Small scoped change after gate | implement directly or skip to step 4 |

Run `review-spec` before `create-plan` when the plan would depend on unverified assumptions.
After `create-plan`, prefer `plan-review` for non-trivial, cross-area, or
handoff-ready plans. The planning agent owns triage: accept, adapt, or decline
reviewer findings, edit the plan, and rerun `plan-review` after material plan
changes. Harness does not edit plans automatically.

**Done when:** plan approved or direct-implement path confirmed.

## 3. Hand off between agents

Use `handoff-work` when a different agent or session continues:

- After `create-plan` → executor runs `implement-plan`
- After partial `implement-plan` → reviewer or continuation agent
- Before `change-review-workflow` when the implementer is not the reviewer

**Done when:** handoff written or explicitly skipped (same agent, same session).

## 4. Implement

| Path | Skill |
|------|-------|
| Approved `dev/plans/*.md` | `implement-plan` |
| Gate-cleared small change | implement in session |

**Done when:** plan phases complete or scoped change landed.

## 5. Close

| Outcome | Next |
|---------|------|
| Code changed, review needed | `change-review-workflow` |
| Plan-only session | update plan status; stop |

**Done when:** next workflow named or user stops.

## Reference

- [references/routing.md](references/routing.md) — intake, handoffs, skip rules, fixtures, pass criteria
