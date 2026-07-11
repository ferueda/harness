# Plan 260711-remove-factory-implementation-timeout: Let Factory implementations run without a default absolute cap

> **Executor instructions**: Follow this plan step by step. Run every verification
> command and confirm the expected result before moving to the next step. If any
> STOP condition occurs, stop and report; do not improvise.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Work item**: [FER-67](https://linear.app/ferueda/issue/FER-67/remove-fixed-30-minute-cap-from-factory-implementation-runs)

## Why this matters

Factory implementation currently inherits the shared 1,800,000 ms provider cap, so a healthy implementation can be projected as failed after 30 minutes. Implementation work may legitimately take hours and provider streams do not promise periodic events. Make the implementation station uncapped by default while retaining an operator-supplied positive absolute cap, external cancellation, provider failure detection, stream evidence, lifecycle truth, Linear projection, and same-host stale-owner recovery.

The 2026-07-11 minimal architecture memo supersedes the earlier heartbeat/inactivity proposal. “Liveness” for FER-67 therefore means authoritative provider completion/failure or explicit cancellation, not a resettable heartbeat timer. Silence remains observable after the fact through timestamped provider stream JSONL and is non-fatal by default.

## Requirements

### Functional behavior

1. `harness factory implementation run` resolves an omitted `--max-runtime-ms` to the internal disabled value `0`.
2. `createAgentSignalState(..., 0)` creates no absolute timer. It must remain active for multiple simulated hours, including total provider silence.
3. A caller-supplied positive `--max-runtime-ms` remains an absolute provider deadline and retains the existing timeout result/classification.
4. The implementation command continues converting SIGINT/SIGTERM into its existing external `AbortSignal`; a disabled absolute timeout must not weaken that path.
5. Factory triage, Factory planning, implementation review, `change-review`, and `plan-review` retain their current positive 30-minute defaults.

### Preserved invariants

- No heartbeat or inactivity-abort subsystem. Provider event silence never proves failure.
- No `Infinity` sentinel. `0` is the sole internal disabled-timeout representation; CLI users may only supply positive values.
- Provider-specific termination, timeout, stream-settlement, and error formatting remain inside the Cursor and Codex adapters.
- Existing sequenced/timestamped `implementation/implementer.stream.jsonl` remains provider-silence evidence; no stream, artifact, schema, lifecycle, or Linear payload changes.
- The per-work-item execution lease remains held through the provider pass and requested terminal projection. Dead same-host recovery and fail-closed remote-owner handling remain unchanged.
- Harness remains authoritative for terminal lifecycle state; Linear remains a projection.

### Acceptance interpretation

- A fake-timer test that advances an uncapped signal state by several hours with no provider events is stronger than a “heartbeats continue” test: if complete silence cannot trigger a timeout, streamed activity cannot trigger one either.
- Silence detection is post-hoc inspection of existing timestamped stream artifacts, not an automatic stall detector.
- Cancellation, lifecycle/Linear truth, and stale-owner recovery are regression-gated through their existing focused suites because this change must not alter those implementations.

## Current state

- `bin/harness.ts:110,236-240` owns the shared bounded default and passes it into all Factory command registration:

  ```ts
  const DEFAULT_MAX_RUNTIME_MS = 30 * 60 * 1000;

  addFactoryCommands(program, {
    positiveNumber,
    defaultMaxRuntimeMs: DEFAULT_MAX_RUNTIME_MS,
    writeVerboseWorkflowEvent,
  });
  ```

- `bin/factory-commands.ts:561-585` registers the implementation run option with that shared default unconditionally:

  ```ts
  .option(
    "--max-runtime-ms <ms>",
    `per-agent timeout (default: ${config.defaultMaxRuntimeMs})`,
    config.positiveNumber,
    config.defaultMaxRuntimeMs,
  )
  ```

  The same file passes `options.maxRuntimeMs` unchanged into `createFactoryImplementationRunContext` at lines 644-653. Planning (`1134-1137`), triage (`1602-1605`), and implementation review (`bin/factory-implementation-review-command.ts:67-70`) separately keep `config.defaultMaxRuntimeMs`; do not change those registrations.

- `lib/factory-implementation-run-context.ts:198-205,247-260` intentionally requires live callers to pass a runtime value, then exposes `options.maxRuntimeMs ?? 0`. Keep this explicit live-call contract: the CLI should pass `0`, not omit the field.

- `workflows/factory-implementation.workflow.ts:128-137` forwards the context value to the selected provider without interpreting it. This preserves the project invariant from `docs/project-intent.md`: workflows remain provider-agnostic.

- `lib/agent-signals.ts:24-57` currently always creates a timer:

  ```ts
  const timeout = setTimeout(() => {
    if (controller.signal.aborted) return;
    timedOut = true;
    controller.abort(new Error("timeout"));
  }, timeoutMs);
  // ...
  clearTimeout(timeout);
  ```

  Passing `0` today aborts on the next timer turn; the helper must make timer creation conditional on `timeoutMs > 0` and conditionally clear it.

- `providers/codex/codex-agent.ts:96-181` and `providers/cursor/cursor-sdk-agent.ts:150-269` both delegate their only absolute deadline to `createAgentSignalState`. Their other `input.maxRuntimeMs` uses only format existing timeout errors. No provider-specific branch is needed.

- `bin/factory-commands.ts:637-640,780-782` already wires SIGINT/SIGTERM to an `AbortController` and removes both listeners in `finally`. `test/agent-signals.test.ts:10-58` verifies pre-abort, external abort precedence, timeout classification, and cleanup. Both provider suites also cover external abort and partial stream preservation.

- `lib/agent-stream-log.ts:26-79` writes provider events with monotonically increasing `sequence` and ISO `timestamp`. `workflows/factory-implementation.workflow.ts:46-70` tests that live implementation supplies `implementation/implementer.stream.jsonl` as the provider log path.

- `test/factory-implementation-policy.test.ts:98-150` already proves a dead same-host execution lease is recoverable and a remote owner never expires by age. `docs/contributing/factory.md:622-641` documents lease ownership and fail-closed lifecycle/Linear ordering.

- Repository conventions: Node 24+ ESM TypeScript, `.ts` import extensions, strict/erasable syntax, and Vitest without globals (`package.json`, `tsconfig.json`, `vitest.config.ts`). Tests use descriptive top-level `test(...)` cases and direct state assertions; match `test/agent-signals.test.ts` and the injected Commander fixture in `test/factory-implementation-apply-command.test.ts`.

- Baseline verification was not executable in the planning sandbox: dependencies were absent and network-restricted installation could not reach the npm registry. No baseline failure was observed in source; the executor must install dependencies and run all gates below before editing.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Install | `pnpm install --frozen-lockfile` | exit 0; lockfile unchanged |
| Signal tests | `pnpm exec vitest run test/agent-signals.test.ts` | all tests pass |
| CLI/default tests | `pnpm exec vitest run test/factory-implementation-cli.test.ts test/factory-implementation-apply-command.test.ts` | all tests pass |
| Regression tests | `pnpm exec vitest run test/factory-implementation-policy.test.ts test/factory-implementation.workflow.test.ts providers/codex/codex-agent.test.ts providers/cursor/cursor-sdk-agent.test.ts` | all tests pass |
| Typecheck | `pnpm typecheck` | exit 0, no TypeScript errors |
| Final gate | `pnpm check` | format, lint, typecheck, tests, build, and distribution smoke all pass |
| Review diff | `git diff --check && git diff -- bin/factory-commands.ts lib/agent-signals.ts test/agent-signals.test.ts test/factory-implementation-cli.test.ts test/factory-implementation-apply-command.test.ts docs/contributing/factory.md` | exit 0; only intended changes shown |

## Skills for the executor

| Skill/tool | Use in step | Why verified/relevant |
| --- | --- | --- |
| `node` | Step 1 | Available repo skill; apply its AbortSignal, timer-cleanup, and graceful-shutdown guidance without changing the existing signal ownership model. |
| `vitest` | Steps 1-2 | Available repo skill; use deterministic fake timers, restore timer state, and keep mocks isolated. |
| `change-review-workflow` | Step 4 | Available repo coordinator and documented project close path; run the full change review after implementation gates pass. |

Before editing, read `.agents/skills/node/SKILL.md`, `.agents/skills/vitest/SKILL.md`, and `.agents/skills/change-review-workflow/SKILL.md`. Read `docs/project-intent.md` for provider/workflow ownership and `docs/contributing/factory.md:568-665` for implementation lifecycle and lease guarantees.

## Scope and ownership

### In scope — only these files may change

- `lib/agent-signals.ts` — shared `0`-means-disabled timer contract.
- `bin/factory-commands.ts` — implementation-run-only Commander default/help text.
- `test/agent-signals.test.ts` — multi-hour silence, positive cap, cleanup, and external abort regression coverage.
- `test/factory-implementation-cli.test.ts` — generated implementation help contract.
- `test/factory-implementation-apply-command.test.ts` — parsed command default and explicit override forwarding.
- `docs/contributing/factory.md` — operator-facing timeout and silence semantics.

### Hard out of scope — do not touch

- `bin/harness.ts` and its `DEFAULT_MAX_RUNTIME_MS`: changing the shared constant would uncap triage, planning, and review.
- `bin/factory-implementation-review-command.ts`: implementation review remains bounded.
- `workflows/factory-implementation.workflow.ts`, `lib/factory-implementation-run-context.ts`, provider adapters, Agent interfaces, schemas, and exported artifacts: current contracts already carry numeric `0` correctly once the shared signal helper supports it.
- Lifecycle writers, Linear adapters/projections, locks, leases, stale-owner recovery, retry behavior, and workspace/ref materialization.
- New provider activity abstractions, heartbeat/stall timers, cancellation settlement types, durable attempt records, fencing, remote recovery, Inngest workers, or automatic silence cancellation.
- Planning/review timeout policy, configuration schema additions, dependency changes, and generated `dist/` commits.

## Ordered implementation steps

### Step 0: Establish the baseline

Run installation, the four scoped test groups from “Commands you will need,” and `git status --short`. Record any pre-existing failure before editing. The working tree must contain no unexpected tracked changes; ignored build/test artifacts are acceptable only when produced by the documented gates.

**Verify**: `git status --short && pnpm exec vitest run test/agent-signals.test.ts test/factory-implementation-cli.test.ts test/factory-implementation-apply-command.test.ts test/factory-implementation-policy.test.ts test/factory-implementation.workflow.test.ts providers/codex/codex-agent.test.ts providers/cursor/cursor-sdk-agent.test.ts` → clean/known starting status and all tests pass.

### Step 1: Make `0` disable only the absolute timer

In `lib/agent-signals.ts`, change `createAgentSignalState` so it calls `setTimeout` only when `timeoutMs > 0`. Store the result as an optional timer and clear it only when present. Do not change external-abort precedence, abort reasons, `isTimedOut`, `isExternallyAborted`, `createAgentAbortRace`, or result classification.

In `test/agent-signals.test.ts`:

- Add a deterministic fake-timer regression that creates state with `timeoutMs: 0`, advances at least three simulated hours with no events, and proves the signal is not aborted and neither classification flag is set.
- Prove the same zero-timeout state still follows an external controller abort and reports `isExternallyAborted() === true`, `isTimedOut() === false`.
- Retain/prove that a positive timeout still aborts and reports only `isTimedOut() === true`.
- Always call `cleanup()` and restore real timers/mocks so the suite leaves no open handle or shared timer state.

Do not add a heartbeat callback or resettable inactivity timer: the absence of a timer at `0` is the feature.

**Verify**: `pnpm exec vitest run test/agent-signals.test.ts` → all signal tests pass deterministically, including the multi-hour zero-timeout case and positive timeout case.

### Step 2: Default only Factory implementation runs to `0`

In `bin/factory-commands.ts`, update only the `implementation run` `--max-runtime-ms` option at lines 581-585:

- Keep `config.positiveNumber` as the parser so explicitly supplied `0`, negatives, `Infinity`, and non-numbers remain invalid.
- Set the Commander default argument to numeric `0` rather than `config.defaultMaxRuntimeMs`.
- Change help text to state that the option is an optional absolute per-agent timeout and is disabled by default. Do not suggest that silence terminates a run.
- Continue passing `options.maxRuntimeMs` into the live context exactly as today.

Add command-level regression tests:

- In `test/factory-implementation-apply-command.test.ts`, use the existing injected `implementationRunner`/Commander fixture to capture the context. With the flag omitted, assert `ctx.maxRuntimeMs === 0`; with `--max-runtime-ms 1234`, assert `ctx.maxRuntimeMs === 1234`. Let both runs complete through the existing lifecycle/Linear fixture so the test also guards truthful terminal behavior.
- In `test/factory-implementation-cli.test.ts`, strengthen `implementation run help includes live options` to assert the generated help describes the default as disabled.
- Do not weaken the production `positiveNumber` parser or the live-context requirement for an explicit numeric value.

**Verify**: `pnpm exec vitest run test/factory-implementation-cli.test.ts test/factory-implementation-apply-command.test.ts` → all tests pass; omitted implementation runtime reaches the runner as `0`, explicit positive runtime is preserved, and help says disabled by default.

### Step 3: Document the operational contract

In `docs/contributing/factory.md`, add a concise paragraph in “Implementation Station” beside the live-mode description:

- implementation has no absolute provider runtime cap by default;
- `--max-runtime-ms <positive-ms>` opts into the existing absolute cap;
- SIGINT/SIGTERM remain explicit cancellation;
- provider/process/protocol failure remains terminal;
- event silence is non-fatal and existing timestamped `implementation/implementer.stream.jsonl` is post-hoc activity/silence evidence when the provider streams.

Do not describe synthetic heartbeats, stall alerts, automatic inactivity cancellation, distributed leases, or Inngest behavior as current.

**Verify**: `pnpm exec oxfmt --check docs/contributing/factory.md && rg -n "max-runtime-ms|implementer\.stream\.jsonl|SIGINT|SIGTERM" docs/contributing/factory.md` → format check exits 0 and the new contract is findable in the Implementation Station section.

### Step 4: Run regression, full gates, and review

Run the focused regression suite covering shared timeout behavior, implementation forwarding, provider cancellation/timeout settlement, stream evidence, lifecycle/Linear projection, and local/remote lease recovery. Then run typecheck and the repository final gate. Inspect the diff and confirm no out-of-scope timeout default changed.

After all gates pass, invoke `change-review-workflow` with all default review steps. Implement only findings that stay within this plan; stop on any finding that requires the out-of-scope systems above.

**Verify**:

1. `pnpm exec vitest run test/agent-signals.test.ts test/factory-implementation-cli.test.ts test/factory-implementation-apply-command.test.ts test/factory-implementation-policy.test.ts test/factory-implementation.workflow.test.ts providers/codex/codex-agent.test.ts providers/cursor/cursor-sdk-agent.test.ts` → all pass.
2. `pnpm typecheck && pnpm check` → both exit 0.
3. `rg -n "config\.defaultMaxRuntimeMs" bin/factory-commands.ts bin/factory-implementation-review-command.ts` → matches remain for planning, triage, and implementation review, but not the `factory implementation run` option.
4. `git diff --check && git status --short` → no whitespace errors; only the six in-scope files are modified.
5. Full `change-review-workflow` → no unresolved Implement/Adapt findings.

## Test plan

| Concern | Evidence |
| --- | --- |
| Multi-hour activity/silence does not false-timeout | New fake-timer `createAgentSignalState(..., 0)` test advances at least three hours without abort. No heartbeat events are necessary because silence is the stricter case. |
| Explicit safety cap remains | Existing/new positive signal timeout test plus command override forwarding test. Existing Codex/Cursor timeout tests retain exit 124 behavior. |
| SIGINT/SIGTERM cancellation remains | New zero-timeout external AbortSignal test plus existing command signal wiring and provider external-abort suites; expected provider result remains exit 130/`aborted: true`. |
| Provider silence remains inspectable | Existing implementation workflow log-path assertion and Codex/Cursor partial stream-log tests; docs explain timestamped JSONL is evidence, not a heartbeat contract. |
| Lifecycle and Linear projections remain durable/truthful | `test/factory-implementation-apply-command.test.ts` runs the default/override contexts through the existing applied command fixture; full existing suite remains green. No projection code changes. |
| Lease and stale-owner behavior remains safe | `test/factory-implementation-policy.test.ts` keeps dead same-host recovery and non-expiring remote-owner coverage green. No lease/recovery code changes. |
| Planning/review remain bounded | Structural grep plus untouched shared constant/option registrations; full CLI and repository gates. |

## Done criteria

- [ ] Omitted `harness factory implementation run --max-runtime-ms` reaches the provider context as numeric `0`.
- [ ] `createAgentSignalState(undefined, 0)` creates no effective absolute deadline and remains un-aborted after at least three simulated hours of silence.
- [ ] External abort still wins and classifies as cancellation when timeout is disabled.
- [ ] An explicit positive implementation cap still times out through the existing provider contract; CLI-supplied `0` remains rejected.
- [ ] Implementation help and `docs/contributing/factory.md` truthfully describe disabled-by-default absolute timeout and diagnostic-only stream evidence.
- [ ] Planning, triage, implementation review, change review, and plan review still use the positive shared default.
- [ ] No lifecycle, Linear, lease, stale-owner, stream schema, provider adapter, or artifact format code changes.
- [ ] All focused tests, `pnpm typecheck`, and `pnpm check` exit 0.
- [ ] `git diff --check` exits 0 and `git status --short` lists only the six in-scope files.
- [ ] Full change review has no unresolved Implement/Adapt findings.

## STOP conditions

Stop and report instead of broadening the change if:

- Current call-site inspection no longer matches this plan—for example, a provider has acquired another absolute deadline outside `createAgentSignalState`.
- Commander cannot retain a positive-only user parser while supplying internal default `0` without changing public validation semantics.
- Making `0` work requires changing `AgentRunInput`, schemas, provider adapters, workflow/lifecycle output, or using `undefined`/`Infinity` instead.
- A focused test shows planning, triage, or any review command becomes uncapped.
- Cancellation at `0` no longer settles through the existing provider path, changes exit 130/`aborted` classification, or leaves an open timer/listener.
- Tests indicate lifecycle, Linear terminal projection, workspace safety, or lease ownership changes are necessary.
- The proposed fix introduces provider-event heartbeat/inactivity semantics, remote owner recovery, fencing, retries, or Inngest integration.
- Dependency installation or a baseline test fails for a reason unrelated to FER-67; record the exact command/output and get direction before changing unrelated code.
- Any verification fails twice after one reasonable in-scope correction, or implementation needs a file outside the explicit scope.

## Maintenance notes

- `0` is an internal policy value, not a CLI-accepted duration. Preserve the positive parser if the option is moved or configuration support is added later.
- Any future inactivity/stall feature must remain diagnostic unless a separate architecture decision establishes a reliable provider heartbeat contract.
- Future Inngest orchestration may observe stream evidence or request cancellation, but must not infer provider death from event silence. Durable attempt ownership, fencing, and remote recovery are separate work.
- Reviewers should scrutinize default isolation: the common `DEFAULT_MAX_RUNTIME_MS` must remain intact everywhere except Factory implementation run’s Commander default.
- Reviewers should also check fake-timer cleanup and ensure the zero-timeout path installs no long-lived Node timer that could leak or abort immediately.
