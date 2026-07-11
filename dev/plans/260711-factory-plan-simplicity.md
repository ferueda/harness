# Plan 260711-factory-plan-simplicity: Make Factory plans minimum-sufficient

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: direction

## Why this matters

Factory planning currently rewards exhaustive executor handoffs more strongly
than task fidelity and proportionality. Small work can therefore produce long,
defensive plans that obscure the requested outcome. Factory should preserve
project intent, choose the smallest coherent solution, and include only the
decisions and verification an executor actually needs.

## Current state

- `lib/prompts/factory-planning.ts` makes the full `create-plan` apparatus
  mandatory for every Factory plan.
- `lib/prompts/spec-review.ts` mentions simplicity but leads with a broad
  completeness checklist.
- `workflows/factory-planning.workflow.ts` forwards every reviewer finding into
  revisions, including advice.
- `lib/workflow-context.ts` validates review shape but not the `verdict` ↔
  `must_fix` contract for spec reviews.
- `lib/config.ts` defaults Factory planning to three review passes; this repo
  configures five, and `test/config.test.ts` locks both behavior paths.
- `docs/project-intent.md` leaves scope judgment to humans, and
  `docs/contributing/harness-engineering.md` says to implement the smallest
  coherent change.

## Scope

In scope: Factory planner/revision prompts, shared spec-review guidance,
spec-review verdict validation, Factory finding selection, default review
ceiling, focused tests, and operator docs.

Out of scope: general `create-plan` behavior, new reviewers, hard word limits,
triage schemas, plan profiles, provider behavior, lifecycle/storage contracts,
and tracker-comment authority parsing.

## Alignment constraints

- Keep workflows provider-agnostic and leave generic review schemas unchanged.
- Preserve complete durable reviewer evidence and existing Factory scratch/store
  ownership; only the next planner prompt is filtered.
- Keep docs generic, standalone, and accurate to current runtime behavior.
- The work item remains the task source. An architecture decision constrains
  planning only when the work item explicitly marks it accepted, current, or
  locked, or says it supersedes an earlier direction. Unmarked proposals and
  option lists are context only. Do not infer authority from comment order;
  unresolved explicit conflicts require `needs-human` quoting both directions.

## Skills for the executor

| Skill                    | Use                                                                          |
| ------------------------ | ---------------------------------------------------------------------------- |
| `typescript-refactor`    | Keep review-contract validation explicit and locally typed.                  |
| `vitest`                 | Cover prompt contracts, verdict validation, finding filtering, and defaults. |
| `change-review-workflow` | Review the completed implementation before publication.                      |

## Steps

### 1. Define minimum-sufficient authoring and scope-first review

Make the Factory prompt prioritize hard invariants, explicit human scope,
accepted architecture decisions, and verified repo facts. Require only goal,
relevant constraints/current state, smallest coherent approach, scoped changes,
focused verification, and genuine blockers. Make other plan sections
conditional. Align `review-spec` prompt and skill around traceability to the
accepted goal and removal of unsupported work.

**Verify**: `pnpm exec vitest run test/factory-planning-prompt.test.ts
test/workflow-context.test.ts` → prompt tests prove intent hierarchy,
conditional detail, scope traceability, and pruning language remain present.

### 2. Make review revisions blocking-only

For spec review, reject `needs_changes` without a `must_fix` and `pass` with a
`must_fix`. Enforce this after generic schema parsing for `review-spec` only;
invalid output fails that review step while retaining raw evidence, and other
reviewers keep their current contract. `blocked` is exempt because it represents
missing evidence or human direction rather than a requested plan revision.

Enrich every finding once so IDs remain stable, persist the complete list, then
derive the blocking subset for the revision prompt and decision validation.
Reject planner decisions for advisory IDs. Revisions must remove obsolete or
speculative material after fixing the blocker.

**Verify**: `pnpm exec vitest run test/workflow-context.test.ts
test/factory-planning.workflow.test.ts` → inconsistent spec verdicts fail;
mixed advisory/blocking findings retain stable IDs in evidence while only
blocking IDs reach the revision. Direct workflow-context cases assert raw
evidence remains, no parsed review is written, and the same payload still
parses for a non-spec reviewer; existing blocked-flow coverage remains green.

### 3. Bound normal review churn and document the contract

Change the default Factory review ceiling to two completed reviews while
preserving explicit configuration overrides. Update repo configuration and
active operator surfaces: `harness.json`, `bin/factory-commands.ts`, `README.md`,
`docs/contributing/factory.md`, and `skills/factory-operator/SKILL.md`. Describe
minimum-sufficient plans and one normal revision opportunity; retain a
configured value such as five in tests to prove overrides.

**Verify**:

1. `pnpm exec vitest run test/config.test.ts test/workflow-context.test.ts
test/factory-planning.workflow.test.ts test/factory-planning-smoke.test.ts
test/review-output-schema-sync.test.ts
test/factory-planning-output-schema-sync.test.ts` → targeted behavior passes.
2. `pnpm check` → repository gate passes.
3. `harness run change-review --plan
dev/plans/260711-factory-plan-simplicity.md` → no unresolved actionable
   findings.

## Done criteria

- Factory prompts make task fidelity, project intent, and the smallest coherent
  solution higher priority than exhaustive handoff detail.
- Optional plan sections are required only by a named constraint or risk.
- Spec-review verdicts and `must_fix` findings cannot contradict each other.
- Advisory findings remain evidence but never expand a Factory revision.
- Default review ceiling is two and remains configurable.
- Focused tests and `pnpm check` pass with no unrelated source changes.

## STOP conditions

- Stop if verdict enforcement requires changing the shared exported review
  schema for non-spec reviewers.
- Stop if filtering findings would remove them from durable review evidence.
- Stop if the solution requires a new triage authority or plan-format schema.

## Maintenance notes

Treat plan length only as a diagnostic signal. If representative Factory runs
remain bloated after this contract change, evaluate a provenance-aware planning
brief before introducing profiles or hard limits.
