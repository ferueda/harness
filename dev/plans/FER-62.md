# Plan 260710-automate-factory-implementation-review: Make Factory implementation review and remediation durable and resumable

> **Executor instructions**: Follow this plan in order. Run every verification
> command and confirm its expected
> result before moving on. Do not start implementation until the dependency gate
> in Step 0 passes. If any STOP condition occurs, stop and report; do not invent a
> parallel review engine, lifecycle recovery path, or tracker contract.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Execution status**: ready for implementation; final plan-review findings
  applied and accepted without a second reviewer run.
- **Depends on**: FER-52 implementation merge `6e10bf60fd6d2f743bea507de5928cd4768d5c9e`
  (implementation Linear projection) and FER-61 implementation merge
  `5aff4d4e3d4c4d95d5130397a0ef3409829e0c38` (workspace/durable-store writer
  boundary). Both implementation PRs are merged; their exact surfaces are
  reconciled below.
- **Category**: direction
- **Issue**: https://linear.app/ferueda/issue/FER-62/automate-factory-implementation-review-and-remediation

## Why this matters

Factory currently stops after one implementation provider pass. It preserves a
candidate ref and a handoff, but operators must manually run `change-review` and
there is no canonical, resumable remediation lineage. This change makes Factory
own review through a deterministic PR-ready handoff while keeping lifecycle JSONL
and durable run evidence canonical, Git as the code source of truth, and Linear as
a human projection only.

## Requirements and fixed decisions

These requirements are the contract. Do not weaken them to simplify the code.

### Functional flow

1. Add `harness factory implementation review` with exactly one identity source:
   `--item-file` or `--linear-issue`; support `--resume` for interrupted/failed
   review attempts.
2. Resolve the stable owning implementation from canonical lifecycle state and
   its recorded run metadata. A caller-supplied run directory is not an identity
   input and must not be added.
3. Reuse `createWorkflowContext(...)` and `workflows/change-review.workflow.ts`
   with all three existing roles. Every completed review compares the original
   implementation `reviewBase` with the latest immutable candidate ref.
4. Normalize reviewer findings in stable role order with per-review IDs:
   `implementation-NNN`, `quality-NNN`, and `simplify-NNN`.
5. Resume the original implementer provider session. Require exactly one
   `implement`, `adapt`, or `decline` decision with a non-empty rationale for
   every current finding.
6. `implement`/`adapt` requires a changed workspace tree. Any material workspace
   change creates a new immutable cumulative candidate ref and forces another
   full three-role review. No partial follow-up review is allowed in Factory.
7. A pass with no findings, or justified declines of only non-blocking findings,
   produces a Harness-rendered deterministic PR-ready handoff. A declined
   `must_fix` is an unconditional `ready-for-human` outcome—even when the
   remediation turn changed the workspace or recovery started from a partial
   tree. Blocked review, missing/incompatible session, or exhausted review limit
   also produces `ready-for-human`, never `implementation-failed`.
8. Reviewer/provider/Git/artifact/protocol failures produce durable
   `review-failed` evidence. Only completed three-role review cycles increment
   `factory.implementation.maxReviewIterations`.

### Canonical lifecycle and concurrency

- Add `implementation.review.started`, `.checkpointed`, `.completed`,
  `.unresolved`, and `.failed` events. Checkpoints contain artifact/ref pointers,
  counters, and provenance, never full findings.
- Add an optional internal implementation checkpoint to the lifecycle read model:
  owning implementation run, original base, approved latest-candidate
  ref/commit/tree, implementer session, workspace/store provenance, candidate
  version, completed review count, immutable effective review limit and its
  config/CLI provenance, active attempt, prior attempt, latest review/decision
  pointers, optional partial-recovery ref/commit/tree plus attempt/index, and
  latest outcome/error classification. Partial recovery evidence never replaces
  the approved candidate tuple.
- Every ownership transition is conditional and is evaluated while holding the
  per-work-item lifecycle lock. Idempotency lookup happens before precondition
  evaluation so retrying the same event remains safe.
- `factoryRunId` remains the owning implementation run ID for all implementation
  and review stages. Review-attempt IDs are internal checkpoint fields and the
  `implementation.review.*` event `runId`; review events must never replace the
  public `factoryRunId` projection. The checkpoint separately stores
  `owningImplementationRunId` and `activeReviewAttemptId`.
- Add a separate durable workspace writer lease, keyed solely by the physical
  Git checkout rather than work item or Factory-store project. Define one shared
  canonicalizer: resolve the workspace's Git top-level, `realpath` that existing
  directory, and derive a stable key from the physical path; failure to resolve
  either value fails closed. Store project provenance remains owner metadata and
  is revalidated, but never participates in the lease key. Use the physical key
  for lease acquisition, tuple
  revalidation, owner diagnostics, and status inspection—never the caller's
  lexical/symlinked workspace path. Any live implementation or remediation
  provider turn must acquire it before the final clean/tree check and retain it
  through provider completion plus candidate/partial-ref materialization and
  terminal/checkpoint persistence. Release it before any Linear projection call;
  a blocked or failed Linear call must never retain the workspace lease. It is
  not the lifecycle lock and is never held for nested read-only review, artifact
  rendering, or Linear I/O. Stale-owner recovery follows existing durable lease
  liveness rules. The lease
  namespace is `join(defaultFactoryStoreRoot(env), "workspace-leases")`, resolved
  from the OS-user Harness data root and independent of explicit store-root,
  project-ID, state-root, and runs-dir overrides. All commands in one user
  environment therefore converge on the same namespace even when their Factory
  projects or store roots differ. The canonical physical key is the SHA-256
  digest of the `realpath` Git top-level; the lease path is
  `<lease-root>/<key>.lock`. Create the namespace with owner-only permissions,
  fail closed if it cannot be created or inspected, and remove only a matching
  owner token on release. `factory status` derives and inspects this same path
  without acquiring it. Contention fails closed with owner diagnostics.
  Revalidate the approved/partial tuple after
  acquisition and immediately before ref creation.
- `implementation.started` must become a real ownership stage. A fresh
  implementation may claim only a canonical ready stage and must reject an
  existing `implementation-started`, `implementation-complete`, every review
  stage, and stale owners.
- Implementation ownership preserves the existing first-run/retry matrix:
  `attempt: first` may claim only canonical `ready-to-implement` with no active
  owner; `attempt: retry` may claim only canonical `implementation-failed` with
  the expected prior failed implementation run ID and no active review
  checkpoint. Each claim allocates a new run ID, records the prior run for a
  retry, and emits the same conditional `implementation.started` ownership
  event. Linear start projection uses FER-52's existing first/retry input;
  retry never claims from `implementation-complete`, any review stage,
  `ready-for-human`, or stale ownership.
- Add an explicit stale-owner recovery transition for a crash after
  `implementation.started` and before local terminalization. Under the lifecycle
  lock, require the recorded same-host owner PID to be proven dead, no terminal
  event/review checkpoint to exist, the reservation/run metadata to match, and
  the physical workspace lease to be acquirable. Re-probe Linear status before
  deciding anything: `Ready to Implement` records a retryable local
  `implementation.failed` with `linearStartState: "not-started"` and no failed
  projection; `Implementing` records `linearStartState: "implementing"` and
  permits exactly one failed projection after local evidence and lease release;
  any other, remote, unknown, or unavailable status transitions to
  `ready-for-human` with `stale-owner` evidence and no provider invocation.
  If the workspace tree/HEAD differs from the recorded pre-provider snapshot,
  preserve the edits and take the same `ready-for-human` path rather than
  guessing whether the crashed provider completed. A retryable stale-owner
  failure may be retried only after a fresh status probe: `Ready to Implement`
  uses Linear's first-attempt input and `Implementation Failed` uses its retry
  input. Add live/dead/remote PID, tree-drift, status-probe, one-projection,
  and retry tests; stale workspace leases alone never rewrite lifecycle state.
- Initial review is allowed only from `implementation-complete`; resume is
  allowed only from `review-running` or `review-failed` with exact owner and
  checkpoint matches. `review-complete` returns the existing handoff
  idempotently. `ready-for-human` remains terminal.
- Never hold the lifecycle lock around Git work, provider execution, reviewer
  execution, or artifact rendering.
- A separate work item may not begin an implementation/remediation provider turn
  in the same workspace while the workspace writer lease is held; reviews remain
  read-only and may run without it.
- Resume behavior is explicit: a `review-failed` checkpoint with a validated
  partial tuple restores its immutable findings/index and resumes remediation;
  a `review-failed` checkpoint without a partial tuple revalidates the approved
  candidate and starts a fresh full three-role review from that candidate. Both
  paths preserve the completed-review counter, effective limit, owning
  implementation ID, and prior-attempt lineage. Missing/incompatible sessions
  remain `ready-for-human`; repeated reviewer/provider/artifact failures follow
  the same matrix and never invent a new implementation session.

### Git/workspace lineage

- Preserve `refs/harness/factory/<implementation-run-id>/implementation`.
- Approved remediation candidates use create-only refs
  `refs/harness/factory/<implementation-run-id>/review/<candidate-version>`.
  Version starts at 1 for the first remediation, independent of review count.
- Each remediation commit uses the prior candidate commit as its sole parent.
  The temporary index starts from the prior candidate, stages the current
  workspace, rejects `.harness/` in the tree, and updates the ref only if it does
  not already exist.
- Before an ordinary review/resume, require workspace `HEAD ==
  originalReviewBase`, current materialized workspace tree == recorded approved
  candidate tree, approved candidate ref == recorded commit, candidate commit
  tree == recorded tree, workspace/store provenance match, and exact lifecycle
  owner/checkpoint match. A `review-failed` resume with partial recovery instead
  validates the distinct recorded partial ref/commit/tree and its attempt/index;
  it must not substitute that tuple for the approved candidate or accept an
  unrecorded tree.
- A provider failure after edits gets a create-only partial evidence ref under
  `refs/harness/factory/<implementation-run-id>/review-attempt/<attempt-run-id>/<review-index>/partial`,
  plus status, patch, stream, and recovery manifest. It does not replace the
  approved latest candidate. Resume may continue only from that exact recorded
  failure tree; otherwise require human recovery.

### Two-plane ownership

| Plane | Writer | Allowed contents |
| --- | --- | --- |
| Target workspace | Implementer/remediation agent | Repository source/test/doc edits required by the work item; no refs, lifecycle, decisions, checkpoints, or handoffs |
| Durable Factory store | Harness only | Factory attempts, nested reviews, prompts, raw/parsed output, streams, findings, decisions, status/patches, refs/checkpoints, recovery manifests, summaries, lifecycle, and handoffs |

- Inline findings in the remediation prompt. Do not expose any durable path as
  an agent output destination. Decisions are provider structured output; agents
  never write decision files.
- Continue passing `logPath` to the provider adapter: the adapter/Harness writes
  the stream, not the agent tool session.
- Prompts are not the authority boundary. Add a typed
  `FactoryWriterBoundarySnapshot`/`assertFactoryWriterBoundary` guard around
  every implementation and remediation turn. Before invocation, snapshot all
  Git refs plus `HEAD`/index, the workspace `.harness` tree, lifecycle
  state/events, and Factory-store paths outside the explicit Harness-owned
  allowlist for this attempt (including the adapter stream path). After the
  provider returns, reject any unexpected ref, `HEAD`/index, `.harness`,
  lifecycle, or durable-store mutation; retain the before/after boundary
  manifests. Expected source/test/doc working-tree edits remain allowed and are
  captured by the existing `workspaceGuard: "record"`. A boundary violation is
  a typed `workspace`/`protocol` failure, never reviewed or promoted; if source
  files also changed, capture the non-promoted partial tuple before
  terminalization.
- Review/candidate commits and refs are Harness Git operations through a
  temporary index. Agents must not receive a ref-mutating turn.
- The final handoff is rendered directly by Harness. No final agent-writing turn.

### Explicit non-goals

- GitHub PR creation/linking, branch creation, pushing, or moving tracker work to Done.
- New Linear review statuses or parsing Linear comments as workflow input.
- Inngest, worktrees, transactional rollback, or `danger-full-access` as normal policy.
- A second reviewer executor/aggregator or changes to standalone `change-review` semantics.
- Fresh implementation as review recovery.
- Canonical lifecycle state or Factory durable evidence inside the target workspace.

## Current state (verified 2026-07-10)

- `workflows/factory-implementation.workflow.ts:51-217` performs one live
  implementer call, captures the session, materializes one review head, writes a
  handoff, and returns `implementation-complete`. Its summary explicitly says
  reviewers were not run.
- `lib/factory-review-head.ts:27-78` already uses a temporary Git index and
  `commit-tree`, but it only creates the initial implementation ref, does not
  return the tree SHA, and uses unconditional `git update-ref`.
- `workflows/change-review.workflow.ts:7-26` defines the existing ordered review
  set (`implementation`, `quality`, `simplify`) and maps it to
  `review-implementation`, `code-quality-review`, and `simplify`. This is the only
  review engine the Factory coordinator may invoke.
- `workflows/factory-planning.workflow.ts:281-321` is the nested-workflow exemplar:
  it creates a `WorkflowContext`, points `runsDir` at the durable review store,
  forwards provider/model/policy/event sink, invokes the existing review workflow,
  and stores a small reference instead of copying nested artifacts.
- `lib/workflow-context.ts:163-221` accepts explicit base/head, review run root,
  plan path, and Harness-read `handoffText`; lines 335-394 show Harness writing
  prompts/raw/parsed reviewer output/streams. No workflow-context change is
  required unless FER-61 changes this verified contract.
- `lib/factory-lifecycle.ts:184-230` currently has only implementation
  started/completed/failed events. `FactoryLifecycleStateSchema` has no internal
  implementation checkpoint. The reducer at lines 636-671 treats
  `implementation.started` as audit-only and only changes stage at terminal time.
- `lib/factory-lifecycle.ts:365-399` serializes append/reduce/cache writes under a
  per-item lock, but has no conditional expected-state contract. Current command
  code therefore performs stale reads followed by unconditional appends.
- `bin/factory-commands.ts:628-697` appends import/start, runs the provider, then
  appends terminal state. This must be hardened for atomic ownership as part of
  this issue, not left as a review-only fix.
- `lib/factory-schemas.ts:19-40` already lists `review-running`,
  `review-complete`, and `ready-for-human`; it lacks `review-failed`.
- `lib/schemas.ts:72-112` configures only `factory.implementation.roles.implementer`;
  `lib/config.ts:73-107,137-183` has no implementation reviewer role or
  implementation review-limit resolver. Existing Cursor review execution uses
  agent mode, and `workspaceGuard` detects post-run drift rather than preventing
  writes; Factory therefore needs a Codex-only enforced read-only reviewer role.
- `lib/agents.ts:24,70-89`, `providers/codex/codex-agent.ts`, and
  `providers/cursor/cursor-sdk-agent.ts` already support `AgentSessionRef`
  resumption and provider-owned `logPath` streaming. `lib/agent-session.ts:33-65`
  rejects provider/session mismatches.
- `docs/contributing/factory.md:543-616`, `README.md:139`, and
  `docs/contributing/architecture.md:163-177,246-266` document the current manual
  stop before `change-review`; all are stale after this work and must change.
- FER-52 is merged. `lib/factory-linear-implementation-apply.ts` provides
  `applyLinearImplementationStarted`, `applyLinearImplementationCompleted`,
  and `applyLinearImplementationFailed`; `LinearFactoryAdapter` exposes the
  corresponding three methods; `bin/factory-commands.ts` invokes them; and
  `lib/schemas.ts`/`lib/config.ts` provide the `implementing` and
  `implementationFailed` status mappings. The dependency tests are
  `test/factory-linear-implementation-apply.test.ts`,
  `test/factory-linear-adapter.test.ts`, and
  `test/factory-implementation-apply-command.test.ts`.
- FER-61 is merged. `FactoryPlanningRunContext` now exposes
  `preparePlannerScratch()` and `preparePlannerIteration(index)`, separates
  workspace-local `.harness/factory-drafts/<run-id>/draft.md` from durable
  evidence, and preserves the existing provider input contract. The planning
  workflow invokes the scratch/iteration preparation and uses the recorded
  workspace guard. Coverage is in `test/factory-planning-run-context.test.ts`,
  `test/factory-planning-policy.test.ts`, `test/factory-planning-smoke.test.ts`,
  and the updated planning workflow/CLI failure tests.
- The FER-52/FER-61 dependency gate is now satisfied. Step 0 still requires
  this plan's exact-surface reconciliation and a passing plan-review before
  implementation begins.
- Baseline verification: `pnpm typecheck` exits 0. The six-file focused command
  below passes 143 tests. A full `pnpm test` currently passes 882 tests and fails
  only `skills/sessions/test/cli.test.ts > installed sessions skill bootstraps
  dependencies without harness checkout` because its child install exits 1 in
  this restricted environment. Treat that as known baseline evidence, not as an
  authorization to ship a newly failing full gate.

### Existing conventions to match

- Strict runtime boundaries use Zod `.strict()` schemas plus inferred types; see
  `lib/factory-planning-schemas.ts:14-50`.
- Provider schemas have checked-in JSON Schema twins and sync tests; see
  `schemas/factory-planning-output.schema.json` and
  `test/factory-planning-output-schema-sync.test.ts`.
- Run contexts own directory creation, typed artifact writers, event sinks, meta,
  summary, and cleanup; see `lib/factory-implementation-run-context.ts:136-268`.
- Lifecycle events store run/store-relative artifact pointers via
  `formatLifecycleArtifactPath`; see `lib/factory-lifecycle-writes.ts:512-537`.
- Git tests create real temporary repositories and inspect commits/refs; follow
  `test/factory-review-head.test.ts`.
- Workflow tests inject fake providers/runners and inspect precise inputs; follow
  `test/factory-planning.workflow.test.ts` and
  `test/factory-implementation.workflow.test.ts`.
- Node ESM imports use `.ts`, type-only imports use `import type`, and exported
  functions receive explicit return types where practical.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Install | `pnpm install --frozen-lockfile` | exit 0 using `pnpm@11.9.0` |
| Focused baseline | `pnpm exec vitest run test/factory-lifecycle.test.ts test/factory-implementation-cli.test.ts test/factory-implementation.workflow.test.ts test/factory-review-head.test.ts test/workflow-context.test.ts test/config.test.ts` | 6 existing files and all tests pass |
| New review suite | `pnpm exec vitest run test/factory-implementation-review-*.test.ts test/factory-lifecycle.test.ts test/factory-locks.test.ts test/factory-status.test.ts test/factory-run-allocation.test.ts test/factory-writer-boundary.test.ts test/factory-review-head.test.ts test/factory-implementation-cli.test.ts test/config.test.ts` | all named files pass |
| Linear integration | `pnpm exec vitest run test/factory-linear-adapter.test.ts test/factory-linear-implementation-apply.test.ts test/factory-implementation-cli.test.ts test/factory-implementation-review-cli.test.ts` | all named files pass |
| Typecheck | `pnpm typecheck` | exit 0, no diagnostics |
| Format check | `pnpm format:check` | exit 0 |
| Lint | `pnpm lint` | exit 0 |
| Build | `pnpm build` | exit 0 and `dist/` generated |
| CLI smoke | `pnpm smoke:dist` | exit 0; review command help checks pass |
| Full gate | `make check` | exit 0; format, lint, typecheck, tests, build, smoke all pass |
| Change review | Save the Step 6 CLI JSON output, derive `runDir`, `workspace`, `originalReviewBase`, `approvedCandidate.ref`, and optional `approvedPlanPath` from that output/run `meta.json`, then use the literal Step 7 command below. | completed run; all findings triaged |

Do not use `pnpm test -- <files>` for a focused run: in this repository it still
executed the entire suite during planning. Use `pnpm exec vitest run <files>`.

## Skills for the executor

| Skill | Verified location | Use in |
| --- | --- | --- |
| `typescript-refactor` | `.agents/skills/typescript-refactor/SKILL.md` | Steps 1-6: discriminated lifecycle/event unions, exhaustive narrowing, explicit exported types, and error classification. |
| `zod` | `.agents/skills/zod/SKILL.md` | Steps 1-2 and 4: strict provider output, lifecycle checkpoint, event, and artifact parsing at trust boundaries. |
| `node` | `.agents/skills/node/SKILL.md` | Steps 2-5: filesystem durability, async provider failure handling, ESM/type-only imports, and temporary Git-index cleanup. |
| `vitest` | `.agents/skills/vitest/SKILL.md` | Every step's regression tests; isolated temp repos, typed fakes, awaited failures, and no shared mutable state. |
| `change-review-workflow` | `skills/change-review-workflow/SKILL.md` | Final gate: review the implementation against this plan, triage every finding, remediate, and re-review material fixes. |

## Scope and ownership

### Step 0 reconciliation exception

Before implementation, only Step 0 may edit the tracked source plan
`dev/plans/FER-62.md` to record the merged FER-52/FER-61 implementation commits,
their exact APIs/files/tests, and the reconciled scope. Never edit a generated
`.harness/runs/.../context/plan.md` copy. Update `dev/plans/README.md` from
`blocked` only after the reconciled source plan passes `plan-review`; until then
it remains `blocked`.

### In scope (only these production/docs files)

- `schemas/factory-implementation-remediation-output.schema.json` (new)
- `lib/factory-implementation-review-schemas.ts` (new)
- `lib/factory-implementation-review-input.ts` (new)
- `lib/factory-implementation-review-run-context.ts` (new)
- `lib/factory-implementation-review-lifecycle-writes.ts` (new)
- `lib/factory-implementation-review-findings.ts` (new; reviewer adapter only)
- `lib/factory-run-allocation.ts` (new)
- `lib/factory-writer-boundary.ts` (new; protected-surface snapshot/guard)
- `lib/factory-lifecycle.ts`
- `lib/factory-lifecycle-writes.ts`
- `lib/factory-locks.ts`
- `lib/factory-status.ts`
- `lib/factory-schemas.ts`
- `lib/factory-review-head.ts`
- `lib/factory-implementation-run-context.ts`
- `lib/config.ts`
- `lib/schemas.ts`
- `lib/prompts/factory-implementation-review.ts` (new)
- `lib/prompts/index.ts`
- `workflows/factory-implementation-review.workflow.ts` (new)
- `workflows/factory-implementation.workflow.ts`
- `lib/factory-linear-implementation-apply.ts` (FER-52 completion-comment wording plus typed start-apply provenance)
- `bin/factory-implementation-review-command.ts` (new)
- `bin/factory-implementation-review-cli.ts` (new)
- `bin/factory-commands.ts` (registration plus atomic implementation ownership only)
- `lib/factory-linear-adapter.ts` (only the FER-52 projection extension described in Step 6)
- `scripts/smoke-dist.ts`
- `README.md`
- `docs/contributing/factory.md`
- `docs/contributing/architecture.md`
- `docs/contributing/setup-manifest.md`
- `docs/contributing/script-command-surface.md`
- `skills/factory-operator/SKILL.md`
- `dev/plans/FER-62.md` (Step 0 reconciliation only)
- `dev/plans/README.md` (Step 0 status update only, after a passing re-review)

### In-scope tests

- `test/factory-implementation-review-output-schema-sync.test.ts` (new)
- `test/factory-implementation-review-input.test.ts` (new)
- `test/factory-implementation-review-run-context.test.ts` (new)
- `test/factory-run-allocation.test.ts` (new)
- `test/factory-implementation-review-findings.test.ts` (new)
- `test/factory-writer-boundary.test.ts` (new)
- `test/factory-implementation-review.workflow.test.ts` (new)
- `test/factory-implementation-review-cli.test.ts` (new)
- `test/factory-implementation-review-test-helpers.ts` (new, only if shared setup avoids duplication)
- `test/factory-lifecycle.test.ts`
- `test/factory-locks.test.ts` (new)
- `test/factory-status.test.ts` (new)
- `test/factory-review-head.test.ts`
- `test/factory-implementation-run-context.test.ts`
- `test/factory-implementation.workflow.test.ts`
- `test/factory-implementation-cli.test.ts`
- `test/factory-implementation-apply-command.test.ts` (existing command/lease migration)
- `test/factory-linear-implementation-apply.test.ts` (FER-52 completion-comment assertion plus start-apply failure cases)
- `test/config.test.ts`
- `test/factory-linear-adapter.test.ts`
- `test/skills.test.ts` (manual-stop/review-command contract only)
- `test/docs-contracts.test.ts` (only if a durable command/ownership assertion belongs there)

FER-52's landed projection surface is `lib/factory-linear-adapter.ts`, backed by
`lib/factory-linear-implementation-apply.ts`; its command wiring is in
`bin/factory-commands.ts`. FER-62 does not add a review projection API; Step 6
updates the existing implementation-completion comment/assertion and adds the
typed start-apply provenance described there.
so the user-facing next command is the Factory review command.

### Hard out of scope

- `providers/codex/codex-agent.ts`, `providers/cursor/cursor-sdk-agent.ts`, and
  `lib/workflow-context.ts`: verified contracts already support sessions,
  adapter-owned logs, and nested review. Touch only after a STOP/report if FER-61
  deliberately changed those contracts.
- `workflows/change-review.workflow.ts`, `workflows/review-steps.ts`, reviewer
  prompts, and `schemas/review-output.schema.json`: reuse unchanged.
- Planning/triage behavior, their lifecycle outcomes, and their Linear comments.
- GitHub, PR, branch, push, worktree, Inngest, or tracker completion code.
- Parsing or inspecting Linear comment bodies for identity, decisions, resume, or
  lifecycle state.
- Workspace-local `.harness/factory` canonical state or agent-authored durable artifacts.
- Unrelated refactors of the already-large lifecycle or command files. New review
  command/run/artifact logic belongs in the new focused modules above.

## Ordered implementation steps

### Step 0: Reconcile merged dependency implementations and verify exact APIs

FER-52 and FER-61 are now merged to `main`. This reconciliation records merge
commits `6e10bf60fd6d2f743bea507de5928cd4768d5c9e` and
`5aff4d4e3d4c4d95d5130397a0ef3409829e0c38`, reads their landed diffs, and
updates the dependency-owned current-state and scope references above. Keep
these edits limited to this tracked source plan; never edit a generated
`.harness/runs/.../context/plan.md` copy. Run `plan-review` after the
reconciliation and before any FER-62 code edit. Confirm:

- FER-52 provides the exact implementation started/terminal Linear-apply APIs,
  configured `Implementing` and `Implementation Failed` targets, and never makes
  comments canonical input.
- FER-61 preserves `Agent.run({ workspace, logPath, schemaPath, session })`,
  makes Harness/provider adapters the durable writers, and does not require
  agents to write outside the workspace.
- The current-state anchors below still have the same ownership. Small line drift
  is fine; changed responsibility, API names, or file ownership require updating
  scope and re-review before implementation.

Do not combine either dependency implementation with this branch. FER-62 extends
their merged contracts; it does not infer or finish them.

**Verify**:

```bash
rg -n "implementationFailed|implementing|applyImplementation" lib bin test
rg -n "workspaceGuard|logPath|durable.*writer|Harness.*writes" lib providers workflows test
pnpm exec vitest run test/factory-lifecycle.test.ts test/factory-implementation-cli.test.ts test/factory-implementation.workflow.test.ts test/factory-review-head.test.ts test/workflow-context.test.ts test/config.test.ts test/factory-linear-implementation-apply.test.ts test/factory-linear-adapter.test.ts test/factory-implementation-apply-command.test.ts test/factory-planning-run-context.test.ts test/factory-planning-policy.test.ts test/factory-planning-smoke.test.ts test/factory-planning.workflow.test.ts test/factory-planning.workflow-failures.test.ts test/factory-planning-apply-command.test.ts
pnpm typecheck
```

Expected: both dependency implementations and their recorded symbols/tests exist;
FER-61's two-plane contract is visible; focused tests and typecheck pass. This
reconciled revision must pass `plan-review` before editing production code.
Otherwise STOP, reconcile this plan against the merged dependency surface, and
re-run `plan-review` before editing.

### Step 1: Define review configuration and structured decision contracts

1. In `lib/schemas.ts`, extend `factory.implementation` with:
   - `maxReviewIterations?: positive integer`;
   - an optional `roles.reviewer` dedicated schema next to `implementer` that,
     when present, accepts only `agent: "codex"`, requires
     `sandboxMode: "read-only"` and `approvalPolicy: "never"`, and rejects
     Cursor and write-capable overrides. Do not make existing
     implementation-only configs invalid at general config parse time;
   - a secure explicit default used only by the new review command when the
     optional role is absent: Codex plus `read-only`/`never` and the configured
     or standard Codex review model. The command must reject an omitted/default
     provider that cannot resolve to this exact secure role;
   - explicit command-resolution errors explaining that Factory reviewers have
     no target workspace write authority.
2. In `lib/config.ts`:
   - add a review-command-specific resolver for
     `{ station: "implementation", role: "reviewer" }` that applies the secure
     default above; preserve existing generic `resolveFactoryRoleAgent` fallback
     behavior for all current stations and implementation-only configs;
   - add `resolveFactoryImplementationSettings(...)`, defaulting
     `maxReviewIterations` to 3, independent of planning's limit;
   - define `parsePositiveIntegerOption` for the review command and use the
     same positive-integer contract for config and CLI values. It accepts only
     finite integers greater than zero; reject `0`, negatives, fractions,
     `NaN`, and `Infinity` before persistence. Add fixtures for each rejected
     value and assert the persisted checkpoint contains the validated integer,
     never the raw CLI string/number;
   - preserve implementation implementer's workspace-write default; construct the
     Factory nested-review input from the validated reviewer role with fixed
     Codex `read-only`/`never`, never from Cursor/default review settings.
3. Add `lib/factory-implementation-review-schemas.ts` with strict Zod schemas and
   inferred types for remediation output:

   ```ts
   {
     summary: string; // non-empty
     findingDecisions: Array<{
       findingId: string; // non-empty
       decision: "implement" | "adapt" | "decline";
       rationale: string; // non-empty
     }>;
   }
   ```

   Keep cross-finding completeness/uniqueness validation in the coordinator,
   where the expected finding set is available.
4. Add the Codex-strict JSON Schema twin and sync tests. Test valid output,
   missing arrays, empty strings, extra properties, and invalid decisions.
5. Add `review-failed` to `FACTORY_STAGES`. Do not add a Linear status for it.

**Verify**:

```bash
pnpm exec vitest run test/factory-implementation-review-output-schema-sync.test.ts test/config.test.ts
pnpm typecheck
```

Expected: all named tests pass; existing implementation-only configs still parse;
review-command input is always Codex `read-only`/`never`; Cursor and any
write-capable reviewer configuration are rejected; an absent optional reviewer
uses the documented secure command-only default; runtime and JSON schemas
accept/reject the same fixtures; fractional, zero, non-finite, and negative
review limits are rejected consistently by config and CLI parsing.

### Step 2: Make lifecycle ownership conditional and project review checkpoints

1. Extend `appendFactoryLifecycleEvent` in `lib/factory-lifecycle.ts` with a typed
   precondition contract evaluated after lock acquisition and event-ID
   idempotency lookup, using the freshly reduced state. It must support:
   - allowed current stages (including explicitly uninitialized where a trusted
     first import is permitted);
   - expected implementation run ID;
   - expected active review-attempt ID (including expected absence);
   - expected last checkpoint/event ID.
   Throw `FactoryLifecycleError` with expected/actual values on mismatch. Do not
   accept an untyped callback from command code.
2. Change the reducer for `implementation.started` to set
   `factoryStage: "implementation-started"` and `factoryRunId: event.runId`.
   Guard implementation start and terminal event writers so a fresh run cannot
   overwrite active/completed/review state and a terminal event must match its
   active implementation owner.
   In `lib/factory-locks.ts`, add the workspace-writer lease primitive and one
   exported physical-workspace canonicalizer. It must resolve Git top-level then
   `realpath` it, derive the durable lease filename solely from that physical
   path, and fail closed on non-Git/missing/unresolvable paths; no
   caller-supplied lexical path or Factory project ID may choose the key. Durable
   owner metadata includes the physical path, store provenance, work-item/run/
   attempt identifiers, liveness data, and operation (`implementation` or
   `remediation`). Expose a dedicated retained
   handle API—`acquireFactoryWorkspaceWriterLease(...)` returns an owner handle;
   `releaseFactoryWorkspaceWriterLease({ handle })` removes only that exact
   token. It is deliberately not `withFactoryWorkItemLock` and never accepts an
   async callback. Acquisition is fail-fast: one immediate mkdir/inspection plus
   at most one safe stale-owner reclaim, then a typed contention error containing
   current owner diagnostics; it must never wait or block while another in-process
   provider is running. Callers retain the handle across awaited provider work
   and release it in async `finally` only after provider-result lineage is
   terminalized. A same-host owner with a live PID is never stale, regardless of
   age; reclaim only a same-host owner proven dead. Remote, unknown, malformed,
   or missing owner liveness fails closed with diagnostics and requires operator
   cleanup, never automatic reclaim. Extend `factory status` to canonicalize before
   inspecting and report an active workspace writer lease and physical owner
   diagnostics without acquiring or releasing it.
   The writer lease uses `resolveFactoryWorkspaceLeaseRoot(env)`, whose only
   implementation is `join(defaultFactoryStoreRoot(env), "workspace-leases")`;
   it never consumes `factoryStateRoot`, `projectRoot`, `projectId`, or a
   `runsDir` override. Status and all commands call this helper, and tests use
   two explicit store roots plus two project IDs to prove they still collide on
   one physical workspace. Record this namespace/key and canonical physical
   path in owner diagnostics; create it with mode `0700` and fail closed on
   permission, path, or inspection errors.
   Add `lib/factory-run-allocation.ts` for the shared pre-claim allocator used by
   live implementation runs and review attempts. For writer paths, allocate after
   workspace-lease acquisition; for a read-only review attempt, allocate directly
   before lifecycle claim. In both cases reserve `<factoryRunsDir>/<id>` with
   non-recursive no-replace directory creation; retry collisions with a bounded
   8-attempt budget, then fail without provider invocation. Return only
   `{ runId, runDir, reservationToken }`; it writes no context/meta artifacts.
   The caller writes a separate identity-only reservation manifest after
   allocation and before lifecycle claim: `attempt-reservation.json` for review
   attempts and `implementation-reservation.json` for implementation runs. Each
   manifest contains station, work-item key, run ID, reservation token, physical
   workspace/store provenance, and attempt (`first`/`retry` where applicable);
   it contains no provider output or mutable lifecycle state. The run contexts
   accept this allocation and create their children only under the reserved
   directory. If allocation fails before the manifest exists, remove only the
   matching empty reservation; after the manifest exists, preserve it and append
   rejection or failure evidence.
3. Add strict schemas/types for the five review events. Payloads store only IDs,
   counters, immutable limits, provenance, and run-relative artifact pointers:
   - `started`: implementation owner, attempt owner, optional prior attempt,
     resume flag, expected checkpoint, and the effective review limit with its
     config/CLI provenance. Initial start persists this value; resume must match
     it exactly and may not replace it;
   - `checkpointed`: phase (`review` or `remediation`), completed-review count,
     approved candidate version/ref/commit/tree, workspace tree/status pointer,
     and optional nested review/findings/decision/candidate/recovery pointers;
   - `completed`: owner IDs, final candidate tuple, handoff path, accepted-debt
     pointer/count;
   - `unresolved`: owner IDs, reason (`blocked`, `missing-session`,
     `incompatible-session`, `legacy-incomplete`, `declined-must-fix`,
     `max-iterations`, `stale-owner`), summary path,
     and latest checkpoint pointers;
   - `failed`: owner IDs, classification (`reviewer`, `provider`, `git`,
     `artifact`, `protocol`, `workspace`), retryable flag, error, summary path,
     recovery pointers, and—only for failure after edits—a distinct immutable
     partial-evidence tuple of ref, commit, tree, attempt ID, and review index.
     The tuple is absent when no partial ref was created and never changes the
     approved candidate tuple.
   Use these concrete strict schemas/types (exported from the review schema or
   lifecycle module; names are contractual):

   ```ts
   RunRootProvenance = { factoryRunsDir: string; reviewRunsDir: string }
   ArtifactPointer = {
     runId: string; root: "factory" | "review"; path: string
   } // path relative to that runDir
   CandidateTuple = { ref: string; commit: string; tree: string }
   WorkspaceProvenance = {
     physicalGitRoot: string; workspaceKey: string; factoryProjectId: string
   }
   EffectiveReviewLimit = {
     value: positive integer; source: "default" | "config" | "cli"
   }
   ImplementationReviewCheckpoint = {
     version: 1; checkpointId: string;
     owningImplementationRunId: string; originalReviewBase: string;
     approvedCandidate: CandidateTuple; implementerSession: AgentSessionRef;
     workspace: WorkspaceProvenance; runRoots: RunRootProvenance;
     latestCheckpointId: string;
     candidateVersion: nonnegative integer;
     completedReviewCount: nonnegative integer; effectiveReviewLimit: EffectiveReviewLimit;
     activeReviewAttemptId?: string; priorReviewAttemptId?: string;
     activeReviewIndex?: positive integer; latestReview?: ArtifactPointer;
     latestDecision?: ArtifactPointer; partialRecovery?: {
       tuple: CandidateTuple; attemptId: string; reviewIndex: positive integer;
       status: ArtifactPointer; patch: ArtifactPointer; recovery: ArtifactPointer
     }; latestOutcome?: string; latestErrorClass?: string
   }
   ```

   `checkpointId` is the immutable ID of the checkpointed lifecycle event and
   `latestCheckpointId` in the reduced implementation state is its exact last
   value. The first `started` claim requires expected checkpoint `null`; every
   later claim supplies the exact persisted `latestCheckpointId`. A
   `checkpointed` event generates its ID before append, includes it in its
   payload, and the reducer persists it atomically with the checkpoint. Replay
   of the same event returns the same ID/state; a different event with the same
   expected ID is rejected under the lifecycle lock. `completed`, `unresolved`,
   and `failed` carry and preserve the latest checkpoint ID, so restart and
   resume never infer identity from timestamps or directory order.

   `ArtifactPointer.path` is always POSIX-normalized, non-empty, relative to
   the run directory identified by `runId`, and contains no absolute component,
   `..`, or symlink escape. Resolve it by locating that run ID under the
   recorded `runRoots[ pointer.root ]`, joining the path, and requiring the
   resolved run directory to be a direct child of that canonical root and the
   resolved file to remain inside it. `formatLifecycleArtifactPath` may be
   reused only for its run-relative result; reject its project-relative or
   absolute fallback for these pointers. Nested review artifacts use the nested
   review run ID, never the parent attempt ID. Add cross-run, nested-review,
   traversal, absolute-path, and symlink-escape resolution tests. The recorded
   roots are immutable provenance: resolution never consults current CLI
   overrides. New review attempts always use the canonical recorded
   `reviewRunsDir`; the review command does not expose `--runs-dir`. Existing
   implementation `--runs-dir` support must canonicalize and persist the actual
   `factoryRunsDir` in `FactoryStoreMeta`; a run whose metadata root does not
   contain its run directory is rejected as legacy/incomplete before provider
   execution. Root creation and realpath checks must prevent symlink escapes.

   Every pointer is validated as a non-empty run-relative path and every
   object is strict. Event schemas extend the existing base event with stable
   `id`, `occurredAt`, `workItemKey`, and event `runId`; `started` additionally
   requires `owningImplementationRunId`, `activeReviewAttemptId`,
   `attemptIndex`, `resume`, `expectedCheckpointId`, and the immutable effective
   limit. `checkpointed` requires phase, candidate tuple, completed count, and
   checkpoint ID. `completed` requires the final tuple and handoff pointer;
   `unresolved` requires its reason and latest checkpoint; `failed` requires
   classification, retryable, error, and latest checkpoint, plus the partial
   tuple only when one was created.
4a. Implement and test this transition matrix before the workflow:

   | Transition | Allowed current state | New owner/run | Counter effect | Outcome |
   | --- | --- | --- | --- | --- |
   | first implementation | `ready-to-implement` | new implementation run | reset | `implementation-started` |
   | implementation retry | `implementation-failed` + expected prior run | new implementation run | reset | `implementation-started` |
   | stale implementation owner, unchanged tree | `implementation-started` + same-host dead owner + fresh Linear `Ready to Implement` | recovery run | reset | retryable `implementation-failed`, no failed projection |
   | stale implementation owner, verified active status | `implementation-started` + same-host dead owner + fresh Linear `Implementing` | recovery run | reset | one `implementation-failed` projection, retryable |
   | stale implementation owner, drift/unknown | `implementation-started` + dead/unknown owner or tree/status drift | none | preserve | `stale-owner` -> `ready-for-human` |
   | initial review | `implementation-complete` | new review attempt | preserve | `review-running` |
   | ordinary resume | `review-running`/`review-failed` + exact owner/checkpoint | new review attempt | preserve | `review-running` |
   | no-partial failure resume | `review-failed` + no partial tuple | new review attempt | preserve | full review from approved candidate |
   | partial failure recovery | `review-failed` + exact partial tuple | new recovery attempt | preserve | remediation, then full review |
   | legacy implementation | `implementation-complete` + `legacyReviewBlock` | none | preserve | `legacy-incomplete` -> `ready-for-human` |
   | idempotent complete | `review-complete` + matching owner | none | preserve | existing handoff |
   | human terminal | `ready-for-human` | none | preserve | no resume without human state change |

   Rejected/stale claims append no lifecycle transition, preserve their
   reservation evidence, and never invoke a provider. Event-ID retries are
   idempotent before precondition evaluation.
5. Extend the optional lifecycle state checkpoint. On
   `implementation.completed`, seed owner/base/candidate/session/workspace/store
   provenance and zero counters from the event. Historical events from before
   FER-62 may lack session, candidate tree, or workspace/store provenance. Replay
   those events without constructing an incomplete checkpoint; instead persist a
   strict `legacyReviewBlock` marker containing the owning implementation run ID
   and missing fields (`session`, `candidate-tree`, `workspace-provenance`, or
   `store-provenance`). When the review command encounters
   `implementation-complete` plus that marker, it appends one conditional
   `implementation.review.unresolved` with reason `legacy-incomplete`, writes a
   durable summary, transitions to `ready-for-human`, and invokes no provider.
   Human recovery requires a new supported implementation run; `--resume` never
   fabricates the missing checkpoint fields. Initial review start persists the
   effective review limit; resume rejects an effective config/CLI limit that
   differs from it. Review started/checkpointed events update active owner,
   approved lineage, counters, and latest pointers. A failure after edits projects
   its validated partial-evidence tuple separately; a resume validates that exact
   tuple before allowing work to continue. Terminal review events map stages
   exactly:
   - active -> `review-running`;
   - completed -> `review-complete`;
   - unresolved -> `ready-for-human`;
   - failed -> `review-failed`;
   - implementation execution failure remains `implementation-failed`.
6. Keep the internal checkpoint out of generic `FactoryWorkItemMetadata` merging;
   only the public stage/run projection remains there.
7. Put review-specific event constructors in the new
   `lib/factory-implementation-review-lifecycle-writes.ts`; use
   `formatLifecycleArtifactPath` and exact conditional preconditions. Keep
   implementation start/terminal hardening in existing lifecycle writes.
8. Add reducer/replay/backward-compatibility tests, event parsing failures,
   pointer-only assertions (no full finding bodies), idempotent retry tests,
   legacy `implementation.completed` replay with missing session/tree/provenance,
   and deterministic race tests where two distinct start attempts target the same
   state and only one succeeds. Cover first-run versus implementation-retry
   ownership, pre-provider start/lease-reacquisition failures with terminal
   lifecycle events, persisted limit defaults/overrides and
   rejected config or CLI changes on resume; cover missing, malformed, and
   tampered partial-evidence tuples independently of approved-candidate lineage.
   Add lease tests for release on success/failure/throw, dead-owner recovery,
   live-owner protection beyond the generic stale threshold, and two different
   work-item keys targeting one workspace: only one provider turn may enter; the
   waiting run must not invoke its provider or materialize a ref. Add real-path
   versus symlink aliases and different Factory project IDs, proving all resolve
   to one physical-workspace lease key. Use an unresolved fake provider to prove
   its retained handle remains held while awaited and a second command gets
   immediate typed contention rather than polling or invoking its provider.
   Add allocator tests for no-replace collision retry/exhaustion, ownership-token
   cleanup of an empty pre-claim reservation, preserved post-context evidence,
   and lease contention producing neither allocation nor lifecycle event.

**Verify**:

```bash
pnpm exec vitest run test/factory-lifecycle.test.ts test/factory-locks.test.ts test/factory-status.test.ts test/factory-run-allocation.test.ts test/factory-implementation-cli.test.ts
pnpm typecheck
```

Expected: all tests pass; stale/concurrent transitions append no event; repeated
same-ID appends are idempotent; historical implementation events still replay;
fresh implementation cannot claim implementation/review stages; workspace-lease
tests prove live-owner contention, stale recovery, release on error, and
read-only status inspection without acquiring a lease.

### Step 3: Generalize temporary-index lineage and exact workspace validation

1. In `lib/factory-review-head.ts`, extract one private temporary-index tree
   materializer used by initial, remediation, and partial evidence commits. It
   must:
   - initialize from the supplied parent candidate;
   - stage the workspace without altering the real index;
   - reject `.harness/` in the written tree;
   - return `treeSha`, commit SHA, ref, and cumulative original-base diff;
   - clean up temporary index files best-effort;
   - create refs with compare-and-swap expecting a nonexistent ref (zero OID),
     never overwrite.
2. Preserve `createFactoryReviewHead(...)` and its existing initial ref contract,
   but add the tree SHA to its result/meta/lifecycle event.
3. Add narrowly named helpers for:
   - approved remediation candidate creation with prior candidate as parent;
   - best-effort partial failure ref creation that returns its ref/commit/tree
     tuple without promoting it;
   - resolving and comparing `HEAD`, ref commit, commit tree, and current workspace
     tree to recorded approved-candidate or partial-evidence values.
4. Treat ignored `.harness/` as Harness evidence, not workspace source. Do not
   include it in comparisons or commits. Do not silently omit other changed
   source files.
5. Test parent chains, create-only collision failure, binary/untracked/delete
   capture, `.harness/` exclusion, original-base cumulative diff, latest-ref
   tampering, HEAD drift, tree drift, and partial ref non-promotion. Assert the
   partial helper exposes a complete immutable tuple and rejects missing/tampered
   ref, commit, or tree rather than falling back to the approved candidate.

**Verify**:

```bash
pnpm exec vitest run test/factory-review-head.test.ts test/factory-implementation.workflow.test.ts test/factory-implementation-run-context.test.ts
pnpm typecheck
```

Expected: all tests pass; `git rev-parse <review/2>^` equals the commit recorded
for `<review/1>`; original base remains the review diff base; collisions and all
recorded-lineage mismatches fail closed.

### Step 4: Build the canonical review input and Harness-owned attempt context

1. Add `lib/factory-implementation-review-input.ts`. Identity rules:
   - item file: parse it only to derive/verify the work-item key;
   - Linear: parse/canonicalize the issue identifier directly to
     `linear:TEAM-NNN`; do not fetch or read comments to resolve workflow state;
   - load canonical lifecycle state, then resolve the owning implementation
     `runDir`/`meta.json`/`context/work-item.json` and implementation artifacts
     from its checkpoint and recorded store provenance;
   - validate work-item key, implementation run ID, workspace, project/store,
     implementation status, meta schema/shape, handoff, optional approved plan,
     approved candidate tuple, and (for `review-failed` recovery) the distinct
     partial-evidence tuple. Never select a run by scanning for “latest”.
2. Separate identity resolution from full validation so every syntactically valid
   command can reserve a run ID and write one immutable, path-safe
   `attempt-reservation.json` containing only identity/provenance before full
   validation terminalizes. This minimal pre-claim manifest is not the attempt
   context. Rejected, stale, and idempotent claims append a terminal marker beside
   it; only a successful claim creates the full attempt context. State/owner claim
   remains atomic through Step 2's lifecycle API.
3. Add `lib/factory-implementation-review-run-context.ts` following existing
   run-context conventions. It owns only fixed Harness writers and exports typed
   meta/summary. Required layout:

   ```text
   attempt-reservation.json
   attempt-rejected.json                 # rejected/stale claim only
   attempt-idempotent.json               # already-complete claim only
   context/work-item.json
   context/implementation-ref.json
   iterations/<review-index>/change-review-ref.json
   iterations/<review-index>/review-findings.json
   iterations/<review-index>/remediation.prompt.md
   iterations/<review-index>/remediation.raw.json
   iterations/<review-index>/remediation.json
   iterations/<review-index>/remediation.stream.jsonl
   iterations/<review-index>/workspace-status.json
   iterations/<review-index>/diff.patch
   iterations/<review-index>/candidate-ref.json
   iterations/<review-index>/partial-candidate-ref.json  # failure-after-edit only
   iterations/<review-index>/recovery.json               # failure-after-edit only
   implementation-review/pr-ready-handoff.md             # success only
   events.jsonl
   summary.md
   meta.json
   ```

   Artifact metadata must advertise only files actually written. Nested reviews
   remain in `factoryStore.reviewRunsDir` and are referenced. `meta.json` must
   expose `workspace`, `runDir`, `implementationRunId`, `originalReviewBase`,
   `approvedCandidate.ref`, `approvedCandidate.commit`,
   `approvedCandidate.tree`, and optional `approvedPlanPath`; the CLI output
   must expose `runDir` and `workspace` so the final review command can derive
   every input without chat-only context.
4. Add `lib/factory-implementation-review-findings.ts` as a small adapter. Parse
   the three existing reviewer JSON files with `ReviewOutputSchema`, normalize in
   fixed role order, assign IDs, preserve `must_fix`/source/location, and reject a
   completed `needs_changes` result with no findings. It must not invoke reviewers
   or aggregate verdicts.
5. Add `lib/prompts/factory-implementation-review.ts`:
   - remediation prompt inlines all normalized findings and the required output
     contract;
   - explicitly forbids decision files, durable writes, lifecycle/ref/branch/PR
     mutation, and changes outside the work item;
   - PR-ready renderer orders attempts, nested reviews, decisions, accepted debt,
     original base/final head, cumulative diff, and provenance deterministically,
     and states no branch or PR was created.
6. Tests must prove a Linear identity path does not call comment-fetching input
   resolution, missing/mismatched artifacts are classified, traversal/mismatched
   provenance is rejected, no agent prompt names a durable output destination,
   and run metadata references only written files.

**Verify**:

```bash
pnpm exec vitest run test/factory-implementation-review-input.test.ts test/factory-implementation-review-run-context.test.ts test/factory-implementation-review-findings.test.ts
pnpm typecheck
```

Expected: all tests pass; identity comes from lifecycle, not run-directory input
or Linear comments; artifact writers stay Harness-owned; findings have stable IDs.

### Step 5: Implement the review/remediation state machine by composing existing workflows

Add `workflows/factory-implementation-review.workflow.ts`. Keep orchestration
explicit and split pure validation/render helpers into the Step 4 modules rather
than growing one monolith.

1. On initial/ordinary-review resume:
   - allocate and exclusively reserve a review-attempt run ID/directory, write the
     immutable identity-only `attempt-reservation.json`, then atomically claim that
     exact attempt with expected stage/implementation owner/active
     attempt/checkpoint. On rejected/stale/idempotent claim, append the matching
     terminal marker and preserve the reservation evidence; only a reservation
     failure before that manifest exists may remove an empty reservation. Create
     the full attempt context only after successful claim;
   - for `review-complete`, export an idempotent result pointing at the existing
     handoff without invoking providers or appending lifecycle;
   - reject `ready-for-human`; for stale ownership, export rejected attempt
     evidence without mutating lifecycle;
   - validate the persisted effective review limit before claim: an initial
     command stores its resolved config/CLI value, while resume rejects any
     changed config or explicit CLI override rather than increasing the limit;
   - validate Git/workspace/artifact/session/provider compatibility after claim;
     missing/incompatible session becomes unresolved; Git/artifact/workspace
     validation becomes review-failed with recovery evidence. If no partial tuple
     exists, a later `--resume` revalidates the approved candidate and reruns the
     complete three-role review; it does not resume from an unrecorded tree or
     partial finding set;
   - immediately before any remediation provider turn, acquire the durable
     workspace writer lease using the shared physical Git-top-level canonicalizer,
     retaining its exact owner handle across awaited work. A live owner returns
     immediate typed contention diagnostics—never polling/waiting—before provider
     invocation;
     revalidate Git/workspace/artifact/session/provider compatibility against that
     physical checkout after acquisition and immediately before materializing a
     candidate or partial ref, and keep the lease through terminal/checkpoint
     writes. Release it in `finally` for success, failure, abort, and throw.
     Nested `change-review` remains outside the lease because its role is
     enforced read-only.
2. Handle `review-failed` with a persisted partial-evidence tuple as a separate
   recovery transition, not an ordinary review:
   - allocate/reserve a new recovery attempt, write its identity-only reservation
     manifest, then atomically claim it and validate the stored partial
     ref/commit/tree and attempt/index and restore the immutable finding snapshot
     and remediation index referenced by the failed checkpoint; preserve a
     rejected claim's reservation evidence and remove only a reservation that
     failed before its manifest was written;
   - acquire the physical-workspace writer lease, validate that the materialized
     physical checkout is exactly the partial tree, then resume the original implementer session
     directly with those persisted findings. Do not invoke `change-review` and do
     not point a reviewer at the old approved candidate while partial edits exist;
   - require a complete valid decision set for the restored findings. Evaluate
     changes against the prior approved candidate, not merely the tree at recovery
     entry. A valid implement/adapt outcome with a differing partial tree creates
     the next approved candidate using that prior approved candidate as sole
     parent; all-decline with partial edits is protocol failure, not implicit
     acceptance;
   - only after that new approved candidate is checkpointed, start the next full
     three-role review at the next review index. Preserve the completed-review
     count until that review actually completes. A repeat failure writes a new
     partial tuple linked to the recovery attempt; no partial ref is ever used as
     `headRef` or promoted by resume alone.
3. For each review needed, create `WorkflowContext` with:
   - `runsDir: factoryStore.reviewRunsDir`;
   - `baseRef: originalReviewBase`;
   - `headRef: latestCandidateRef`;
   - approved plan path only for planned mode;
   - implementation handoff read by Harness and passed as `handoffText`;
   - the validated Factory reviewer role, always Codex with `sandbox: read-only`
     and `approval-policy: never` (reject Cursor/default/write-capable input
     before invoking the nested workflow);
   - Factory event sink, signal, timeout, and provider factory.
   Invoke `runChangeReview(reviewCtx)` without `steps`, guaranteeing all three roles.
4. On nested review failure, persist its ref/successful coverage and emit
   review-failed without incrementing completed reviews. A failure without a
   partial tuple resumes from the approved candidate through a complete
   three-role review; a failure with a partial tuple follows the dedicated
   remediation recovery path. On complete result:
   normalize/write findings, increment the durable completed count, and checkpoint
   before making a terminal/remediation decision.
5. Terminal rules in exact order:
   - aggregate `blocked` -> unresolved;
   - no findings and aggregate `pass` -> PR-ready;
   - findings present -> continue even when aggregate passes, because every
     finding needs a decision;
   - if completed count reached the persisted effective limit while findings remain ->
     unresolved before another remediation turn.
6. Resume the original implementer provider with the recorded session and current
   configured implementer role only when `role.agent === session.provider`.
   Pass `schemaPath`, Harness-owned `logPath`, `workspaceGuard: "record"`, current
   model/policy/timeout/signal, and the inlined remediation prompt. Never create a
   fresh implementation session.
7. Parse and persist output; validate exact set equality (no missing, duplicate,
   or unknown IDs). Apply decision rules:
   - any `implement`/`adapt` plus unchanged tree -> protocol failure;
   - any declined `must_fix` -> unresolved immediately, before tree comparison or
     candidate promotion. If the workspace tree changed, first capture a
     non-promoted partial-evidence tuple plus status, patch, stream, and recovery
     artifacts against the prior approved candidate; checkpoint that tuple, leave
     the approved candidate unchanged, then terminalize `ready-for-human`.
     If the tree did not change, retain the approved candidate without a partial
     tuple. `--resume` remains rejected from `ready-for-human` until a human
     restores/records a supported lifecycle state; the partial tuple is for
     inspection and explicit human recovery, never automatic promotion;
   - all declines, unchanged tree -> unresolved only when a `must_fix` was
     declined; otherwise PR-ready with accepted debt;
   - any changed tree, with no declined `must_fix` -> materialize/checkpoint the
     next approved candidate and start another full review.
8. If remediation fails/aborts/returns invalid output after changing files,
   capture status, patch, stream, partial ref/commit/tree, and recovery manifest
   best-effort; write the complete tuple to the failed event/checkpoint before
   returning `review-failed`, while preserving the prior approved candidate. If
   partial capture itself fails, preserve every artifact that succeeded, record
   that no resumable partial tuple exists, and name both errors without masking
   the provider error.
9. Render success handoff solely from lifecycle events plus validated attempt
   artifacts, so it includes prior-attempt lineage and every nested review and
   decision. Write handoff before the conditional completed event; if lifecycle
   completion fails, do not report success.
10. Workflow tests must cover:
   - immediate pass/no findings;
   - advisory findings all declined with accepted debt;
   - implement/adapt edits -> cumulative ref -> full re-review -> pass;
   - declined must-fix, including unchanged-tree and changed-tree cases where the
     latter persists a non-promoted partial tuple before `ready-for-human`, plus
     explicit rejection of resume from that human terminal;
     blocked, missing/incompatible session, max limit;
   - reviewer failure (not counted), invalid decisions, implement-without-change;
   - provider failure before/after edits; recovery restores findings/index,
     resumes remediation before review, materializes only a post-decision
     candidate, then performs a full review; missing/malformed/tampered partial
     tuple rejection and all-decline-with-partial-edits protocol failure;
   - HEAD/tree/ref/workspace/store drift and stale/concurrent ownership;
   - resume from review-running/review-failed, complete idempotency, human terminal;
   - planned review receives plan, direct review does not;
   - every nested review sees fixed original base and current immutable head;
   - persisted limit on initial claim, rejected config/CLI limit drift on resume,
     physical-workspace lease acquisition/revalidation/release, cross-work-item
     contention including real-path/symlink aliases, and no lifecycle lock held
     while fake reviewers/providers are awaiting;
   - provider attempts that mutate refs, `HEAD`/index, `.harness`, lifecycle
     state, or protected Factory-store paths are rejected by the writer boundary,
     while allowed source edits and the Harness-owned stream path remain valid.
   The writer boundary is intentionally a protected-surface policy, not a
   work-item allowlist: it machine-checks refs, `HEAD`/index, `.harness`,
   lifecycle files, and Factory-store paths, while permitting ordinary source,
   test, and documentation edits for the provider turn. Work-item scope is
   enforced separately by the review input/prompt, changed-tree capture, and
   normalized finding review; an out-of-scope source edit is retained and
   surfaced for review/human resolution, never silently discarded or treated as
   a writer-boundary success claim.

**Verify**:

```bash
pnpm exec vitest run test/factory-implementation-review.workflow.test.ts test/factory-implementation-review-findings.test.ts test/factory-run-allocation.test.ts test/factory-writer-boundary.test.ts test/factory-lifecycle.test.ts test/factory-review-head.test.ts
pnpm typecheck
```

Expected: all scenarios pass; only complete three-role reviews increment the
persisted limit; material edits always receive another full review; failure
evidence is resumable only through its exact recorded tuple and is never
promoted implicitly.

### Step 6: Add the command, resume contract, and FER-52 projection extension

1. Add `bin/factory-implementation-review-command.ts` instead of expanding the
   1,472-line `bin/factory-commands.ts`. Export a small registration function and
   the lifecycle wrapper used by tests. Register it as a child of the existing
   implementation command. Options:
   - `--workspace`, exactly one of `--item-file`/`--linear-issue`;
   - `--resume`;
   - `--factory-store-root` and `--factory-store-project-id` store overrides;
     do not register `--runs-dir` for this command. Review attempts always use
     the recorded canonical `reviewRunsDir`; an arbitrary run root would make
     lifecycle pointers and resume identity ambiguous;
   - `--max-review-iterations`, `--max-runtime-ms`, `--verbose`. The max flag
     supplies the initial effective limit only; a resume must resolve to the
     checkpoint's persisted limit and rejects any explicit or config-derived
     difference;
   - no Linear `--apply` flag: review-stage projection is deliberately a no-op;
     the canonical lifecycle remains authoritative and the issue stays in Linear
     `Implementing` while review is active, unresolved, or complete.
   Do not add `--run-dir`, `--base`, `--head`, partial-review steps, or a fresh-session flag.
2. Resolve both implementation roles: the validated Codex-only read-only reviewer
   for nested review, and the implementer for compatible session resume. Build
   the attempt context under Factory runs and point nested review context at
   `store.reviewRunsDir`.
3. Add `bin/factory-implementation-review-cli.ts` to emit stable JSON containing
   attempt/implementation IDs, status, lineage, current candidate, completed
   review count, artifact/meta/summary/handoff paths, and warnings/error. Return
   exit 0 only for review-complete/already-complete; unresolved, failed, and
   rejected attempts exit nonzero.
4. Keep FER-52's implementation projection deliberately narrow, without adding
   statuses or a review-specific adapter method:
   - `implementation-started` and `implementation-complete` use the existing
     implementation apply methods;
   - `review-running`, `review-failed`, `ready-for-human`, and `review-complete`
     perform no Linear mutation and preserve the existing `Implementing` status;
   - only genuine `implementation-failed` uses the existing
     `Implementation Failed` projection.
   Extend `lib/factory-linear-implementation-apply.ts` with a typed
   `LinearImplementationStartApplyError` carrying a partial
   `LinearImplementationUpdatePlan`. Track `statusMutationCompleted` only after
   `updateIssue` reports success, and track `statusPostconditionVerified` only
   after a fresh read proves `Implementing`. The implementation command must
   project `Implementation Failed` after a start-apply error only when the typed
   error says `statusPostconditionVerified: true`; `statusMutationCompleted:
   true` alone is insufficient. Update-success/postcondition-failure therefore
   preserves local `preProviderFailure` evidence but makes no failed projection;
   update failure and fetch/validation failure make no failed projection either.
   Preserve the typed update/error in the CLI result and add adapter/command
   tests for all three cases, including a verified-Implementing failure that
   permits exactly one failed projection.
   The start-failure state table is explicit: (a) validation, fetch, or
   `updateIssue` failure before mutation records `linearStartState:
   "not-started"`; (b) a successful update followed by a failed postcondition
   read invokes one fresh status probe, records `"implementing"` only when that
   probe proves `Implementing`, and otherwise records `"unknown"`; (c) an
   `"unknown"` or unexpected status routes to `ready-for-human` with preserved
   evidence. Only `"implementing"` permits one failed projection. A
   `"not-started"` local failure remains retryable: the next implementation
   attempt probes Linear first, uses FER-52's `first` input if Linear is
   `Ready to Implement`, and uses its `retry` input if Linear is
   `Implementation Failed`; any other result routes to `ready-for-human`.
   Thus no retry assumes that a failed update mutated Linear, and the
   `statusPostconditionVerified: true` error is produced only by the explicit
   fresh probe path, not by the currently successful return path.
   Update the FER-52 completion comment and its test to point to
   `harness factory implementation review --linear-issue <issue>` instead of
   standalone `change-review`. Review lifecycle state, not comments, remains the
   source of truth; no comment body may become an input to state, resume, or
   decisions. This Step 6 extension does not add a new Linear review API.
5. Add CLI tests for help/options, mutual exclusions, initial/resume stage gates,
   no-comment identity, run/store placement, output/exit codes, signal forwarding,
   terminal Linear apply failure preservation, rejected Cursor/default/write-capable
   reviewer input, positive-integer limit rejection, and persisted-limit config/CLI
   drift across resume. Assert the
   deliberate no-op review projection and updated completion comment. Add a
   deferred Linear terminal-call fixture proving a blocked or failed projection
   does not retain the workspace lease. Migrate the existing
   `test/factory-implementation-apply-command.test.ts` seams and fixtures to real
   temporary Git workspaces and assert physical-workspace canonicalization,
   allocation-before-claim, first/retry ownership, pre-provider failures, and
   Linear projection ordering there.
6. Harden the existing implementation command/wrapper to use Step 2's atomic
   start/terminal ownership and the physical-workspace writer lease. The exact
   live order is: canonicalize the physical Git top-level; acquire the retained
   fail-fast lease; allocate/reserve the run ID and directory; write
   `implementation-reservation.json`; reload/revalidate readiness; conditionally
   claim `implementation.started`; release the lease; call
   `applyImplementationStarted`; reacquire the lease; revalidate ownership/tree
   state; then create the context and invoke the provider. A lease contention
   before allocation creates no run directory/event. A rejected claim preserves
   its reservation manifest and appends `implementation-rejected.json` without
   invoking a provider.
   If Linear start projection fails, classify it with the start-failure table:
   append conditional local `implementation.failed` evidence with the exact
   `linearStartState`, preserve the reservation/error evidence, and invoke no
   provider. `not-started` permits the fresh-probe retry matrix above;
   `implementing` permits exactly one `applyImplementationFailed` call after
   local terminalization and lease release; `unknown`/unexpected status becomes
   `ready-for-human`. A lease reacquisition failure after a successful start
   projection is treated as `implementing` only because the successful start
   postcondition is recorded; never infer that status from a thrown update call.
   Keep the reacquired lease through
   provider execution, review-head materialization, and local terminal lifecycle
   persistence; revalidate tree/HEAD immediately before materializing the ref;
   release that exact handle in async `finally`. Perform terminal
   `applyImplementationCompleted`/`applyImplementationFailed` only after local
   terminalization and lease release. Preserve dry-run behavior and FER-52 apply
   ordering, except that all Linear I/O is explicitly outside the lease.
   When the existing implementation command receives `--runs-dir`, update its
   recorded `FactoryStoreMeta.factoryRunsDir` to the canonical resolved override
   (while retaining override provenance), require the allocated run directory to
   be contained directly beneath it, and reject symlink escapes. Review
   pointer/resume resolution uses that recorded root, never a later CLI default.
   Add a regression fixture for an implementation run created under a custom root
   and resumed from a different current default.
7. Extend `scripts/smoke-dist.ts` with review command help and required options.

**Verify**:

```bash
pnpm exec vitest run test/factory-implementation-review-cli.test.ts test/factory-implementation-cli.test.ts test/factory-implementation-apply-command.test.ts test/factory-linear-adapter.test.ts test/factory-linear-implementation-apply.test.ts test/config.test.ts
pnpm build
pnpm smoke:dist
```

Expected: tests/build/smoke pass; no arbitrary run-dir identity exists; all review
stages stay projected as Implementing; implementation execution failure alone
projects as Implementation Failed.

### Step 7: Replace manual-stop documentation and run release gates

1. Keep `README.md` entrypoint-sized: add only the review command, a concise
   current-behavior summary, and a link to `docs/contributing/factory.md`. Put
   canonical identity, attempt lineage, resume matrix, stage outcomes, artifact
   tree, immutable ref chain, two-plane ownership, workspace writer-lease
   contention/recovery, and the explicit “no branch or PR” handoff statement in
   `docs/contributing/factory.md`. Remove README instructions to manually run
   standalone change-review after `implementation-complete`; keep standalone
   review docs for non-Factory use.
   Update the packaged `skills/factory-operator/SKILL.md` with the review command,
   resume matrix, durable attempt artifacts, workspace lease behavior, and the
   deliberate Linear `Implementing` projection. Remove its standalone
   change-review-after-implementation instructions.
2. Update `docs/contributing/architecture.md` to assign ownership to the new input,
   run-context, lifecycle-write, findings adapter, prompt, command, and workflow
   modules; state that the workflow composes existing `change-review`.
3. Update `docs/contributing/setup-manifest.md` and
   `docs/contributing/script-command-surface.md` for durable review-attempt/nested
   review paths and the new command. Keep examples generic (`/path/to/repo`,
   `TEAM-123`), never local/private paths.
4. Add/adjust doc contract tests so stale claims such as “stops before
   change-review” and “no nested change-review loop” cannot return.
5. Run formatting, focused suites, and full gates, then save the Step 6 CLI JSON
   output as `REVIEW_OUTPUT`. Derive the durable run directory and workspace from
   that JSON, then derive the review base, immutable candidate ref, approved plan
   path, and Harness-rendered handoff from that run's `meta.json`/artifact paths.
   For planned work, run:

   ```bash
   RUN_DIR="$(node --input-type=module -e 'import { readFileSync } from "node:fs"; process.stdout.write(JSON.parse(readFileSync(process.argv[1], "utf8")).runDir)' "$REVIEW_OUTPUT")"
   WORKSPACE="$(node --input-type=module -e 'import { readFileSync } from "node:fs"; process.stdout.write(JSON.parse(readFileSync(process.argv[1], "utf8")).workspace)' "$REVIEW_OUTPUT")"
   BASE="$(node --input-type=module -e 'import { readFileSync } from "node:fs"; const m=JSON.parse(readFileSync(process.argv[1], "utf8")); process.stdout.write(m.originalReviewBase)' "$RUN_DIR/meta.json")"
   HEAD="$(node --input-type=module -e 'import { readFileSync } from "node:fs"; const m=JSON.parse(readFileSync(process.argv[1], "utf8")); process.stdout.write(m.approvedCandidate.ref)' "$RUN_DIR/meta.json")"
   PLAN="$(node --input-type=module -e 'import { readFileSync } from "node:fs"; const m=JSON.parse(readFileSync(process.argv[1], "utf8")); process.stdout.write(m.approvedPlanPath ?? "")' "$RUN_DIR/meta.json")"
   HANDOFF="$RUN_DIR/implementation-review/pr-ready-handoff.md"
   printf '%s\n' "$(cat "$HANDOFF")" | .harness/bin/harness run change-review --workspace "$WORKSPACE" --base "$BASE" --head "$HEAD" --plan "$PLAN" --handoff-stdin --verbose
   git -C "$WORKSPACE" diff --check
   git -C "$WORKSPACE" status --short
   ```

   For direct work, omit `--plan "$PLAN"`. Triage every finding and rerun after
   material fixes.

**Verify**:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm exec vitest run test/factory-implementation-review-output-schema-sync.test.ts test/factory-implementation-review-input.test.ts test/factory-implementation-review-run-context.test.ts test/factory-implementation-review-findings.test.ts test/factory-implementation-review.workflow.test.ts test/factory-implementation-review-cli.test.ts test/factory-lifecycle.test.ts test/factory-locks.test.ts test/factory-status.test.ts test/factory-run-allocation.test.ts test/factory-review-head.test.ts test/factory-implementation-run-context.test.ts test/factory-implementation.workflow.test.ts test/factory-implementation-cli.test.ts test/factory-implementation-apply-command.test.ts test/factory-linear-implementation-apply.test.ts test/factory-linear-adapter.test.ts test/factory-writer-boundary.test.ts test/factory-planning-run-context.test.ts test/factory-planning-policy.test.ts test/factory-planning-smoke.test.ts test/factory-planning.workflow.test.ts test/factory-planning.workflow-failures.test.ts test/factory-planning-apply-command.test.ts test/config.test.ts test/docs-contracts.test.ts test/skills.test.ts
git diff --check
git status --short
make check
```

Expected: all commands exit 0. If full test still fails only at the known sessions
dependency-bootstrap test, rerun that test with installation/network access. Do
not mark done with a nonzero full gate unless a human explicitly accepts the
unchanged external baseline failure.

## Test plan summary

- **Schemas/config**: strict Zod/JSON parity; Codex-only enforced read-only
  reviewer policy; independent positive review limit/default and persisted-limit
  resume rejection.
- **Lifecycle**: old replay compatibility, new reducer stages/checkpoint fields,
  pointer-only events, immutable effective limit, approved versus partial lineage,
  atomic implementation/review ownership, no-replace pre-claim run/attempt
  allocation, workspace writer lease, idempotency, stale owner/checkpoint and
  deterministic same-/cross-work-item concurrency rejection.
- **Git**: exact approved and partial HEAD/tree/ref validation, immutable
  compare-and-swap refs, cumulative parent chain/diff, `.harness/` exclusion,
  partial evidence refs without promotion.
- **Input/artifacts**: canonical owner resolution, no latest-run scanning, no
  Linear comments, store/workspace provenance, absent/corrupt artifact failures,
  only-written artifact metadata, deterministic handoff.
- **Workflow**: pass, accepted advisory debt, material remediation loop, explicit
  partial recovery from persisted findings/index, every human outcome, every
  retryable failure, resumption, max counts, planned/direct context, all-reviewer
  fixed-base scope, physical-workspace lease across writer turns only, and no
  lifecycle lock across long operations.
- **CLI/Linear**: source flags, resume legality, status/exit JSON, signals,
  durable roots, help/smoke, all review stages -> Implementing, only execution
  failure -> Implementation Failed.
- **Ownership regression**: inspect fake `AgentRunInput` and generated prompts to
  prove agents receive only workspace mutation authority and structured output;
  all decisions/checkpoints/refs/handoffs are written by Harness fixtures.

## Done criteria

All must hold:

- [ ] FER-52 and FER-61 implementation PRs—not merely their plan PRs—are merged;
  their exact commits, symbols, files, and tests were reconciled in this plan and
  the reconciled revision passed `plan-review` before edits.
- [ ] Initial and resumed review identity derives from canonical lifecycle plus recorded implementation metadata; no command accepts an arbitrary run directory.
- [ ] Implementation start/terminal and every review transition use conditional state checks under the per-work-item lock.
- [ ] Live implementation and remediation provider turns hold one durable
  physical-workspace writer lease through ref/terminal persistence; a different
  work item or lexical/symlink alias cannot write the same checkout concurrently,
  while read-only review remains lease-free.
- [ ] Every live implementation/review attempt reserves a collision-safe run ID
  before lifecycle claim; rejected claims preserve their pre-claim reservation
  evidence, allocation failures before the manifest clean only the empty
  reservation, and lease contention creates neither an allocation nor lifecycle
  ownership.
- [ ] All three existing reviewers run via `change-review` against original base -> latest immutable candidate; no duplicate reviewer engine exists.
- [ ] Every current finding receives exactly one validated decision; material remediation always creates a cumulative immutable ref and receives a full re-review.
- [ ] Missing/incompatible sessions, blocked reviews, max iterations, and declined must-fix findings end in `ready-for-human`, not `implementation-failed`.
- [ ] Reviewer/provider/Git/artifact/protocol/workspace failures preserve recovery evidence and end in `review-failed`; only completed review cycles count.
- [ ] Partial recovery restores its recorded findings/index, resumes the original
  session against the exact partial tree, creates an approved candidate only after
  valid decisions, then starts a full review; it never reviews or promotes partial
  evidence directly.
- [ ] Resume enforces owner/checkpoint/approved-or-partial tree/ref provenance,
  preserves the immutable effective limit across config/CLI changes, and never
  starts a fresh implementation/session.
- [ ] PR-ready handoff deterministically includes work item, stable implementation owner, attempt lineage, original/final refs, cumulative diff, all nested review refs/decisions, accepted debt, verdict/provenance, and “no branch or PR created”.
- [ ] Linear comments are never parsed/read as review workflow input; all active/review/human/failure stages project to Implementing; only genuine implementation execution failure projects to Implementation Failed.
- [ ] The reviewer is enforced as Codex `read-only`/`never`; agents otherwise
  write only intended workspace changes and structured output; Harness exclusively
  writes durable artifacts, lifecycle, streams, refs, recovery, and handoffs.
- [ ] No PR, branch, push, worktree, Inngest, new Linear status, or tracker completion behavior was added.
- [ ] New/focused tests, `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm smoke:dist`, and `make check` exit 0.
- [ ] Final `change-review-workflow` findings are each Implemented, Adapted, or Declined with rationale, and material fixes are re-reviewed.
- [ ] `git diff --check` exits 0 and `git status --short` shows no files outside this plan's scope.

## STOP conditions

Stop and report instead of improvising if:

- Either dependency implementation PR is not merged (a merged plan PR is
  insufficient), or its actual API/ownership differs from Step 0.
- Lifecycle JSONL cannot identify exactly one completed implementation owner and
  its run/store/workspace provenance without using tracker comments or run scans.
- Supporting historical completed implementations requires guessing missing
  refs/session/workspace provenance; classify as human attention rather than
  synthesizing ownership.
- The provider recorded in `AgentSessionRef` differs from current implementation
  role configuration, a provider no longer supports resume through the shared
  `Agent.run` contract, or the nested reviewer cannot be enforced as Codex
  `read-only`/`never`.
- Exact workspace tree validation or cumulative commit creation would require the
  real Git index, checking out/resetting the workspace, overwriting an existing
  ref, or allowing an agent to mutate Git refs.
- A proposed design asks an agent to write a decision, prompt, stream, checkpoint,
  ref, recovery bundle, summary, or handoff outside the workspace.
- A durable workspace writer lease cannot be acquired/revalidated around every
  implementation/remediation provider turn without holding the short lifecycle
  lock or weakening same-workspace exclusion.
- A review result cannot be represented by the existing three-role
  `change-review` output without changing standalone reviewer semantics.
- Resume would need to discard an unrecognized workspace tree, reset the review
  limit, or run a fresh implementation session.
- Any requirement expands into PR/branch/push/worktree/Inngest/tracker completion
  or comment-parsing behavior.
- Implementation requires production files outside the exact scope list; update
  and re-review this plan first.
- A verification command fails twice after a reasonable scoped correction, or
  the known full-suite baseline failure changes/expands.

## Maintenance and review notes

- The lifecycle checkpoint is an internal recovery read model, not generic tracker
  metadata. Future PR-linking should consume the PR-ready handoff and
  `review-complete`; it must not redefine review ownership.
- Candidate version and completed review count are deliberately separate. The
  effective review limit is immutable after initial claim, and partial evidence is
  a separate non-promoted tuple. Future retry work must not conflate any of these.
- Lifecycle events remain the reconstruction source of truth; state JSON is a
  cache. Any new checkpoint field needs replay tests from JSONL alone.
- Reviewers should scrutinize lifecycle versus workspace-lease boundaries,
  create-only ref updates, provider failure after partial edits, artifact
  path/provenance validation, and whether any prompt accidentally turns a durable
  path into an agent output target.
- Retention/pruning of implementation/review lineage is deferred. A future policy
  must preserve refs/artifacts reachable from active lifecycle checkpoints and
  PR-ready handoffs.
- Human resolution of `ready-for-human` is deliberately deferred until an
  explicit input/event contract exists; do not add an undocumented reset flag.
