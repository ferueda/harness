# FER-62 — Review completed Factory implementations

**Status:** approved

**Scope:** Factory implementation review only

**Depends on:** shipped Factory implementation station and durable Factory store

## Goal

Add one Factory command that takes a work item whose implementation already completed, runs the existing `change-review` workflow against the immutable implementation refs, persists the review run reference in the Factory lifecycle, and ends at either `review-complete` or `ready-for-human`.

This is orchestration, not a second review engine. The implementation must reuse the existing `WorkflowContext`, `change-review` workflow, reviewer schemas, artifacts, provider configuration, and durable review-runs directory.

## Confirmed product decisions

- Command: `harness factory implementation review`.
- Inputs: exactly one of `--item-file` or `--linear-issue`, plus `--workspace`, Factory store overrides, `--max-runtime-ms`, and `--verbose`. This command has no `--runs-dir`; nested reviews always use the resolved store's `reviewRunsDir`.
- Eligible source state: lifecycle-authoritative `implementation-complete` only.
- Review scope: the completed implementation event's `reviewBase..reviewCommitSha`, plan when available, and generated change-review handoff.
- Reviewer set: existing default `implementation`, `quality`, and `simplify` steps, invoked once.
- Passing review: lifecycle stage `review-complete`.
- Needs-changes, blocked, or failed review: lifecycle stage `ready-for-human`.
- Linear projection: unchanged; this command does not update Linear.
- Remediation: out of scope. A later command/workflow may consume findings.

## Explicit non-goals

- Automatic fixes, remediation loops, iteration budgets, or reviewer reruns.
- Recovery of partial review trees or stale processes.
- Cross-project workspace leases or long-lived review ownership.
- New Git refs, commits, snapshots, or writer-boundary checks.
- Changes to reviewer prompts, reviewer schemas, `change-review`, or `WorkflowContext`.
- Factory-specific provider roles or review configuration.
- Resume/apply/run-directory identity modes.

## Current-state evidence

- `workflows/change-review.workflow.ts` already runs the three review roles and exports one `run(ctx)` entry point.
- `lib/workflow-context.ts` already accepts workspace, base/head refs, plan, handoff, review-runs root, provider policy, timeout, signal, and event sink.
- `workflows/factory-planning.workflow.ts` already demonstrates nesting a review workflow with `createWorkflowContext` and a durable review-runs root.
- `workflows/factory-implementation.workflow.ts` already records `reviewBase`, a candidate `reviewHead` ref, immutable `reviewCommitSha`, and `implementation/change-review-handoff.md`.
- `implementation.completed` lifecycle events already persist those refs, handoff path, run identity, and execution directory.
- `resolveFactoryStore()` already exposes `factoryRunsDir`, `reviewRunsDir`, and `factoryStateRoot` outside the target repo.
- Factory stage schemas already include `review-complete` and `ready-for-human`.

## Design

### Review source resolution

Create a focused Factory implementation-review module. It resolves the same canonical work-item key used by existing Factory commands, loads lifecycle state/events from the durable store, and requires `implementation-complete`.

Find the `implementation.completed` event matching the current lifecycle `factoryRunId`. Resolve its implementation run directory from durable execution metadata and require the execution's current Factory store/project identity to match the resolved store. The run directory must be a direct contained child of `store.factoryRunsDir`, never an arbitrary absolute path or traversal.

Parse `meta.json` as a JSON object, explicitly project the consumed persisted fields, then validate that projection with a strict Zod schema: workflow, completed status, run id, workspace, run directory, review base/head/commit SHA, change-review handoff artifact, and optional Factory plan metadata. The projection intentionally ignores the existing envelope's unrelated valid fields; it does not parse the raw full envelope with the narrow strict schema. Reject malformed or mismatched consumed evidence before provider creation. Cover the parser with a fixture shaped like an actual successful implementation `meta.json`, including its normal extra envelope fields.

Resolve persisted artifact paths relative to the validated implementation run directory, canonicalize them, require regular readable files, and require containment within that run directory. Workspace-relative approved plans are the sole exception: resolve them from the validated workspace and require containment within that workspace. Never pass persisted relative paths directly to `WorkflowContext`.

Evidence precedence and required checks:

| Value                                                     | Authority                                         | Required validation                                                                                  |
| --------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Work-item key/current stage/current implementation run id | Lifecycle state                                   | State is `implementation-complete`; run id is present.                                               |
| Implementation event                                      | Lifecycle event matching state run id             | Type/run id/work-item key match; execution exists.                                                   |
| Store identity                                            | Current `resolveFactoryStore()` result            | Event execution store root/project id/factory state root match the current store.                    |
| Implementation run directory                              | Event `execution.runDir`                          | Absolute canonical direct child of current `factoryRunsDir`; basename equals run id.                 |
| Run/workspace/refs                                        | Projected `meta.json`                             | Workflow/status/run id/runDir/workspace match event, current workspace, and canonical run directory. |
| Handoff                                                   | Meta artifact path, cross-checked with event path | Both resolve to the same canonical regular file contained by the run directory.                      |
| Approved plan                                             | Lifecycle state's approved plan path              | Workspace-relative only; canonical regular file contained by workspace. Missing plan is allowed.     |
| Review refs                                               | Implementation event and projected meta           | Base/head/commit values agree exactly before Git validation.                                         |

Conflicting or missing required values are STOP errors before provider creation. Do not fall back between conflicting lifecycle and meta evidence.

In the validated workspace repository, peel `reviewBase`, `reviewHead`, and `reviewCommitSha` with `rev-parse <value>^{commit}`; reject missing refs and non-commit objects. Require the peeled `reviewHead === reviewCommitSha`, require the recorded SHA to equal its peeled commit, and require `git merge-base reviewBase reviewCommitSha` to succeed. Then pass the recorded commit SHA to `WorkflowContext`; later ref movement cannot change the reviewed object.

The validated source supplies:

- `workspace`
- `reviewBase`
- `reviewCommitSha` as the immutable review head
- `reviewHead` only as metadata validated to resolve to that commit before review
- `changeReviewHandoffPath`
- optional approved plan path
- implementation run id

Do not infer current `HEAD`, inspect uncommitted files, or create new refs.

### Existing review invocation

Resolve ordinary harness review options for the target workspace. Build one `WorkflowContext` with:

- `runsDir: store.reviewRunsDir`
- source `reviewBase` and recorded `reviewCommitSha`; do not pass the mutable `reviewHead` ref
- validated handoff path
- approved plan path only when present and readable
- standard agent/provider configuration
- command timeout, signal, verbose event sink

Call `runChangeReview(ctx)` with no step override.

### Lifecycle result

Add one strict lifecycle event, `implementation.review.completed`, containing:

- `implementationRunId`
- outcome: `review-complete` or `ready-for-human`
- review verdict for completed review runs
- review summary and meta artifact paths

The event is a discriminated result: completed review runs require the existing review verdict; failed review runs omit verdict and retain their failed-review evidence in the nested review artifacts. The event `runId` is the review run id. Reducer projection sets the Factory stage to the outcome and `factoryRunId` to the review run id. No separate started event is needed: review workflow events provide execution detail, while the Factory lifecycle records the durable handoff result.

Mapping:

| Review result                 | Factory outcome   |
| ----------------------------- | ----------------- |
| completed + `pass`            | `review-complete` |
| completed + `needs_changes`   | `ready-for-human` |
| completed + `blocked`         | `ready-for-human` |
| failed review run, no verdict | `ready-for-human` |

Failures before a review run exists remain command errors and do not append a misleading terminal review event.

If review artifacts complete but the Factory lifecycle append fails, report the review run id/directory/meta path in the command error, leave lifecycle unchanged, and preserve the review artifacts. A normal command rerun is the supported recovery and may create another immutable review run; no partial-run recovery is added.

### CLI output

Print a discriminated stable JSON result. Completed reviews contain implementation run id, review run id/directory, outcome, verdict, summary path, and meta path. Failed reviews contain the same fields except verdict, plus failed-review evidence already exposed by review metadata. Exit zero only for `review-complete`; set a nonzero exit code for `ready-for-human`.

Concurrent invocations are not specially coordinated in this scope. Both can create immutable review runs; the append-only lifecycle remains auditable and the latest valid terminal event is authoritative. Document this operator limitation instead of adding a second lease protocol.

## Implementation steps

### 1. Add lifecycle review result

**Files:** `lib/factory-lifecycle.ts`, lifecycle tests

- Add strict schemas/types for `implementation.review.completed`; completed review results require a verdict and failed review results omit it.
- Add the event to the discriminated union.
- Add an append helper following existing lifecycle write conventions.
- Project outcome and review run id in the reducer.
- Test schema rejection, completed/failed append-read round trips, and both terminal projections.

### 2. Resolve and run implementation review

**Files:** new focused modules under `lib/` and/or `workflows/`, focused tests

- Resolve work-item identity through existing item-file/Linear parsing helpers.
- Load current lifecycle evidence and require `implementation-complete`.
- Locate and validate the completed implementation run with a strict persisted-evidence schema.
- Enforce current store/project identity, direct run-root containment, safe run-relative artifact resolution, regular files, workspace-contained plan resolution, and `reviewHead === reviewCommitSha` at validation time.
- Pass `reviewCommitSha`, not the mutable ref, as the review workflow head.
- Build the existing review workflow context from immutable source evidence.
- Run the default `change-review` workflow once.
- Map review status/verdict to the two Factory outcomes and append the terminal lifecycle event.
- Keep dependency seams narrow enough for tests to inject the review runner/provider without duplicating production logic.
- Test happy path, needs-changes, blocked/failed review, wrong lifecycle stage, malformed/mismatched implementation evidence, missing/non-commit/moved refs, traversal/wrong-root/relative artifact paths, optional plan propagation, and lifecycle append failure with review paths preserved in the error.

### 3. Expose the command

**Files:** focused Factory command module, `bin/factory-commands.ts`, CLI tests

- Register `factory implementation review` without expanding the existing large command file with workflow logic.
- Enforce exactly one source input. Expose only workspace, Factory store, runtime, and verbose options; intentionally omit `--runs-dir`.
- Wire abort handling and ordinary review provider configuration.
- Print stable JSON; set exit status from the mapped Factory outcome.
- Add command help and option-validation coverage.

### 4. Update operator contract and distribution smoke

**Files:** `skills/factory-operator/SKILL.md`, `docs/contributing/factory.md`, `docs/contributing/architecture.md`, `docs/contributing/script-command-surface.md`, `README.md` when its current-flow summary is affected, `scripts/smoke-dist.ts`

- Replace the manual standalone-review handoff with the Factory review command.
- State the two terminal outcomes, no Linear mutation, no remediation, and concurrent-invocation limitation.
- Add the command and durable review-artifact ownership to the command-surface inventory.
- Ensure packaged CLI help exposes `factory implementation review`.

### 5. Verify and review

- Focused Vitest suites for lifecycle, resolver/workflow, and CLI behavior.
- `pnpm format:check`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm smoke:dist`
- Run the full `change-review` workflow against the implementation, triage all findings, fix accepted findings, and rerun after material changes.

## Acceptance criteria

- A completed Factory implementation can be reviewed by work-item identity with one command.
- Review always uses the recorded implementation commit SHA and contained handoff evidence, never a mutable ref or ambient worktree state.
- Existing three-role `change-review` runs exactly once with its standard artifacts in the durable review-runs root.
- Factory lifecycle durably points to the review run and projects `review-complete` only for a passing review.
- All other completed/failed reviewer outcomes project `ready-for-human` and return nonzero.
- Invalid lifecycle state or source evidence fails before reviewer invocation.
- No remediation, recovery, new Git lineage, new reviewer configuration, or review-engine changes are introduced.
- Operator docs and dist smoke match the shipped command.

## Verification matrix

The required gate is layered. Deterministic tests prove every branch and safety
boundary; live provider smoke proves that the packaged command, configured
agents, real Git objects, durable store, and existing `change-review` workflow
compose successfully. Live smoke uses only disposable repositories, item files,
and store roots. It never reads or mutates Linear.

| ID | Layer | Scenario | Execution | Required oracle |
| --- | --- | --- | --- | --- |
| U1 | Lifecycle | Completed `pass`, `needs_changes`, `blocked`, and failed review results | Append/read real lifecycle JSONL and reduce state | `pass` projects `review-complete`; every other result projects `ready-for-human`; failed results have no invented verdict; review run id becomes authoritative. |
| U2 | Evidence resolver | Valid completed implementation, with and without approved plan | Real temporary Git repository, Factory store, lifecycle JSONL, run metadata, and artifacts | Resolver returns canonical workspace/artifact paths and immutable commit SHA; optional plan is propagated only when valid. |
| U3 | Evidence resolver | Wrong stage/run/work item/store/project/workspace; malformed metadata; missing event | Mutate one authority at a time | STOP before agent/provider creation and before a review run directory or terminal lifecycle event exists. |
| U4 | Filesystem safety | Relative/wrong-root run dir; traversal, symlink escape, missing, directory, or unreadable handoff/plan | Real filesystem fixtures | Unsafe evidence is rejected before provider creation; no outside file is read or changed. |
| U5 | Git safety | Missing/non-commit base, head, or SHA; moved review ref; head/SHA disagreement; unrelated history | Real Git refs and commits | Review never starts; recorded SHA is the only head passed to the workflow when evidence is valid. |
| U6 | Result mapping | Review `pass`, `needs_changes`, `blocked`, and failed run | Inject only the review result at the narrow runner seam | Stable CLI/domain result contains correct status, outcome, paths, verdict presence, and failed-review evidence. |
| U7 | Persistence failure | Review artifacts complete, lifecycle append fails | Inject append failure after a completed review fixture | Error reports review run id, directory, and meta path; artifacts remain; lifecycle remains at `implementation-complete`. |
| C1 | CLI contract | Help, exactly-one input, bounded options, exit behavior | Commander command tests | No `--runs-dir`; item-file/Linear exclusivity enforced; zero only for `review-complete`; stable JSON emitted. |
| I1 | Workflow integration | Pass through the actual `runChangeReview` implementation | Real `WorkflowContext`, Git diff, review run directory, and artifact writers; deterministic fake agents return valid implementation/quality/simplify outputs | All three standard roles run once; aggregate/meta/summary artifacts are real; Factory lifecycle points to that review run. No custom reviewer loop is involved. |
| I2 | Workflow integration | One role returns a valid must-fix finding; one role invocation fails | Same real workflow as I1, varying only fake agent output/failure | Must-fix aggregates to `needs_changes`; invocation failure creates failed review metadata; both project `ready-for-human` without remediation. |
| D1 | Distribution | Packaged nested command and bounded help surface | `pnpm build && pnpm smoke:dist` | Built CLI exposes `factory implementation review`; help contains intended options and omits `--runs-dir`. |
| L1 | Live provider smoke | Benign synthetic change passes | Real packaged implementation run followed by real packaged review run against a disposable repo | Three real reviewer turns complete; command exits 0; lifecycle is `review-complete`; refs, summary, meta, and aggregate artifacts agree. |
| L2 | Live failure smoke | Reviewer executable/provider fails | Real packaged implementation run, then real review with deliberately broken reviewer config | Review exits nonzero; a failed nested review is preserved; lifecycle is `ready-for-human`; terminal event has no verdict. |
| L3 | Live preflight smoke | Implementation review ref is moved after completion | Real packaged implementation run, mutate only its disposable internal ref, then invoke review | Command rejects evidence before provider invocation; no review run and no review terminal event are created. |

### Deterministic integration additions

`I1` and `I2` are the most important additions beyond the existing focused
tests. They must not inject `reviewRunner`. Inject agents at
`agentProviderFactory`, then run the production `change-review` workflow and
real artifact writers. Assert artifact contents and lifecycle JSONL, not only
mock call counts. Keep these tests offline and include them in `pnpm test`.

The fake-agent matrix is:

| Case | Implementation reviewer | Quality reviewer | Simplify reviewer | Expected aggregate |
| --- | --- | --- | --- | --- |
| Clean candidate | `pass`, no findings | `pass`, no findings | `pass`, no findings | completed `pass` -> `review-complete` |
| Actionable defect | one valid `must_fix` finding | `pass` | `pass` | completed `needs_changes` -> `ready-for-human` |
| Reviewer failure | valid output | invocation throws | valid output | failed run -> `ready-for-human`, no verdict |

For every case verify `meta.json`, `summary.md`, aggregate result, per-step
artifacts, Factory terminal event, projected lifecycle stage, review run id, and
that the source workspace/ref pair did not change.

### Live smoke protocol

Run live smoke only when provider credentials are available, after
`pnpm check`, from the candidate commit. It is a release/PR verification step,
not part of the offline unit-test gate. Preserve failed roots for diagnosis;
clean successful roots after recording the evidence.

#### Shared disposable fixture

1. Build Harness, create a temporary target repository and external store, and
   record their paths. Never point the smoke at a developer checkout or the
   default Factory store.

   ```bash
   export HARNESS_CHECKOUT="$PWD"
   pnpm install --frozen-lockfile
   pnpm build

   export SMOKE_ROOT="$(mktemp -d)"
   export TARGET="$SMOKE_ROOT/target"
   export STORE="$SMOKE_ROOT/store"
   mkdir -p "$TARGET" "$STORE"
   git -C "$TARGET" init -b main
   git -C "$TARGET" config user.name "Harness Smoke"
   git -C "$TARGET" config user.email "harness-smoke@example.invalid"
   printf '# Factory review smoke\n' > "$TARGET/README.md"
   git -C "$TARGET" add README.md
   git -C "$TARGET" commit -m "Seed smoke repository"
   ```

2. Add a target-local `harness.json`. Use the configured real provider with a
   read-only default reviewer policy and a workspace-write override only for
   `factory.implementation.roles.implementer`. Use a low-cost model suitable
   for smoke, `approvalPolicy: "never"`, and a finite timeout. Do not configure
   Linear. Commit `harness.json` so the target is clean before implementation.

   ```json
   {
     "defaultAgent": "codex",
     "agents": {
       "codex": {
         "model": "gpt-5.6-luna",
         "modelReasoningEffort": "medium",
         "sandboxMode": "read-only",
         "approvalPolicy": "never"
       }
     },
     "factory": {
       "implementation": {
         "roles": {
           "implementer": {
             "agent": "codex",
             "model": "gpt-5.6-luna",
             "modelReasoningEffort": "medium",
             "sandboxMode": "workspace-write",
             "approvalPolicy": "never"
           }
         }
       }
     }
   }
   ```

3. Add `.harness/inbox/factory/work-item.json` with synthetic direct-mode
   readiness. Keeping the item under ignored `.harness/` avoids contaminating
   the implementation candidate:

   ```json
   {
     "id": "fer62-live-smoke-pass",
     "source": "file",
     "title": "Add a harmless smoke marker",
     "body": "Create SMOKE.md containing exactly: Factory review smoke passed. Do not change any other file.",
     "labels": ["smoke"],
     "metadata": {
       "factoryStage": "ready-to-implement",
       "factoryRoute": "ready-to-implement",
       "factoryNextAction": "implement-directly"
     }
   }
   ```

The `.example.invalid` identity, item, repository, and store are disposable
fake data. Item-file mode guarantees no tracker reads or writes.

#### L1 — real implementation and passing review

Run both packaged commands against the same item identity and explicit store:

```bash
node "$HARNESS_CHECKOUT/dist/bin/harness.js" factory implementation run \
  --workspace "$TARGET" \
  --item-file "$TARGET/.harness/inbox/factory/work-item.json" \
  --factory-store-root "$STORE" \
  --factory-store-project-id fer62-live-pass \
  --max-runtime-ms 300000 | tee "$SMOKE_ROOT/implementation.json"

node "$HARNESS_CHECKOUT/dist/bin/harness.js" factory implementation review \
  --workspace "$TARGET" \
  --item-file "$TARGET/.harness/inbox/factory/work-item.json" \
  --factory-store-root "$STORE" \
  --factory-store-project-id fer62-live-pass \
  --max-runtime-ms 300000 | tee "$SMOKE_ROOT/review.json"
```

Pass only when all of these hold:

- implementation status is `implementation-complete`, and its base, internal
  head ref, and commit SHA peel to the recorded objects;
- review exits zero with `reviewStatus: "completed"`, `verdict: "pass"`, and
  `outcome: "review-complete"`;
- review run directory is a direct child of the explicit store's review-runs
  root and contains `meta.json`, `summary.md`, and structured/raw artifacts for
  implementation, quality, and simplify;
- lifecycle JSONL ends with one `implementation.review.completed` event whose
  implementation/review run ids and relative artifact paths match disk;
- lifecycle projection is `review-complete` and points at the review run;
- `git rev-parse HEAD` in the target remains the committed fixture tip, the
  internal implementation ref is unchanged, and no Linear
  marker/config/artifact exists.

A real reviewer may occasionally return a justified non-pass. Treat that as a
smoke failure and inspect the finding; do not rewrite lifecycle evidence or
rerun until the fixture/prompt or product defect is understood.

#### L2 — real failed review run

Create a fresh shared fixture and complete its real implementation run. Before
review, change only the disposable target's reviewer executable/config to a
known failing command while leaving the implementation role usable. Invoke the
same review command.

Pass when the command exits nonzero, reports `reviewStatus: "failed"` and
`outcome: "ready-for-human"`, preserves the nested failed review meta/summary
and per-role failure evidence, appends exactly one terminal Factory review
event with no verdict, and projects `ready-for-human`. The implementation ref
and commit must remain unchanged. This tests orchestration failure mapping, not
model judgment.

#### L3 — moved-ref rejection before spend

Create another fresh fixture and complete its implementation run. Read the
recorded `reviewHead` and `reviewBase`, then move the internal head to the base
commit in the disposable target:

```bash
git -C "$TARGET" update-ref "$REVIEW_HEAD" "$REVIEW_BASE"
```

Record the review-runs directory and lifecycle JSONL before invoking review.
Pass when the command exits nonzero with the moved-ref evidence error, the
review-runs directory is byte-for-byte/listing-identical, lifecycle has no
`implementation.review.completed` event, and provider logs show no invocation.
This smoke must not consume reviewer turns.

### Verification record

Record candidate commit, provider/model, command exit codes, implementation and
review run ids, durable store path, terminal lifecycle stage, and the three
reviewer statuses in the PR. Do not commit generated smoke repositories,
credentials, provider logs, or durable run artifacts.

## Skills for the executor

| Skill                    | Use                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------- |
| `typescript-refactor`    | Keep lifecycle/result types narrow and discriminated; avoid unnecessary abstractions. |
| `zod`                    | Extend strict persisted lifecycle schemas safely.                                     |
| `vitest`                 | Add focused async, lifecycle, and CLI regression tests.                               |
| `node`                   | Preserve abort/error/exit-code behavior in the Node CLI.                              |
| `change-review-workflow` | Run the final three-role implementation review and close findings.                    |

## Risks and guardrails

- **Evidence mismatch:** validate lifecycle event, run meta, run id, workspace, refs, and artifact existence together before review.
- **Accidental engine fork:** no reviewer loop or result parser outside existing `change-review` APIs.
- **Lifecycle ambiguity:** one terminal Factory event; no synthetic started/recovery states.
- **Command-file growth:** workflow logic lives in focused modules; registration stays thin.
- **Scope creep into remediation:** findings stop at `ready-for-human`.
