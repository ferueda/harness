# Plan FER-61: Keep factory planner writes inside the workspace

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report. Do not improvise.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: FER-53 durable factory store, shipped in PR #108
- **Category**: security, factory, architecture, correctness
- **Linear issue**: FER-61

## Why this matters

The durable-store migration correctly moved factory-owned evidence outside the
target checkout, but planning still gives the planner that durable path as its
writable draft. Codex under the intended `workspace-write` sandbox cannot write
there, so valid default-store runs stop with `needs-human`. The fix separates
agent scratch from Harness persistence while keeping the durable store
authoritative and the least-privilege defaults intact.

## Requirements

### Ownership and artifact behavior

- Keep default lifecycle/run storage under
  `${XDG_DATA_HOME:-~/.local/share}/harness/store/projects/<repo-id>/`; do not
  move canonical factory state back into the checkout.
- Give the planner one mutable draft at
  `<workspace>/.harness/factory-drafts/<run-id>/draft.md`. Initial and revision
  prompts must name that local path, never `<runDir>/planning/draft.md`.
- Treat scratch as ignored, transient agent state—not canonical evidence and not
  recovery state. Do not export it in `meta.json`, lifecycle events, review
  refs, or implementation handoff metadata.
- Intentionally retain run-scoped scratch after the run. Do not automatically
  delete it. This is the safer cleanup policy for Node's path APIs and is
  explicitly permitted by FER-61. Later runs use new ids and never trust/reuse
  retained scratch.
- Harness owns a run id exclusively. Create the durable run directory with
  no-replace semantics; a collision allocates a new id before any run artifact
  exists, or fails closed after exactly 8 total attempts with
  `FactoryPlanningError("Unable to allocate unique factory planning run directory after 8 attempts")`.
  Create the run-scoped scratch
  directory exclusively when first needed; `EEXIST` is a stale-scratch failure,
  never an invitation to reuse its contents. Only the same context's recorded
  prepared scratch directory may be reused for later revisions.
- For every `draft-ready` turn, Harness must validate and read the local draft,
  then publish identical bytes to:
  - current canonical `<runDir>/planning/draft.md`;
  - immutable `<runDir>/iterations/<n>/plan.md`.
- Publish durable files through completed same-directory staging files. Publish
  iteration plans with atomic no-replace semantics; an existing destination is
  a hard collision and must never be overwritten.
- Review only a completed iteration `plan.md`. Copy approved `dev/plans/*.md`
  from that snapshot, never directly from scratch.
- Revisions edit the same scratch path. Revision N updates canonical and adds an
  immutable iteration N without changing earlier plan snapshots.
- Preserve planner-turn evidence. Every planner attempt writes
  `iterations/<n>/planner.prompt.md` and `planner.raw.json`. A successful
  structured turn additionally writes `planner.json`; a failed, aborted, or
  timed-out turn instead writes `planner.failure.json` with its error, exit
  code, and abort/timeout classification. Preserve provider-owned stream output
  when available.
- Every non-publishable planner attempt—provider failure/abort/timeout, thrown
  invocation, malformed structured output, tracked-workspace guard failure,
  invalid revision finding decisions, or unsafe/missing draft—must persist the
  prompt, raw/error evidence, and a classified `planner.failure.json` before
  terminalizing. It must not validate/read scratch, publish canonical or
  iteration artifacts, start review, or run cleanup. Keep scratch retained and
  untrusted; a later run must use a new run id and never reuse it.
- “No iteration snapshot” means `iterations/<n>/plan.md` is absent; it does not
  mean the iteration directory or planner metadata is removed.
- Initial `needs-human`: keep planner metadata for iteration 1; create no
  canonical draft, `plan.md`, review ref, or review.
- Revision `needs-human`: keep that turn's planner metadata without a new
  `plan.md`/review; preserve the last canonical draft and all prior plan
  snapshots/reviews.
- Preserve durable names/layout, metadata/lifecycle schemas, review refs,
  publication, and approved-plan handoff behavior.

### Path safety and supported threat model

- Defer scratch creation until the planning workflow reaches its first
  draft-producing operation. Context construction, lifecycle start, Linear
  apply start, and invalid handoff exits create no scratch.
- Reject prospective and real overlap between `scratchRunDir` and `runDir` in
  either direction, including explicit `--runs-dir` and symlink aliases.
- For live planning, reject a `runDir` inside the real workspace even when it is
  disjoint from scratch. The planner has workspace-write access and ignored
  `.harness` files are not protected by the Git workspace guard. The default
  external durable store remains supported. Dry-run may use an in-workspace run
  root because it invokes no planner and carries no live durable-integrity claim.
- Create scratch components without accepting a pre-existing symlink in
  `.harness`, `factory-drafts`, or the run-scoped directory. Require the
  resulting real directory to be inside the real workspace and disjoint from
  real `runDir`.
- After every provider turn, reject a symlinked/replaced scratch parent,
  scratch run directory, or final `draft.md`. Require a regular, non-empty draft
  whose resolved path remains in the prepared scratch directory/workspace.
  Read with final-component `O_NOFOLLOW` plus `fstat` into one stable buffer.
- A successful `draft-ready` result is the only admission to post-turn scratch
  validation and durable publication. Do not treat `Agent.run(...)` as a
  quiescence boundary for aborts or timeouts: current adapters can return from
  their abort race before the underlying provider work settles.
- On a failed, aborted, or timed-out turn, Harness records only the failure
  evidence and retains the untrusted workspace-local scratch. It never reads,
  copies, reviews, publishes, or cleans that scratch, so a late provider write
  cannot affect durable Factory evidence.
- Harness defends successful-turn validation against unsafe completed path state
  and accidental/operator aliases. It does not claim protection against a
  separate same-account process continuously replacing parents between Node path
  checks and file operations.
- Node core does not expose portable `openat`/`openat2`/`unlinkat` directory-fd
  traversal needed to close arbitrary concurrent parent-swap races. Do not
  describe `lstat`/`realpath`/`O_NOFOLLOW` as race-safe against such an attacker.
- Add deterministic parent-swap tests at each Harness-defined validation seam.
  A swap completed before final validation must be rejected. Document that a
  continuously racing same-account process is outside the supported model.
- Never automatically remove scratch, so an unsafe parent cannot redirect
  recursive cleanup outside the workspace. Manual cleanup is an operator action
  after containment inspection, not Harness runtime behavior.

### Least privilege and compatibility

- Default Codex planning must reach the provider as `workspace-write` with
  effective approval policy `never`; assert both through the real role resolver.
- Preserve explicit role-level sandbox/approval overrides. They are existing
  operator opt-outs; this issue neither removes them nor relies on them.
- Do not add `danger-full-access`, another writable root, or a workspace-local
  default `--runs-dir` workaround.
- Keep triage and plan review read-only. Keep implementation's existing
  workspace-write/durable-evidence split unchanged.
- Keep provider-independent workflow behavior.
- Preserve dry-run's CLI `run-started` stderr progress announcement. Dry-run
  suppresses provider/reviewer calls, workflow `events.jsonl`, and lifecycle
  writes; it is not silent on stderr.
- Update all durable guidance, including the packaged `factory-operator` skill,
  so no instruction tells a planner to write durable `planning/draft.md`.

### Required regression coverage

- Default durable-store planning through `resolveFactoryRoleAgent`, asserting
  workspace, `workspace-write`, effective `never`, and no
  `danger-full-access`.
- Static and injected parent replacement, final draft symlink, path overlap,
  iteration collision, atomic publish failures, revision/needs-human metadata,
  successful/failed/aborted/timed-out provider turns, pre-workflow failures,
  dry-run, intentional scratch retention, and scratch non-export assertions in
  every durable contract.
- Docs, packaged-skill, and full repository gates.

## Current state

### Verified code behavior

- `docs/project-intent.md:45-56` makes durable factory storage authoritative and
  the target repo the execution sandbox/Git materialization point. It does not
  name the writer split.
- `bin/factory-commands.ts:746-795` already supplies target `workspace` and
  durable `runsDir` separately:

  ```ts
  const ctx = createFactoryPlanningRunContext({
    workspace: settings.workspace,
    runsDir: options.runsDir ?? store.factoryRunsDir,
    reviewRunsDir: store.reviewRunsDir,
    ...
  });
  ```

  No new CLI flag/store resolver is required.
- `lib/factory-planning-run-context.ts:221-231` currently conflates agent scratch
  and durable evidence:

  ```ts
  const runDir = join(resolve(options.runsDir ?? join(workspace, ".harness/runs/factory")), runId);
  const draftPath = join(runDir, "planning", "draft.md");
  mkdirSync(dirname(draftPath), { recursive: true });
  ```

- `writePlannerArtifacts` at lines 281-292 validates with `statSync` and copies
  with `copyFileSync`. `statSync` follows a draft symlink; direct sequential
  copies are neither stable-source nor failure-atomic.
- `workflows/factory-planning.workflow.ts:112-143` gives `ctx.draftPath` to both
  prompt variants, invokes the provider with `workspace: ctx.workspace`, and
  requests durable artifacts. This is the sandbox/path mismatch.
- The workflow already reviews returned `iterations/<n>/plan.md` and copies that
  snapshot to `dev/plans/` only after pass (`workflows/...:161-180`). Preserve
  this sequence.
- `writePlannerArtifacts` writes `planner.prompt.md`, `planner.raw.json`, and
  `planner.json` before checking `outcome` (`lib/factory-planning-run-context.ts:
  281-287`). Thus `needs-human` correctly retains planner metadata even though
  no plan snapshot exists.
- Dry-run writes its placeholder through `ctx.draftPath`
  (`workflows/...:223-235`), so it can exercise local-to-durable publication.
- `lib/prompts/factory-planning.ts:13-26` is path-agnostic and needs no contract
  change.
- `resolveFactoryRoleAgent` gives a default Codex planner `workspace-write`
  (`lib/config.ts:154-161`). Role overrides still win. Approval can resolve
  undefined (`lib/config.ts:163-164`), then `plannerPolicyOptions` supplies
  effective `never` at provider invocation (`workflows/...:416-425`).
- `runFactoryPlanningWithLinearApply` performs lifecycle import/start and
  optional `applyPlanningStarted` before calling the workflow
  (`bin/factory-commands.ts:848-886`). Scratch created by context construction
  would leak on those failures; lazy workflow preparation avoids it.
- Explicit `--runs-dir` can currently be workspace-local
  (`bin/factory-commands.ts:708-712`), which lets a workspace-write planner
  tamper with ignored durable artifacts. Live planning must reject this mode
  before provider construction; dry-run remains the only local-run compatibility
  mode.
- Current Codex and Cursor adapters race their provider work against abort and
  timeout signals (`providers/codex/codex-agent.ts:123-161` and
  `providers/cursor/cursor-sdk-agent.ts:163-197,241-269`). On an abort/timeout,
  either adapter can return before its underlying provider work settles.
  Planning must therefore avoid every post-turn scratch read/publication action
  for non-successful turns rather than assuming provider quiescence.
- `renameSync` is an atomic same-filesystem replacement but can overwrite an
  existing destination on POSIX. It is suitable for replaceable canonical
  `planning/draft.md`, not immutable iteration publication.
- `linkSync(stagedPath, planPath)` within one directory provides atomic
  no-replace publication: it fails with `EEXIST`, then Harness can unlink the
  staging name. If supported filesystems cannot provide same-directory hard
  links, stop rather than fall back to overwrite or partial direct writes.
- `.gitignore` ignores `.harness/`; intentional retention requires no new ignore
  pattern.
- `skills/factory-operator/SKILL.md:269-272` currently tells planners to write
  `runs/factory/<run-id>/planning/draft.md` in the durable store. That shipped
  guidance directly contradicts FER-61 and is in scope.

### Existing tests and reproducible baseline

- `test/factory-planning.workflow.test.ts`: approval, revisions, needs-human,
  prompts, snapshots, provider policy.
- `test/factory-planning.workflow-failures.test.ts`: invalid drafts,
  provider/reviewer failures, unresolved review, tracked mutation, output plan
  failures. It is already above the approximate 700-line guideline; do not grow
  it.
- `test/factory-planning-apply-command.test.ts`: wrapper ordering/failure
  preservation; extend only for lazy scratch absence.
- `test/cli.test.ts:2187-2274`: external durable-store dry-run, durable
  artifacts, `run-started` progress, and lifecycle suppression.
- `test/skills.test.ts` and `test/docs-contracts.test.ts` are the relevant
  packaged-skill/durable-doc checks.
- Planning-session observation, not executor baseline: with local repo clock
  `2026-07-09 23:12 PDT`, the three planning/config suites passed 79 tests.
  Step 0 must record the actual execution result/count.
- `pnpm test -- <files>` runs the configured full suite. Use
  `pnpm exec vitest run <files>` for focused gates.

## Design

### Context lifecycle and intentional retention

| Purpose | Path | Writer | Lifetime |
| --- | --- | --- | --- |
| Planner scratch | `<workspace>/.harness/factory-drafts/<run-id>/draft.md` | Planner; Harness for dry-run placeholder | Prepared lazily; intentionally retained ignored local state |
| Canonical draft | `<runDir>/planning/draft.md` | Harness | Durable latest successful `draft-ready` |
| Review snapshot | `<runDir>/iterations/<n>/plan.md` | Harness | Immutable per-review evidence |

Retain `ctx.draftPath` as prompt-facing scratch. Add
`ctx.durableDraftPath` and idempotent `ctx.preparePlannerScratch()`. Context
construction derives paths, rejects prospective overlap, and prepares durable
run/context/planning directories, but creates no scratch.

Call preparation only after handoff validation and immediately before dry-run or
the first planner invocation. Revisions reuse the directory. Do not add
`cleanupPlannerScratch`: retention is deliberate, removes a risky recursive
deletion path, and avoids inventing cleanup-warning state. Docs must say
retained scratch is non-authoritative and may be manually removed only after
checking it still resolves inside the workspace and does not overlap runDir.

### Supported path validation, seams, and limits

Add narrow helpers in `lib/factory-planning-run-context.ts`:

1. Canonicalize a not-yet-created path through the real nearest existing
   ancestor and unresolved suffix.
2. Allocate the durable run root through exactly 8 total exclusive-creation
   attempts. Retry only `EEXIST` before writing any artifact; never merge an
   existing run directory. Expose a `runIdGenerator` only through
   `createFactoryPlanningRunContextForTest` so collision-then-success and
   exhausted-collision tests are deterministic. Compare prospective scratch/run paths with separator-aware
   same-or-descendant checks in both directions. For a live run, also reject a
   run root or run directory contained by the real workspace; permit it only for
   dry-run before any provider can be invoked.
3. During lazy scratch preparation, create missing parent components one at a
   time, then create the run-scoped scratch directory exclusively. Record that
   exact prepared directory in the context; only later calls from that context
   may reuse it. A pre-existing regular run-scoped directory is a hard stale
   collision. Reject existing symlink/non-directory components. After each
   component and
   at the end, repeat lstat/realpath containment and runDir-disjointness checks.
4. Before source read, revalidate `.harness`, `factory-drafts`, scratch run
   directory, and draft. The final draft must be a non-symlink regular non-empty
   file.
5. Open the final file with `O_RDONLY | O_NOFOLLOW`, fstat it again, read one
   stable buffer, and close in `finally`.
6. Provide a narrow filesystem/test-boundary seam only through
   `createFactoryPlanningRunContextForTest`. Tests may swap a parent after an
   early check but before final validation; the final validation must reject.
7. State in helper comments that these checks reject unsafe completed state,
   not a concurrently racing same-account process. Do not claim directory-fd
   safety.

The executor must not attempt shell `find`, platform-specific native addons, or
child-process cleanup to simulate `openat`. Provider quiescence is required only
for a successful `draft-ready` result; abort/timeout/provider-failure paths are
safe because they terminalize without touching the untrusted scratch surface.

### Failure-atomic and no-replace publication

Read scratch once into a stable byte buffer. Stage canonical and iteration bytes
in exclusive hidden files beside their destinations; fully write/flush/close
before publication.

Publish in this order:

1. `linkSync(iterationTemp, planPath)` to atomically create immutable
   `iterations/<n>/plan.md` without replacement.
2. If `EEXIST`, throw an explicit iteration-collision
   `FactoryPlanningError`; never touch the existing plan or canonical draft.
3. Unlink the iteration staging name; `plan.md` retains the staged inode.
4. Atomically `renameSync(canonicalTemp, durableDraftPath)` last.
5. Return `planPath`; perform no later fallible artifact copy.

Failure behavior:

- Staging/link failure: unlink exact temp files; existing canonical/iterations
  remain byte-for-byte unchanged.
- Canonical rename failure after iteration link: unlink the just-created current
  `plan.md` and exact temps; preserve old canonical/prior iterations and the
  primary error.
- If rollback unlink also fails, preserve the publication error and leave only a
  complete unreferenced current plan, never a truncated file.
- Hard interruption after no-replace link but before canonical rename may leave
  a complete current plan (and possibly its hard-linked staging name) plus old
  canonical. It cannot overwrite earlier evidence. The incomplete run has no
  review/meta reference for that plan.
- Once canonical rename succeeds, canonical and iteration contain the same
  stable bytes.

Use the existing test context factory for a narrow filesystem-operations seam;
production context keeps normal Node operations. Inject stage, link, canonical
rename, and rollback failures. Add a pre-existing `plan.md` collision test and
assert its sentinel bytes, canonical, and prior iterations are unchanged.

### Planner-turn metadata semantics

Split planner evidence by result class:

| Outcome | Planner evidence | New `plan.md` | Canonical update | Review |
| --- | --- | --- | --- | --- |
| Initial/revision `draft-ready` | prompt, raw, structured JSON | Yes | Yes | Yes |
| Initial/revision `needs-human` | prompt, raw, structured JSON | No | No/absent or prior retained | No |
| Invalid/unsafe draft | prompt, raw, structured JSON, failure JSON | No | No | No |
| Any other non-publishable attempt | exact failure matrix below | No | No | No |

`meta.iterations` keeps the existing `{ index }` entry for a needs-human turn;
`planPath` remains absent. Do not delete planner evidence or change the durable
iteration directory contract. For every non-publishable attempt, record the
attempt as an iteration entry without `planPath`; the terminal error and
`planner.failure.json` must agree. Write these artifacts before terminalizing,
then do not validate/read scratch or publish durable plan artifacts.

`planner.failure.json` is a strict Harness-written record with
`classification`, `message`, optional `exitCode`, `aborted`, and the serialized
raw/error artifact. Use exactly one classification:
`provider-failed`, `provider-aborted`, `provider-timeout` (exit code 124),
`invocation-threw`, `structured-output-invalid`, `workspace-guard-failed`,
`finding-decisions-invalid`, or `draft-invalid`. A reviewer failure occurs only
after a successful immutable snapshot and therefore retains normal successful
planner artifacts rather than adding a planner failure record.

Add optional `failureKind: "workspace-guard"` to the false arm of
`AgentRunResult`. `applyWorkspaceGuard` sets it only when enforced tracked
workspace mutation changes an otherwise returned result; provider adapters
preserve it unchanged. Planning derives provider failure/abort/timeout from the
existing typed `aborted` and `exitCode` fields, uses `failureKind` for the
workspace-guard classification, and assigns every other classification inside
the workflow from the exact operation that failed. Never classify by matching an
error string.

Planning owns one authoritative tracked-workspace guard flow for both real
providers and test doubles. Capture status before invoking the planner; pass
`workspaceGuard: "record"` to `Agent.run`; normalize a thrown invocation into a
false `AgentRunResult`; then call `withWorkspaceGuard(..., "enforce")` exactly
once before parsing, finding-decision validation, or scratch access. Remove the
separate `assertTrackedStatusUnchanged` path. A tracked mutation always reaches
the result handler as typed `failureKind: "workspace-guard"` and is recorded as
`workspace-guard-failed` without scratch publication.

Persist prompt/raw before downstream validation, then use this exact artifact
matrix. `raw` means the returned provider raw value or a Harness error artifact
when invocation throws:

| Classification | `planner.json` | `planner.failure.json` | Scratch access |
| --- | --- | --- | --- |
| `provider-failed`, `provider-aborted`, `provider-timeout`, `invocation-threw` | No | Yes | None after return |
| `workspace-guard-failed`, `structured-output-invalid` | No | Yes | None |
| `finding-decisions-invalid`, `draft-invalid` | Yes | Yes | Decision validation: none; draft validation: one validation read only |

All rows retain prompt/raw and available stream evidence. `draft-invalid` may
read only enough to diagnose the invalid/unsafe draft; it never publishes,
reviews, cleans, or trusts the scratch. A successful `needs-human` is not a
failure and writes `planner.json` only. A reviewer failure follows successful
publication and keeps normal successful planner artifacts.

### Default policy contract

An end-to-end injected-provider test must:

1. Write minimal `harness.json` selecting Codex without explicit policy
   overrides.
2. Resolve roles with `resolveFactoryRoleAgent`.
3. Build a context with an external durable runs dir.
4. Assert captured provider input:
   - target `workspace`;
   - `sandboxMode === "workspace-write"`;
   - `approvalPolicy === "never"`;
   - sandbox is not `danger-full-access`;
   - prompt names local scratch, not durable draft, as mutable.
5. Pass review; verify durable/final artifacts and retained local scratch.

Explicit role overrides remain supported/unchanged and are not used by this
default regression.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Install | `pnpm install --frozen-lockfile` | exit 0; lockfile unchanged |
| Focused planning | `pnpm exec vitest run test/factory-planning-run-context.test.ts test/factory-planning.workflow.test.ts test/factory-planning.workflow-failures.test.ts test/factory-planning-policy.test.ts test/factory-planning-apply-command.test.ts test/config.test.ts` | selected tests pass |
| CLI regression | `pnpm exec vitest run test/cli.test.ts -t "harness factory planning dry-run works in non-git workspaces"` | selected test passes |
| Docs/skills | `pnpm exec vitest run test/docs-contracts.test.ts test/skills.test.ts` | all pass |
| Typecheck | `pnpm typecheck` | exit 0; no errors |
| Format | `pnpm format:check` | exit 0; no drift |
| Lint | `pnpm lint` | exit 0; no errors |
| Full gate | `pnpm check` | exit 0, including build/test/smoke-dist |

## Skills for the executor

| Skill/tool | Verified location | Use in |
| --- | --- | --- |
| `node` | `.agents/skills/node/SKILL.md` | Steps 1-4: filesystem validation, stable descriptor read, hard-link/rename publication |
| `typescript-refactor` | `.agents/skills/typescript-refactor/SKILL.md` | Steps 1-4: explicit production/test context types and TypeScript 6 conventions |
| `vitest` | `.agents/skills/vitest/SKILL.md` | Steps 2-6: isolated temp dirs, boundary injection, collision/async assertions |
| `skill-creator` | host skill from the injected available-skills list | Step 7: update and validate the existing packaged operator skill concisely |
| `writing-great-skills` | host-injected: `/Users/frueda/.agents/skills/writing-great-skills/SKILL.md` | Step 7: keep changed operator instructions predictable and single-source |
| `change-review-workflow` | `.agents/skills/change-review-workflow/SKILL.md` | Step 8: final multi-review, triage, fixes, re-review |

Before editing, read `docs/project-intent.md`,
`docs/contributing/architecture.md`, and `docs/contributing/testing.md`.

## Scope

### In scope: implementation and tests

- `lib/factory-planning-run-context.ts`
  - separate paths, reject overlap, lazily prepare scratch;
  - validate completed path state and read final draft with no-follow;
  - stage/publish canonical and immutable no-replace iterations;
  - write durable failed-turn evidence without treating it as a structured plan;
  - provide a narrow test-only filesystem seam.
- `lib/agents.ts` and `lib/review-guard.ts`
  - add one provider-independent typed workspace-guard failure kind; preserve
    existing provider error text and raw artifacts.
- `workflows/factory-planning.workflow.ts`
  - prepare scratch after handoff validation, immediately before first draft use;
  - retain it across revisions and after terminalization;
  - terminalize failed/aborted/timed-out turns without reading or publishing
    their untrusted scratch state.
- `test/factory-planning-run-context.test.ts` (new)
  - ownership, overlap, parent swap/static symlink, collision, atomic failure,
    and retention cases only.
- `test/factory-planning-policy.test.ts` (new)
  - resolver-to-provider default policy contract only.
- `test/factory-planning.workflow.test.ts`
  - revisions, needs-human metadata, successful-turn publication, and explicit
    scratch non-export assertions.
- `test/factory-planning.workflow-failures.test.ts`
  - provider failure/abort/timeout evidence, no post-failure scratch use, and
    terminal error preservation.
- `lib/review-guard.test.ts`
  - assert enforced tracked-workspace mutation carries the typed failure kind.
- `test/factory-planning-apply-command.test.ts`
  - pre-workflow lifecycle/apply failure scratch-absence assertions.
- `test/cli.test.ts`
  - extend only the existing durable-store dry-run test.

### In scope: documentation and packaged guidance

- `docs/project-intent.md`
- `docs/contributing/architecture.md`
- `docs/contributing/factory.md`
- `docs/contributing/setup-manifest.md`
- `docs/contributing/script-command-surface.md`
- `README.md`
- `skills/factory-operator/SKILL.md`

Use generic paths. Keep the skill edit focused on the planning ownership/write
surface; do not restructure unrelated operator sections.

### Hard out of scope

- `bin/factory-commands.ts`: lazy preparation avoids wrapper changes.
- `lib/factory-store.ts` and store/config schemas.
- `lib/config.ts` and `test/config.test.ts`: default and explicit overrides are
  unchanged; use them as resolver inputs/gates.
- `lib/prompts/factory-planning.ts` and planning output schemas.
- Automated scratch cleanup, cleanup warnings, prune commands, or automatic
  retention indexes. Retention is the chosen explicit policy.
- Native addons, platform-specific `openat` helpers, or claims of adversarial
  same-account race safety.
- Triage, plan-review, implementation, publication, Linear, lifecycle-event,
  review-ref, meta/handoff schema, and approved-plan semantics.
- Generic all-station artifact managers or cross-run recovery.
- `.gitignore` changes or committed `.harness` content.
- FER-52 behavior and `skills/sessions/**`.
- Generated plan file and `dev/plans/README.md`; publication/bookkeeping are
  separate.

## Steps

### Step 0: Record execution baseline and provider-failure boundary

Re-read current-state files. Confirm no concurrent change has split paths,
changed wrapper ordering, provider completion, iteration behavior, or sandbox
defaults. Record actual date/test count.

Confirm the actual abort/timeout behavior of supported `Agent.run` adapters.
The expected current behavior is an abort race that can return before underlying
provider work settles. On every non-successful turn, planning must preserve
failure evidence but skip all scratch validation, durable publication, review,
and cleanup; retained scratch is untrusted and never reused. Do not add a
provider-quiescence requirement or a provider change solely for this plan.

**Verify**:

```bash
date '+%Y-%m-%d %H:%M:%S %Z'
rg -n "draftPath|planning/draft|copyFileSync|statSync|runReview" \
  lib/factory-planning-run-context.ts workflows/factory-planning.workflow.ts
rg -n "run.wait|safeDisposeAgent|thread.run|runStreamed" \
  providers/codex/codex-agent.ts providers/cursor/cursor-sdk-agent.ts
rg -n "appendPlanningStartedEvent|applyPlanningStarted|runPlanning" \
  bin/factory-commands.ts
pnpm exec vitest run test/factory-planning.workflow.test.ts \
  test/factory-planning.workflow-failures.test.ts \
  test/factory-planning-apply-command.test.ts test/config.test.ts
```

Expected: direct durable draft flow, raced abort/timeout adapters, and
pre-workflow wrapper ordering are visible; selected baseline tests pass. Record
actual counts.

### Step 1: Derive paths and reject overlap before creation

In `lib/factory-planning-run-context.ts`:

1. Derive `runDir`, `scratchRunDir`, local `draftPath`, and
   `durableDraftPath`.
2. Add prospective-path resolution through the real nearest existing ancestor.
3. Allocate the durable run directory exclusively with bounded collision retry;
   reject same/ancestor/descendant scratch/run overlap before durable creation;
   for a live run reject a real/prospective runDir within the workspace; recheck
   real paths after durable creation and scratch preparation.
4. Keep durable run/context/planning setup in context construction, but do not
   create scratch.
5. Expose `durableDraftPath` and `preparePlannerScratch()`; export no scratch
   metadata.

Test exact overlap, nested overlap, symlink aliases, external default, and a
workspace-local live `--runs-dir` rejection that proves the planner is never
invoked and its sentinel is unchanged. Verify local runs remain available only
to dry-run. Seed durable-run and regular scratch collisions; prove no existing
artifact/scratch byte is changed or published, and prove two preparations in one
context reuse only its recorded directory. Exercise one collision followed by a
new generated id and eight exhausted collisions with the exact final error.

**Verify**:

```bash
pnpm typecheck
pnpm exec vitest run test/factory-planning-run-context.test.ts \
  -t "overlapping scratch and run paths|run id collision|stale scratch"
```

Expected: overlap and live workspace-local run roots fail before provider or
artifact creation; external live and local dry-run paths work.

### Step 2: Lazily prepare scratch and validate completed path state

Implement **Supported path validation, seams, and limits**:

- create scratch parent components one at a time and create the run-scoped
  scratch directory exclusively;
- reject a pre-existing scratch run directory, symlink, or non-directory;
- revalidate real workspace containment and runDir disjointness after creation;
- make preparation idempotent only after this context records its exclusive
  scratch creation;
- add test-only boundary hooks/operations without changing production options;
- retain scratch after every outcome; add no recursive cleanup.

Add cases where a test hook replaces `.harness` or `factory-drafts` after an
early check but before final validation. The final validation must reject and
external sentinels must remain unchanged. Label these deterministic boundary
tests, not proof against arbitrary concurrent mutation.

**Verify**:

```bash
pnpm exec vitest run test/factory-planning-run-context.test.ts \
  -t "parent replacement|retains planner scratch"
```

Expected: completed unsafe path state is rejected; scratch is retained only for
safe prepared paths; sentinels survive.

### Step 3: Revalidate and read draft into one stable buffer

Replace `validateDraftPath`/direct scratch copying:

- revalidate all scratch components immediately before read;
- reject symlink/non-regular/empty `draft.md`;
- require real containment in prepared scratch/workspace;
- open final component with `O_RDONLY | O_NOFOLLOW`;
- fstat regular/non-empty, read bytes, close in `finally`;
- repeat parent validation at the final pre-open seam;
- use one buffer for both durable outputs.

Inject a parent replacement before final validation and a final-file symlink.
Both must fail before review/canonical publication; no external sentinel bytes
may appear in durable artifacts.

Document the remaining concurrent same-account race limit in code comments.

**Verify**:

```bash
pnpm exec vitest run test/factory-planning-run-context.test.ts \
  -t "parent replacement|draft symlink|stable buffer"
```

Expected: unsafe completed state is rejected; safe drafts produce stable bytes.

### Step 4: Publish immutable iteration with no-replace semantics

Implement **Failure-atomic and no-replace publication**:

1. Exclusively create/write/flush/close staging files in destination dirs.
2. Publish `plan.md` with same-directory `linkSync`, which fails atomically if
   destination exists.
3. On `EEXIST`, return an explicit collision error without touching existing
   plan or canonical.
4. Unlink iteration staging name after successful link.
5. Rename canonical staging over canonical last.
6. Roll back only the newly linked current plan/exact temps on later failure.

Inject failures for both stages, link, canonical rename, and rollback. Add an
existing `iterations/<n>/plan.md` sentinel collision. Assert it and all prior
evidence remain byte-identical. If hard-link no-replace is unavailable on a
supported filesystem, STOP; do not use overwriting `renameSync` or direct
exclusive writes as a non-atomic fallback.

**Verify**:

```bash
pnpm exec vitest run test/factory-planning-run-context.test.ts \
  -t "no-replace|publishes atomically|preserves prior durable"
```

Expected: collisions never overwrite; every boundary preserves prior evidence.

### Step 5: Preserve failed-turn evidence without touching untrusted scratch

In `workflows/factory-planning.workflow.ts`:

- keep run-start/event behavior;
- validate work-item handoff first;
- construct the planner provider after handoff validation but before scratch
  preparation; provider-construction failure leaves scratch absent;
- call `preparePlannerScratch()` only immediately before the dry-run placeholder
  write or the first `Agent.run` invocation;
- prepare once, retain through all revisions, and do not delete at terminal.
- refactor planner invocation into one result-handling path: persist prompt/raw
  first after every returned or thrown attempt, then either parse/publish a
  successful result or write the strict classified failure record;
- replace `assertTrackedStatusUnchanged` with the one workflow-owned guard:
  invoke providers in record mode, normalize thrown calls, then apply
  `withWorkspaceGuard(..., "enforce")` once before parsing or scratch access so
  real providers and fake agents reach the same typed failure path;
- add `failureKind: "workspace-guard"` to the false `AgentRunResult` arm and
  set it only in `applyWorkspaceGuard` for enforced tracked-workspace mutation;
  derive all other provider classifications from typed `aborted`/`exitCode` or
  the local workflow operation, never from an error string;
- classify and persist provider failure, abort, timeout, thrown invocation,
  malformed structured output, workspace-guard failure, invalid revision
  finding decisions, and draft validation failure before terminalizing;
- after any non-publishable attempt, do not call draft validation (unless that
  validation itself is the classified failure),
  `writePlannerArtifacts`, canonical/iteration publication, review, or cleanup.

Leave `bin/factory-commands.ts` unchanged. Extend
`test/factory-planning-apply-command.test.ts` with real contexts:

- lifecycle start/persistence failure before workflow leaves scratch absent and
  preserves primary error;
- `applyPlanningStarted` rejection leaves scratch absent, skips runPlanning, and
  preserves apply error;
- invalid handoff leaves scratch absent;
- planner-provider construction failure leaves scratch absent;
- once workflow starts, terminal outcomes retain scratch intentionally.
- provider failure, abort, timeout, thrown invocation, malformed output,
  workspace-guard failure, and invalid finding decisions preserve classified
  failure evidence while publishing no plan/canonical/review and never reading
  scratch after a provider failure returns.
- the existing fake-agent tracked-mutation workflow regression reaches the same
  `workspace-guard-failed` classification as a real provider and publishes no
  scratch-derived artifact.
- the focused review-guard regression proves the typed workspace-guard kind is
  present only for the enforced mutation path.

**Verify**:

```bash
pnpm exec vitest run test/factory-planning-apply-command.test.ts \
  -t "before workflow|apply start"
pnpm exec vitest run test/factory-planning.workflow-failures.test.ts \
  -t "provider failure|abort|timeout|thrown|malformed|workspace guard|finding decisions|does not publish"
```

Expected: pre-draft exits create no scratch; failed turns retain untrusted scratch
without publishing it; draft-producing runs retain safe scratch.

### Step 6: Regress policy, workflow outcomes, and non-export boundaries

Keep tests in their existing ownership layers:

- `test/factory-planning-policy.test.ts`: resolver-to-provider policy contract
  from **Design**, without manually filling policy fields. Cover both default
  Codex `workspace-write`/`never` and explicit planning-role sandbox/approval
  overrides reaching the provider unchanged.
- `test/factory-planning.workflow.test.ts`: revisions, needs-human metadata,
  successful publication, and scratch non-export behavior.
- `test/factory-planning.workflow-failures.test.ts`: classified provider failure,
  abort, timeout, thrown invocation, malformed output, workspace-guard,
  decision-validation, and draft-validation evidence plus the
  no-post-failure-scratch-use contract.
- `test/factory-planning-run-context.test.ts`: path preparation, validation,
  staging, collision, and atomic publication only.

Cover:
- two-turn revision/same session and retained same scratch path;
- initial/revision needs-human planner metadata directories remain;
- no `plan.md`, canonical update, or review for needs-human;
- prior canonical/snapshots remain on revision needs-human;
- invalid source retains diagnostic scratch but publishes no plan;
- every non-publishable classification writes prompt/raw/error/failure evidence,
  preserves the matching terminal error, and writes no plan/canonical/review;
- dry-run retains placeholder scratch and publishes canonical/iteration;
- CLI keeps `run-started` progress while omitting events/lifecycle writes.
- parse `meta.json` and lifecycle events and inspect review refs/handoff text for
  approved, revision, needs-human, dry-run, and failure outcomes; each must omit
  `factory-drafts` and expose no scratch path/field.

Extend `test/cli.test.ts:2187` to assert prompt-local scratch, external durable
canonical/iteration, retained run-scoped scratch placeholder, existing progress
assertion, and absent `events.jsonl`/lifecycle state.

**Verify**:

```bash
pnpm exec vitest run test/factory-planning-run-context.test.ts \
  test/factory-planning.workflow.test.ts \
  test/factory-planning.workflow-failures.test.ts \
  test/factory-planning-policy.test.ts \
  test/factory-planning-apply-command.test.ts test/config.test.ts
pnpm exec vitest run test/cli.test.ts \
  -t "harness factory planning dry-run works in non-git workspaces"
```

Expected: selected tests pass offline; needs-human metadata is preserved exactly;
default Codex input is workspace-write/never; retained scratch is ignored state.

### Step 7: Update docs and the packaged operator skill

Use `skill-creator` and `writing-great-skills` for the existing skill edit.

Update:

- `docs/project-intent.md`: agent workspace writes vs Harness durable writes.
- `docs/contributing/architecture.md`: three paths, stable validation,
  no-replace publication, threat-model boundary, intentional retention.
- `docs/contributing/factory.md`: ignored retained scratch, manual cleanup
  caution, live planner-writable `--runs-dir` rejection, and dry-run-only local
  compatibility.
- `docs/contributing/setup-manifest.md`: scratch row with creator, ownership,
  ignore/retention/non-recovery policy.
- `docs/contributing/script-command-surface.md`: transient planning scratch vs
  canonical Harness evidence; dry-run progress distinction.
- `README.md`: concise ownership/retention sentence by durable-store config.
- `skills/factory-operator/SKILL.md:269-272`: replace durable-write instruction
  with workspace-local scratch plus Harness validation/publication/revision
  behavior. Keep it concise and consistent with operator docs.

**Verify**:

```bash
rg -n "planning/draft|factory-drafts|planner writes" \
  README.md docs skills/factory-operator/SKILL.md
pnpm exec vitest run test/docs-contracts.test.ts test/skills.test.ts
python3 /Users/frueda/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  skills/factory-operator
pnpm format:check
```

Expected: no guidance asks planners to write durable draft; docs/skill tests,
the packaged operator-skill validation, and format pass.

### Step 8: Gate and review

Run all focused and full gates, then `change-review-workflow`. Triage every
finding; fix justified findings and rerun affected gates/review.

Before review, stage only the in-scope implementation/docs/test/skill files
after inspecting `git status --short` and `git diff --cached`. Create a temporary
immutable review commit with the staged tree only—do not move `HEAD`, create a
branch, or include `.harness`:

```bash
git add <exact-in-scope-files>
git diff --cached --check
base=$(git merge-base origin/main HEAD)
tree=$(git write-tree)
review_head=$(printf 'review: FER-61 preflight\n' | git commit-tree "$tree" -p HEAD)
git update-ref refs/harness/review/fer-61-preflight "$review_head"
handoff='FER-61: agent writes only workspace-local scratch; Harness alone publishes durable evidence. Review scratch/run containment, live workspace-local runDir rejection, no-replace publication, failure evidence, and scratch non-export invariants.'
printf '%s\n' "$handoff" | node dist/bin/harness.js run change-review \
  --workspace . --base "$base" --head refs/harness/review/fer-61-preflight \
  --plan dev/plans/FER-61.md --handoff-stdin --verbose
git update-ref -d refs/harness/review/fer-61-preflight
```

If review needs a material fix, repeat the staged-tree/ref creation and review
after the fix. Preserve the final staged tree for the ordinary implementation
commit; never rely on the temporary ref as publication history.

**Verify**:

```bash
pnpm exec vitest run test/factory-planning-run-context.test.ts \
  test/factory-planning.workflow.test.ts \
  test/factory-planning.workflow-failures.test.ts \
  test/factory-planning-policy.test.ts \
  test/factory-planning-apply-command.test.ts test/config.test.ts \
  test/docs-contracts.test.ts test/skills.test.ts lib/review-guard.test.ts
python3 /Users/frueda/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  skills/factory-operator
pnpm typecheck
pnpm lint
pnpm format:check
pnpm check
git diff --check
git status --short
```

Expected: all gates pass; no tracked `.harness` files; status contains only the
approved plan and in-scope source/test/docs/skill changes; review has no
unresolved must-fix finding.

## Test plan

| Scenario | Planner metadata | Plan/canonical behavior | Scratch behavior |
| --- | --- | --- | --- |
| Default Codex/external store | iteration metadata written | canonical/plan/final identical | safe local scratch retained |
| Revision | metadata for both turns | canonical revision 2; plans 1/2 immutable | same path retained |
| Initial `needs-human` | iteration 1 prompt/raw/JSON | no plan/canonical/review | directory retained; draft optional |
| Revision `needs-human` | new turn prompt/raw/JSON | no new plan/review; prior durable retained | same directory retained |
| Draft/parent symlink | planner metadata retained | no external content published | unsafe path not deleted |
| Deterministic parent swap | depends on turn boundary | final validation rejects | external sentinel survives |
| Overlapping runsDir | none | no run created | none |
| Live workspace-local runsDir | planner is never invoked | no durable live run; sentinel unchanged | none |
| Planner-provider construction failure | none | no plan/canonical/review | none |
| Run-id collision then success | no stale prior metadata | new exclusive run only | new exclusive scratch only |
| Exhausted run-id/scratch collision | none or current error evidence only | existing sentinel unchanged | stale scratch never read |
| Existing plan collision | planner metadata retained | plan sentinel/canonical unchanged | retained |
| Stage/link failure | planner metadata retained | old durable evidence unchanged | retained |
| Canonical rename failure | planner metadata retained | current plan rolled back; old canonical retained | retained |
| Hard interruption after link | durable metadata may be incomplete | complete unreferenced plan + old canonical | retained |
| Every non-publishable planner attempt | exact prompt/raw/planner.json/failure matrix and available stream | no plan, canonical update, or review | retained and untrusted; draft-invalid only diagnoses once |
| Lifecycle/apply/handoff pre-draft failure | normal pre-draft artifacts only | wrapper behavior unchanged | none |
| Dry-run | placeholder planner metadata | placeholder canonical/plan | placeholder scratch retained; progress kept |

## Done criteria

All must hold:

- [ ] Planner prompts name only workspace-local mutable scratch.
- [ ] Completed unsafe parent/final symlink state is rejected; external sentinel
      bytes are neither copied nor deleted.
- [ ] Successful `draft-ready` is the only admission to scratch validation and
      durable publication; failed/aborted/timed-out turns retain untrusted
      scratch without later reads, review, publication, or cleanup.
- [ ] Scratch/run overlap and aliases are rejected before artifact creation;
      live workspace-local run roots are rejected before planner invocation; only
      dry-run may use a local compatibility root.
- [ ] Durable run and run-scoped scratch directories are exclusively owned by
      one context; collisions never merge or reuse retained artifacts.
- [ ] Iteration publication atomically fails on existing destination and never
      overwrites immutable evidence.
- [ ] Staged durable publication/injected failures preserve prior canonical and
      iterations without truncation.
- [ ] Needs-human retains planner prompt/raw/JSON metadata while omitting only
      new plan snapshot/canonical update/review.
- [ ] Failed provider turns retain prompt/raw/failure evidence and preserve the
      terminal error without claiming a structured planner result.
- [ ] Failure classification is typed: workspace-guard mutation is not inferred
      from strings, and provider abort/timeout derives from existing typed fields.
- [ ] Parsed metadata, lifecycle events, review refs, and handoff text for every
      outcome omit scratch paths and `factory-drafts` fields.
- [ ] Scratch is created only for draft-producing workflow paths and
      intentionally retained afterward as ignored, non-authoritative state.
- [ ] Default resolver-to-provider Codex policy is workspace-write/never with no
      danger-full-access; explicit planning-role overrides reach the provider
      unchanged.
- [ ] Dry-run retains CLI progress and scratch placeholder while suppressing
      provider/reviewer calls, workflow events file, and lifecycle writes.
- [ ] All docs and `skills/factory-operator/SKILL.md` state the same ownership
      contract.
- [ ] `quick_validate.py` passes for the changed packaged operator skill.
- [ ] Durable layout/meta/lifecycle/handoff, triage, reviewer, implementation,
      and publication contracts remain unchanged.
- [ ] Focused/full gates pass; no `.harness` artifact is tracked.
- [ ] Final change review has no unresolved must-fix findings.

## STOP conditions

Stop and report; do not improvise if:

- A non-successful provider turn can reach draft validation, publication, review,
  cleanup, or any trusted reuse of its scratch state.
- Requirements demand defense against a concurrent same-account filesystem
  attacker; implement fd-anchored native traversal in a separately approved
  platform design instead.
- Supported filesystems cannot provide atomic same-directory hard-link
  no-replace publication for iteration plans.
- A safe implementation cannot reject scratch/run overlap before creation.
- A failure can overwrite/truncate an existing iteration or replace canonical
  before the current immutable plan is safely published.
- Plan review cannot read the immutable durable snapshot without write access;
  do not widen reviewer privilege.
- The fix requires danger-full-access, extra writable roots, workspace-local
  default runs, or agent-owned durable copying.
- Planning output, lifecycle, meta, handoff, store, or config schema changes are
  required.
- Focused tests fail twice after a root-cause attempt or behavior outside scope
  changes.
- Full gate fails only in the pre-existing sessions dependency-bootstrap
  fixture. Capture exact output and ask whether to accept the environmental
  failure; do not edit `skills/sessions/**`.
- Concurrent/user changes overlap in-scope files and cannot be preserved.

## Maintenance notes

- `ctx.draftPath` is agent-facing; `ctx.durableDraftPath` is Harness-facing.
- Retained scratch is diagnostics only, never recovery input.
- Do not add automatic recursive cleanup without a platform-level
  directory-fd/no-follow design and explicit threat-model expansion.
- Hard-link publication is the immutable no-replace boundary; canonical rename
  remains the replaceable-current boundary.
- Iteration-first/canonical-last prefers a complete unreferenced plan on hard
  interruption over damage to prior canonical evidence.
- Future agent-produced durable artifacts should reuse this ownership,
  validation, no-replace, and success-only-publication model.
