# Routing scenarios

Fixture prompts for manual routing checks after editing `planning-workflow` or child skills. Compare agent behavior to expected first skill and path.

Routing rules: [routing.md](routing.md).

## Fixtures

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

## Pass criteria

- Names first skill before acting.
- **gate**: no commands, edits, or plans before confirmed interpretation.
- **interview**: one question at a time until user says write up.
- Skipped steps match [routing.md](routing.md) with stated reason.
- Artifacts at expected paths when the path produces them.

Evaluate real sessions with `session-evidence` — [audit-examples.md](../../session-evidence/references/audit-examples.md) (planning example).
