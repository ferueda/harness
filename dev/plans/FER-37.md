# Plan FER-37: Refactor triage around lifecycle state

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report. Do not improvise.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: FER-53 durable factory store, shipped in PR #108
- **Category**: factory, lifecycle, correctness
- **Linear issue**: FER-37
- **Plan review**: approved; Codex 5.6 Terra High pass with zero findings on
  2026-07-09 (`20260709-220959-b6038d`)

## Why this matters

Triage currently starts a new run whenever its source and config are valid.
That permits accidental repeated triage even when durable lifecycle history
already contains `triage.completed`. Linear status cannot safely prevent this:
it is a human-facing projection, can drift, and is not present for file-backed
work items. FER-37 makes durable lifecycle history the authority, adds one
explicit `--rerun` override, and invalidates stale plan publication fields when
a new triage result supersedes earlier planning.

## Requirements

- Permit triage only when the work item's lifecycle event log has no prior
  `triage.completed`, unless the operator passes `--rerun`.
- Inspect event history, not `factoryStage`, route, or Linear status, because
  later lifecycle events can obscure the fact that triage already completed.
- Run the policy check after resolving the work item and before
  `createFactoryRunContext`; rejected attempts create no run directory, emit no
  run-started progress, append no lifecycle event, and make no Linear mutation.
- Apply the same gate to live and `--dry-run` commands.
- Keep `--rerun` as the only override. Do not add unpark, resume, or reset CLIs.
- Change only the lifecycle-aware station command, `harness factory triage`.
  Keep the low-level `harness run factory-triage` workflow escape hatch
  unchanged; it does not resolve durable factory state.
- Preserve the normal non-rerun Linear entry statuses: intake, needs-info, and
  triage-failed.
- For `--rerun --apply`, let lifecycle policy be authoritative: after the
  adapter validates issue presence and configured team/project scope, accept
  any present Linear status at the apply-start step. Missing status still fails.
- Pass rerun intent only to triage apply-start validation. Completed/failed
  projection remains route-driven and unchanged.
- Every new `triage.completed` projection must clear `approvedPlanPath`,
  `approvedPlanPrUrl`, and `approvedPlanCommit` before applying its new route.
- When lifecycle state exists, lifecycle-owned work-item metadata must be
  replaced by the durable projection rather than merely overlaid. Fields absent
  from current lifecycle state must not survive from stale item-file metadata.
- Keep triage prompts, output schemas, route semantics, and event schemas
  unchanged unless implementation reveals a concrete defect and a STOP
  condition is resolved.
- Document the lifecycle gate, `--rerun`, dry-run behavior, and Linear apply
  interaction for contributors and factory operators.

## Current state

- FER-53 is merged. It moves lifecycle and run evidence into the durable factory
  store and exposes `store.factoryStateRoot` to station commands. FER-37 owns
  policy; FER-53 owns store placement, locking, XDG behavior, and migration.
- `bin/factory-commands.ts` registers `harness factory triage` with apply,
  dry-run, and durable-store options, but no rerun option.
- The triage action resolves the work item through
  `resolveFactoryWorkItemInput`, then immediately prepares cancellation and
  calls `createFactoryRunContext`. There is no history-based eligibility gate.
- Live triage resolves lifecycle input with `lifecycleReadMode: "load"`, which
  may rebuild the durable projection under the FER-53 per-item lock. Dry-run
  uses `"inspect"`, which reports projection warnings without repair. The new
  event-history policy runs after either mode and does not change those
  projection semantics.
- `lib/factory-triage-input.ts` overlays the current lifecycle read model onto
  work-item metadata. That projection is insufficient for this policy because
  later station events replace its stage and run fields.
- `lib/factory-lifecycle.ts` already provides lifecycle event-log reads and
  work-item key derivation. Reuse those boundaries instead of parsing JSONL or
  rebuilding paths in the command.
- `mergeFactoryStateIntoWorkItem` currently spreads defined lifecycle fields
  over source metadata. It cannot clear a lifecycle-owned key that is absent
  from the new state, so stale item-file plan publication fields can survive a
  rerun and incorrectly force planned implementation mode.
- The lifecycle reducer's `triage.completed` case replaces route fields but
  preserves prior plan publication fields. Existing publication helpers clear
  only URL/commit in some planning transitions, so triage needs an explicit
  all-publication-fields reset.
- `lib/factory-linear-adapter.ts` accepts triage apply-start only from intake,
  needs-info, or triage-failed. Its apply input has no rerun signal.
- FER-53 lifecycle locking covers short critical sections. Holding a lock for
  the full provider-backed triage run is intentionally outside FER-37.
- `test/factory-lifecycle.test.ts`, `test/factory-triage-input.test.ts`,
  `test/factory-implementation-input.test.ts`,
  `test/factory-linear-adapter.test.ts`, and `test/cli.test.ts` contain the
  nearest reducer, input, adapter, and station command regressions.
  `scripts/smoke-dist.ts` owns built help assertions.
- `docs/contributing/factory.md`, `docs/contributing/architecture.md`, and
  `skills/factory-operator/SKILL.md` describe triage behavior.
  `docs/contributing/script-command-surface.md` defers exact flags to generated
  help and needs an update only where lifecycle/mutability semantics change.

## Design

Add a small `lib/factory-triage-policy.ts` module rather than growing command
logic, further expanding the already-large lifecycle persistence module, or
leaking complete event history through the resolved work-item type.
Its public policy function accepts `factoryStateRoot`, the resolved work item,
and a rerun boolean. It derives the canonical work-item key, reads that item's
durable event log, and rejects when any event is `triage.completed` and rerun is
false. On success it returns whether prior completion existed so downstream
operator guidance can distinguish a first dry-run from an overridden dry-run.
The error should identify the work item, mention the prior run when available,
and tell the operator to use `--rerun` for an intentional repeat.

Do not substitute current `factoryRoute` or `factoryNextAction` for the event
predicate. Those fields happen to survive later reducer cases today, but that is
incidental projection behavior, not proof encoded by the policy contract. The
ticket requires the historical event fact, and reading it directly avoids
coupling eligibility to future reducer retention changes. Keep the new module
narrow: one public policy assertion over existing lifecycle read/identity
helpers, with no new storage abstraction.

This is a sequential eligibility policy, not a claim of single-flight station
execution. Two first triages launched concurrently can both pass before either
records completion. Preventing that would require a lease or long-running lock
and is a separate design problem.

Always read and validate lifecycle history before applying the override.
Malformed lifecycle history must fail closed through the existing lifecycle
reader even with `--rerun`; the flag overrides a completed-history decision,
not corrupt durable evidence. Histories containing only imported, started, or
failed triage events remain eligible.

For Linear apply-start, extend `LinearTriageApplyInput` with optional
`rerun?: boolean`. Preserve the existing allowlist when false. When true,
require only a present status after the adapter's existing issue and scope
checks; this prevents Linear projection drift from contradicting the canonical
lifecycle override. Do not weaken configured scope checks.

Extract the currently inlined post-resolution triage orchestration into an
exported helper, following `runFactoryPlanningWithLinearApply`. The helper must
own, in order: lifecycle eligibility, run-context creation, lifecycle start
writes, Linear apply-start, station execution, terminal lifecycle write, and
terminal Linear projection. Accept narrow injected context/provider/adapter
seams for tests. This gives the blocked live apply path a direct assertion that
context creation, provider execution, and `applyTriageStarted` are never
reached; do not create a generic station framework.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Install | `pnpm install --frozen-lockfile` | exit 0 |
| Policy tests | `pnpm exec vitest run test/factory-triage-policy.test.ts` | eligibility and fail-closed cases pass |
| Orchestration tests | `pnpm exec vitest run test/factory-triage-apply-command.test.ts` | blocked apply reaches no mutating seam |
| Reducer tests | `pnpm exec vitest run test/factory-lifecycle.test.ts` | rerun projection clears all publication fields |
| Input/readiness tests | `pnpm exec vitest run test/factory-triage-input.test.ts test/factory-implementation-input.test.ts` | stale source publication fields are cleared end to end |
| Adapter tests | `pnpm exec vitest run test/factory-linear-adapter.test.ts` | normal allowlist and rerun widening pass |
| Route guidance tests | `pnpm exec vitest run test/factory-intake.test.ts test/factory-triage.workflow.test.ts` | live rerun and dry-run guidance differ correctly |
| CLI tests | `pnpm exec vitest run test/cli.test.ts` | gate timing, dry-run, rerun, and help cases pass |
| Source help | `node bin/harness.ts factory triage --help` | help includes `--rerun` |
| Focused suite | `pnpm exec vitest run test/factory-triage-policy.test.ts test/factory-triage-apply-command.test.ts test/factory-intake.test.ts test/factory-lifecycle.test.ts test/factory-linear-adapter.test.ts test/factory-triage-input.test.ts test/factory-triage.workflow.test.ts test/factory-implementation-input.test.ts test/cli.test.ts` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Dist smoke | `pnpm smoke:dist` | built help includes `--rerun` |
| Full gate | `pnpm check` | format, lint, typecheck, tests, build, and smoke pass |

## Skills for the executor

| Step | Skill/tool | Why |
| --- | --- | --- |
| Policy and adapter steps | `typescript-refactor` | Keep assertion inputs and optional rerun plumbing narrow and type-safe. |
| Test steps | `vitest` | Follow existing fixture, error, and CLI regression patterns. |
| Docs step | `factory-operator` | Keep operator instructions aligned with the canonical lifecycle model and command behavior. |

## Scope

**In scope — modify only these files unless a STOP condition is resolved:**

- `bin/factory-commands.ts`
- `lib/factory-triage-policy.ts` (new)
- `lib/factory-intake.ts`
- `lib/factory-lifecycle.ts`
- `lib/factory-linear-adapter.ts`
- `workflows/factory-triage.workflow.ts`
- `test/factory-triage-policy.test.ts` (new)
- `test/factory-triage-apply-command.test.ts` (new)
- `test/factory-intake.test.ts`
- `test/factory-lifecycle.test.ts`
- `test/factory-linear-adapter.test.ts`
- `test/factory-triage-input.test.ts`
- `test/factory-triage.workflow.test.ts`
- `test/factory-implementation-input.test.ts`
- `test/cli.test.ts`
- `scripts/smoke-dist.ts`
- `docs/contributing/architecture.md`
- `docs/contributing/factory.md`
- `docs/contributing/script-command-surface.md`
- `docs/contributing/setup-manifest.md`
- `skills/factory-operator/SKILL.md`

**Out of scope:**

- Durable-store placement, XDG paths, migration, repair, or lock redesign.
- A replay projector or new lifecycle event/schema fields.
- Holding a work-item lock during provider execution or guaranteeing concurrent
  first-run single-flight behavior.
- New unpark, resume, reset, or lifecycle-editing commands.
- Changes to the low-level `harness run factory-triage` workflow or its help.
- Triage prompt, output schema, route, or next-action redesign.
- Planning/implementation station policy changes.
- Inngest, SQLite, worktree, branch, or PR orchestration.
- Treating Linear status or bootstrap `factoryStage` as canonical eligibility.

## Implementation steps

### Step 0: Confirm the merged FER-53 baseline

- Verify `resolveFactoryStore` exposes `factoryStateRoot`, triage passes it to
  `resolveFactoryWorkItemInput`, and lifecycle reads use the durable store.
- Verify live triage still uses lifecycle read mode `load` and dry-run uses
  `inspect`; FER-37 must not replace or merge those modes.
- Run the existing triage dry-run and lifecycle tests before editing.

**Verify:**

```bash
pnpm exec vitest run test/factory-lifecycle.test.ts test/cli.test.ts
```

Expected: exit 0 on current `main`, which already contains FER-53.

### Step 1: Add the lifecycle-history triage policy

Create `lib/factory-triage-policy.ts`:

- Define a narrow input type containing `factoryStateRoot`, `workItem`, and
  `rerun`, plus a narrow result containing `hadPriorCompletion` and the prior
  run ID when available.
- Derive the canonical key with the existing lifecycle helper.
- Read events through the existing lifecycle event reader.
- Read and validate the complete event log first. Return
  `hadPriorCompletion: false` when no `triage.completed` exists. When one exists
  and rerun is true, return `hadPriorCompletion: true` with its run ID.
- Otherwise throw a stable, actionable error naming the work item and
  `--rerun`; include the prior completion run ID when present.
- Do not inspect projected stage/route metadata or Linear fields.
- Do not catch/soften corrupt-history errors.

Add `test/factory-triage-policy.test.ts` covering:

- New/imported-only item is eligible.
- `triage.started` and `triage.failed` without a completed event are eligible.
- Any prior `triage.completed` rejects without rerun, even when later planning,
  publication, or implementation events changed the current projection.
- Rerun permits the same completed history.
- Successful decisions accurately report whether prior completion existed.
- Malformed event JSON fails closed with the existing reader error.
- Malformed event JSON also fails closed with `rerun: true`.

**Verify:**

```bash
pnpm exec vitest run test/factory-triage-policy.test.ts
```

Expected: exit 0.

### Step 2: Gate the triage command before run creation

Update `bin/factory-commands.ts`:

- Add `rerun?: boolean` to `FactoryTriageStationOptions` and expose
  `--rerun` with wording that it intentionally repeats completed triage.
- Extract an exported `runFactoryTriageWithLinearApply` helper (or an equally
  narrow triage-specific name) from the current inline orchestration. Model its
  result and dependency injection after `runFactoryPlanningWithLinearApply`,
  while retaining triage's existing failure/export behavior.
- Pass `store.factoryStateRoot`, `input.workItem`, and `options.rerun` into that
  helper. Make lifecycle eligibility its first operation.
- Keep the policy before AbortController/context creation, run-started output,
  lifecycle appends, provider execution, and Linear apply-start. Context
  creation must be injectable so this ordering is directly testable.
- Run it for live and dry-run commands alike.
- When apply mode starts, pass rerun intent through the adapter input. Do not add
  rerun to terminal apply calls unless required by structural typing; terminal
  behavior must not branch on it.
- Pass the successful policy result into workflow execution as
  `nextLiveRunRequiresRerun = !ctx.dryRun || hadPriorCompletion`. Do not infer
  this from placeholder text or Linear status.

Add `test/factory-triage-apply-command.test.ts`:

- Seed a completed lifecycle history and invoke the exported helper with fake
  context creation, triage execution, and Linear adapter functions.
- Without rerun, assert rejection occurs before context creation,
  `applyTriageStarted`, provider/station execution, lifecycle append, or
  terminal apply.
- Repeat the blocked case for dry-run inputs.
- With rerun, assert context creation proceeds and apply-start receives
  `rerun: true`; preserve the existing terminal projection behavior.
- Assert orchestration passes `nextLiveRunRequiresRerun: true` for live runs
  and for overridden dry-runs with prior completion, but false for a first
  dry-run with no prior completion.
- Cover a started/failed-only history proceeding without rerun.

Extend `test/cli.test.ts`:

- Help includes `--rerun` and existing role-configuration exclusions remain.
- Seed durable history with `triage.completed`; normal live and dry-run triage
  reject before run creation.
- Rejection creates no new run directory, prints no run-started progress,
  appends no event, and leaves the source item in place.
- `--rerun --dry-run` passes the gate, creates ordinary dry-run artifacts, and
  still appends no lifecycle event.
- A started/failed-only history remains runnable without `--rerun`.

Keep subprocess CLI coverage focused on real option wiring and file-backed
artifact behavior. Use the direct helper test—not a networked subprocess—to
prove the live Linear apply mutation boundary.

**Verify:**

```bash
pnpm exec vitest run test/factory-triage-apply-command.test.ts test/cli.test.ts
node bin/harness.ts factory triage --help
```

Expected: tests pass; help includes `--rerun`.

### Step 3: Align Linear apply-start with lifecycle reruns

Update `lib/factory-linear-adapter.ts`:

- Add optional `rerun` to `LinearTriageApplyInput`.
- Extend `assertLinearTriageApplyAllowed` with a rerun input or equivalent
  narrow policy.
- Always reject a missing current status.
- Preserve the current three-status allowlist when rerun is false/omitted.
- When rerun is true, accept any present status. Keep issue existence,
  team/project scope, and configured status-map validation unchanged.
- Apply this only before moving the issue to the configured triaging status.

Extend `test/factory-linear-adapter.test.ts`:

- Existing non-rerun allowed/rejected status matrix remains unchanged.
- Rerun apply-start succeeds from representative routed, planning,
  ready-to-implement, parked, and terminal statuses.
- Rerun with no current status still rejects.
- Rerun cannot bypass configured project/team scope.
- Successful rerun still updates to triaging and returns the actual source
  status in the update plan.

**Verify:**

```bash
pnpm exec vitest run test/factory-linear-adapter.test.ts
```

Expected: exit 0.

### Step 4: Invalidate plan publication fields end to end

Update the `triage.completed` reducer in `lib/factory-lifecycle.ts`:

- Remove `approvedPlanPath`, `approvedPlanPrUrl`, and `approvedPlanCommit` from
  the prior state before applying the new triage stage, route, next action, and
  run ID.
- Use a clearly named helper for clearing all publication state. Do not change
  the existing planning helper semantics that intentionally retain historical
  `approvedPlanPath` in selected transitions.
- Update `mergeFactoryStateIntoWorkItem` so that, whenever lifecycle state
  exists, it first removes all lifecycle-owned keys from source metadata, then
  applies the defined durable state fields. Lifecycle-owned keys are
  `factoryStage`, `factoryRoute`, `factoryNextAction`, `factoryRunId`,
  `approvedPlanPath`, `approvedPlanPrUrl`, and `approvedPlanCommit`.
- Preserve non-lifecycle metadata such as `linearStatus`, tracker identity, and
  unrelated source metadata. When no lifecycle state exists, preserve the
  current no-op behavior.

Extend `test/factory-lifecycle.test.ts`:

- Build a state with all three publication fields, then reduce a new
  `triage.completed`; all three fields are absent and the new triage fields win.
- Cover at least one route that plans and one route that does not, proving the
  reset is unconditional.
- Replace the existing imported-only merge regression that expects source
  `factoryStage: "incoming"` to survive. When any lifecycle state exists—even
  imported-only—assert all seven lifecycle-owned source keys are absent unless
  defined by durable state: `factoryStage`, `factoryRoute`,
  `factoryNextAction`, `factoryRunId`, `approvedPlanPath`,
  `approvedPlanPrUrl`, and `approvedPlanCommit`.
- In that replacement regression, separately assert `linearStatus`, tracker
  identity, and unrelated/custom metadata remain intact.
- Keep a distinct planned-publication projection case proving publication
  fields still appear when durable lifecycle state legitimately defines them.
- Preserve existing replan/failure expectations.

Extend `test/factory-triage-input.test.ts` and, where the downstream assertion
is clearest, `test/factory-implementation-input.test.ts`:

- Start with item-file metadata containing all three stale publication fields.
- Resolve it against lifecycle history whose latest `triage.completed` routes
  directly to implementation; the resolved metadata has none of those fields.
- Confirm non-lifecycle metadata is preserved.
- Confirm implementation input resolves direct mode instead of treating the
  stale item-file plan fields as planned-work signals.
- Confirm a lifecycle state that legitimately contains publication fields still
  projects them over source metadata.

**Verify:**

```bash
pnpm exec vitest run test/factory-lifecycle.test.ts test/factory-triage-input.test.ts test/factory-implementation-input.test.ts
```

Expected: exit 0.

### Step 5: Update operator docs and built help smoke

Update `lib/factory-intake.ts` and `workflows/factory-triage.workflow.ts`:

- Extend workflow/route-plan construction with an explicit
  `nextLiveRunRequiresRerun` input supplied by triage orchestration. Do not
  infer it from placeholder output strings or only from `ctx.dryRun`.
- For successful live `needs-info` and `wait-to-implement` routes, generated
  operator guidance must say an intentional repeat uses `--rerun`.
- For a first dry-run with no prior completion, generated guidance must say to
  run normal live triage without `--rerun`, because that dry-run writes no
  completion event.
- For `--rerun --dry-run` over completed history, generated guidance must retain
  `--rerun` for the subsequent live command because the older completion still
  exists.
- Keep `FactoryRoutePlanSchema`, route names, next actions, and triage output
  schema unchanged; only the deterministic command guidance varies.

Extend `test/factory-intake.test.ts` and
`test/factory-triage.workflow.test.ts`:

- Assert live `needs-info` and `wait-to-implement` route plans and rendered
  artifacts mention `--rerun`.
- Assert dry-run guidance does not request `--rerun` and instead directs the
  operator to the first live triage when no prior completion exists.
- Seed completed history, run `--rerun --dry-run`, and assert the generated
  route/summary guidance includes `--rerun` for the next live triage.
- Assert ready-to-plan and ready-to-implement guidance remains unchanged.

Update `docs/contributing/factory.md`, `docs/contributing/architecture.md`,
`docs/contributing/script-command-surface.md`,
`docs/contributing/setup-manifest.md`, and `skills/factory-operator/SKILL.md`:

- Add a rerun example for file and/or Linear input, including
  `--linear-issue ... --rerun --apply` where projection behavior matters.
- State that durable lifecycle history is canonical: a prior
  `triage.completed` blocks normal triage regardless of current Linear status.
- State the gate runs before artifact creation and also applies to dry-runs.
- Explain that `--rerun` is intentional re-triage and that its completed event
  invalidates any prior approved plan publication fields.
- Explain that rerun apply may begin from any present in-scope Linear status;
  normal apply keeps its existing entry-status allowlist.
- Do not document unpark/resume commands or concurrency guarantees.
- Qualify the architecture map's blanket dry-run artifact statement: eligible
  dry-runs write placeholders, while a lifecycle-blocked dry-run exits before
  creating a station run unless `--rerun` is supplied.
- Qualify the command-surface table's blanket factory dry-run statement with
  the same lifecycle-gate behavior; do not duplicate generated flag help.
- Qualify the setup manifest's statement that item-file triage creates run
  artifacts: eligible runs do, while lifecycle-blocked triage exits before run
  creation and never moves the inbox item.

Update `scripts/smoke-dist.ts` to assert built factory triage help contains
`--rerun`.

**Verify:**

```bash
pnpm exec vitest run test/factory-intake.test.ts test/factory-triage.workflow.test.ts
pnpm smoke:dist
```

Expected: exit 0; built help exposes `--rerun`.

### Step 6: Run final gates and inspect the diff

Run:

```bash
pnpm exec vitest run test/factory-triage-policy.test.ts test/factory-triage-apply-command.test.ts test/factory-intake.test.ts test/factory-lifecycle.test.ts test/factory-linear-adapter.test.ts test/factory-triage-input.test.ts test/factory-triage.workflow.test.ts test/factory-implementation-input.test.ts test/cli.test.ts
pnpm typecheck
pnpm smoke:dist
pnpm check
git diff --check
git diff -- bin/factory-commands.ts lib/factory-triage-policy.ts lib/factory-intake.ts lib/factory-lifecycle.ts lib/factory-linear-adapter.ts workflows/factory-triage.workflow.ts test/factory-triage-policy.test.ts test/factory-triage-apply-command.test.ts test/factory-intake.test.ts test/factory-lifecycle.test.ts test/factory-linear-adapter.test.ts test/factory-triage-input.test.ts test/factory-triage.workflow.test.ts test/factory-implementation-input.test.ts test/cli.test.ts scripts/smoke-dist.ts docs/contributing/architecture.md docs/contributing/factory.md docs/contributing/script-command-surface.md docs/contributing/setup-manifest.md skills/factory-operator/SKILL.md
```

Expected:

- All commands exit 0.
- Diff stays within scope.
- No prompt, route, lifecycle schema, store placement, or lock-scope change.
- Rejected normal triage has no run, lifecycle append, provider, or Linear side
  effect. Preserve FER-53's existing live projection-load/repair behavior.
- Rerun is explicit in CLI input but does not become a new lifecycle field.

## Test plan

- Unit policy: eligible incomplete histories, blocked completed histories,
  override, later-event history, malformed log failure.
- Orchestration helper: blocked completed history reaches no context, provider,
  lifecycle append, or Linear apply seam; rerun proceeds with intent preserved.
- Reducer: every new completion clears all three publication fields.
- Metadata merge/downstream readiness: durable absence clears stale item-file
  publication fields and direct implementation routing remains direct.
- Generated route guidance: live repeatable routes name `--rerun`; dry-run
  placeholders direct the first live run without the override.
- Linear adapter: unchanged normal allowlist, widened in-scope rerun entry,
  missing-status and scope failures.
- CLI: option help, pre-context rejection, no side effects, dry-run parity, and
  successful dry-run override.
- Distribution: built help includes the new option.
- Full regression: `pnpm check`.

## Done criteria

- [ ] `harness factory triage --help` exposes one new override: `--rerun`.
- [ ] Prior durable `triage.completed` rejects triage without `--rerun`.
- [ ] Eligibility uses event history, never Linear status or projected
      `factoryStage`.
- [ ] Rejection occurs before run context creation and leaves no run, event,
      provider, or Linear side effect.
- [ ] Live and dry-run commands use the same policy.
- [ ] Started/failed-only triage histories remain eligible.
- [ ] `--rerun --apply` accepts any present status after normal issue/scope
      validation; non-rerun apply keeps its existing allowlist.
- [ ] New `triage.completed` state clears path, PR URL, and commit publication
      fields unconditionally.
- [ ] Lifecycle-owned metadata replacement prevents source item-file plan fields
      from surviving when durable state has cleared them.
- [ ] A direct helper test proves blocked live apply cannot reach context
      creation, provider execution, lifecycle append, or Linear mutation.
- [ ] Generated live `needs-info` and parked route artifacts tell operators to
      use `--rerun`, while dry-run artifacts do not.
- [ ] Event schema, triage prompt/output/routes, store placement, and lock scope
      remain unchanged.
- [ ] Contributor/operator docs and built help smoke describe the behavior.
- [ ] Focused tests, typecheck, smoke-dist, and `pnpm check` pass.

## STOP conditions

Stop and report if:

- The implementation baseline no longer contains FER-53's explicit durable
  `factoryStateRoot` seam or its live-load/dry-run-inspect split.
- Determining prior completion requires using current `factoryStage`, Linear
  bootstrap state, or a workspace-local legacy store.
- Correct behavior appears to require holding a lifecycle lock throughout the
  provider-backed station run or otherwise solving concurrent first-run leases.
- Rerun requires a new lifecycle event/schema field, route, or prompt/output
  change.
- Linear rerun cannot preserve issue existence and configured scope checks.
- Implementation needs files outside the in-scope list.
- A verification command fails twice after a reasonable fix attempt.

## Maintenance notes

- If concurrent first-triage duplication becomes operationally significant,
  design an explicit station lease; do not silently widen FER-53 lock duration.
- Lifecycle history remains authoritative. Linear status/comment updates are a
  projection for humans and may be repaired independently.
- A future lifecycle replay/projector may expose completion history more
  efficiently, but FER-37 should keep its policy boundary independent of that
  optimization.
