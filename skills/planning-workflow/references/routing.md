# Planning routing

Routing rules, skip table, artifact paths, and scenario fixtures. Use when choosing the first skill, validating a path, or scoring sessions against expected behavior.

## Intake

| Signal | Start with |
|--------|------------|
| Vague idea, no brief | `shape-requirements` **interview** |
| Build/fix/plan now but scope or done-ness unclear | `shape-requirements` **gate** |
| Symptom, bug, ticket, or design concern about current code | `diagnose-issue` |
| Written brief/spec/plan already exists | `review-spec` or `create-plan` |
| Approved plan ready to execute | `implement-plan` |

**shape-requirements** when the question is what the user wants. **diagnose-issue** when the question is what is true in the repo. Too vague to investigate → **gate** only (not interview), then `diagnose-issue`.

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
| review-spec | Trivial plan or prior review on same revision |
| create-plan | Single-file fix after gate |
| handoff-work | Same agent continues in one session |

## Artifact paths

| Artifact | Path |
|----------|------|
| Requirements brief | `dev/briefs/YYMMDD-short-slug.md` |
| Problem definition | inline or `dev/issues/YYMMDD-short-slug.md` |
| Implementation plan | `dev/plans/YYMMDD-short-slug.md` |

## Scenario fixtures

Manual checks after editing `planning-workflow` or child skills. Compare agent behavior to expected first skill and path.

| # | User prompt | Expected first skill | Expected path |
|---|-------------|----------------------|---------------|
| 1 | "Interview me about a caching layer for session indexing" | `shape-requirements` **interview** | brief → `review-spec` → `create-plan` |
| 2 | "Add retry logic to the API client" (no scope) | `shape-requirements` **gate** | gate → implement or `create-plan` |
| 3 | "JIRA-442: login 500 when email is empty" | `diagnose-issue` | diagnose → `create-plan` → `implement-plan` |
| 4 | "Review dev/plans/foo.md against the codebase" | `review-spec` | `review-spec` only |
| 5 | "Implement dev/plans/foo.md" | `implement-plan` | implement → `change-review-workflow` |
| 6 | "Something's wrong with sessions" | `shape-requirements` **gate** | gate → `diagnose-issue` |
| 7 | "Audit this repo for DX improvements" | `audit` | audit → `create-plan`(s) |
| 8 | "Add logging" (nothing else) | `shape-requirements` **gate** | gate only — no implement/plan before approval |
| 9 | Three diagnose directions; pick one | `shape-requirements` **gate** | gate → `create-plan` |
| 10 | Greenfield brief, no code-truth claims | `shape-requirements` **interview** | brief → `create-plan` (skip diagnose) |

### Pass criteria

- Names first skill before acting.
- **gate**: no commands, edits, or plans before confirmed interpretation.
- **interview**: one question at a time until user says write up.
- Skipped steps match the skip table above with a stated reason.
- Artifacts at expected paths when the path produces them.

### Score real sessions

Use `session-evidence` — [audit-examples.md](../../session-evidence/references/audit-examples.md) (planning example). Score against fixture # and pass criteria.
