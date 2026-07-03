# Planning routing

Routing rules, skip table, artifact paths, and scenario fixtures. Use when choosing the first skill or validating a path.

## Intake

| Signal | Start with |
|--------|------------|
| Vague idea, no brief | `shape-requirements` **interview** |
| Build/fix/plan now but scope or done-ness unclear | `shape-requirements` **gate** |
| Symptom, bug, ticket, or design concern about current code | `diagnose-issue` |
| Written brief/spec/plan already exists | `harness run plan-review --plan <path>` for existing plans; otherwise `review-spec` or `create-plan` |
| Created implementation plan needs review before execution | `harness run plan-review --plan <path>` (`review-spec` fallback) |
| Approved plan ready to execute | `implement-plan` |

**shape-requirements** when the question is what the user wants. **diagnose-issue** when the question is what is true in the repo. Too vague to investigate → **gate** only (not interview), then `diagnose-issue`.

Intent-aware review: when work affects product direction, architecture boundaries, docs-architecture, data/tenancy, provider contracts, public APIs, or workflow-wide behavior, validate it against the target repo's intent source (`docs/project-intent.md`, root `VISION.md`, or explicit intent docs linked from repo guidance).

## shape ↔ diagnose handoffs

| Question | Skill |
|----------|-------|
| What should we build? | shape |
| Is this bug/risk real in the code? | diagnose |
| Brief asserts current behavior | shape → diagnose |
| Diagnose found multiple directions | diagnose → shape **gate** |
| Diagnose **Not Found** / **Invalidated** | report evidence; shape **interview** only if the goal was wrong |

## When to skip steps

| Skip | When |
|------|------|
| shape | Ticket has repro + clear acceptance criteria |
| diagnose | Greenfield feature with no code-truth claims |
| plan-review / review-spec | Trivial plan or prior review on same revision |
| create-plan | Single-file fix after gate |
| handoff-work | Same agent continues in one session |

## Artifact paths

| Artifact | Path |
|----------|------|
| Requirements brief | `dev/briefs/YYMMDD-short-slug.md` |
| Problem definition | inline or `dev/issues/YYMMDD-short-slug.md` |
| Implementation plan | `dev/plans/YYMMDD-short-slug.md` |

## Scenario fixtures

Manual checks after editing `planning-workflow` or child skills. Compare agent behavior to the expected first action and path.

| # | User prompt | Expected first action | Expected path |
|---|-------------|----------------------|---------------|
| 1 | "Interview me about a caching layer for session indexing" | `shape-requirements` **interview** | brief → `review-spec` → `create-plan` → `plan-review` |
| 2 | "Add retry logic to the API client" (no scope) | `shape-requirements` **gate** | gate → implement or `create-plan` |
| 3 | "JIRA-442: login 500 when email is empty" | `diagnose-issue` | diagnose → `create-plan` → `plan-review` → `implement-plan` |
| 4 | "Review dev/plans/foo.md against the codebase" | `harness run plan-review --plan dev/plans/foo.md` | `plan-review` when harness is available; direct `review-spec` fallback |
| 5 | "Implement dev/plans/foo.md" | `implement-plan` | implement → `change-review-workflow` |
| 6 | "Audit this repo for DX improvements" | `audit` | audit → `create-plan`(s) |
| 7 | "Add logging" (nothing else) | `shape-requirements` **gate** | gate only — no implement/plan before approval |
| 8 | Three diagnose directions; pick one | `shape-requirements` **gate** | gate → `create-plan` → `plan-review` |
| 9 | Greenfield brief, no code-truth claims | `shape-requirements` **interview** | brief → `create-plan` → `plan-review` (skip diagnose) |
| 10 | "Plan a new public API shape for this project" | `shape-requirements` **gate** when intent is unclear; otherwise `review-spec` or `create-plan` | confirm intent source → `create-plan` → `plan-review` validates project alignment |

### Pass criteria

- Names first skill before acting.
- **gate**: no commands, edits, or plans before confirmed interpretation.
- **interview**: one question at a time until user says write up.
- Skipped steps match the skip table above with a stated reason.
- Artifacts at expected paths when the path produces them.
