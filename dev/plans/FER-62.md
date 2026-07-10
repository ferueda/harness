# Plan 260710-automate-factory-implementation-review: Make Factory implementation review and remediation durable and resumable

> **Executor instructions**: Invoke the verified `implement-plan` skill and follow
> this plan in order. Run every verification command and confirm its expected
> result before moving on. Do not start implementation until the dependency gate
> in Step 0 passes. If any STOP condition occurs, stop and report; do not invent a
> parallel review engine, lifecycle recovery path, or tracker contract.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: FER-52 (implementation Linear projection) and FER-61 (workspace/durable-store writer boundary)
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
   `must_fix`, blocked review, missing/incompatible session, or exhausted review
   limit produces `ready-for-human`, never `implementation-failed`.
8. Reviewer/provider/Git/artifact/protocol failures produce durable
   `review-failed` evidence. Only completed three-role review cycles increment
   `factory.implementation.maxReviewIterations`.

### Canonical lifecycle and concurrency

- Add `implementation.review.started`, `.checkpointed`, `.completed`,
  `.unresolved`, and `.failed` events. Checkpoints contain artifact/ref pointers,
  counters, and provenance, never full findings.
- Add an optional internal implementation checkpoint to the lifecycle read model:
  owning implementation run, original base, latest candidate ref/commit/tree,
  implementer session, workspace/store provenance, candidate version, completed
  review count, active attempt, prior attempt, latest review/decision pointers,
  and latest outcome/error classification.
- Every ownership transition is conditional and is evaluated while holding the
  per-work-item lifecycle lock. Idempotency lookup happens before precondition
  evaluation so retrying the same event remains safe.
- `implementation.started` must become a real ownership stage. A fresh
  implementation may claim only a canonical ready stage and must reject an
  existing `implementation-started`, `implementation-complete`, every review
  stage, and stale owners.
- Initial review is allowed only from `implementation-complete`; resume is
  allowed only from `review-running` or `review-failed` with exact owner and
  checkpoint matches. `review-complete` returns the existing handoff
  idempotently. `ready-for-human` remains terminal.
- Never hold the lifecycle lock around Git work, provider execution, reviewer
  execution, or artifact rendering.

### Git/workspace lineage

- Preserve `refs/harness/factory/<implementation-run-id>/implementation`.
- Approved remediation candidates use create-only refs
  `refs/harness/factory/<implementation-run-id>/review/<candidate-version>`.
  Version starts at 1 for the first remediation, independent of review count.
- Each remediation commit uses the prior candidate commit as its sole parent.
  The temporary index starts from the prior candidate, stages the current
  workspace, rejects `.harness/` in the tree, and updates the ref only if it does
  not already exist.
- Before review/resume, require workspace `HEAD == originalReviewBase`, current
  materialized workspace tree == recorded checkpoint tree, candidate ref ==
  recorded commit, candidate commit tree == recorded tree, workspace/store
  provenance match, and exact lifecycle owner/checkpoint match.
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
  implementation review-limit resolver.
- `lib/agents.ts:24,70-89`, `providers/codex/codex-agent.ts`, and
  `providers/cursor/cursor-sdk-agent.ts` already support `AgentSessionRef`
  resumption and provider-owned `logPath` streaming. `lib/agent-session.ts:33-65`
  rejects provider/session mismatches.
- `docs/contributing/factory.md:543-616`, `README.md:139`, and
  `docs/contributing/architecture.md:163-177,246-266` document the current manual
  stop before `change-review`; all are stale after this work and must change.
- FER-52 is not present on this branch: `lib/schemas.ts` has no `implementing` or
  `implementationFailed` Linear status keys, and `LinearFactoryAdapter` has no
  implementation apply methods. `dev/plans/README.md:11` still names FER-52 as
  the next unplanned issue. FER-61 is also not present as a merged code contract.
  This is why Step 0 is mandatory.
- Baseline verification: `pnpm typecheck` exits 0. The six-file focused command
  below passes 137 tests. A full `pnpm test` currently passes 882 tests and fails
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
| Focused baseline | `pnpm exec vitest run test/factory-lifecycle.test.ts test/factory-implementation-cli.test.ts test/factory-implementation.workflow.test.ts test/factory-review-head.test.ts test/workflow-context.test.ts test/config.test.ts` | 6 files and all tests pass |
| New review suite | `pnpm exec vitest run test/factory-implementation-review-*.test.ts test/factory-lifecycle.test.ts test/factory-review-head.test.ts test/factory-implementation-cli.test.ts test/config.test.ts` | all named files pass |
| Linear integration | `pnpm exec vitest run test/factory-linear-adapter.test.ts test/factory-implementation-cli.test.ts test/factory-implementation-review-cli.test.ts` | all named files pass |
| Typecheck | `pnpm typecheck` | exit 0, no diagnostics |
| Format check | `pnpm format:check` | exit 0 |
| Lint | `pnpm lint` | exit 0 |
| Build | `pnpm build` | exit 0 and `dist/` generated |
| CLI smoke | `pnpm smoke:dist` | exit 0; review command help checks pass |
| Full gate | `make check` | exit 0; format, lint, typecheck, tests, build, smoke all pass |
| Change review | `printf '%s\n' "$HANDOFF" | .harness/bin/harness run change-review --workspace . --base <base> --head <immutable-review-ref> --plan <approved-plan-path> --handoff-stdin --verbose` | completed run; all findings triaged |

Do not use `pnpm test -- <files>` for a focused run: in this repository it still
executed the entire suite during planning. Use `pnpm exec vitest run <files>`.

## Skills for the executor

| Skill | Verified location | Use in |
| --- | --- | --- |
| `implement-plan` | `skills/implement-plan/SKILL.md` | Coordinate all steps and run gates phase by phase. |
| `typescript-refactor` | `.agents/skills/typescript-refactor/SKILL.md` | Steps 1-6: discriminated lifecycle/event unions, exhaustive narrowing, explicit exported types, and error classification. |
| `zod` | `.agents/skills/zod/SKILL.md` | Steps 1-2 and 4: strict provider output, lifecycle checkpoint, event, and artifact parsing at trust boundaries. |
| `node` | `.agents/skills/node/SKILL.md` | Steps 2-5: filesystem durability, async provider failure handling, ESM/type-only imports, and temporary Git-index cleanup. |
| `vitest` | `.agents/skills/vitest/SKILL.md` | Every step's regression tests; isolated temp repos, typed fakes, awaited failures, and no shared mutable state. |
| `change-review-workflow` | `skills/change-review-workflow/SKILL.md` | Final gate: review the implementation against this plan, triage every finding, remediate, and re-review material fixes. |

## Scope and ownership

### In scope (only these production/docs files)

- `schemas/factory-implementation-remediation-output.schema.json` (new)
- `lib/factory-implementation-review-schemas.ts` (new)
- `lib/factory-implementation-review-input.ts` (new)
- `lib/factory-implementation-review-run-context.ts` (new)
- `lib/factory-implementation-review-lifecycle-writes.ts` (new)
- `lib/factory-implementation-review-findings.ts` (new; reviewer adapter only)
- `lib/factory-lifecycle.ts`
- `lib/factory-lifecycle-writes.ts`
- `lib/factory-schemas.ts`
- `lib/factory-review-head.ts`
- `lib/factory-implementation-run-context.ts`
- `lib/config.ts`
- `lib/schemas.ts`
- `lib/prompts/factory-implementation-review.ts` (new)
- `lib/prompts/index.ts`
- `workflows/factory-implementation-review.workflow.ts` (new)
- `workflows/factory-implementation.workflow.ts`
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

### In-scope tests

- `test/factory-implementation-review-output-schema-sync.test.ts` (new)
- `test/factory-implementation-review-input.test.ts` (new)
- `test/factory-implementation-review-run-context.test.ts` (new)
- `test/factory-implementation-review-findings.test.ts` (new)
- `test/factory-implementation-review.workflow.test.ts` (new)
- `test/factory-implementation-review-cli.test.ts` (new)
- `test/factory-implementation-review-test-helpers.ts` (new, only if shared setup avoids duplication)
- `test/factory-lifecycle.test.ts`
- `test/factory-review-head.test.ts`
- `test/factory-implementation-run-context.test.ts`
- `test/factory-implementation.workflow.test.ts`
- `test/factory-implementation-cli.test.ts`
- `test/config.test.ts`
- `test/factory-linear-adapter.test.ts`
- `test/docs-contracts.test.ts` (only if a durable command/ownership assertion belongs there)

If FER-52 lands with its projection in a file other than
`lib/factory-linear-adapter.ts` or its tests outside the named Linear test file,
STOP and update this plan's exact scope before editing those dependency-owned
files.

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

### Step 0: Rebase dependencies and re-verify anchors

Before editing, rebase/merge the approved FER-52 and FER-61 changes. Read their
diffs and rerun the focused baseline. Confirm:

- FER-52 provides implementation started/terminal Linear apply with configured
  `Implementing` and `Implementation Failed` targets, and does not make comments
  canonical input.
- FER-61 preserves `Agent.run({ workspace, logPath, schemaPath, session })`, makes
  Harness/provider adapters the durable writers, and does not require agents to
  write outside the workspace.
- The current-state anchors above still have the same ownership. Small line drift
  is fine; changed responsibility or data contracts are not.

Do not combine FER-52/FER-61 implementation with this branch. This plan extends
their merged contracts.

**Verify**:

```bash
rg -n "implementationFailed|implementing|applyImplementation" lib bin test
rg -n "workspaceGuard|logPath|durable.*writer|Harness.*writes" lib providers workflows test
pnpm exec vitest run test/factory-lifecycle.test.ts test/factory-implementation-cli.test.ts test/factory-implementation.workflow.test.ts test/factory-review-head.test.ts test/workflow-context.test.ts test/config.test.ts
pnpm typecheck
```

Expected: FER-52 symbols/tests exist; FER-61's two-plane contract is visible;
focused tests and typecheck pass. Otherwise STOP and revise the plan against the
merged dependency surface.

### Step 1: Define review configuration and structured decision contracts

1. In `lib/schemas.ts`, extend `factory.implementation` with:
   - `maxReviewIterations?: positive integer`;
   - `roles.reviewer?: FactoryRoleSchema` next to `implementer`;
   - the same Codex-only/provider-model validation applied to the new reviewer.
2. In `lib/config.ts`:
   - allow `{ station: "implementation", role: "reviewer" }`;
   - resolve it from `factory.implementation.roles.reviewer`;
   - add `resolveFactoryImplementationSettings(...)`, defaulting
     `maxReviewIterations` to 3, independent of planning's limit;
   - preserve implementation implementer's workspace-write default and let the
     existing review context retain read-only/never review defaults.
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

Expected: all named tests pass; configuration defaults to 3; reviewer provider
and Codex-only fields validate exactly like existing roles; runtime and JSON
schemas accept/reject the same fixtures.

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
3. Add strict schemas/types for the five review events. Payloads store only IDs,
   counters, classifications, provenance, and relative/store artifact pointers:
   - `started`: implementation owner, attempt owner, optional prior attempt,
     resume flag, expected checkpoint;
   - `checkpointed`: phase (`review` or `remediation`), completed-review count,
     candidate version/ref/commit/tree, workspace tree/status pointer, and
     optional nested review/findings/decision/candidate/recovery pointers;
   - `completed`: owner IDs, final candidate tuple, handoff path, accepted-debt
     pointer/count;
   - `unresolved`: owner IDs, reason (`blocked`, `missing-session`,
     `incompatible-session`, `declined-must-fix`, `max-iterations`), summary path,
     and latest checkpoint pointers;
   - `failed`: owner IDs, classification (`reviewer`, `provider`, `git`,
     `artifact`, `protocol`, `workspace`), retryable flag, error, summary path,
     and recovery pointers.
4. Extend the optional lifecycle state checkpoint. On
   `implementation.completed`, seed owner/base/candidate/session/workspace/store
   provenance and zero counters from the event. Review started/checkpointed events
   update active owner, lineage, counters, and latest pointers. Terminal review
   events map stages exactly:
   - active -> `review-running`;
   - completed -> `review-complete`;
   - unresolved -> `ready-for-human`;
   - failed -> `review-failed`;
   - implementation execution failure remains `implementation-failed`.
5. Keep the internal checkpoint out of generic `FactoryWorkItemMetadata` merging;
   only the public stage/run projection remains there.
6. Put review-specific event constructors in the new
   `lib/factory-implementation-review-lifecycle-writes.ts`; use
   `formatLifecycleArtifactPath` and exact conditional preconditions. Keep
   implementation start/terminal hardening in existing lifecycle writes.
7. Add reducer/replay/backward-compatibility tests, event parsing failures,
   pointer-only assertions (no full finding bodies), idempotent retry tests, and
   deterministic race tests where two distinct start attempts target the same
   state and only one succeeds.

**Verify**:

```bash
pnpm exec vitest run test/factory-lifecycle.test.ts test/factory-implementation-cli.test.ts
pnpm typecheck
```

Expected: all tests pass; stale/concurrent transitions append no event; repeated
same-ID appends are idempotent; historical implementation events still replay;
fresh implementation cannot claim implementation/review stages.

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
   - best-effort partial failure ref creation without promoting it;
   - resolving and comparing `HEAD`, ref commit, commit tree, and current workspace
     tree to recorded values.
4. Treat ignored `.harness/` as Harness evidence, not workspace source. Do not
   include it in comparisons or commits. Do not silently omit other changed
   source files.
5. Test parent chains, create-only collision failure, binary/untracked/delete
   capture, `.harness/` exclusion, original-base cumulative diff, latest-ref
   tampering, HEAD drift, tree drift, and partial ref non-promotion.

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
     and candidate tuple. Never select a run by scanning for “latest”.
2. Separate identity resolution from full validation so every syntactically valid
   command can create append-only attempt evidence before validation terminalizes.
   State/owner claim remains atomic through Step 2's lifecycle API.
3. Add `lib/factory-implementation-review-run-context.ts` following existing
   run-context conventions. It owns only fixed Harness writers and exports typed
   meta/summary. Required layout:

   ```text
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
   remain in `factoryStore.reviewRunsDir` and are referenced.
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

1. On initial/review resume:
   - atomically claim the attempt with expected stage/implementation owner/active
     attempt/checkpoint;
   - for `review-complete`, export an idempotent result pointing at the existing
     handoff without invoking providers or appending lifecycle;
   - reject `ready-for-human`; for stale ownership, export rejected attempt
     evidence without mutating lifecycle;
   - validate Git/workspace/artifact/session/provider compatibility after claim;
     missing/incompatible session becomes unresolved; Git/artifact/workspace
     validation becomes review-failed with recovery evidence.
2. For each review needed, create `WorkflowContext` with:
   - `runsDir: factoryStore.reviewRunsDir`;
   - `baseRef: originalReviewBase`;
   - `headRef: latestCandidateRef`;
   - approved plan path only for planned mode;
   - implementation handoff read by Harness and passed as `handoffText`;
   - configured implementation reviewer provider/model/policy;
   - Factory event sink, signal, timeout, and provider factory.
   Invoke `runChangeReview(reviewCtx)` without `steps`, guaranteeing all three roles.
3. On nested review failure, persist its ref/successful coverage and emit
   review-failed without incrementing completed reviews. On complete result:
   normalize/write findings, increment the durable completed count, and checkpoint
   before making a terminal/remediation decision.
4. Terminal rules in exact order:
   - aggregate `blocked` -> unresolved;
   - no findings and aggregate `pass` -> PR-ready;
   - findings present -> continue even when aggregate passes, because every
     finding needs a decision;
   - if completed count reached the configured limit while findings remain ->
     unresolved before another remediation turn.
5. Resume the original implementer provider with the recorded session and current
   configured implementer role only when `role.agent === session.provider`.
   Pass `schemaPath`, Harness-owned `logPath`, `workspaceGuard: "record"`, current
   model/policy/timeout/signal, and the inlined remediation prompt. Never create a
   fresh implementation session.
6. Parse and persist output; validate exact set equality (no missing, duplicate,
   or unknown IDs). Apply decision rules:
   - any `implement`/`adapt` plus unchanged tree -> protocol failure;
   - all declines, unchanged tree, any declined `must_fix` -> unresolved;
   - all declines, unchanged tree, only non-blockers -> PR-ready with accepted debt;
   - any changed tree -> materialize/checkpoint the next approved candidate and
     start another full review, regardless of decision mix.
7. If remediation fails/aborts/returns invalid output after changing files,
   capture status, patch, stream, partial ref/tree, and recovery manifest
   best-effort; preserve the prior approved candidate; emit review-failed. If
   partial capture itself fails, preserve every artifact that succeeded and name
   both errors without masking the provider error.
8. Render success handoff solely from lifecycle events plus validated attempt
   artifacts, so it includes prior-attempt lineage and every nested review and
   decision. Write handoff before the conditional completed event; if lifecycle
   completion fails, do not report success.
9. Workflow tests must cover:
   - immediate pass/no findings;
   - advisory findings all declined with accepted debt;
   - implement/adapt edits -> cumulative ref -> full re-review -> pass;
   - declined must-fix, blocked, missing/incompatible session, max limit;
   - reviewer failure (not counted), invalid decisions, implement-without-change;
   - provider failure before/after edits and resumable partial checkpoint;
   - HEAD/tree/ref/workspace/store drift and stale/concurrent ownership;
   - resume from review-running/review-failed, complete idempotency, human terminal;
   - planned review receives plan, direct review does not;
   - every nested review sees fixed original base and current immutable head;
   - no lifecycle lock is held while fake reviewers/providers are awaiting.

**Verify**:

```bash
pnpm exec vitest run test/factory-implementation-review.workflow.test.ts test/factory-implementation-review-findings.test.ts test/factory-lifecycle.test.ts test/factory-review-head.test.ts
pnpm typecheck
```

Expected: all scenarios pass; only complete three-role reviews increment the
limit; material edits always receive another full review; failure evidence is
resumable but never promoted implicitly.

### Step 6: Add the command, resume contract, and FER-52 projection extension

1. Add `bin/factory-implementation-review-command.ts` instead of expanding the
   1,472-line `bin/factory-commands.ts`. Export a small registration function and
   the lifecycle wrapper used by tests. Register it as a child of the existing
   implementation command. Options:
   - `--workspace`, exactly one of `--item-file`/`--linear-issue`;
   - `--resume`;
   - `--runs-dir`, store root/project ID overrides;
   - `--max-review-iterations`, `--max-runtime-ms`, `--verbose`;
   - FER-52's existing Linear apply flag/adapter contract, if it is opt-in.
   Do not add `--run-dir`, `--base`, `--head`, partial-review steps, or a fresh-session flag.
2. Resolve both implementation roles: reviewer for nested review, implementer for
   compatible session resume. Build the attempt context under Factory runs and
   point nested review context at `store.reviewRunsDir`.
3. Add `bin/factory-implementation-review-cli.ts` to emit stable JSON containing
   attempt/implementation IDs, status, lineage, current candidate, completed
   review count, artifact/meta/summary/handoff paths, and warnings/error. Return
   exit 0 only for review-complete/already-complete; unresolved, failed, and
   rejected attempts exit nonzero.
4. Update FER-52's implementation projection mapping, without adding statuses:
   - `implementation-started`, `implementation-complete`, `review-running`,
     `review-failed`, `ready-for-human`, and `review-complete` -> Linear
     `Implementing`;
   - only genuine `implementation-failed` -> Linear `Implementation Failed`.
   Reuse FER-52 apply methods and idempotency. No comment body may become an input
   to state/resume/decisions.
5. Add CLI tests for help/options, mutual exclusions, initial/resume stage gates,
   no-comment identity, run/store placement, output/exit codes, signal forwarding,
   and terminal Linear apply failure preservation. Extend FER-52's table-driven
   projection tests for every new stage.
6. Harden existing `runFactoryImplementationWithLifecycle` to use Step 2's atomic
   start/terminal ownership. Preserve dry-run behavior and FER-52 apply ordering.
7. Extend `scripts/smoke-dist.ts` with review command help and required options.

**Verify**:

```bash
pnpm exec vitest run test/factory-implementation-review-cli.test.ts test/factory-implementation-cli.test.ts test/factory-linear-adapter.test.ts test/config.test.ts
pnpm build
pnpm smoke:dist
```

Expected: tests/build/smoke pass; no arbitrary run-dir identity exists; all review
stages stay projected as Implementing; implementation execution failure alone
projects as Implementation Failed.

### Step 7: Replace manual-stop documentation and run release gates

1. Update `README.md` and `docs/contributing/factory.md` with the review command,
   canonical identity, attempt lineage, resume matrix, stage outcomes, artifact
   tree, immutable ref chain, two-plane ownership, and explicit “no branch or PR”
   handoff statement. Remove instructions to manually run standalone change-review
   after `implementation-complete`; keep standalone review docs for non-Factory use.
2. Update `docs/contributing/architecture.md` to assign ownership to the new input,
   run-context, lifecycle-write, findings adapter, prompt, command, and workflow
   modules; state that the workflow composes existing `change-review`.
3. Update `docs/contributing/setup-manifest.md` and
   `docs/contributing/script-command-surface.md` for durable review-attempt/nested
   review paths and the new command. Keep examples generic (`/path/to/repo`,
   `TEAM-123`), never local/private paths.
4. Add/adjust doc contract tests so stale claims such as “stops before
   change-review” and “no nested change-review loop” cannot return.
5. Run formatting, focused suites, full gates, then invoke
   `change-review-workflow` against the immutable implementation review ref.
   Triage every finding. Re-run after material fixes.

**Verify**:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm exec vitest run test/factory-implementation-review-output-schema-sync.test.ts test/factory-implementation-review-input.test.ts test/factory-implementation-review-run-context.test.ts test/factory-implementation-review-findings.test.ts test/factory-implementation-review.workflow.test.ts test/factory-implementation-review-cli.test.ts test/factory-lifecycle.test.ts test/factory-review-head.test.ts test/factory-implementation-run-context.test.ts test/factory-implementation.workflow.test.ts test/factory-implementation-cli.test.ts test/config.test.ts test/factory-linear-adapter.test.ts test/docs-contracts.test.ts
make check
```

Expected: all commands exit 0. If full test still fails only at the known sessions
dependency-bootstrap test, rerun that test with installation/network access. Do
not mark done with a nonzero full gate unless a human explicitly accepts the
unchanged external baseline failure.

## Test plan summary

- **Schemas/config**: strict Zod/JSON parity; reviewer role/provider policy;
  independent positive review limit and default.
- **Lifecycle**: old replay compatibility, new reducer stages/checkpoint fields,
  pointer-only events, atomic implementation/review ownership, idempotency,
  stale owner/checkpoint and deterministic concurrency rejection.
- **Git**: exact HEAD/tree/ref validation, immutable compare-and-swap refs,
  cumulative parent chain/diff, `.harness/` exclusion, partial evidence refs.
- **Input/artifacts**: canonical owner resolution, no latest-run scanning, no
  Linear comments, store/workspace provenance, absent/corrupt artifact failures,
  only-written artifact metadata, deterministic handoff.
- **Workflow**: pass, accepted advisory debt, material remediation loop, every
  human outcome, every retryable failure, resumption, max counts, planned/direct
  context, all-reviewer fixed-base scope, no lock across long operations.
- **CLI/Linear**: source flags, resume legality, status/exit JSON, signals,
  durable roots, help/smoke, all review stages -> Implementing, only execution
  failure -> Implementation Failed.
- **Ownership regression**: inspect fake `AgentRunInput` and generated prompts to
  prove agents receive only workspace mutation authority and structured output;
  all decisions/checkpoints/refs/handoffs are written by Harness fixtures.

## Done criteria

All must hold:

- [ ] FER-52 and FER-61 are merged and their contracts were reconciled before edits.
- [ ] Initial and resumed review identity derives from canonical lifecycle plus recorded implementation metadata; no command accepts an arbitrary run directory.
- [ ] Implementation start/terminal and every review transition use conditional state checks under the per-work-item lock.
- [ ] All three existing reviewers run via `change-review` against original base -> latest immutable candidate; no duplicate reviewer engine exists.
- [ ] Every current finding receives exactly one validated decision; material remediation always creates a cumulative immutable ref and receives a full re-review.
- [ ] Missing/incompatible sessions, blocked reviews, max iterations, and declined must-fix findings end in `ready-for-human`, not `implementation-failed`.
- [ ] Reviewer/provider/Git/artifact/protocol/workspace failures preserve recovery evidence and end in `review-failed`; only completed review cycles count.
- [ ] Resume enforces owner/checkpoint/tree/ref provenance and never resets limits or starts a fresh implementation/session.
- [ ] PR-ready handoff deterministically includes work item, stable implementation owner, attempt lineage, original/final refs, cumulative diff, all nested review refs/decisions, accepted debt, verdict/provenance, and “no branch or PR created”.
- [ ] Linear comments are never parsed/read as review workflow input; all active/review/human/failure stages project to Implementing; only genuine implementation execution failure projects to Implementation Failed.
- [ ] Agents write only intended workspace changes and structured output; Harness exclusively writes durable artifacts, lifecycle, streams, refs, recovery, and handoffs.
- [ ] No PR, branch, push, worktree, Inngest, new Linear status, or tracker completion behavior was added.
- [ ] New/focused tests, `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm smoke:dist`, and `make check` exit 0.
- [ ] Final `change-review-workflow` findings are each Implemented, Adapted, or Declined with rationale, and material fixes are re-reviewed.
- [ ] `git diff --check` exits 0 and `git status --short` shows no files outside this plan's scope.

## STOP conditions

Stop and report instead of improvising if:

- FER-52 or FER-61 is not merged, or its actual API/ownership differs from Step 0.
- Lifecycle JSONL cannot identify exactly one completed implementation owner and
  its run/store/workspace provenance without using tracker comments or run scans.
- Supporting historical completed implementations requires guessing missing
  refs/session/workspace provenance; classify as human attention rather than
  synthesizing ownership.
- The provider recorded in `AgentSessionRef` differs from current implementation
  role configuration, or a provider no longer supports resume through the shared
  `Agent.run` contract.
- Exact workspace tree validation or cumulative commit creation would require the
  real Git index, checking out/resetting the workspace, overwriting an existing
  ref, or allowing an agent to mutate Git refs.
- A proposed design asks an agent to write a decision, prompt, stream, checkpoint,
  ref, recovery bundle, summary, or handoff outside the workspace.
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
- Candidate version and completed review count are deliberately separate. Future
  retry work must not conflate refs created with reviews completed.
- Lifecycle events remain the reconstruction source of truth; state JSON is a
  cache. Any new checkpoint field needs replay tests from JSONL alone.
- Reviewers should scrutinize lock boundaries, create-only ref updates, provider
  failure after partial edits, artifact path/provenance validation, and whether
  any prompt accidentally turns a durable path into an agent output target.
- Retention/pruning of implementation/review lineage is deferred. A future policy
  must preserve refs/artifacts reachable from active lifecycle checkpoints and
  PR-ready handoffs.
- Human resolution of `ready-for-human` is deliberately deferred until an
  explicit input/event contract exists; do not add an undocumented reset flag.
