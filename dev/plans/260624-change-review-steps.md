# Plan 260624-change-review-steps: Replace review workflows with caller-selected change-review steps

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report - do not improvise.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: dx

## Why this matters

Harness currently has two review workflow commands: `review` runs implementation plus quality, and `review-full` runs implementation plus quality plus simplify. In multi-cycle reviews this forces callers to rerun already-passing reviewers when only one pass still needs attention, which wastes agent time and makes review cycles noisy. The target model is one primary workflow, `change-review`, with stable step IDs and an explicit `--steps` option so callers choose exactly which passes run. This is intentionally a breaking cleanup: do not keep compatibility aliases or fallbacks for `review` and `review-full`.

## Current state

- `bin/harness.ts` registers two review commands today:

```ts
// bin/harness.ts:96-106
const run = program.command("run").description("Run a harness workflow");
addReviewCommand(run, {
  name: "review",
  description: "Run implementation and code-quality reviewers",
  workflow: runReview,
});
addReviewCommand(run, {
  name: "review-full",
  description: "Run implementation, code-quality, and simplify reviewers",
  workflow: runReviewFull,
});
```

- `bin/harness.ts` has no step-selection option in `ReviewOptions` or `addReviewCommand`:

```ts
// bin/harness.ts:24-36
type ReviewOptions = {
  workspace?: string;
  base?: string;
  head?: string;
  plan?: string;
  handoff?: string;
  handoffStdin?: boolean;
  runsDir?: string;
  cursorAgent?: string;
  model?: string;
  maxRuntimeMs: number;
  dryRun: boolean;
};
```

- `workflows/review.workflow.ts` and `workflows/review-full.workflow.ts` encode two different fixed lists:

```ts
// workflows/review.workflow.ts:6-7
export function run(ctx: WorkflowContext) {
  return runReviewSteps(ctx, "Review Summary", ["review-implementation", "code-quality-review"]);
}

// workflows/review-full.workflow.ts:6-11
export function run(ctx: WorkflowContext) {
  return runReviewSteps(ctx, "Full Review Summary", [
    "review-implementation",
    "code-quality-review",
    "simplify",
  ]);
}
```

- `workflows/review-steps.ts` accepts agent names, not user-facing step IDs, and starts every provided agent concurrently:

```ts
// workflows/review-steps.ts:27-44
export async function runReviewSteps(
  ctx: WorkflowContext,
  title: string,
  agents: ReviewAgentName[],
): Promise<WorkflowRunMeta> {
  const reviewTasks = agents.map((agentName) => ({
    agentName,
    ...ctx.reviewInfo(agentName),
  }));
  const results = await Promise.allSettled(
    reviewTasks.map(async ({ agentName, key, title: reviewTitle }) => {
      return {
        key,
        title: reviewTitle,
        review: await ctx.agent(agentName),
      };
    }),
  );
```

- `lib/workflow-context.ts` already maps internal agent names to stable user-facing-ish stages and summary keys. Preserve the existing artifact filenames and review JSON keys unless this plan explicitly says otherwise:

```ts
// lib/workflow-context.ts:78-111
const AGENTS = {
  "review-implementation": {
    skillName: "review-implementation",
    title: "Implementation review",
    summaryKey: "implementation",
    promptFile: "implementation-review.prompt.md",
    reviewFile: "implementation-review.json",
    rawFile: "implementation-review.raw.json",
    stage: "implementation",
  },
  "code-quality-review": {
    skillName: "code-quality-review",
    title: "Code quality review",
    summaryKey: "codeQuality",
    promptFile: "quality-review.prompt.md",
    reviewFile: "quality-review.json",
    rawFile: "quality-review.raw.json",
    stage: "quality",
  },
  simplify: {
    skillName: "simplify-review",
    title: "Simplify review",
    summaryKey: "simplify",
    promptFile: "simplify-review.prompt.md",
    reviewFile: "simplify-review.json",
    rawFile: "simplify-review.raw.json",
    stage: "simplify",
  },
};
```

- `lib/workflow-context.ts` writes run metadata without workflow or step-selection fields:

```ts
// lib/workflow-context.ts:214-228
const reviewSummaries = buildReviewSummaries(input.reviews);
const baseMeta = {
  runId,
  workspace,
  scope: scopeMeta,
  startedAt: startedAtIso,
  durationMs,
  ...buildTopLevelReviewFields(reviewSummaries),
  reviews: reviewSummaries,
};
const meta =
  input.status === "completed"
    ? { ...baseMeta, status: "completed", verdict: input.verdict }
    : { ...baseMeta, status: "failed", failedReviews: input.failedReviews };
```

- `lib/config.ts` still makes repo-local shims recommend the old workflow:

```ts
// lib/config.ts:6-9
const CONFIG_FILE = "harness.json";
export const HARNESS_GITIGNORE_ENTRY = ".harness/";
export const HARNESS_SHIM_RELATIVE_PATH = ".harness/bin/harness";
export const HARNESS_RECOMMENDED_COMMAND = `${HARNESS_SHIM_RELATIVE_PATH} run review`;
```

- Tests currently assert old command help and behavior in `test/cli.test.ts`, including `harness run review`, `harness run review-full`, dry-run prompts, and review-full pass/fail behavior.
- `skills/change-review-workflow/SKILL.md` and `.agents/skills/change-review-workflow/SKILL.md` are currently identical and teach `review`/`review-full`. Keep them in sync; `test/skills.test.ts` checks sync.
- `skills/simplify-review/SKILL.md` and `skills/simplify-review/agents/openai.yaml` mention `review-full`; update this wording to `change-review`.
- Repo convention: TypeScript source is ESM with `.ts` import extensions and type-only imports where needed. Node 24 type stripping is supported; avoid enums, namespaces, and parameter properties.
- Repo verification uses `pnpm check`, which runs format check, lint, strict typecheck, Vitest, build, and dist smoke test through `Makefile`.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Install | `pnpm install --frozen-lockfile` | exit 0 |
| Focused tests | `pnpm vitest run test/review-steps.test.ts test/cli.test.ts test/aggregate.test.ts test/workflow-context.test.ts test/skills.test.ts test/config.test.ts` | exit 0, all selected tests pass |
| Full gate | `pnpm check` | exit 0; format, lint, typecheck, tests, build, and smoke-dist pass |
| CLI help smoke | `node bin/harness.ts run change-review --help` | exit 0 and prints `harness run change-review` plus `--steps` |

## Suggested executor toolkit

| Skill | Use it for |
| --- | --- |
| `implement-plan` | Execute this plan phase by phase; update checkboxes as work completes. |
| `node` | Maintain Node 24 type-stripping compatibility: `.ts` imports, type-only imports, no non-erasable TypeScript syntax. |
| `typescript-refactor` | Design the step ID types and selection helpers without unsafe casts or over-broad unions. |
| `vitest` | Add and update focused CLI/workflow tests with isolated temp workspaces and deterministic assertions. |
| `change-review-workflow` | After implementation, run the new `change-review` workflow against the branch and triage findings. |

## Scope

**In scope**:

- `bin/harness.ts`
- `lib/config.ts`
- `lib/workflow-context.ts`
- `lib/aggregate.ts`
- `lib/review-prompts.ts`
- `install`
- `scripts/smoke-dist.ts`
- `workflows/review-steps.ts`
- `workflows/change-review.workflow.ts` (create)
- `workflows/review.workflow.ts` (delete)
- `workflows/review-full.workflow.ts` (delete)
- `README.md`
- `AGENTS.md`
- `skills/change-review-workflow/SKILL.md`
- `.agents/skills/change-review-workflow/SKILL.md`
- `skills/change-review-workflow/references/review-handoff.md`
- `.agents/skills/change-review-workflow/references/review-handoff.md`
- `skills/simplify-review/SKILL.md`
- `skills/simplify-review/agents/openai.yaml`
- Tests under `test/` that cover CLI, workflow steps, aggregation output, workflow context metadata, config recommended command, and skill sync.
- `dev/plans/README.md` status update for this plan.

**Out of scope**:

- No compatibility aliases or fallback commands for `review` or `review-full`.
- No automatic reuse, caching, resume, previous-run lookup, or "passed reviewers" inference.
- No generic workflow engine rewrite beyond the small step-selection model needed for this review workflow.
- No artifact directory rename; keep `.harness/runs/reviews` for this change.
- No review output schema changes for individual reviewer JSON files.
- No provider changes under `providers/`.

## Target behavior

- `harness run change-review` runs all three steps: `implementation`, `quality`, `simplify`.
- `harness run change-review --steps implementation` runs only implementation.
- `harness run change-review --steps implementation,quality` runs implementation then quality, even if the user lists them in another order.
- `--steps` uses workflow step IDs, not internal agent names.
- Valid step IDs are exactly `implementation`, `quality`, and `simplify`.
- Duplicate step IDs are normalized; `--steps implementation,implementation` runs implementation once.
- Empty `--steps`, whitespace-only `--steps`, and unknown step IDs fail before creating expensive provider work. Error text must list valid IDs.
- `harness run review` and `harness run review-full` no longer exist. Commander should fail them as unknown commands.
- Run metadata records step selection:

```json
{
  "workflow": "change-review",
  "availableSteps": ["implementation", "quality", "simplify"],
  "requestedSteps": ["implementation"],
  "executedSteps": ["implementation"],
  "omittedSteps": ["quality", "simplify"],
  "partial": true
}
```

- For default runs, `requestedSteps` should either be omitted or equal all available steps. Prefer equal all available steps because it is easier for callers to inspect.
- Dry-run metadata must include the same workflow/step fields.
- Summary markdown should not imply omitted steps passed. It should show a short step section when any step is omitted.
- Failed-run summary markdown must follow the same rule. If a partial run has one selected reviewer fail or provider-fail, `summary.md` must still show which steps were executed and which were omitted.

## Steps

### Step 1: Replace fixed review workflows with `change-review`

Create `workflows/change-review.workflow.ts`. It should export one workflow named `change-review` and default to all three step IDs. Delete `workflows/review.workflow.ts` and `workflows/review-full.workflow.ts`.

Use step IDs in the workflow surface:

```ts
export const CHANGE_REVIEW_STEPS = ["implementation", "quality", "simplify"] as const;
export type ChangeReviewStepId = (typeof CHANGE_REVIEW_STEPS)[number];
```

Map step IDs to existing internal agents in one place, likely `workflows/review-steps.ts`:

```ts
const REVIEW_STEP_AGENTS = {
  implementation: "review-implementation",
  quality: "code-quality-review",
  simplify: "simplify",
} satisfies Record<ChangeReviewStepId, ReviewAgentName>;
```

Keep `runReviewSteps` concurrent for the selected steps. Do not serialise reviewers.

**Verify**: `pnpm vitest run test/review-steps.test.ts` -> exit 0 after tests are updated in Step 5.

### Step 2: Add CLI `change-review --steps`

In `bin/harness.ts`, remove imports for `review.workflow.ts` and `review-full.workflow.ts`, import `change-review.workflow.ts`, and register only:

```bash
harness run change-review
```

Add a `--steps <ids>` option to this command. Parse comma-separated values, trim whitespace, reject empty values, and pass the selected IDs to the workflow. Keep existing options: `--workspace`, `--base`, `--head`, `--plan`, `--handoff`, `--handoff-stdin`, `--runs-dir`, `--cursor-agent`, `--model`, `--max-runtime-ms`, and `--dry-run`.

Prefer a small parser function near `positiveNumber`, for example:

```ts
function parseStepList(value: string): string[] {
  const steps = value.split(",").map((step) => step.trim()).filter(Boolean);
  if (steps.length === 0) throw new InvalidArgumentError("must include at least one step");
  return steps;
}
```

Let the workflow-level validation produce the valid-ID message if a non-empty unknown step appears.

Use this concrete wiring pattern unless code drift makes it impossible:

1. Add `steps?: string[]` to `ReviewOptions`.
2. In `addReviewCommand`, parse `--steps <ids>` with Commander before the action receives `options`.
3. Keep `createWorkflowContext(...)` focused on repo/context/provider options; do not put raw CLI step strings into context construction.
4. Change the workflow function shape for this workflow to accept selected steps separately, for example `workflow(ctx, { steps: options.steps })`.
5. Validate and normalize `options.steps` inside `workflows/change-review.workflow.ts` or a helper it owns, then pass normalized step metadata into `runReviewSteps`.

**Verify**: `node bin/harness.ts run change-review --help` -> exit 0, help includes `harness run change-review` and `--steps`.

### Step 3: Record workflow and step metadata

Extend the workflow/context path so `meta.json` and stdout include workflow fields for completed, failed, and dry-run outputs:

- `workflow: "change-review"`
- `availableSteps: ["implementation", "quality", "simplify"]`
- `requestedSteps`
- `executedSteps`
- `omittedSteps`
- `partial: boolean`

The cleanest small change is to pass a `workflow` or `stepSelection` object through `runReviewSteps` into `ctx.export` / `ctx.exportFailed`, then have `createWorkflowContext` include it in `baseMeta` and dry-run meta. Keep this typed; avoid `[key: string]: unknown` as the main contract for new fields.

Update `lib/aggregate.ts` to include step metadata in `summary.md` for both completed and failed runs. Prefer a shared helper used by both `renderSummary` and `renderFailedSummary`, so failed partial runs cannot omit the step information. Use a short section near the header:

```md
## Steps

- Available: `implementation`, `quality`, `simplify`
- Executed: `implementation`
- Omitted: `quality`, `simplify`
```

Only include `Omitted` when non-empty. Do not render omitted steps as reviewer sections.

**Verify**: `pnpm vitest run test/aggregate.test.ts test/workflow-context.test.ts` -> exit 0.

### Step 4: Update config, docs, and packaged skills

Update `lib/config.ts`:

```ts
export const HARNESS_RECOMMENDED_COMMAND = `${HARNESS_SHIM_RELATIVE_PATH} run change-review`;
```

Update `scripts/smoke-dist.ts` because `pnpm check` runs `make smoke-dist` after build:

- Change `EXPECTED_RECOMMENDED_COMMAND` to `.harness/bin/harness run change-review`.
- Replace `run review` dry-runs with `run change-review`.
- Replace `run review-full` dry-runs with default `run change-review`, because default `change-review` now covers all three steps.
- Keep smoke assertions that implementation, quality, and simplify prompt paths exist for the default workflow.
- Add one selected-step smoke if it stays concise: `run change-review --steps implementation --dry-run` should include implementation prompt metadata and omit quality/simplify prompt metadata.

Update `install` so the final "Next" command prints `harness run change-review`.

Update `AGENTS.md` so repo instructions describe `change-review` instead of `review-full`.

Update `README.md`:

- Install quickstart should use `harness run change-review`.
- First workflow section should teach one workflow and default all three steps.
- Add examples:
  - `harness run change-review`
  - `harness run change-review --steps implementation`
  - `printf '%s\n' "$HANDOFF" | harness run change-review --handoff-stdin`
- Remove `review-full` as a separate workflow concept.
- Update source iteration example to `node bin/harness.ts run change-review`.

Update both copies of `change-review-workflow`:

- `skills/change-review-workflow/SKILL.md`
- `.agents/skills/change-review-workflow/SKILL.md`
- `skills/change-review-workflow/references/review-handoff.md`
- `.agents/skills/change-review-workflow/references/review-handoff.md`

The skill should say default command is `change-review`, and callers can use `--steps implementation`, `--steps quality`, or `--steps implementation,quality` when intentionally rerunning selected passes. It should not mention `review-full`.

Update simplify-review wording:

- `skills/simplify-review/SKILL.md`: replace "used by the `review-full` workflow" with "used by the `change-review` workflow".
- `skills/simplify-review/agents/openai.yaml`: replace "harness review-full" in the short description.

Update runtime reviewer prompts:

- `lib/review-prompts.ts`: replace the simplify prompt wording "review-full workflow" with `change-review` workflow or generic "review workflow".

**Verify**: `rg -n "review-full|harness run review|run review\\b|Full Review Summary|Review Summary" README.md skills .agents/skills bin lib workflows scripts test` -> no stale runtime/docs references except deliberate test assertions that old commands fail.

### Step 5: Update tests for the breaking command change

Update tests to match the new model.

In `test/review-steps.test.ts`:

- Replace old agent-list tests with step-selection tests.
- Assert default change-review starts `review-implementation`, `code-quality-review`, and `simplify`.
- Assert selected steps start only selected agents.
- Assert selected steps are executed in workflow order, not caller order.
- Assert duplicate selected steps run once.
- Assert unknown step rejects with valid IDs.

In `test/cli.test.ts`:

- Replace help tests with `harness run change-review --help`.
- Add tests that `harness run review --help` and `harness run review-full --help` exit non-zero because there is no compatibility fallback.
- Update dry-run tests to `change-review`.
- Add dry-run selected-step test: `--steps implementation` writes only implementation prompt/review artifacts and metadata has `partial: true`, `executedSteps: ["implementation"]`, `omittedSteps: ["quality", "simplify"]`.
- Add invalid `--steps unknown` test.
- Update pass/fail tests: default `change-review` includes all three reviews.
- Add or update a CLI/provider-failure test for a selected-step run so failed metadata and failed `summary.md` still include workflow/step fields and do not imply omitted steps passed.

In `test/config.test.ts`:

- Update expected `recommendedCommand` to `.harness/bin/harness run change-review`.

In `scripts/smoke-dist.ts`:

- Keep the smoke test aligned with the new command names so `pnpm check` can pass after the build.

In `test/skills.test.ts`:

- Existing sync test should keep passing after both copies of `change-review-workflow` are updated.

**Verify**: `pnpm vitest run test/review-steps.test.ts test/cli.test.ts test/config.test.ts test/skills.test.ts` -> exit 0.

### Step 6: Run full repo gate and update this plan status

Run the full gate:

```bash
pnpm check
```

Expected result: exit 0.

If the code is complete, update this plan's status in `dev/plans/README.md` from `planned` to `done`. If executing in phases and stopping before completion, leave the status as `in_progress` and update the plan with completed checkboxes or notes.

**Verify**: `git status --short` -> only intended source/docs/test/plan files are modified.

## Test plan

- `test/review-steps.test.ts`: unit tests for step normalization, validation, workflow-order execution, duplicate handling, selected-step execution, and failed selected reviewers.
- `test/cli.test.ts`: CLI help, dry-run, selected steps, old command rejection, invalid step validation, provider pass/fail behavior.
- `test/aggregate.test.ts`: summary renders step metadata and omits omitted reviewer sections.
- `test/workflow-context.test.ts`: metadata includes workflow/step fields for completed, failed, and dry-run paths.
- `test/config.test.ts`: init recommended command uses `change-review`.
- `test/skills.test.ts`: packaged and local change-review-workflow skill copies remain in sync.

## Done criteria

- [x] `harness run change-review` is the only review workflow command.
- [x] `harness run review` and `harness run review-full` are removed, not aliases.
- [x] `--steps` runs exactly the caller-selected step subset in workflow order.
- [x] Invalid or empty step selection fails before provider execution and lists valid step IDs.
- [x] Metadata and summary distinguish executed steps from omitted steps.
- [x] Completed, failed, and dry-run outputs all include workflow/step metadata.
- [x] README, packaged skills, local development skill copy, and simplify-review metadata use `change-review`.
- [x] `lib/config.ts` recommends `.harness/bin/harness run change-review`.
- [x] `scripts/smoke-dist.ts` uses `change-review` and passes as part of `pnpm check`.
- [x] Focused tests pass: `pnpm vitest run test/review-steps.test.ts test/cli.test.ts test/aggregate.test.ts test/workflow-context.test.ts test/skills.test.ts test/config.test.ts`.
- [x] Full gate passes: `pnpm check`.
- [x] `dev/plans/README.md` status row updated.

## STOP conditions

Stop and report back if:

- The current code no longer has `review.workflow.ts`, `review-full.workflow.ts`, or the `addReviewCommand` shape shown in this plan.
- A compatibility requirement for `review` or `review-full` reappears. This plan intentionally removes them; do not silently add aliases.
- Implementing `--steps` appears to require a generic workflow engine rewrite. Keep this scoped to change-review.
- A provider contract requires internal agent names on the CLI. The user-facing CLI must expose step IDs, not `review-implementation` or `code-quality-review`.
- Any verification command fails twice after a reasonable fix attempt.

## Maintenance notes

- Future workflows can reuse the `--steps` concept, but this plan should not generalize the full workflow engine prematurely.
- Reviewers should scrutinize command removal and docs consistency: stale `review-full` references will confuse agents.
- Reviewers should check that omitted steps are never presented as passed.
- If a future cycle feature adds reuse/caching, it should build on these explicit step IDs and metadata instead of resurrecting `review` vs `review-full`.
