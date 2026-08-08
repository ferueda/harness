# Planning routing

Use these skip rules and fixtures when validating `planning-workflow` routing.
The coordinator's intake rubric is authoritative.

## When to skip steps

| Skip | When |
|------|------|
| shape | The outcome and acceptance boundary are materially clear |
| diagnose | Code truth can be confirmed through normal implementation discovery and cannot reasonably change scope or direction |
| review-spec | No material written claim needs validation, or the same revision was already reviewed |
| create-plan | One safe implementation pass is credible and no durable sequencing, risk, review, or handoff artifact is needed |
| plan-review | The plan is trivial or the same revision was already reviewed |
| handoff-work | The same agent continues in one session |

## Artifact paths

| Artifact | Path |
|----------|------|
| Requirements brief | `dev/briefs/YYMMDD-short-slug.md` |
| Problem definition | inline or `dev/issues/YYMMDD-short-slug.md` |
| Architecture memo | inline only |
| Implementation plan | `dev/plans/YYMMDD-short-slug.md` |

## Scenario fixtures

Forward-test representative routes after editing the coordinator or child
skills. Run each prompt with fresh context and compare the first action and path.

| # | User prompt | Expected first action | Expected path |
|---|-------------|----------------------|---------------|
| 1 | "Interview me about a caching layer for session indexing" | `shape-requirements` **interview** | interview → brief; later work re-enters triage |
| 2 | "Add retry logic to the API client" (no behavior or boundary) | low-risk read, then `shape-requirements` **gate** if material ambiguity remains | gate → re-triage |
| 3 | "Fix the login 500 when email is empty. Repro and acceptance criteria attached." | implementation | repository test-first fix path → `change-review-workflow` |
| 4 | "Login sometimes returns 500; find out why" | `diagnose-issue` | diagnosis → re-triage |
| 5 | "Review dev/plans/foo.md against the codebase" | `harness run plan-review --plan dev/plans/foo.md` | plan review |
| 6 | "Implement dev/plans/foo.md" | implementation | implement → `change-review-workflow` |
| 7 | "Implement this detailed checkout spec. It touches API, database, and UI but defines one accepted outcome and tests." | low-risk validation, then implementation when the claims hold | implement → `change-review-workflow` |
| 8 | "Plan the phased migration of stored tokens with rollback and zero downtime" | `create-plan` after validating material assumptions | plan → `plan-review` |
| 9 | Three outcomes that can ship independently | `shape-requirements` **gate** | recommend the smallest useful slice → re-triage |
| 10 | "Plan a new public API shape for this project" | `shape-requirements` **gate** when intent is unclear; otherwise `review-spec` or `create-plan` | validate intent → plan → `plan-review` |
| 11 | "Use architect to design a new public API shape first" | `architect` | inline memo → stop or re-triage per the original request |
| 12 | "Audit this repo for DX improvements" | `audit` | audit → prioritized findings or plans per the audit request |
| 13 | "The brief says the worker retries forever; implement its bounded fix" | low-risk read; `diagnose-issue` only if that claim could change direction | validate or diagnose → re-triage or implement |

### Pass criteria

- States the route before starting a child skill or editing.
- Direct-ready work creates no requirements, diagnosis, or plan artifact.
- Ready work asks no question unless a human prerequisite blocks all useful
  routes.
- Loads a selected child skill instead of imitating it inline.
- Re-triages after a planning output; planning does not make `create-plan`
  inevitable.
- **gate** asks only about material ambiguity after low-risk discovery.
- **interview** asks one question at a time until the user says write up.
- Created plans are minimum-sufficient for a capable executor and connect each
  material outcome to focused proof.
