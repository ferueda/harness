# Plan 260630-plan-review-workflow: Add first-class plan review runs

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

Planning currently has a manual feedback loop: create a plan, ask another agent
to run `review-spec`, triage findings, edit the plan, and repeat. Harness
already has durable review artifacts, structured review output, provider
selection, events, dry runs, and summaries for code review. This plan adds the
smallest first-class executable workflow for plan review without automating plan
edits or broader requirements review.

The result should be:

```bash
harness run plan-review --plan dev/plans/260630-plan-review-workflow.md --verbose
```

That command runs one read-only `review-spec` pass against the plan and current
repo, writes normal harness run artifacts, and exits nonzero when the plan needs
changes.

## Current state

Relevant files and roles:

- `workflows/change-review.workflow.ts` - existing executable review workflow.
  It maps step ids to review agents and wraps `runReviewSteps` with run start/end
  events.
- `workflows/review-steps.ts` - reusable executor for one or more read-only
  review steps. It already handles parallel/serial execution, step events,
  failed reviewers, aggregation, and export.
- `lib/workflow-context.ts` - hardcoded review runtime context. It owns reviewer
  configs, prompt generation, schema validation, run artifacts, summaries, and
  provider invocation.
- `lib/aggregate.ts` - review verdict aggregation and Markdown summary
  rendering. Summary headers currently require git diff scope.
- `lib/workflow-events.ts` - event shape plus `STEP_ID_BY_AGENT`, currently
  closed over the three change-review reviewer identities.
- `bin/harness.ts` - CLI entrypoint. It exposes `harness run change-review` via a
  change-review-specific command builder.
- `schemas/review-output.schema.json` - structured reviewer output contract:
  `verdict`, `summary`, and `findings[]` with `must_fix`.
- `skills/review-spec/SKILL.md` - current human/chat skill definition for spec
  review against codebase reality.

Current code facts:

- `workflows/change-review.workflow.ts:7-18` defines only
  `implementation`, `quality`, and `simplify` steps mapped to
  `review-implementation`, `code-quality-review`, and `simplify`.
- `workflows/change-review.workflow.ts:20-67` emits workflow-level events and
  delegates all reviewer execution to `runReviewSteps`.
- `workflows/review-steps.ts:21-43` defines the reusable `WorkflowContext`
  interface. It is generic over review steps but uses `ReviewAgentName` from
  `lib/workflow-context.ts`.
- `workflows/review-steps.ts:49-92` already handles review execution,
  aggregation, and failed reviewer preservation.
- `workflows/review-steps.ts:101-167` emits step start/heartbeat/end events and
  derives output filenames from each review stage.
- `lib/workflow-context.ts:49-68` requires `baseRef` and `headRef` in
  `WorkflowRunOptions`.
- `lib/workflow-context.ts:118-149` hardcodes exactly three reviewer configs.
- `lib/workflow-context.ts:160-205` always prepares git scope and always writes a
  diff artifact.
- `lib/workflow-context.ts:258-301` always passes `scope` into summary/meta
  export.
- `lib/workflow-context.ts:453-475` always renders diff prompt values, and only
  includes the plan reference for `review-implementation`.
- `lib/aggregate.ts:42-58` requires `ReviewScope` in the summary header input.
- `lib/aggregate.ts:130-143` always prints `Scope` and `Head SHA` lines.
- `lib/workflow-events.ts:6` and `lib/workflow-events.ts:33-37` only know the
  three change-review reviewer names.
- `bin/harness.ts:155-160` registers only `change-review`.
- `bin/harness.ts:218-327` exposes a command builder with `--base`, `--head`,
  `--steps`, and optional `--plan`; that shape is wrong for `plan-review`.
- `lib/config.ts:63-89` resolves workspace, agent provider, model, and default
  git refs. `plan-review` should reuse workspace/agent resolution but must not
  run git scope preparation.
- `schemas/review-output.schema.json:1-42` is suitable for plan review:
  `pass`, `needs_changes`, or `blocked`; findings carry severity, location,
  issue, recommendation, rationale, and `must_fix`.
- `skills/review-spec/SKILL.md:8-17` defines the review process; lines 19-30
  define review dimensions; lines 48-55 require code verification, specificity,
  prioritization, and smaller plans.

Repo conventions to match:

- TypeScript imports use `.ts` extensions and `import type` for type-only imports,
  e.g. `workflows/change-review.workflow.ts:1-3`.
- Config-like maps use `as const` or `satisfies`, e.g.
  `workflows/change-review.workflow.ts:7-18` and
  `lib/workflow-events.ts:33-37`.
- CLI tests use `runHarness([...])` and JSON stdout assertions, e.g.
  `test/cli.test.ts:679-708`.
- Workflow context tests create temporary workspaces and fake providers, e.g.
  `test/workflow-context.test.ts:115-143`.
- Event tests assert both emitted event metadata and output filenames, e.g.
  `test/workflow-events.test.ts:169-231`.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Install | `pnpm install --frozen-lockfile` | exit 0 |
| Format | `pnpm format:check` | exit 0 |
| Lint | `pnpm lint` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0, no errors |
| Tests | `pnpm test -- test/review-steps.test.ts test/workflow-context.test.ts test/workflow-events.test.ts test/cli.test.ts` | all selected tests pass |
| Full gate | `pnpm check` | exit 0 |

## Suggested executor toolkit

| Skill | Use for |
| --- | --- |
| `typescript-refactor` | Steps 1-5: keep union types, config objects, and optional scope typing narrow and erasable. Prefer `satisfies`, literal unions, and type guards over unsafe casts. |
| `node` | Steps 2-4: keep Node 24 type-stripping compatibility: `.ts` imports, `import type`, no enums, no namespaces, no parameter properties. |
| `vitest` | Steps 5-6: add focused Vitest coverage for CLI behavior, optional git scope, event metadata, and prompt generation without shared mutable state. |

## Scope

**In scope**:

- `workflows/plan-review.workflow.ts` (create)
- `workflows/review-steps.ts`
- `lib/workflow-context.ts`
- `lib/aggregate.ts`
- `lib/workflow-events.ts`
- `lib/prompts/spec-review.ts` (create)
- `lib/prompts/index.ts`
- `bin/harness.ts`
- `test/review-steps.test.ts`
- `test/workflow-context.test.ts`
- `test/workflow-events.test.ts`
- `test/review-prompts.test.ts`
- `test/cli.test.ts`
- `skills/planning-workflow/SKILL.md`
- `skills/planning-workflow/references/routing.md`
- `README.md`
- `AGENTS.md`
- `dev/plans/README.md`

**Out of scope**:

- Do not add automatic plan editing, triage, or rerun looping inside harness.
- Do not add `requirements-review`, idea review, or a coordinator skill in this
  plan.
- Do not add a new `plan-review-workflow` skill in this plan. Updating the
  existing `planning-workflow` skill/routing to mention the new command is in
  scope.
- Do not add a new generic workflow registry or rewrite all workflow context
  plumbing into a new abstraction. Keep changes targeted.
- Do not change the reviewer output schema unless a test proves it cannot
  represent plan-review findings.
- Do not change `harness init`'s recommended command.
- Do not move run artifacts out of `.harness/runs/reviews`; reuse the existing
  prune path for this plan.

## Steps

### Step 1: Add the plan-review workflow

Create `workflows/plan-review.workflow.ts` modeled after
`workflows/change-review.workflow.ts:20-67`, with these differences:

- Export `meta = { name: "plan-review" }`.
- Define a single step id, `spec`.
- Map `spec` to the review agent name `review-spec`.
- Do not accept a `steps` option. One invocation is one review-spec pass.
- Pass title `Plan Review Summary` to `runReviewSteps`.
- Build step metadata with:
  - `workflow: "plan-review"`
  - `availableSteps: ["spec"]`
  - `requestedSteps: ["spec"]`
  - `executedSteps: ["spec"]`
  - `omittedSteps: []`
  - `partial: false`

Keep the run start/end event shape identical to change-review so `--verbose`
and `events.jsonl` remain familiar.

**Verify**:
`pnpm typecheck` -> expected failure at this point only if `review-spec` is not
yet part of `ReviewAgentName`; no unrelated syntax errors.

### Step 2: Add the review-spec prompt and reviewer config

Create `lib/prompts/spec-review.ts` and export it from `lib/prompts/index.ts`.

The prompt must be standalone, like the existing prompts, but it must explicitly
align with `skills/review-spec/SKILL.md`:

- Tell the reviewer to be read-only.
- Tell it to read `AGENTS.md`, the plan file, and referenced code directly.
- Tell it to verify the plan against codebase reality.
- Include the review dimensions from `skills/review-spec/SKILL.md:19-30`.
- Include a strong simplicity/proportionality section.
- Require JSON matching `schemas/review-output.schema.json`.
- Map `review-spec` terms into the schema:
  - `location` should be a plan section, file path, or `path:line`.
  - `must_fix: true` means the plan should not be executed before the issue is
    addressed.
  - `verdict: "needs_changes"` means plan edits are needed.
  - `verdict: "blocked"` means the reviewer could not review from the artifacts.
- Do not include diff-centric sections or placeholders such as `{{DIFF_REF}}`,
  `{{BASE_REF}}`, or `{{HEAD_REF}}`. The spec prompt should reference only the
  plan artifact and optional handoff artifact.

Add a short comment near the prompt export or prompt declaration:

```ts
// Keep this aligned with skills/review-spec/SKILL.md; the prompt must also
// state the JSON schema contract used by harness reviewers.
```

Update `lib/workflow-context.ts`:

- Import `SPEC_REVIEW_PROMPT`.
- Add a `review-spec` entry to `REVIEWER_CONFIGS`:
  - `title: "Spec review"`
  - `summaryKey: "spec"`
  - `promptTemplate: SPEC_REVIEW_PROMPT`
  - `promptFile: "spec-review.prompt.md"`
  - `reviewFile: "spec-review.json"`
  - `rawFile: "spec-review.raw.json"`
  - `stage: "spec"`
  - `dryRunReview: DRY_RUN_REVIEW`
- Ensure `buildPromptValues` includes `PLAN_REF` for both
  `review-implementation` and `review-spec`.

**Verify**:
`pnpm test -- test/workflow-context.test.ts` -> expected failure only where
optional git scope and event-name typing still need follow-up steps.

### Step 3: Make workflow context support diff-less runs

In `lib/workflow-context.ts`, add an option such as
`includeGitScope?: boolean` to `WorkflowRunOptions`. Default behavior must stay
unchanged: when `includeGitScope` is omitted, `change-review` still prepares git
scope and writes `context/diff.patch`.

Implement the option:

- Make `baseRef` and `headRef` optional in `WorkflowRunOptions`.
- Keep the internal `Scope` shape for git-backed runs, but allow every scope
  surface to be absent when `includeGitScope === false`:
  - local declarations: `let scope: Scope | undefined`,
    `let scopeMeta: ScopeMeta | undefined`, and
    `let diffRef: string | undefined`
  - returned context object fields: `scope?: Scope` and `scopeMeta?: ScopeMeta`
  - summary calls: pass `scope` through as optional to `renderSummary` and
    `renderFailedSummary`
  - metadata: include `scope` only when `scopeMeta` exists
- Only call `prepareGitScope` and `buildDiffRef` when git scope is enabled.
- Always call `writeRunContext` so plan and handoff artifacts still get copied.
- In `buildPromptValues`, accept `scope?: Scope` and `diffRef?: string` (or an
  equivalent optional shape). Guard every scope dereference and return empty
  strings for `BASE_REF`, `HEAD_REF`, `DIFF_RANGE`, and `DIFF_REF` when `scope`
  is absent. Do not use non-null assertions or fake fallback refs.
- Preserve current behavior for `change-review`, including `context/diff.patch`
  and summary scope lines.
- For plan-review dry runs and real runs, omit `scope` from `meta.json` when no
  scope exists instead of writing `scope: undefined`.

In `lib/aggregate.ts`:

- Change summary input types so `scope?: ReviewScope`.
- Render `Scope` and `Head SHA` lines only when `scope` is present.
- Add `spec: "Spec review"` to `FAILED_REVIEW_TITLES` so failed plan-review
  summaries render a human title instead of the raw key.
- Keep existing summary output byte-for-byte close for change-review except for
  unavoidable formatting from the conditional implementation.

**Verify**:
`pnpm test -- test/workflow-context.test.ts` -> all pass after updating tests in
Step 5.

### Step 4: Add event and metadata support for review-spec

In `lib/workflow-events.ts`:

- Add `"review-spec"` to `WorkflowReviewAgentName`.
- Add `"review-spec": "review-spec"` to `STEP_ID_BY_AGENT`.

In `lib/workflow-context.ts`:

- Ensure `PromptArtifacts` and `StreamArtifacts` include the new `spec` stage via
  the existing `ReviewStage` type.
- Update `buildTopLevelReviewFields` so plan-review meta exposes a spec summary
  without breaking existing fields. Acceptable output:
  - existing fields still appear for change-review:
    `implementationReview`, `qualityReview`, `simplifyReview`
  - extend the existing key map with `spec: "specReview"` so plan-review adds
    `specReview`
  - canonical summaries remain in `reviews.spec`

Do not change `schemas/review-output.schema.json`.

**Verify**:
`pnpm test -- test/workflow-events.test.ts` -> all pass after tests are updated
in Step 5.

### Step 5: Expose `harness run plan-review`

In `bin/harness.ts`:

- Import `run as runPlanReview` from `workflows/plan-review.workflow.ts`.
- Register `plan-review` under `harness run`.
- Do not reuse the existing `addReviewCommand` directly if that would expose
  change-review-only flags. Add a dedicated `addPlanReviewCommand` or a tiny
  shared helper for common flags.
- `--plan <path>` must be required.
- Do not expose `--base`, `--head`, or `--steps` on `plan-review`.
- Reuse common flags:
  - `--workspace`
  - `--handoff <path>`
  - `--handoff-stdin`
  - `--runs-dir`
  - `--agent <provider>`
  - `--codex-executable <path>`
  - `--model <id>`
  - `--sandbox <mode>`
  - `--approval-policy <policy>`
  - `--reasoning-effort <effort>`
  - `--max-runtime-ms <ms>`
  - `--dry-run`
  - `--verbose`
- Reuse the same Codex-only option validation already enforced for
  `change-review`.
- Create the workflow context with `includeGitScope: false`.
- `resolveHarnessOptions` still returns default `baseRef` and `headRef`
  (`lib/config.ts:73-78`). For `plan-review`, those defaults are intentionally
  unused; `includeGitScope: false` must prevent them from reaching git scope
  preparation, summaries, metadata, prompts, or artifacts.
- Call `runPlanReview(ctx)` directly. Do not pass `{ steps: ... }` and do not
  let the command expose or forward a `steps` option.
- Keep exit behavior: status `0` for `verdict: "pass"` or dry run, otherwise
  `1`.

Type cleanup:

- Narrow `resolveHandoffText` so it accepts a shared handoff option type, not
  necessarily the full change-review option type. Use a minimal shape such as:

  ```ts
  type HandoffCliOptions = {
    handoff?: string;
    handoffStdin?: boolean;
  };
  ```

  Both command actions should pass only those fields into `resolveHandoffText`.
- Avoid broad `any` casts. Prefer duplicating the small SIGINT/SIGTERM and
  exit-code action block for `plan-review` first. Extract a shared helper inside
  `bin/harness.ts` only if the duplication is obviously harder to read after
  both commands exist; do not create a new module for this plan.

**Verify**:
`node bin/harness.ts run plan-review --help` -> help includes `--plan` and does
not include `--base`, `--head`, or `--steps`.

### Step 6: Add focused tests

Update existing test helpers for the expanded `ReviewAgentName` union:

- `test/review-steps.test.ts:33-39` must include a `review-spec` deferred review.
- `test/review-steps.test.ts:61-75` must return review info for `review-spec`.
- `test/workflow-events.test.ts:65-79` must return review info for
  `review-spec`.
- Existing change-review tests must still assert only the three change-review
  steps are started.

Add tests:

- `test/review-steps.test.ts`
  - `plan-review starts only the spec review step`
  - Assert exported step metadata is exactly the single `spec` step.
- `test/workflow-context.test.ts`
  - A context with `includeGitScope: false` works in a non-git temp workspace.
  - A plan file is copied to `context/plan.md`.
  - `ctx.agent("review-spec")` writes `spec-review.prompt.md` and
    `spec-review.json` in dry-run mode.
  - The prompt includes the plan reference and does not include a diff file
    reference.
  - `SPEC_REVIEW_PROMPT` contains the `review-spec` dimension keywords from
    `skills/review-spec/SKILL.md` (`Architecture`, `Feasibility`, `Simplicity`,
    `Reliability`, `Performance`, `Security`, `Edge Cases`, `Testing`) and the
    harness JSON verdict mapping (`pass`, `needs_changes`, `blocked`,
    `must_fix`). This is a lightweight drift guard between the skill and prompt.
  - A real export without scope writes `summary.md` with no `Scope` or
    `Head SHA` lines and writes `meta.json` with no `scope` key.
- `test/workflow-events.test.ts`
  - `STEP_ID_BY_AGENT` includes `review-spec`.
  - `runReviewSteps` emits `stepId: "review-spec"`, `cliStep: "spec"`, and
    output names `spec-review.prompt.md`, `spec-review.raw.json`,
    `spec-review.json`, `spec-review.stream.jsonl`.
- `test/cli.test.ts`
  - `harness run plan-review --plan plan.md --workspace <non-git-temp-dir> --dry-run`
    exits 0.
  - Output has `workflow: "plan-review"`, `requestedSteps: ["spec"]`,
    `prompts.spec` ending in `spec-review.prompt.md`, and no `scope`.
  - Output has no `baseRef`, `headRef`, `mergeBase`, or `headSha` in
    plan-review metadata; resolved default refs from `resolveHarnessOptions`
    must not leak into diff-less artifacts.
  - The generated prompt contains the copied plan reference.
  - `harness run plan-review --workspace <dir> --dry-run` exits 2 for missing
    required `--plan`.
  - `harness run plan-review --plan plan.md --base HEAD --dry-run` exits 2 for
    unknown option.
  - `harness run plan-review --plan plan.md --steps spec --dry-run` exits 2 for
    unknown option.

Regression protection:

- Keep existing `change-review` dry-run tests passing, especially
  `test/cli.test.ts:679-708` and `test/cli.test.ts:735-759`.
- Keep schema validation tests passing for existing reviewers, e.g.
  `test/workflow-context.test.ts:169-242`.

**Verify**:
`pnpm test -- test/review-steps.test.ts test/workflow-context.test.ts test/workflow-events.test.ts test/cli.test.ts`
-> all pass.

### Step 7: Document the command

Update `README.md`:

- Add a short `Plan Review` section near the existing workflow docs.
- Show:

```bash
harness run plan-review --plan dev/plans/260630-plan-review-workflow.md --verbose
```

- Explain:
  - one invocation runs one `review-spec` pass
  - `--plan` is required
  - no `--base`, `--head`, or `--steps`
  - artifacts are still under `.harness/runs/reviews/<run-id>/`
  - callers triage findings and edit the plan; harness does not edit plans

Update `skills/planning-workflow/SKILL.md`:

- Keep the existing intake and shaping semantics.
- In step 2, after `create-plan`, add `harness run plan-review --plan <path>`
  as the preferred executable review path when the plan is non-trivial,
  cross-area, or intended for executor handoff.
- State that the planning agent still owns triage: accept/adapt/decline
  reviewer findings, edit the plan, and rerun `plan-review` after material plan
  changes.
- Keep direct `review-spec` as the lightweight path for reviewing an existing
  brief/spec/plan in chat when no harness command is available or durable run
  artifacts are unnecessary.
- Do not imply harness edits the plan automatically.

Update `skills/planning-workflow/references/routing.md`:

- Add a routing row for "Created implementation plan needs review before
  execution" -> `harness run plan-review --plan <path>` / `review-spec` fallback.
- Update skip rules so `plan-review` can be skipped for trivial plans or when a
  prior review already covered the same plan revision.
- Update scenario fixtures:
  - create-plan paths for non-trivial work should become
    `create-plan` -> `plan-review` -> `implement-plan`
  - "Review dev/plans/foo.md against the codebase" should prefer
    `harness run plan-review --plan dev/plans/foo.md` when harness is available,
    with direct `review-spec` as fallback.

Update `dev/plans/README.md` only as needed for plan status. Do not add a
shipped entry until implementation lands and the plan file is removed.

**Verify**:
`pnpm format:check` -> exit 0.

## Test plan

- Unit/workflow tests:
  - `test/review-steps.test.ts` covers `plan-review` step selection and metadata.
  - `test/workflow-events.test.ts` covers `review-spec` event ids and output
    filenames.
  - `test/workflow-context.test.ts` covers optional git scope, prompt generation,
    copied plan context, summary/meta without scope, and existing schema
    validation behavior.
- CLI tests:
  - `test/cli.test.ts` covers `plan-review` dry-run success in a non-git
    workspace, missing required `--plan`, and rejection of change-review-only
    flags.
- Regression tests:
  - Existing change-review tests remain passing to prove default git-backed
    review behavior did not drift.

Verification:

```bash
pnpm test -- test/review-steps.test.ts test/workflow-context.test.ts test/workflow-events.test.ts test/cli.test.ts
pnpm check
```

Both commands exit 0.

## Done criteria

All must hold:

- [x] `node bin/harness.ts run plan-review --help` shows required `--plan` and no
      `--base`, `--head`, or `--steps`.
- [x] `node bin/harness.ts run plan-review --workspace <non-git-temp-dir> --plan plan.md --dry-run`
      exits 0 and writes `spec-review.prompt.md`, `spec-review.json`, and
      `context/plan.md`.
- [x] Plan-review `summary.md` and `meta.json` do not show fake git scope.
- [x] Plan-review metadata contains no `baseRef`, `headRef`, `mergeBase`, or
      `headSha`.
- [x] Change-review dry runs still include git scope and `context/diff.patch`.
- [x] `SPEC_REVIEW_PROMPT` is covered by a drift-guard test for the
      `review-spec` dimensions and JSON verdict mapping.
- [x] `review-output.schema.json` is unchanged unless the executor stopped and
      reported why a schema change is necessary.
- [x] `pnpm test -- test/review-steps.test.ts test/workflow-context.test.ts test/workflow-events.test.ts test/cli.test.ts`
      exits 0.
- [x] `pnpm check` exits 0.
- [x] `README.md` documents `harness run plan-review`.
- [x] `skills/planning-workflow/SKILL.md` and
      `skills/planning-workflow/references/routing.md` route non-trivial
      created plans through `plan-review` before implementation, with direct
      `review-spec` as fallback.
- [x] No files outside the in-scope list are modified, except this plan's status
      updates and generated ignored `.harness/` run artifacts if manually
      testing non-dry runs.

## STOP conditions

Stop and report back if:

- Adding `review-spec` requires changing the review output schema in a way that
  would break existing `change-review` consumers.
- `includeGitScope: false` cannot be implemented without fake `baseRef`,
  `headRef`, `mergeBase`, or `headSha` values appearing in plan-review artifacts.
- `plan-review` cannot run in a non-git workspace with an explicit `--workspace`
  and existing plan file.
- The implementation requires a new generic workflow registry or large
  cross-module rewrite to avoid duplication.
- Existing change-review behavior changes beyond adding support for the new
  reviewer identity.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- The `review-spec` prompt is now a second executable representation of
  `skills/review-spec/SKILL.md`. Future edits to the skill should check whether
  `lib/prompts/spec-review.ts` needs the same semantic change, especially around
  review dimensions and output expectations.
- If a later `requirements-review` or `plan-review-workflow` coordinator is
  added, prefer consuming this command's existing artifacts over adding another
  provider path.
- If a third executable review workflow appears, revisit whether
  `lib/workflow-context.ts` should be extracted into a generic reviewer runtime.
  Do not do that extraction in this first plan.
