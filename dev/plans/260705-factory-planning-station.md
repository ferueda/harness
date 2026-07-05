# Plan 260705-factory-planning-station: Add single-item factory planning station

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the next
> step. If anything in the "STOP conditions" section occurs, stop and report.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Implementation**: complete in `codex/factory-planning-station`
- **Depends on**:
  - `dev/plans/260705-factory-station-api-role-config.md`
  - `dev/plans/260705-agent-session-continuation.md`
- **Category**: dx
- **Execution gate**: do not implement until both dependency plans are merged.

## Why this matters

Factory triage can route an item to `ready-to-plan`, but there is no station
that turns that item into a reviewed implementation plan. Manual planning works
today because the same planner writes the plan, reads reviewer findings, and
decides whether to implement, adapt, or decline each finding. This plan preserves
that planner ownership while making the loop deterministic, bounded, and
artifact-backed.

## Current state

Relevant files:

- `bin/factory-commands.ts` owns `harness factory ...` station commands.
- `bin/harness.ts` owns low-level `harness run plan-review` and
  `harness run factory-triage`.
- `lib/factory-run-context.ts` is the existing triage run context pattern:
  run ids, `.harness/runs/factory`, dry-run placeholders, events, metadata.
- `lib/factory-schemas.ts` owns `FactoryWorkItem` and triage schemas.
- `lib/prompts/factory-triage.ts` and `lib/prompts/index.ts` show prompt module
  layout.
- `lib/workflow-context.ts` creates review workflow runs under
  `.harness/runs/reviews`.
- `workflows/plan-review.workflow.ts` runs the `review-spec` step.
- `workflows/review-steps.ts` writes review prompt/raw/parsed artifacts.
- `schemas/factory-triage-output.schema.json` and
  `test/factory-triage-output-schema-sync.test.ts` show schema parity pattern.
- `test/factory-triage.workflow.test.ts` shows factory workflow tests with fake
  providers and artifact assertions.
- `test/cli.test.ts` covers harness command help, dry-run, missing file, and
  invalid JSON cases.

Desired loop from `dev/todo/260704-factory-planner-station.md`:

```text
ready-to-plan work item
  -> planner writes initial plan
  -> harness runs plan-review
  -> planner receives review findings
  -> planner decides implement/adapt/decline for each finding
  -> planner outputs revised plan + decision rationale
  -> harness runs plan-review again when needed
  -> plan-approved | plan-needs-human | plan-review-unresolved | planning-failed
```

Plan-review findings currently have no ids. The planning loop must synthesize
stable ids like `spec-001`, `spec-002`, in the order returned by the `spec`
review step.

## Commands you will need

| Purpose       | Command                                                                                                                                           | Expected on success |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Install       | `pnpm install`                                                                                                                                    | exit 0              |
| Typecheck     | `pnpm typecheck`                                                                                                                                  | exit 0, no errors   |
| Lint          | `pnpm lint`                                                                                                                                       | exit 0              |
| Format check  | `pnpm format:check`                                                                                                                               | exit 0              |
| Build         | `pnpm build`                                                                                                                                      | exit 0              |
| Focused tests | `pnpm test -- test/factory-planning.workflow.test.ts test/factory-planning-output-schema-sync.test.ts test/cli.test.ts test/review-steps.test.ts` | all pass            |
| Full check    | `pnpm check`                                                                                                                                      | exit 0              |

## Suggested executor toolkit

| Skill                 | Use for                                                              |
| --------------------- | -------------------------------------------------------------------- |
| `node`                | Filesystem artifacts, abort handling, CLI wiring, provider timeouts. |
| `typescript-refactor` | Station status/result types, session handling, test seams.           |
| `zod`                 | Planner output contract and strict parse errors.                     |
| `vitest`              | Workflow tests with fake planner and fake plan-review runner.        |
| `create-plan`         | Prompt rules for implementation-plan structure and revision output.  |
| `review-spec`         | Plan-review verdict/finding semantics used by the revision loop.     |

## Scope

**In scope**:

- `bin/factory-commands.ts`
- `lib/factory-planning-run-context.ts` (create)
- `lib/factory-planning-schemas.ts` (create, unless keeping factory schemas
  compact is still clearer)
- `lib/prompts/factory-planning.ts` (create)
- `lib/prompts/index.ts`
- `schemas/factory-planning-output.schema.json` (create)
- `workflows/factory-planning.workflow.ts` (create)
- `test/factory-planning.workflow.test.ts` (create)
- `test/factory-planning-output-schema-sync.test.ts` (create)
- `test/cli.test.ts`
- focused review workflow helper exports only if required to call plan-review
  without shelling out

**Out of scope**:

- Provider session internals; use Plan 2's `AgentSessionRef` API.
- Factory role config internals; use Plan 1's resolver.
- GitHub, Linear, Jira, Inngest, labels, comments, branches, or PRs.
- Implementation, change-review, PR, or inbox batch planning stations.
- `PRODUCT.md` / `TECH.md` split.
- `harness run factory-planning`; this is an operator station command under
  `harness factory planning`.
- Letting planner agents write directly to tracked files.

## Target behavior

Add:

```bash
harness factory planning --workspace /path/to/repo --item-file work-item.json
```

Supported options:

```text
--workspace <path>
--item-file <path>
--runs-dir <path>
--output-plan <path>
--max-review-iterations <n>
--max-runtime-ms <ms>
--dry-run
--verbose
```

Role selection:

- Planner turns use `factory.planning.roles.planner`.
- Plan-review turns use `factory.planning.roles.reviewer`.
- `--max-review-iterations` overrides
  `factory.planning.maxReviewIterations`, which falls back to `3`.
- Do not add per-role agent/model CLI flags.

Station statuses:

```ts
type FactoryPlanningRunStatus =
  | "dry_run"
  | "plan-approved"
  | "plan-needs-human"
  | "plan-review-unresolved"
  | "planning-failed";
```

## Steps

### Step 1: Verify dependencies from Plans 1 and 2

Before coding, inspect the repo state.

This plan is not executable until
`dev/plans/260705-factory-station-api-role-config.md` and
`dev/plans/260705-agent-session-continuation.md` have landed. On the branch
where this plan was written, those two plans are still `planned`, so the symbol
checks below are expected to fail until their PRs merge.

Treat this as a hard dependency gate, not implementation work for this plan. If
the checks fail, stop before Step 2 and implement/merge the dependency plans in
order. Do not create substitute role/session APIs inside this slice.

Confirm Plan 1 provides:

- `resolveFactoryRoleAgent(...)` or equivalent;
- `factory.planning.roles.planner` resolution;
- `factory.planning.roles.reviewer` resolution;
- `factory.planning.maxReviewIterations` typed access;
- no direct agent/model flags on station commands.

Confirm Plan 2 provides:

- `AgentRunInput.session?: AgentSessionRef`;
- successful provider `result.session?: AgentSessionRef`;
- provider mismatch handling in adapters.

Run concrete symbol checks before Step 2:

```bash
rg -n "resolveFactoryRoleAgent|resolveFactoryPlanningSettings" lib/config.ts
rg -n "AgentSessionRef|session\\?:" lib/agents.ts
rg -n "sessionId" lib/agents.ts providers test
```

Expected:

- first command finds role/settings resolver exports;
- second command finds `AgentSessionRef` and `AgentRunInput.session`;
- third command returns no implementation/test matches.

Use the implemented names from those plans. Do not invent duplicate wrappers.

**Verify**: `pnpm typecheck` -> exit 0 before edits.

### Step 2: Add planner output schema

Create `lib/factory-planning-schemas.ts`.

Add strict Zod schema. Keep markdown out of JSON; the planner writes the plan
to the run draft file and returns only metadata.

```ts
export const FACTORY_PLANNING_OUTCOMES = ["draft-ready", "needs-human"] as const;
export const FACTORY_PLANNING_FINDING_DECISIONS = ["implement", "adapt", "decline"] as const;

export const FactoryPlanningOutputSchema = z
  .object({
    outcome: z.enum(FACTORY_PLANNING_OUTCOMES),
    summary: z.string().min(1),
    humanQuestions: z.array(z.string().min(1)).optional(),
    findingDecisions: z.array(
      z.object({
        findingId: z.string().min(1),
        decision: z.enum(FACTORY_PLANNING_FINDING_DECISIONS),
        rationale: z.string().min(1),
      }).strict(),
    ).default([]),
  })
  .strict()
  .superRefine(...);
```

Cross-field rules:

- `draft-ready` means the planner wrote a non-empty draft file; filesystem
  validation owns that check.
- `needs-human` requires at least one `humanQuestions` item.

Add:

- inferred `FactoryPlanningOutput` type;
- `FactoryPlanningError`;
- `parseFactoryPlanningOutput(...)` using `formatZodError`.

Create `schemas/factory-planning-output.schema.json`. It must reject unknown
root/nested fields and contain the same enums. JSON Schema may not fully encode
the conditional `draft-ready` / `needs-human` requirements; Zod owns those.

Add `test/factory-planning-output-schema-sync.test.ts` covering:

- root `additionalProperties: false`;
- enum parity;
- valid draft and needs-human payloads pass JSON schema and Zod;
- extra field fails both;
- invalid decision enum fails both;
- schema does not expose `shortSlug` or `planMarkdown`.

**Verify**: `pnpm test -- test/factory-planning-output-schema-sync.test.ts`
-> all pass.

### Step 3: Add planning prompts

Create `lib/prompts/factory-planning.ts` and export it from
`lib/prompts/index.ts`.

Prompt requirements:

- JSON only, matching `schemas/factory-planning-output.schema.json`;
- planner may mutate only the provided draft path;
- planner must write the full plan to the draft path, not return markdown JSON;
- plan must follow create-plan principles: current-state verification, scope,
  commands, tests, done criteria, STOP conditions, and verified executor skills;
- initial prompt must include work item JSON, current date, and draft path;
- revision prompt must include draft path and current date, but not resend the
  previous full plan markdown;
- revision prompt must include latest review findings with synthetic ids;
- planner must return exactly one `findingDecisions` entry per latest finding;
- planner can implement, adapt, or decline findings with rationale.
- Before authoring the prompt, read the verified `create-plan` and
  `review-spec` skills if they are available in the executor environment. Match
  their planning artifact structure and review vocabulary.

Prefer two exported helpers if clearer:

```ts
renderFactoryPlanningInitialPrompt(input);
renderFactoryPlanningRevisionPrompt(input);
```

**Verify**: `pnpm typecheck` -> exit 0.

### Step 4: Add planning run context

Create `lib/factory-planning-run-context.ts`.

Mirror `lib/factory-run-context.ts` patterns:

- resolve workspace;
- build run id with `buildRunId(startedAt)`;
- default run dir: `<workspace>/.harness/runs/factory/<run-id>`;
- write `context/work-item.json`;
- persist `events.jsonl` for every live non-dry-run run, matching
  `lib/factory-run-context.ts`;
- support `AbortSignal`;
- support `--dry-run` without provider or reviewer calls;
- clean orphaned run dir only if `meta.json` was not written.

Export factory functions mirroring triage context naming:

```ts
export function createFactoryPlanningRunContext(
  options: FactoryPlanningRunContextOptions,
): FactoryPlanningRunContext;

export function createFactoryPlanningRunContextForTest(
  options: FactoryPlanningRunContextOptions,
): FactoryPlanningRunContext;
```

The production CLI must use `createFactoryPlanningRunContext(...)`; tests use
the `ForTest` helper with fake `agentProviderFactory` and `planReviewRunner`.

Artifact layout:

```text
.harness/runs/factory/<run-id>/
  context/work-item.json
  iterations/1/planner.prompt.md
  iterations/1/planner.raw.json
  iterations/1/planner.json
  iterations/1/plan.md
  iterations/1/plan-review-ref.json
  iterations/1/review-findings.json
  summary.md
  meta.json
  events.jsonl
```

`iterations/<n>/plan-review-ref.json` must be strict and stable:

```ts
type FactoryPlanningReviewRef = {
  runId: string;
  runDir: string;
  status: string;
  verdict?: "pass" | "needs_changes" | "blocked";
  specReviewPath: string;
  summaryPath?: string;
};
```

Artifact boundary:

- Follow `docs/project-intent.md` repo-boundary rules.
- Factory and review run artifacts are ignored operational artifacts under the
  target workspace `.harness/`.
- The approved final plan is the only tracked planning artifact written by this
  station, and it lives under the target workspace `dev/plans/`.
- Never overwrite an existing `dev/plans/*.md` file.
- Keep runtime Zod and exported JSON schemas in parity for
  `factory-planning-output.schema.json`.

Meta should store paths, not full plan/review bodies:

```ts
type FactoryPlanningRunMeta = {
  runId: string;
  workflow: "factory-planning";
  status: FactoryPlanningRunStatus;
  workspace: string;
  runDir: string;
  workItem: { id: string; source: FactoryWorkItem["source"]; title: string };
  outputPlan?: string;
  iterations: Array<{ index: number; planPath: string; review?: ... }>;
  plannerSession?: AgentSessionRef;
  startedAt: string;
  durationMs: number;
  error?: string;
};
```

Dry-run:

- writes placeholder prompt/raw/parsed/plan/meta/summary;
- returns `status: "dry_run"`;
- creates no `.harness/runs/reviews` directory;
- writes no final `dev/plans` file.

**Verify**: `pnpm typecheck` -> exit 0.

### Step 5: Implement workflow loop

Create `workflows/factory-planning.workflow.ts`.

Export:

```ts
export const meta = { name: "factory-planning" };
export async function run(ctx: FactoryPlanningRunContext): Promise<FactoryPlanningRunMeta>;
```

Responsibilities:

1. Validate the work item is appropriate:
   - if `metadata.factoryRoute` exists, accept only `ready-to-plan`;
   - if `metadata.factoryNextAction` exists, accept only `create-plan`;
   - if neither exists, proceed because the operator invoked the station
     explicitly.
   - if either key exists with another value, finish `planning-failed` before
     provider calls.
   - this is an optional handoff guard for operators or future orchestrators
     that stamp route metadata. Current triage artifacts do not mutate the
     original work item, so absent keys must not block explicit one-item
     operation.
2. Invoke the planner using `factory.planning.roles.planner`.
   - Planner `AgentRunInput` must include
     `schemaPath: FACTORY_PLANNING_SCHEMA_PATH`, where
     `FACTORY_PLANNING_SCHEMA_PATH = join(HARNESS_ROOT, "schemas/factory-planning-output.schema.json")`,
     mirroring `FACTORY_TRIAGE_SCHEMA_PATH` in `lib/factory-run-context.ts`.
     Do not pass a workspace-relative schema path.
3. Parse planner JSON.
4. If `needs-human`, write artifacts and finish `plan-needs-human`.
5. Write `iterations/<n>/plan.md`.
6. Run plan-review using `factory.planning.roles.reviewer`.
7. If plan-review passes, write final approved plan.
8. If plan-review is blocked, finish `plan-needs-human`.
9. If plan-review fails to run, throws, returns failed meta, or returns invalid
   review output, finish `planning-failed`.
10. If plan-review needs changes, synthesize finding ids and call the same
    planner session with a revision prompt.
11. Repeat until pass, human-needed, failure, or max review iterations.

Planner invocation:

```ts
const planner = resolveFactoryRoleAgent({
  workspace,
  station: "planning",
  role: "planner",
});
const agent = agentProviderFactory({
  provider: planner.agent,
  codexPathOverride: planner.codexPathOverride,
});
const plannerResult = await agent.run({
  workspace,
  prompt: iterationIndex === 1
    ? renderFactoryPlanningInitialPrompt(...)
    : renderFactoryPlanningRevisionPrompt(...),
  schemaPath: FACTORY_PLANNING_SCHEMA_PATH,
  model: planner.model,
  sandboxMode: planner.sandboxMode,
  approvalPolicy: planner.approvalPolicy,
  modelReasoningEffort: planner.modelReasoningEffort,
  maxRuntimeMs,
  logPath: join(iterationDir, "planner.stream.jsonl"),
  session: priorPlannerSession,
  signal,
});
```

Rules:

- Initial turn uses no session.
- Capture `plannerResult.session` after the first successful planner turn.
- Revision turns pass the captured `AgentSessionRef` as `session`.
- If a review needs revision and no planner session was captured, finish
  `planning-failed`.
- Write `planner.prompt.md`, `planner.raw.json`, `planner.json`, and `plan.md`
  under the current iteration directory before invoking plan-review.

Iteration directories:

- Use one new `iterations/<n>/` directory for each planner+plan-review cycle.
- `n` is 1-based.
- Iteration 1 contains the initial planner prompt/output/plan and first
  plan-review reference.
- Iteration 2 contains the revision prompt/output/plan and second plan-review
  reference.
- Do not overwrite a prior iteration directory.
- Increment `n` after each completed plan-review that returns
  `needs_changes` and review budget remains.

Plan-review invocation:

- Call existing plan-review workflow functions directly; do not shell out.
- Pass the iteration draft plan path.
- Store review artifacts in normal `.harness/runs/reviews/<run-id>/`.
- Write only a reference JSON under the factory iteration.
- Wire the review context with the reviewer role explicitly:

```ts
const reviewer = resolveFactoryRoleAgent({
  workspace,
  station: "planning",
  role: "reviewer",
});
const reviewCtx = createWorkflowContext({
  workspace,
  planPath: iterationPlanPath,
  runsDir: join(workspace, ".harness/runs/reviews"),
  includeGitScope: false,
  agentProvider: reviewer.agent,
  codexPathOverride: reviewer.codexPathOverride,
  model: reviewer.model,
  sandboxMode: reviewer.sandboxMode,
  approvalPolicy: reviewer.approvalPolicy,
  modelReasoningEffort: reviewer.modelReasoningEffort,
  maxRuntimeMs,
  dryRun: false,
  signal,
  eventSink,
  agentProviderFactory: createAgentProvider,
});
const reviewMeta = await runPlanReview(reviewCtx);
```

`runPlanReview(...)` returns finalized review metadata; it does not expose
`runDir`. Capture `reviewCtx.runDir` before awaiting the run and use that path
for `plan-review-ref.json`, summary links, and reading review artifacts.
The iteration `plan.md` must already exist on disk before
`createWorkflowContext(...)` is called, and `planPath: iterationPlanPath` must
not be omitted.

- Interpret review result with this table:

| Review result                                                                                               | Station result           |
| ----------------------------------------------------------------------------------------------------------- | ------------------------ |
| `reviewMeta.status === "completed"` and `reviewMeta.verdict === "pass"`                                     | `plan-approved`          |
| `reviewMeta.status === "completed"` and `reviewMeta.verdict === "needs_changes"` with review budget left    | planner revision turn    |
| `reviewMeta.status === "completed"` and `reviewMeta.verdict === "needs_changes"` with no review budget left | `plan-review-unresolved` |
| `reviewMeta.status === "completed"` and `reviewMeta.verdict === "blocked"`                                  | `plan-needs-human`       |
| `reviewMeta.status === "failed"` or thrown error                                                            | `planning-failed`        |

- After each completed plan-review, read full findings from:

```ts
join(reviewCtx.runDir, "spec-review.json");
```

Do not rely on `reviewMeta.specReview.findingCount`; meta does not contain
the full finding bodies. Persist the id-enriched list to
`iterations/<n>/review-findings.json` and pass that JSON to
`renderFactoryPlanningRevisionPrompt(...)`.

Session reuse:

- Capture `result.session` from the first planner turn.
- Pass that exact `AgentSessionRef` on revision turns.
- If review needs revision and the initial planner returned no session, finish
  `planning-failed`.

Revision validation:

- Latest findings get ids `spec-001`, `spec-002`, ...
- Planner output must include exactly one decision for every latest id.
- Duplicate, missing, or unknown ids make the station `planning-failed`.
- Harness must not edit plan markdown based on findings.
- Harness must snapshot the draft file to `iterations/<n>/plan.md` after each
  planner turn and before plan-review.
- Harness must validate the draft exists, is a file, and is non-empty before
  snapshotting.
- In Git workspaces, capture tracked status before each planner turn and fail
  if tracked source changes after the turn. The draft path lives under
  `.harness/runs/factory/<run-id>/planning/draft.md`.

Final plan path:

- If `--output-plan` is provided, resolve it under the workspace and require it
  to be in `dev/plans/`.
- If omitted, derive `dev/plans/YYMMDD-short-slug.md` from run start date and
  the work item title, falling back to the work item id.
- Format `YYMMDD` in UTC with a two-digit year, zero-padded month, and
  zero-padded day. Example: July 5, 2026 -> `260705`.
- Validate `--output-plan` by resolving relative to workspace, rejecting paths
  outside the workspace, rejecting normalized paths outside `dev/plans/`,
  creating `dev/plans/` when missing, and rejecting any existing final file.
- Never overwrite an existing file.

Max review iterations:

- `--max-review-iterations` counts completed plan-review executions, not
  planner turns.
- Increment the count after each completed plan-review gate.
- `needs-human` from the planner and `blocked` from the reviewer stop the loop
  immediately and do not schedule another review.
- If the latest completed review is still `needs_changes` after the budget is
  exhausted, finish `plan-review-unresolved`.

**Verify**: `pnpm typecheck` -> exit 0 after tests compile.

### Step 6: Wire `harness factory planning`

Edit `bin/factory-commands.ts`.

Add:

```bash
harness factory planning --workspace <path> --item-file <path>
```

Options:

```text
--workspace <path>
--item-file <path>
--runs-dir <path>
--output-plan <path>
--max-review-iterations <n>
--max-runtime-ms <ms>
--dry-run
--verbose
```

Rules:

- No direct role agent/model flags.
- Use Plan 1 role resolver.
- Use Plan 2 session-capable provider API.
- Resolve review iteration budget as:

```ts
const planningSettings = resolveFactoryPlanningSettings({ workspace });
const maxReviewIterations = options.maxReviewIterations ?? planningSettings.maxReviewIterations;
```

Pass the resolved integer into the planning run context.

- Use the same SIGINT/SIGTERM abort pattern as existing commands.
- Output JSON with run id, workflow, status, workspace, run dir, work item,
  output plan, iteration count, summary path, and meta path.
- Exit `0` for `plan-approved`, `plan-needs-human`, and `dry_run`.
- Exit `1` for `plan-review-unresolved` and `planning-failed`.

**Verify**: `pnpm test -- test/cli.test.ts` -> expected to fail until Step 7
tests are added.

### Step 7: Add workflow and CLI tests

Create `test/factory-planning.workflow.test.ts`.

Use temp workspaces and injected fake planner/reviewer seams. Do not call real
providers.

Add explicit test seams to the planning run context, following the existing
factory triage `agentProviderFactory` pattern:

```ts
type FactoryPlanningRunContextOptions = {
  ...
  agentProviderFactory: (options: AgentProviderOptions) => Agent;
  planReviewRunner?: (context: WorkflowContext) => ReturnType<typeof runPlanReview>;
};
```

Production uses `createAgentProvider` and `runPlanReview`; tests inject a fake
agent provider and fake `planReviewRunner`. The workflow only needs
`status`, `verdict`, and `runId` from the returned review meta; it uses captured
`reviewCtx.runDir` for artifact paths. Do not use live providers in unit tests.

Required workflow tests:

- dry-run writes placeholder artifacts and calls no provider/reviewer;
- initial draft passes review and writes final
  `dev/plans/YYMMDD-short-slug.md`;
- multi-iteration revision writes `iterations/1/...` and `iterations/2/...`
  without overwriting the first iteration;
- first review needs changes, revision reuses same `AgentSessionRef`, second
  review passes;
- planner returns `needs-human`, no plan-review call happens;
- max review iterations exhausted, no final plan written;
- invalid/missing finding decisions fail as `planning-failed`;
- blocked review maps to `plan-needs-human`;
- failed or thrown plan-review maps to `planning-failed`;
- `metadata.factoryRoute: "ready-to-implement"` fails before provider call;
- absent `metadata.factoryRoute` and `metadata.factoryNextAction` proceeds
  because explicit operator invocation is allowed.

Update `test/cli.test.ts`:

- `harness factory help` includes `planning`;
- `harness factory planning --help` includes required options;
- help does not include role agent/model flags;
- dry-run command exits 0 and writes iteration artifacts;
- missing `--item-file`, missing file, invalid JSON, and unknown workflow flags
  fail clearly.

**Verify**:

```bash
pnpm test -- test/factory-planning.workflow.test.ts test/cli.test.ts
```

Expected: all selected tests pass.

### Step 8: Render summary artifacts

Add summary rendering in the planning context/helper.

Include stable sections:

```markdown
# Factory Planning

## Work item

## Status

## Output plan

## Iterations

## Human questions

## Error
```

Rules:

- Reference review run dirs and finding ids.
- Do not inline full review findings or full plan content.
- Dry-run summary must say providers/reviewers were not called.

**Verify**: workflow tests assert summary contains title, status, and either
output plan or human questions.

### Step 9: Final verification

Run:

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
pnpm test -- test/factory-planning.workflow.test.ts test/factory-planning-output-schema-sync.test.ts test/cli.test.ts test/review-steps.test.ts
pnpm test
pnpm check
```

Expected:

- all commands exit 0;
- no generated `.harness/` artifacts are staged;
- dry-run does not call live providers or reviewers.

## Test plan

- `test/factory-planning-output-schema-sync.test.ts`: schema and Zod parity.
- `test/factory-planning.workflow.test.ts`: station loop behavior and artifacts.
- `test/cli.test.ts`: command help, dry-run, invalid inputs, no role flags.
- Existing `test/review-steps.test.ts`: plan-review behavior remains stable.

## Done criteria

- [x] `harness factory planning --item-file <path> --dry-run` creates planning
      artifacts and calls no provider/reviewer.
- [x] Live planning uses `factory.planning.roles.planner`.
- [x] Plan-review uses `factory.planning.roles.reviewer`.
- [x] Revision turns reuse the initial planner `AgentSessionRef`.
- [x] Review findings are presented to planner with ids like `spec-001`.
- [x] Planner decisions are validated, but harness does not apply findings.
- [x] Approved final plan is written to `dev/plans/YYMMDD-short-slug.md` or
      validated `--output-plan`.
- [x] Draft iterations stay under `.harness/runs/factory/<run-id>/`.
- [x] Plan-review artifacts stay under `.harness/runs/reviews/<run-id>/` and are
      referenced from factory artifacts.
- [x] Full review findings are read from `spec-review.json` and persisted with
      synthetic ids before revision prompts are rendered.
- [x] `plan-review-ref.json` includes `runId`, captured `runDir`,
      `specReviewPath`, and verdict/status fields.
- [x] Reviewer `blocked` maps to `plan-needs-human`, while review workflow
      failure maps to `planning-failed`.
- [x] Max review iterations count completed plan-review executions.
- [x] Existing `harness run plan-review` and `harness run factory-triage`
      behavior remains unchanged.
- [x] `pnpm check` exits 0.

## STOP conditions

Stop and report if:

- Plan 1 role resolver is unavailable.
- Plan 2 session continuation is unavailable.
- Implementing this requires provider-specific session internals.
- Dry-run would call a real provider or reviewer.
- You need GitHub, Linear, Jira, Inngest, tracker state, PRs, or inbox batch
  planning.
- You need to overwrite an existing `dev/plans/*.md`.
- A verification command fails twice after a focused fix attempt.

## Maintenance notes

Reviewers should scrutinize session reuse, no blind application of review
findings, final plan path safety, dry-run isolation, and the boundary between
factory run artifacts and normal plan-review artifacts.
