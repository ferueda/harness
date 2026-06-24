# Plan 260624-parallel-review-runs: Run review agents in parallel

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: perf | dx

## Why this matters

The `review` and `review-full` workflows currently run reviewers one after another. That makes wall time roughly the sum of all reviewer runtimes: two agents for `review`, three agents for `review-full`. The intended workflow model is independent reviewers looking at the same base artifacts, then harness compiles their findings. Passing prior findings from one reviewer into another was the wrong coupling and should be removed. After this plan, all reviewers in a workflow should start concurrently, use the same diff/plan/handoff context, and only meet again at aggregation/export time.

## Current state

- `workflows/review.workflow.ts` — defines the standard workflow as two reviewers:

```ts
// workflows/review.workflow.ts
export function run(ctx: WorkflowContext) {
  return runReviewSteps(ctx, "Review Summary", ["review-implementation", "code-quality-review"]);
}
```

- `workflows/review-full.workflow.ts` — defines the full workflow as three reviewers:

```ts
// workflows/review-full.workflow.ts
export function run(ctx: WorkflowContext) {
  return runReviewSteps(ctx, "Full Review Summary", [
    "review-implementation",
    "code-quality-review",
    "simplify",
  ]);
}
```

- `workflows/review-steps.ts` — currently serializes reviewers by awaiting inside a loop:

```ts
// workflows/review-steps.ts
for (const agentName of agents) {
  const reviewInfo = ctx.reviewInfo(agentName);
  reviews.push({
    key: reviewInfo.key,
    title: reviewInfo.title,
    review: await ctx.agent(agentName),
  });
}
```

- `lib/cursor-agent.ts` — currently blocks the Node process with `spawnSync`, so changing the loop to `Promise.all(...)` is not enough for real concurrency:

```ts
// lib/cursor-agent.ts
const result = spawnSync(process.execPath, args, {
  encoding: "utf8",
  env: process.env,
});
```

- `lib/workflow-context.ts` — builds prompt values for each reviewer and still injects prior review sections:

```ts
// lib/workflow-context.ts
PRIOR_REVIEW_SECTION: buildPriorReviewContext(agentName, runDir, workspace),
```

- `lib/workflow-context.ts` — `simplify` currently receives prior implementation and quality review paths if those files exist:

```ts
// lib/workflow-context.ts
if (agentName === "simplify") {
  return [
    buildPriorReviewSection(join(runDir, "implementation-review.json"), workspace, ...),
    buildPriorReviewSection(join(runDir, "quality-review.json"), workspace, ...),
  ].filter(Boolean).join("\n");
}
```

- `prompts/quality-review.md` and `prompts/simplify-review.md` include `{{PRIOR_REVIEW_SECTION}}`.
- `test/cli.test.ts` currently asserts that the simplify prompt includes prior implementation and quality review paths. Those assertions must be removed or inverted.
- `test/cursor-agent.test.ts` already covers `invokeCursorAgent(...)`; it must become async when the provider wrapper becomes async.
- `lib/workflow-context.ts` currently writes failed-run metadata inside the per-agent path via `writeFailure(...)`. That is safe for sequential execution, but unsafe once reviewers run concurrently because multiple failed reviewers could overwrite `meta.json`.
- Repo conventions:
  - TypeScript source imports local files with `.ts` extensions.
  - Source must stay compatible with Node 24 type stripping: no enums, namespaces, or parameter properties.
  - CLI behavior contracts matter: usage errors exit `2`, runtime errors exit `1`, dry-run exits `0`, passing reviews exit `0`, non-passing reviews exit `1`.
  - Gates are quiet by default through `Makefile`.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Format | `pnpm format` | exit 0 |
| Focused tests | `pnpm test -- test/cursor-agent.test.ts test/cli.test.ts test/context.test.ts test/aggregate.test.ts` | all selected tests pass |
| Typecheck | `pnpm typecheck` | exit 0, no TypeScript errors |
| Build | `pnpm build` | exit 0, `dist/` updated |
| Smoke built CLI | `pnpm smoke:dist` | exit 0 |
| Full local gate | `pnpm check` | exit 0 |
| CI gate | `pnpm check:ci` | exit 0 |

## Suggested executor toolkit

| Skill | Use for |
|-------|---------|
| `implement-plan` | Execute this plan phase by phase and update status as steps complete. |
| `typescript-refactor` | Convert synchronous process code to typed async code without breaking Node 24 type stripping or exported types. |
| `node` | Apply Node async process, timeout, error, and testing patterns around `node:child_process.spawn`. |
| `vitest` | Add deterministic async/concurrency tests without brittle timing or shared-state leakage. |
| `simplify` | Final readability pass after implementation, keeping behavior unchanged. |

## Scope

**In scope**:

- `lib/cursor-agent.ts`
- `lib/workflow-context.ts`
- `lib/context.ts`
- `workflows/review-steps.ts`
- `prompts/quality-review.md`
- `prompts/simplify-review.md`
- `skills/simplify-review/SKILL.md`
- `test/cursor-agent.test.ts`
- `test/cli.test.ts`
- `test/workflow-context.test.ts`
- `test/review-steps.test.ts` (create if a focused workflow orchestration unit test is clearer than putting these cases in CLI tests)
- `test/context.test.ts`
- `test/aggregate.test.ts` only if aggregate coverage needs a small adjustment
- `README.md`
- `bin/harness.ts` only if a failing test proves the existing exit-code behavior is insufficient
- `dev/plans/README.md`

**Out of scope**:

- Per-agent model selection.
- Workflow DAGs, queues, plugin systems, or generic workflow engines.
- User-facing concurrency flags. Parallel should become the default behavior for `review` and `review-full`.
- Automatic retry logic for failed reviewers. Retries should remain a future opt-in design, not part of this first parallel implementation.
- Changing review output schema.
- Changing run directory layout under `.harness/runs/reviews/<run-id>/`.
- Reintroducing prior-review artifact injection between reviewers.
- Adding top-level `skills/{skill}/SKILL.md` target-repo lookup; target repos use `.agents/skills`, then user `~/.agents/skills`, then packaged harness `skills`.

## Steps

### Step 1: Remove reviewer-to-reviewer prompt dependencies

Make every reviewer consume only base workflow artifacts: diff, optional plan where appropriate, optional handoff, scope metadata, and its own skill file.

Required edits:

- In `lib/workflow-context.ts`:
  - Remove the `buildPriorReviewSection` import.
  - Remove `buildPriorReviewContext(...)`.
  - Remove `PRIOR_REVIEW_SECTION` from `buildPromptValues(...)`.
- In `prompts/quality-review.md`:
  - Remove `{{PRIOR_REVIEW_SECTION}}`.
  - Keep diff and optional handoff artifacts.
- In `prompts/simplify-review.md`:
  - Remove `{{PRIOR_REVIEW_SECTION}}`.
  - Keep diff and optional handoff artifacts.
- In `skills/simplify-review/SKILL.md`:
  - Remove any instruction to read prior implementation or quality review JSON.
  - Keep the verdict contract: `needs_changes` only when at least one finding has `must_fix: true`.
  - State that this reviewer is independent and should focus on behavior-preserving simplification from the provided base artifacts.
- In `lib/context.ts` and `test/context.test.ts`:
  - Remove `buildPriorReviewSection(...)` and its tests if it has no remaining callers after this step.
- In `test/cli.test.ts`:
  - Remove assertions that `simplify-review.prompt.md` includes prior implementation or quality review paths.
  - Add assertions that `quality-review.prompt.md` and `simplify-review.prompt.md` do not contain `Prior implementation review file`, `Prior code quality review file`, or `PRIOR_REVIEW_SECTION`.
- In `README.md`:
  - Update workflow docs to say reviewers run in parallel, share the same base artifacts, and are aggregated in workflow order after completion.

**Verify**: `pnpm test -- test/cli.test.ts test/context.test.ts` → all selected tests pass.

### Step 2: Convert Cursor reviewer invocation to async process execution

Make `invokeCursorAgent(...)` actually non-blocking so multiple reviewers can run at the same time.

Required edits in `lib/cursor-agent.ts`:

- Replace `spawnSync` with `spawn` from `node:child_process`.
- Change `invokeCursorAgent(...)` to return `Promise<CursorAgentResult>`.
- Preserve the existing public result union shape:
  - `ok: true`, `review`, `envelope`, `exitCode: 0`
  - `ok: false`, `error`, optional `envelope`, `exitCode`, optional `stderr`
- Preserve the argument list currently sent to the provider wrapper:

```ts
[
  cursorAgentPath,
  "--format", "json",
  "--output-format", "json",
  "--mode", "ask",
  "--workspace", workspace,
  "--schema", schemaPath,
  "--prompt-file", promptPath,
  "--max-runtime-ms", String(maxRuntimeMs),
]
```

- Preserve `--model` when `model` is provided.
- Collect stdout and stderr chunks as strings.
- Handle child process `error` events by returning `ok: false`.
- Parse stdout exactly as today after the child closes.
- Do not add a new dependency.
- Do not change the inner Cursor wrapper in `providers/cursor/` unless a failing test proves it is required.

Required test edits:

- In `test/cursor-agent.test.ts`, make existing tests `async` and `await invokeCursorAgent(...)`.
- Add a positive test with a fake agent that emits a valid structured output and assert `ok: true`.
- Add a spawn-error style test only if it can be deterministic without relying on platform-specific shell behavior.
- In `lib/workflow-context.ts`, update the `ctx.agent(...)` caller to `await invokeCursorAgent(...)` in the same step. Do not leave a temporary state where `result.ok` is read from an unresolved `Promise`.

**Verify**: `pnpm test -- test/cursor-agent.test.ts` → all tests pass.

### Step 3: Run workflow reviewers concurrently

Change orchestration so `review` starts both reviewers immediately and `review-full` starts all three immediately.

Required edits in `workflows/review-steps.ts`:

- Replace the sequential `for` loop with concurrent task creation using `Promise.allSettled(...)`.
- Preserve output order according to the `agents` array, regardless of completion order.
- Use `ctx.reviewInfo(agentName)` for section metadata. Extend that helper to return `stage` alongside `key` and `title` so failed-review metadata can be built deterministically without a second lookup helper.
- Return failed workflow metadata instead of throwing when one or more reviewer provider calls fail. This is an intentional CLI contract change: provider failures should still print JSON to stdout, with `status: "failed"`, while the CLI exits `1`.
- Recommended shape:

```ts
type ReviewTaskSuccess = ReviewSection;
type ReviewTaskFailure = { key: string; stage: string; error: string };

const results = await Promise.allSettled(
  agents.map(async (agentName) => {
    const reviewInfo = ctx.reviewInfo(agentName);
    return {
      key: reviewInfo.key,
      title: reviewInfo.title,
      review: await ctx.agent(agentName),
    };
  }),
);

const reviews: ReviewSection[] = [];
const failedReviews: ReviewTaskFailure[] = [];

for (const [index, result] of results.entries()) {
  const agentName = agents[index];
  const reviewInfo = ctx.reviewInfo(agentName);

  if (result.status === "fulfilled") {
    reviews.push(result.value);
    continue;
  }

  failedReviews.push({
    key: reviewInfo.key,
    stage: reviewInfo.stage,
    error: result.reason instanceof Error ? result.reason.message : String(result.reason),
  });
}

if (failedReviews.length > 0) {
  return ctx.exportFailed({ title, reviews, failedReviews });
}
```

- The exact helper shape can differ, but the implementation must use index-aligned handling so a rejected task maps back to the correct `agents[index]`.
- Keep `failedReviews` small: `{ key, stage, error }`. Do not store redundant title or agent-name fields unless a test proves a consumer needs them.
- A provider failure must not produce `status: "completed"`, but successful peer reviews from the same run must still be preserved in run artifacts and metadata.

Required edits in `lib/workflow-context.ts`:

- Update `ctx.agent(...)` to `await invokeCursorAgent(...)`.
- Remove `writeFailure(...)` from the per-agent path. `ctx.agent(...)` should write only per-agent artifacts:
  - prompt file before invocation
  - raw file after invocation, including failed provider envelopes/errors
  - structured review JSON only on successful validated reviewer output
- On provider failure, `ctx.agent(...)` should throw an `Error` after writing the per-agent raw failure artifact. It must not write `meta.json`.
- Confirm distinct prompt/review/raw file names per agent remain unchanged:
  - implementation: `implementation-review.*`
  - quality: `quality-review.*`
  - simplify: `simplify-review.*`
- Keep dry-run behavior deterministic. Dry-run may still write placeholder review JSON files, but no prompt should depend on those placeholder files.
- Add `exportFailed({ title, reviews, failedReviews })` to `createWorkflowContext()` and to the `WorkflowContext` type. Keep persistence in `workflow-context.ts`; do not inline final metadata writes in `runReviewSteps`.
- `exportFailed(...)` must write one final `meta.json` after all reviewers settle, and must also write `summary.md`.
- Failed `summary.md` should include successful review sections in workflow order plus a `## Failed reviewers` section with each failed review's `key`, `stage`, and `error`.
- Implement failed-summary rendering in `lib/aggregate.ts`, preferably with a dedicated `renderFailedSummary(...)` helper next to `renderSummary(...)`. Keep markdown rendering out of `workflow-context.ts`.
- The failed summary may show an aggregate verdict line as `**failed**`, or omit the aggregate verdict line, but it must clearly include the failed reviewer section.
- `exportFailed(...)` must handle zero successful reviews. In that case, `reviews` should serialize as `{}` and `summary.md` should still be written with only the failed reviewer details.
- Failed `meta.json` must mirror the successful export's base run fields:
  - `runId`
  - `status: "failed"`
  - `workspace`
  - `scope`
  - `startedAt`
  - `durationMs`
  - `reviews`
  - `failedReviews`
- Do not include a workflow `verdict` on provider-failed runs.
- Include top-level review summary keys, such as `implementationReview`, `qualityReview`, and `simplifyReview`, only for successful peer reviews that actually produced validated output.
- No `bin/harness.ts` change is expected for the exit-code contract. The existing CLI behavior treats anything other than `meta.verdict === "pass"` or `meta.status === "dry_run"` as exit `1`. Add or adjust a test only if that behavior regresses.
- Update README to document that provider failures print JSON with `status: "failed"` to stdout and exit `1`.

Required tests in `test/cli.test.ts`:

- Add a provider-failure test:
  - Use a prompt-aware fake agent that branches on `--prompt-file` basename.
  - Return valid JSON for a prompt such as `implementation-review.prompt.md`.
  - Return invalid JSON or invalid structured output for a prompt such as `quality-review.prompt.md`.
  - Assert the CLI exits `1`.
  - Assert stdout is parseable JSON with `status: "failed"`.
  - Assert `meta.json` has `status: "failed"`.
  - Assert `meta.json` includes base run fields: `runId`, `workspace`, `scope`, `startedAt`, and `durationMs`.
  - Assert `meta.json` includes `failedReviews` entries shaped as `{ key, stage, error }`.
  - Assert any successful peer review summaries are still present.
  - Assert raw failure artifacts are still written for the failed reviewer.

Required tests in `test/review-steps.test.ts` or another focused workflow unit test:

- Create a mock `WorkflowContext` where `agent(name)` records the started agent name and returns a manually controlled deferred promise.
- Assert `runReviewSteps(...)` starts both `review` agents before any deferred promise is resolved.
- Assert `runReviewSteps(...)` starts all three `review-full` agents before any deferred promise is resolved.
- Assert successful reviews are passed to export in workflow order even when promises resolve out of order.
- Assert rejected reviewer promises are converted to `exportFailed(...)` input after all agents settle.
- Add an all-reviewers-fail case, or cover it directly in `test/workflow-context.test.ts`, so `exportFailed(...)` is proven to support `reviews: []`.

Use this unit test as the primary concurrency proof. Avoid CLI wall-clock timing tests unless a later regression requires them.

**Verify**: `pnpm test -- test/cli.test.ts test/review-steps.test.ts test/workflow-context.test.ts` → all selected tests pass.

### Step 4: Preserve aggregate/export behavior and partial failure artifacts

Confirm the parallel implementation still produces the same completed-run contract for successful reviewer executions.

Expected completed output for `review`:

```json
{
  "status": "completed",
  "verdict": "pass | needs_changes | blocked",
  "implementationReview": { "verdict": "...", "findingCount": 0 },
  "qualityReview": { "verdict": "...", "findingCount": 0 },
  "reviews": {
    "implementation": { "verdict": "...", "findingCount": 0 },
    "codeQuality": { "verdict": "...", "findingCount": 0 }
  }
}
```

Expected completed output for `review-full` additionally includes:

```json
{
  "simplifyReview": { "verdict": "...", "findingCount": 0 },
  "reviews": {
    "simplify": { "verdict": "...", "findingCount": 0 }
  }
}
```

Required checks:

- Existing pass/fail CLI tests still pass.
- `summary.md` still renders review sections in workflow order, not completion order.
- `meta.json` still has the same success shape.
- A reviewer returning structured `needs_changes` is not a provider failure; the workflow should complete with `status: "completed"` and CLI exit `1`.
- A reviewer provider failure is different from a valid `needs_changes` review:
  - `status` must be `"failed"`, not `"completed"`.
  - CLI exit must be `1`.
  - Successful peer reviews from the same parallel run must still appear in `reviews`.
  - `summary.md` must still be written and include both successful review sections and a `Failed reviewers` section.
  - Failed reviewer details must appear in a dedicated field shaped as `{ key, stage, error }`, for example:

```json
{
  "status": "failed",
  "runId": "20260624-120000-000000",
  "workspace": "/absolute/workspace/path",
  "scope": { "...": "..." },
  "startedAt": "2026-06-24T12:00:00.000Z",
  "durationMs": 1234,
  "failedReviews": [
    {
      "key": "codeQuality",
      "stage": "quality",
      "error": "Invalid reviewer structured output: findings: Required"
    }
  ],
  "reviews": {
    "implementation": { "verdict": "pass", "findingCount": 0 }
  },
  "implementationReview": { "verdict": "pass", "findingCount": 0 }
}
```

- Do not retry failed reviewers automatically. Automatic retries can hide prompt/schema/provider bugs, increase cost unpredictably, and should be designed later as an explicit opt-in command or flag.

**Verify**: `pnpm test -- test/aggregate.test.ts test/cli.test.ts` → all selected tests pass.

### Step 5: Build and smoke the installable runtime

Because harness is installable and package `bin` points to `dist/bin/harness.js`, verify the built JavaScript path.

Required checks:

- `pnpm build`
- `pnpm smoke:dist`
- Confirm `scripts/smoke-dist.ts` still covers:
  - `harness --help`
  - `harness run review --dry-run`
  - `harness run review-full --dry-run`

If `smoke-dist` assumes prior review prompt content, update it to assert only prompt paths and dry-run metadata.

**Verify**: `pnpm build && pnpm smoke:dist` → exit 0.

### Step 6: Final validation and dogfood

Run the repo gates:

```bash
pnpm check
pnpm check:ci
```

Expected: both commands exit 0. Output should stay quiet unless something fails.

Optional dogfood after checks pass:

```bash
node bin/harness.ts run review \
  --workspace . \
  --base main \
  --head HEAD
```

Expected: command completes and writes a run artifact under `.harness/runs/reviews/<run-id>/`. The verdict may be `pass` or `needs_changes` depending on reviewer findings; if it returns `needs_changes`, inspect must-fix findings before proceeding.

## Test plan

- `test/cursor-agent.test.ts`
  - Convert existing invalid structured-output test to async.
  - Add valid structured-output async test.
- `test/cli.test.ts`
  - Remove assertions that prompts include prior review file references.
  - Add assertions that quality/simplify prompts are independent.
  - Add provider-failure CLI contract tests for JSON stdout, failed `meta.json`, failed `summary.md`, partial successful reviews, and raw failed-review artifacts.
  - Keep existing pass/fail workflow tests.
- `test/review-steps.test.ts` (create)
  - Add the primary concurrency tests with a mock `WorkflowContext`.
  - Assert start-before-first-resolution behavior for 2-agent and 3-agent workflows.
  - Assert workflow-order export and partial-failure export.
- `test/workflow-context.test.ts`
  - Add focused failed export tests if the `exportFailed(...)` shape is easiest to verify directly there.
- `test/context.test.ts`
  - Remove `buildPriorReviewSection` coverage if the helper is removed.
- `test/aggregate.test.ts`
  - Keep existing aggregate behavior tests. Add only if a behavior gap appears during implementation.

## Done criteria

All must hold:

- [x] `lib/cursor-agent.ts` no longer uses `spawnSync` for reviewer execution.
- [x] `invokeCursorAgent(...)` returns a `Promise<CursorAgentResult>` and all callers await it.
- [x] `workflows/review-steps.ts` starts all reviewers concurrently with `Promise.allSettled(...)` and preserves output order for successful reviews.
- [x] `ctx.agent(...)` no longer writes final failed-run metadata; final `meta.json` is written once after all reviewer tasks settle.
- [x] Provider failures return JSON-shaped stdout with `status: "failed"` and CLI exit `1`.
- [x] Provider failures produce `status: "failed"` metadata with `failedReviews` and partial successful review summaries.
- [x] Failed runs also write `summary.md` with successful review sections and failed reviewer details.
- [x] Valid reviewer `needs_changes` outputs still produce `status: "completed"` with workflow verdict `needs_changes`.
- [x] No automatic retry mechanism is added.
- [x] `quality-review` and `simplify-review` prompts no longer include prior review JSON paths.
- [x] `skills/simplify-review/SKILL.md` no longer instructs agents to read prior review JSON.
- [x] `pnpm test -- test/cursor-agent.test.ts test/cli.test.ts test/context.test.ts test/aggregate.test.ts test/review-steps.test.ts test/workflow-context.test.ts` exits 0.
- [x] `pnpm check` exits 0.
- [x] `pnpm check:ci` exits 0.
- [x] `git status --short` shows only expected files from this plan before commit.
- [x] `dev/plans/README.md` includes this plan with status `todo` before implementation and is updated as execution progresses.

## STOP conditions

Stop and report back if:

- Cursor CLI or the provider wrapper cannot safely run multiple concurrent `agent -p` sessions in the same workspace.
- Deferred-promise concurrency unit tests fail to prove start-before-resolve behavior after one fix attempt.
- Partial failed-run metadata requires changing the review output schema or redesigning successful `meta.json` shape.
- The implementation appears to require a workflow DAG, queue, worker pool, or config system.
- A retry mechanism appears necessary to make parallel reviews usable; stop and report instead of adding retries inside this plan.
- Removing prior-review prompt sections breaks a test or consumer in a way that implies a hidden required dependency.
- Node 24 type stripping rejects the async process implementation.

## Maintenance notes

- Future per-agent model selection should compose with this design by resolving each agent's model before launching concurrent tasks.
- If skip-step or run-one-step support is added later, keep `runReviewSteps(...)` accepting an explicit agent list and preserving that list's output order.
- Reviewers should scrutinize concurrency tests for timing brittleness and prompt tests for accidental reintroduction of prior-review coupling.
- Failed-run metadata should preserve partial successful reviews, but retry policy is deliberately deferred. A future command such as `harness rerun --run-dir <path> --failed-only` can use these artifacts without making first-run behavior unpredictable.
