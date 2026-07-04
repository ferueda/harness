# Plan 260704-factory-intake-routing: Add deterministic factory intake routing

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report - do not improvise.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: `dev/plans/260621-agent-harness-handoff.md` for the active
  durability/inbox roadmap; this plan may start before `steps.json`, but must
  not reimplement resumability.
- **Category**: direction, dx

## Why this matters

The harness already has reusable skills, provider adapters, and callable review
workflows. The missing factory layer is intake: a deterministic way to turn an
idea, todo, or tracker item into one of a small number of next actions.

The source articles frame the goal as an automation-first SDLC: triage decides
whether work can be implemented directly, needs spec/planning, needs human
information, or should wait; implementation and review then become downstream
stations. The important adaptation for this repo: agents should produce
structured evidence, while harness code owns routing and artifact placement.

Build the first narrow slice: a local factory intake workflow that classifies
one work item, writes durable artifacts under target `.harness/`, and returns a
machine-readable route. Do not build hosted orchestration, tracker mutation, or
automatic PR creation in this plan.

## Source context

- Warp factory thesis:
  `https://www.warp.dev/blog/we-are-now-factory-engineers-not-product-engineers`
  says engineering shifts toward building the machine that ships product, with
  success measured by automated task percentage and cost.
- Attached article, "How to build a cloud software factory - the automatic
  triage skill": starts with `Triage -> Implementation`, four states
  (`ready-to-implement`, `ready-to-spec`, `needs-info`, `wait-to-implement`),
  and deterministic label application outside the agent.
- Spec-driven article in the user prompt: adds a spec station for work that is
  aligned but ambiguous/complex; specs become durable artifacts checked in with
  or before implementation.
- Warp demo triage skill:
  `https://raw.githubusercontent.com/warpdotdev-demos/cloud-factory-demo/refs/heads/main/.agents/skills/triage/SKILL.md`
  requires tracker context + codebase inspection, returns raw JSON, and does
  not mutate the tracker.
- Warp demo implementation skill:
  `https://raw.githubusercontent.com/warpdotdev-demos/cloud-factory-demo/refs/heads/main/.agents/skills/implementation/SKILL.md`
  reads specs first when present, validates, opens a PR, then posts the PR link.
- ADK graph-workflow idea from the user prompt: explicit graph edges and route
  strings beat prompt-only routing. Apply that here as a deterministic dispatch
  table over structured triage output.

## Current state

Relevant repo constraints:

- `docs/project-intent.md:5-12` says harness owns reusable skills, callable
  planning/review workflows, runner code, provider adapters, automations,
  plans, schemas, scripts, and review artifact conventions.
- `docs/project-intent.md:23-43` says this is not a target app template; durable
  docs must stay generic; artifacts belong under target `.harness/`; provider
  details stay behind adapters; runtime and exported schemas must stay aligned.
- `docs/project-intent.md:47-55` separates harness-owned reusable machinery from
  target-repo-owned docs, source, gates, and local skill installs.
- `docs/contributing/architecture.md:16-23` lists current public CLI surfaces:
  `init`, `run change-review`, `run plan-review`, `runs prune`, `models`, and
  `skills install`. No intake or dispatch command exists.
- `docs/contributing/architecture.md:77-94` documents the current run context:
  `lib/workflow-context.ts` creates run directories, writes prompts/reviewer
  JSON, emits events, and `workflows/review-steps.ts` owns shared review-step
  execution.
- `docs/contributing/architecture.md:133-137` says `steps.json`, graders,
  triggers, and Inngest are future work and must not be documented as current
  behavior until implemented.
- `dev/plans/260621-agent-harness-handoff.md:8-19` locks in the multi-repo
  model: harness runs against target repos via `--workspace`, artifacts live in
  target `.harness/`, LLMs produce structured JSON only, and workflows are
  runnable orchestration.
- `dev/plans/260621-agent-harness-handoff.md:31-35` queues `steps.json`,
  graders, trigger inbox, Inngest, capped fix/re-review, and hill-climbing
  later.
- `dev/plans/260621-agent-harness-handoff.md:89-95` orders extraction and inbox
  before Inngest. This plan must fit that sequence.

Executor constraints to carry through every PR:

- Durable docs must use generic target-repo examples and avoid private
  downstream paths.
- Factory artifacts belong under the target repo `.harness/` directory.
- Harness-owned schemas resolve from the harness checkout, not the target repo.
- Runtime Zod schemas and exported JSON schemas must stay aligned.
- Current behavior and planned follow-ups must be clearly separated in docs.
- Provider-specific details stay behind provider adapters.

Current CLI shape:

```ts
// bin/harness.ts:172-179
const run = program.command("run").description("Run a harness workflow");
addReviewCommand(run, {
  name: "change-review",
  description: "Run implementation, code-quality, and simplify reviewers",
  workflow: runChangeReview,
});
addPlanReviewCommand(run);
```

Current run context and artifact shape:

```ts
// lib/workflow-context.ts:178-233
const runId = buildRunId(startedAt);
const runDir = join(resolve(options.runsDir ?? join(workspace, ".harness/runs/reviews")), runId);
...
const eventSink = options.dryRun
  ? noopEventSink
  : options.eventSink
    ? createCompositeEventSink(createFileEventSink(runDir), options.eventSink)
    : createFileEventSink(runDir);
```

Current workflow pattern:

```ts
// workflows/change-review.workflow.ts:7-24
export const CHANGE_REVIEW_STEPS = ["implementation", "quality", "simplify"] as const;
const STEP_AGENTS = {
  implementation: "review-implementation",
  quality: "code-quality-review",
  simplify: "simplify",
} satisfies Record<ChangeReviewStepId, ReviewAgentName>;
```

Current review runner behavior:

```ts
// workflows/review-steps.ts:49-63
export async function runReviewSteps(ctx, title, steps, stepMetadata) {
  const reviewTasks = steps.map((step) => ({
    ...step,
    ...ctx.reviewInfo(step.agentName),
  }));
  const results =
    ctx.reviewConcurrency === "serial"
      ? await runReviewTasksSerially(ctx, reviewTasks)
      : await Promise.allSettled(reviewTasks.map((task) => runReviewTask(ctx, task)));
```

Test conventions:

- `test/cli.test.ts:23-33` uses `spawnSync(process.execPath, [HARNESS_BIN,
...args])` to exercise CLI commands.
- `test/cli.test.ts:35-43` builds temp git workspaces with an initial commit.
- `test/workflow-context.test.ts` and `test/review-steps.test.ts` use
  `createWorkflowContextForTest` and fake provider agents instead of calling
  real providers.

## Commands you will need

| Purpose                 | Command                                                                                                      | Expected on success             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| Install                 | `pnpm install --frozen-lockfile`                                                                             | exit 0                          |
| Targeted CLI tests      | `pnpm test -- test/cli.test.ts`                                                                              | exit 0, all selected tests pass |
| Targeted workflow tests | `pnpm test -- test/factory-intake.test.ts test/factory-triage.workflow.test.ts test/workflow-events.test.ts` | exit 0, all selected tests pass |
| Typecheck               | `pnpm typecheck`                                                                                             | exit 0, no TypeScript errors    |
| Full gate               | `pnpm check`                                                                                                 | exit 0                          |

## Suggested executor toolkit

| Step                  | Skill / resource                                                                             | Why                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| All implementation    | `implement-plan`                                                                             | Execute this plan phase by phase and update checkboxes.                    |
| Type/schema design    | `typescript-refactor`                                                                        | Keep discriminated unions, exported types, and route typing precise.       |
| Node CLI/runtime code | `node`                                                                                       | Match native TypeScript, ESM, signal/error-handling, and file IO patterns. |
| Zod schemas           | `zod`                                                                                        | Define structured factory triage output and parse untrusted JSON safely.   |
| Tests                 | `vitest`                                                                                     | Add isolated tests around routing, CLI, and workflow artifacts.            |
| Plan validation       | `review-spec` or `harness run plan-review --plan dev/plans/260704-factory-intake-routing.md` | Check this plan against code reality before executing large phases.        |
| Final review          | `change-review-workflow`                                                                     | Run implementation, quality, and simplify review after code changes.       |
| Handoff if partial    | `handoff-work`                                                                               | Preserve context if another agent continues.                               |

## Design decisions

1. **Use harness-native names internally.** External examples say
   `ready-to-spec`; this repo's planning stack is broader than PRODUCT/TECH
   specs. Use internal route `ready-to-plan`, and let future tracker adapters
   map it to a repo's preferred label such as `ready-to-spec`.
2. **Keep routing deterministic.** The agent returns structured JSON; code maps
   that JSON to exactly one next action. The provider must not mutate trackers,
   labels, branches, files outside the run artifact, or PRs.
3. **Start with file-backed work items.** Do not depend on GitHub, Linear, Jira,
   MCP, or web APIs in the first slice. Accept an `--item-file` JSON document
   and write local run artifacts. Tracker adapters can feed the same contract
   later.
4. **Classify against target intent.** Triage must read target repo intent docs
   when present (`docs/project-intent.md`, `VISION.md`, `roadmap.md`,
   `README.md`, `AGENTS.md`) and cite only files that exist. When `roadmap.md`
   is absent, `dev/plans/README.md` may substitute for harness-like repos. If no
   intent source exists, the route may still be `ready-to-implement` for a
   narrow bug, but broad product work should become `needs-info` or
   `wait-to-implement`.
5. **Do not build implementation automation yet.** The first downstream action
   is a suggested command or handoff. Automatic PR creation belongs in a later
   implementation-agent plan after intake routes are reliable.
6. **Do not build Inngest yet.** Keep the run synchronous and local. Leave
   hooks aligned with the active `steps.json` and inbox roadmap.
7. **Prompts before skills for runtime behavior.** The executable station is a
   prompt plus workflow plus schema. Add a packaged skill only after the runtime
   shape exists, so the skill documents how humans/agents operate or extend the
   station instead of becoming the station.
8. **GitHub first, adapters later.** The first tracker adapter should be GitHub
   Issues because this repo already centers GitHub PRs, labels, Actions, and
   review flows. Linear and Jira should feed the same `FactoryWorkItem` contract
   later, not fork the factory core.

## Development strategy

Build this as small vertical slices, not as a full factory rewrite.

1. **Contract and golden fixtures first.** Define `FactoryWorkItem`,
   `FactoryTriageOutput`, `FactoryRoutePlan`, and one representative fixture for
   each route. Prove deterministic routing with no LLM call.
2. **Prompt second.** Write `lib/prompts/factory-triage.ts` only after the schema
   exists. The prompt's job is narrow: inspect the target checkout and item,
   then return JSON matching `FactoryTriageOutputSchema`.
3. **Fake provider workflow third.** Wire `factory-triage.workflow.ts` with fake
   provider output before any live provider run. Prove artifacts, summary,
   live-run events, and route parsing locally.
4. **CLI dry-run fourth.** Expose the command and make `--dry-run` useful before
   live LLM calls. Dry-run should materialize prompt/meta/summary artifacts.
5. **Live provider fifth.** Only after schema, prompt, fake workflow, and CLI
   dry-run pass, allow real provider execution.
6. **Local inbox sixth.** Add file-backed dispatch after one-item triage is
   reliable. The inbox is the local precursor to tracker webhooks or scheduled
   polling.
7. **Tracker adapter seventh.** Add GitHub Issues as the first adapter in a
   follow-up plan. It should convert issue data into `FactoryWorkItem`, then
   pass through the same core route logic.
8. **Hosted orchestration last.** Add Inngest only after local runs, step
   durability, and inbox semantics are stable.

## CLI namespace rule

Use `harness run <workflow>` for one named workflow execution. Use
`harness factory <command>` for factory management, adapters, dispatch, queue
state, and multi-item operations.

Examples:

```bash
harness run factory-triage --item-file item.json
harness factory dispatch
harness factory linear fetch TEAM-123
harness factory github fetch 123
harness factory status
```

`factory-triage` is intentionally named with the `factory-` prefix. Do not name
the workflow only `triage`; that is too broad and can collide with issue
triage, review finding triage, plan triage, bug triage, or audit triage. The
name should identify the factory intake station the same way `change-review`
and `plan-review` identify review workflows.

## Implementation PR split

Do not land this as one giant PR. Implement as scoped, sequential PRs:

| PR  | Scope                        | Ships                                                                                                                                        |
| --- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Contract and single-item CLI | Schemas, route helpers, fixtures, prompt, dedicated factory workflow, `harness run factory-triage`, docs for current file-backed behavior.   |
| 2   | Local inbox dispatch         | `.harness/inbox/factory/` dispatcher, processed/failed moves, command-surface docs. Depends on PR 1.                                         |
| 3   | Packaged operating skill     | `skills/factory-triage-workflow/SKILL.md` documenting how to operate the shipped CLI. Depends on PR 1; may follow PR 2.                      |
| 4   | GitHub Issue adapter         | GitHub issue -> `FactoryWorkItem`, dry-run intended labels/comments, optional live deterministic label/comment application. Depends on PR 1. |
| 5   | Orchestrator                 | Inngest function over the stable route graph after `steps.json` and inbox semantics are stable. Depends on durability/inbox work.            |

This plan's required shippable slice is PR 1 only. PRs 2-5 are follow-up slices
captured here so the architecture stays coherent, but they must not be bundled
into PR 1.

## Orchestration direction

Start with the existing synchronous CLI runner. The next orchestration layers
should be:

1. Local run artifacts under `.harness/runs/factory/<run-id>/`.
2. `steps.json` durability once the active durability plan lands.
3. File-backed inbox dispatch.
4. GitHub Action or scheduled trigger that writes inbox files.
5. Inngest function over the same route graph.

PR 1 does not extend `harness runs prune`; factory runs under
`.harness/runs/factory/<run-id>/` are manually cleaned until a later plan updates
`lib/runs.ts` and the prune command.

Use Inngest as the default future orchestrator unless implementation evidence
changes that decision. It fits the current TypeScript/event-driven direction
and gives durable steps, retries, concurrency control, and observability without
forcing the first local slice into hosted infrastructure.

Do not add Trigger.dev, Temporal, or Hatchet in this plan. Keep them as
alternatives:

- Trigger.dev: reconsider if browser-visible job monitoring, managed long-running
  AI tasks, or human-in-the-loop UI becomes the dominant need.
- Temporal: reconsider if workflows become long-lived, business-critical, and
  worth the heavier deterministic workflow model.
- Hatchet: reconsider if self-hosted workers and queue/workflow ownership become
  more important than minimizing new infrastructure.

## Tracker direction

The factory core should stay tracker-agnostic:

```ts
type FactoryWorkItemSource = "file" | "github" | "linear" | "jira" | "manual";
```

First slice accepts `file`. First tracker adapter should be `github`.

GitHub adapter responsibilities for a follow-up plan:

- Read one GitHub Issue with title, body, labels, comments, linked PRs/issues,
  and attachments when accessible.
- Convert it into `FactoryWorkItem`.
- Run the same `factory-triage` workflow.
- In dry-run mode, report intended label/comment changes only.
- In live mode, apply labels/comments deterministically from `FactoryRoutePlan`,
  never directly from raw agent text.

Linear and Jira adapters should follow the same adapter boundary once GitHub is
proven.

## Proposed factory route contract

Structured triage output:

```ts
type FactoryRoute = "ready-to-implement" | "ready-to-plan" | "needs-info" | "wait-to-implement";

type FactoryTriageOutput = {
  route: FactoryRoute;
  confidence: "high" | "medium" | "low";
  rationale: string;
  evidence: Array<{
    kind: "tracker" | "code" | "docs" | "test" | "repo-state";
    path?: string;
    summary: string;
  }>;
  questions?: string[];
  reconsiderWhen?: string;
  suggestedNext: {
    action: "implement-directly" | "create-plan" | "ask-human" | "park";
    command?: string;
    artifact?: string;
  };
};
```

Routing semantics: the agent proposes `route`; harness code validates the route,
applies guardrails, and materializes exactly one `FactoryRoutePlan`. Harness does
not re-derive route from evidence in PR 1. Evidence-table enforcement stays
prompt-level until a later deterministic grader exists.

Deterministic route table and route-plan mapping:

| Route                | Required evidence                                                                                 | `statusLabel`        | `nextAction`         | `artifactRelPath`  | `humanSummary`                                        | `command` template / action                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------- | -------------------- | -------------------- | ------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `ready-to-implement` | Desired behavior clear, target code area identified, low risk, aligned with target intent.        | `ready-to-implement` | `implement-directly` | `factory-route.md` | `Ready for direct implementation after human check.`  | `Run implementation directly after human confirmation; no harness command in PR 1.`                                 |
| `ready-to-plan`      | Goal aligned and clear enough to plan, but ambiguous/complex/risky.                               | `ready-to-plan`      | `create-plan`        | `factory-route.md` | `Needs an implementation plan before coding.`         | `Use the planning-workflow coordinator to invoke create-plan, then run: harness run plan-review --plan <plan-path>` |
| `needs-info`         | Missing reproduction, acceptance criteria, environment, product decision, or target repo context. | `needs-info`         | `ask-human`          | `factory-route.md` | `Needs human clarification before routing further.`   | `Ask the emitted questions[]; rerun factory triage after answers arrive.`                                           |
| `wait-to-implement`  | Misaligned, duplicate, premature, too costly, or blocked by dependency/strategy.                  | `wait-to-implement`  | `park`               | `factory-route.md` | `Parked until the reconsideration condition changes.` | `Park until reconsiderWhen is true; rerun factory triage after that condition changes.`                             |

PR 1 always writes `factory-route.md` as the human-readable route artifact for
every route. Route-specific markdown files such as `factory-questions.md` or
`factory-planning-handoff.md` are deferred until a later PR.

Tracker label fields such as `applyLabel` and `removeLabels` are deferred until
the GitHub adapter PR. PR 1 triage output must not include tracker label fields.

## Scope

**In scope**:

- `lib/factory-intake.ts` - parse work items, build deterministic route plans,
  and render human-readable summaries.
- `lib/factory-schemas.ts` - Zod schemas and inferred types for work items,
  triage output, route plans, and run metadata.
- `schemas/factory-triage-output.schema.json` - exported JSON schema aligned
  with runtime Zod schema.
- `lib/prompts/factory-triage.ts` and `lib/prompts/index.ts` - triage prompt
  template.
- `workflows/factory-triage.workflow.ts` - one-agent factory triage workflow.
- `lib/factory-run-context.ts` - dedicated non-review run context for factory
  triage.
- `bin/harness.ts` - add `harness run factory-triage --item-file <path>`.
- `test/factory-intake.test.ts` - schema, route table, and summary tests.
- `test/cli.test.ts` - CLI help and dry-run coverage.
- `test/factory-triage.workflow.test.ts` - prompt/artifact/event tests using
  fake providers.
- `test/factory-triage-output-schema-sync.test.ts` - exported/runtime schema
  parity tests.
- `test/fixtures/factory/work-item.json` - minimal work-item fixture reused by
  CLI tests and docs examples.
- `docs/contributing/architecture.md` - update only after behavior lands.
- `README.md` - add concise usage only after CLI behavior lands.
- `dev/plans/README.md` - keep active plan queue current.

**Out of scope**:

- GitHub/Linear/Jira API integration.
- Applying tracker labels or comments.
- Creating branches, commits, or PRs for implementation.
- Creating PRODUCT.md/TECH.md as a dedicated spec workflow.
- Hosted Inngest orchestration.
- `steps.json` resumability, except for naming compatibility notes.
- Changing provider adapters except where an existing generic provider hook is
  reused.
- Private downstream repo examples or paths.

## Steps

### Step 1: Add factory intake schemas, fixtures, and pure routing helpers

Create `lib/factory-schemas.ts` with Zod schemas and exported inferred types:

- `FactoryWorkItemSchema`
  - `id`: non-empty string.
  - `source`: enum/string union for `file`, `github`, `linear`, `jira`,
    `manual`.
  - `title`: non-empty string.
  - `body`: string.
  - `url`: optional string URL.
  - `labels`: string array defaulting to `[]`.
  - `metadata`: optional record of JSON-safe values.
- `FactoryRouteSchema` with the four route values listed above.
- `FactoryTriageOutputSchema` matching "Proposed factory route contract".
- `FactoryRoutePlanSchema` containing:
  - `route`
  - `nextAction`
  - `statusLabel`
  - `artifactRelPath`
  - `humanSummary`
  - `command`: optional string for routes with a concrete next command.

Create `lib/factory-intake.ts` with pure functions:

- `parseFactoryWorkItem(input: unknown): FactoryWorkItem`
- `parseFactoryTriageOutput(input: unknown): FactoryTriageOutput`
- `buildFactoryRoutePlan(workItem, triageOutput): FactoryRoutePlan`
- `renderFactoryTriageSummary(workItem, triageOutput, routePlan): string`
- `renderFactoryRouteMarkdown(workItem, triageOutput, routePlan): string`

`buildFactoryRoutePlan` must map `triageOutput.route` to the fixed route-table
values for `statusLabel`, `nextAction`, `artifactRelPath`, `humanSummary`, and
`command`. It must ignore `triageOutput.suggestedNext.command` for PR 1; agent
text can explain a route, but harness code owns command templates and artifact
paths. Tests must assert each route fixture produces the expected table row.

`parseFactoryTriageOutput` owns cross-field validation through
`FactoryTriageOutputSchema.superRefine`. It must enforce the route/action table,
required `questions[]`, and required `reconsiderWhen`. `buildFactoryRoutePlan`
assumes a validated triage object and only materializes deterministic table
values.

`humanSummary` should be derived from a fixed per-route template table, not
generated free-form from the agent. `renderFactoryRouteMarkdown` should use
stable sections:

```md
# Factory Route

- Work item: <id> - <title>
- Route: <route>
- Next action: <nextAction>
- Confidence: <confidence>

## Rationale

<triage rationale>

## Evidence

- <kind>: <summary>

## Operator Next Step

<routePlan.command or action>
```

Add golden-string or stable substring tests for `factory-route.md` rendering for
each route.

Create test fixtures inline in `test/factory-intake.test.ts` or under
`test/fixtures/factory/` if the fixtures are large:

- `ready-to-implement`
- `ready-to-plan`
- `needs-info`
- `wait-to-implement`

Add a minimal CLI fixture at `test/fixtures/factory/work-item.json`:

```json
{
  "id": "local-1",
  "source": "file",
  "title": "Add clearer empty-state copy",
  "body": "The dashboard empty state should explain what to do next.",
  "labels": ["idea"]
}
```

The route planner must reject invalid combinations, for example:

| Route                | Required validation                                                            |
| -------------------- | ------------------------------------------------------------------------------ |
| `ready-to-implement` | `suggestedNext.action === "implement-directly"` and no required `questions[]`. |
| `ready-to-plan`      | `suggestedNext.action === "create-plan"`.                                      |
| `needs-info`         | `suggestedNext.action === "ask-human"` and at least one `questions[]` entry.   |
| `wait-to-implement`  | `suggestedNext.action === "park"` and non-empty `reconsiderWhen`.              |

Tests must cover each valid route and each rejection case above.

**Verify**: `pnpm test -- test/factory-intake.test.ts` -> route/schema tests
pass.

### Step 2: Export schema and schema sync test

Add `scripts` or test-local helper logic, using
`test/review-output-schema-sync.test.ts` as the pattern reference only, so
`schemas/factory-triage-output.schema.json` stays aligned with
`FactoryTriageOutputSchema`.

Do not invent a second schema-generation pattern if the repo already has one.
If the current exported review schema is hand-maintained, keep this schema
small and add tests that validate representative fixtures against both runtime
and exported schema.

Document the limitation in tests and comments: exported JSON Schema provides
structural provider guidance only. Cross-field route/action rules live in
`FactoryTriageOutputSchema.superRefine` and `parseFactoryTriageOutput`. Add one
fixture where JSON Schema accepts but Zod rejects, proving harness parsing is
the authoritative route guard.

**Verify**:

- `pnpm test -- test/factory-intake.test.ts test/factory-triage-output-schema-sync.test.ts`
  -> exit 0.
- `pnpm typecheck` -> exit 0.

### Step 3: Add the factory triage prompt and fake-provider workflow

Add `lib/prompts/factory-triage.ts` and export it through
`lib/prompts/index.ts`.

Prompt requirements:

- Include the work item title/body/labels from `--item-file`.
- Tell the agent to inspect target repo intent docs and nearby code before
  classifying.
- Tell the agent to return only JSON matching
  `schemas/factory-triage-output.schema.json`.
- State that the agent must not mutate files, trackers, branches, labels, or
  comments.
- Use route definitions from this plan.

Add `workflows/factory-triage.workflow.ts`:

- One LLM step named `factory-triage`.
- Serial by default.
- Writes:
  - `factory-triage.prompt.md`
  - `factory-triage.raw.json`
  - `factory-triage.json`
  - `factory-route.json`
  - `factory-route.md`
  - `summary.md`
  - `meta.json`
- Uses target `.harness/runs/factory/<run-id>/`, not the review run directory.
- Emits `events.jsonl` with step id `factory-triage` for live runs.
- On `--dry-run`, writes prompt and placeholder route without calling the
  provider, matching existing review dry-run behavior: no `events.jsonl` and no
  `eventsFile` field in `meta.json`.

Implement `lib/factory-run-context.ts` as a dedicated factory runner context.
It may reuse shared primitives such as `buildRunId`, event sinks, `Agent.run`,
provider selection, model options, timeout, signal handling, stream logging, and
`cleanupOrphanedRunDir`, but it must not use review-only abstractions.

Resolve the factory schema from the harness checkout, not from the target
workspace. Mirror the `HARNESS_ROOT` pattern in `lib/workflow-context.ts` and
define:

```ts
const FACTORY_TRIAGE_SCHEMA_PATH = join(HARNESS_ROOT, "schemas/factory-triage-output.schema.json");
```

Pass that absolute path to `Agent.run({ schemaPath: FACTORY_TRIAGE_SCHEMA_PATH,
... })`. Target repositories invoked with `--workspace` do not own this schema.

Minimum `FactoryRunContext` surface:

```ts
type FactoryRunContext = {
  runId: string;
  runDir: string;
  workspace: string;
  workItem: FactoryWorkItem;
  dryRun?: boolean;
  eventSink: WorkflowEventSink;
  invokeTriageAgent(): Promise<FactoryTriageOutput>;
  export(input: { triage: FactoryTriageOutput; routePlan: FactoryRoutePlan }): FactoryRunMeta;
  exportFailed(error: unknown): FactoryRunMeta;
};
```

Factory run-context construction input:

```ts
type FactoryRunContextFactoryOptions = {
  workspace: string;
  runsDir?: string;
  workItem: FactoryWorkItem;
  agentProvider?: AgentProviderName;
  codexPathOverride?: string;
  model?: string;
  sandboxMode?: AgentSandboxMode;
  approvalPolicy?: AgentApprovalPolicy;
  modelReasoningEffort?: AgentReasoningEffort;
  maxRuntimeMs: number;
  dryRun?: boolean;
  signal?: AbortSignal;
  eventSink?: WorkflowEventSink;
  agentProviderFactory?: (options: AgentProviderOptions) => Agent;
};
```

`includeGitScope` is intentionally omitted; factory triage is not a diff-scope
workflow.

Factory-specific code owns route meta, factory artifacts, and summary rendering.
No verdict aggregation exists for factory triage.

Responsibility split:

- `lib/factory-run-context.ts` owns run bootstrap, `context/work-item.json`,
  prompt rendering, `Agent.run`, schema parsing, route-plan building, artifact
  writes, `export`, and `exportFailed`. It may throw typed
  `FactoryTriageError` values after preserving any artifacts it already wrote.
- `workflows/factory-triage.workflow.ts` owns workflow-level sequencing only:
  `run:start`, `step:start`, `invokeTriageAgent`, `step:end`, and `run:end`. It
  catches `FactoryTriageError`, emits failed step/run events, calls
  `ctx.exportFailed`, returns failed meta, and does not rethrow.

Add a test-only seam:

```ts
export function createFactoryRunContextForTest(
  options: FactoryRunContextFactoryOptions,
): FactoryRunContext;
```

Production callers use `createFactoryRunContext`. Tests use
`createFactoryRunContextForTest` to inject fake `Agent.run` results through the
same workflow path. Do not call live providers in workflow tests.

Failure contract:

- `invokeTriageAgent` returns `FactoryTriageOutput` only after provider output
  passes structural parsing and route guard validation.
- Provider, schema, route-plan, and artifact-write failures become
  `FactoryTriageError` with a stable `message` and optional `cause`.
- Dry-run short-circuits inside `invokeTriageAgent` and never calls `Agent.run`.
- The workflow catches `FactoryTriageError`, writes failed `meta.json` through
  `ctx.exportFailed`, emits `step:end`/`run:end` failed events for live runs,
  returns failed meta, and leaves exit-code handling to the CLI.

Mirror `workflows/plan-review.workflow.ts` for event sequencing:

- `run:start`
- `step:start`
- optional `step:heartbeat`
- `step:end`
- `run:end`

Factory step events must include:

- `stepId: "factory-triage"`
- `cliStep: "factory-triage"`
- `outputs` on successful `step:end`:
  - `factory-triage.prompt.md`
  - `factory-triage.raw.json`
  - `factory-triage.json`
  - `factory-route.json`
  - `factory-route.md`
  - `summary.md`
  - `meta.json`

Forbidden approaches:

- Do not add `factory-triage` to `REVIEWER_CONFIGS`.
- Do not type the factory agent as `ReviewAgentName`.
- Do not call `runReviewSteps`.
- Do not parse factory output with `ReviewOutputSchema`.
- Do not aggregate a factory route into a review verdict.

The CLI action must avoid git diff scope for factory triage. If code reuses
shared context options, pass `includeGitScope: false` and test that dry-run meta
has no `scope` and no `context/diff.patch`.

PR 1 `meta.json` shape:

```json
{
  "runId": "20260704-000000-abc123",
  "workflow": "factory-triage",
  "status": "completed",
  "workspace": "/path/to/repo",
  "runDir": "/path/to/repo/.harness/runs/factory/20260704-000000-abc123",
  "workItem": { "id": "123", "source": "file", "title": "Short title" },
  "route": "ready-to-plan",
  "nextAction": "create-plan",
  "artifacts": {
    "triage": "factory-triage.json",
    "route": "factory-route.json",
    "routeSummary": "factory-route.md",
    "summary": "summary.md"
  },
  "agent": { "name": "cursor", "model": "composer-2.5" },
  "startedAt": "2026-07-04T00:00:00.000Z",
  "durationMs": 1000,
  "eventsFile": "events.jsonl"
}
```

For dry-run, omit `eventsFile` and `scope`; keep `status: "dry_run"` and write
placeholder `factory-triage.json`, `factory-route.json`, `factory-route.md`, and
`summary.md`.

Failed `meta.json` shape:

```json
{
  "runId": "20260704-000000-abc123",
  "workflow": "factory-triage",
  "status": "failed",
  "workspace": "/path/to/repo",
  "runDir": "/path/to/repo/.harness/runs/factory/20260704-000000-abc123",
  "workItem": { "id": "123", "source": "file", "title": "Short title" },
  "agent": { "name": "cursor", "model": "composer-2.5" },
  "startedAt": "2026-07-04T00:00:00.000Z",
  "durationMs": 1000,
  "eventsFile": "events.jsonl",
  "error": "provider failed"
}
```

Failed runs preserve already-written prompt, raw, stream, context, and event
artifacts. They exit `1` because the run failed, not because of any route
outcome.

Define a canonical dry-run fixture:

```ts
const DRY_RUN_FACTORY_TRIAGE = {
  route: "needs-info",
  confidence: "low",
  rationale: "(dry-run placeholder)",
  evidence: [{ kind: "repo-state", summary: "(dry-run placeholder)" }],
  questions: ["(dry-run placeholder)"],
  suggestedNext: { action: "ask-human" },
} satisfies FactoryTriageOutput;
```

Dry-run `factory-route.json` must be the result of
`buildFactoryRoutePlan(workItem, DRY_RUN_FACTORY_TRIAGE)`, so dry-run artifacts
exercise the same route-plan code path.

Live run sequence:

1. Create `runDir` under `.harness/runs/factory/<run-id>/`.
2. Copy the parsed work item to `context/work-item.json`.
3. Render and write `factory-triage.prompt.md`.
4. Call `Agent.run` with:
   - `workspace`
   - rendered prompt
   - `schemaPath: FACTORY_TRIAGE_SCHEMA_PATH`
   - resolved model/policy options
   - `maxRuntimeMs`
   - `logPath: factory-triage.stream.jsonl`
   - `signal`
5. Write `factory-triage.raw.json` from the provider result.
6. If the provider failed, call `exportFailed`, emit failed step/run events,
   preserve partial artifacts, and exit with code 1.
7. Parse `result.structuredOutput` through `parseFactoryTriageOutput`.
8. Build the route plan with `buildFactoryRoutePlan`.
9. Write `factory-triage.json`, `factory-route.json`, `factory-route.md`,
   `summary.md`, and `meta.json`.
10. Emit live-run events using the plan-review event sequence.

The workflow must catch failures from `parseFactoryTriageOutput`,
`buildFactoryRoutePlan`, and artifact writing after partial artifacts exist. On
those failures, it must emit `step:end` with `status: "failed"`, call
`exportFailed`, write failed `meta.json`, return failed meta, and exit `1`
without deleting `runDir`. Add a workflow test where fake provider structured
output fails schema/route validation and assert `meta.json`,
`factory-triage.raw.json`, and `factory-triage.prompt.md` remain.

If `factory-run-context.ts` starts duplicating large parts of
`lib/workflow-context.ts`, extract only shared non-review primitives into a
small helper before continuing. Shared code may cover run directory bootstrap,
provider factory wiring, dry-run event-sink selection, and stream artifact
recording; it must not include review prompt configs, review parsing, or verdict
aggregation.

The first workflow tests must use fake provider output. Do not call Cursor,
Codex, GitHub, Linear, Jira, or network APIs in unit tests.

**Verify**:

- `pnpm test -- test/factory-intake.test.ts test/factory-triage.workflow.test.ts`
  -> factory routing, artifacts, and live-run event tests pass.
- `pnpm test -- test/workflow-events.test.ts` -> existing review event/dry-run
  contracts still pass.

### Step 4: Add CLI command

In `bin/harness.ts`, add:

```bash
harness run factory-triage --workspace /path/to/repo --item-file /path/to/item.json --dry-run
```

Options should mirror review commands where they make sense:

- `--workspace`
- `--item-file` required
- `--runs-dir` defaulting to `<workspace>/.harness/runs/factory`
- `--agent`
- `--codex-executable`
- `--model`
- `--sandbox`
- `--approval-policy`
- `--reasoning-effort`
- `--max-runtime-ms`
- `--dry-run`
- `--verbose`

Do not add `--base`, `--head`, `--plan`, `--handoff`, or `--steps` unless a
current factory requirement needs them. Triage is about the target checkout and
one work item, not a diff review.

Resolve `--item-file` like `--plan`: absolute paths pass through; relative
paths resolve from `workspace`, not process cwd. Add CLI tests for both absolute
and workspace-relative paths.

Add `assertItemFileExists(workspace, itemFile)` before
`createFactoryRunContext`, matching the `assertPlanFileExists` pattern. Missing
item files exit `1` with a concise error. Add a CLI test for a nonexistent item
path.

Factory triage needs its own Commander action. Do not reuse `addReviewCommand`
or review exit-code logic. Set `process.exitCode` from run status and caught
errors only, never from route outcome.

Do not copy the plan-review catch pattern that calls
`cleanupOrphanedRunDir(ctx.runDir)` after context creation. For factory triage,
cleanup is allowed only inside `lib/factory-run-context.ts` during bootstrap
before durable artifacts are written. After `createFactoryRunContext` succeeds,
CLI catch handlers must preserve `runDir`. Add a CLI test that simulates a
post-bootstrap workflow failure and asserts `runDir`,
`factory-triage.prompt.md`, and `meta.json` remain.

The factory command must still reuse existing config resolution:

- Use `resolveHarnessOptions` for `workspace`, `agent`, `model`, provider
  executable, and policy defaults where applicable.
- Pass/represent `includeGitScope: false` in the factory path; factory triage is
  not a diff workflow.
- Use the same Codex defaults as review/plan-review (`read-only`, `never`, high
  effort) unless the caller passes explicit overrides.

The final stdout JSON should include:

- `runId`
- `workflow`
- `status`
- `workspace`
- `runDir`
- `workItem`
- `route`
- `nextAction`
- `summaryPath`
- `triagePath`
- `routePath`
- `routeSummaryPath`

Exit code contract:

- `0` for successful triage with any valid route, including `needs-info` and
  `wait-to-implement`.
- `1` for provider, schema validation, file read, or workflow failures.
- `2` for Commander usage errors, matching existing CLI behavior.

**Verify**:

- `pnpm test -- test/cli.test.ts` -> existing CLI tests and new factory CLI
  tests pass.
- `node bin/harness.ts run factory-triage --help` -> exits 0 and shows
  `--item-file`, `--dry-run`, and `--verbose`.

### Step 5: Stop PR 1 at single-item triage

PR 1 must stop after the one-item `harness run factory-triage` command works.
Do not add local inbox dispatch in PR 1.

Before opening PR 1, confirm:

- `harness run factory-triage --help` works.
- Dry-run writes `.harness/runs/factory/<run-id>/` artifacts.
- Live-run path is tested with fake provider output.
- Docs describe only file-backed single-item triage.

**Verify**: `pnpm check` -> full gate passes for PR 1.

### Step 6: Follow-up PR 2: add local inbox dispatch without tracker mutation

After PR 1 lands, add a file-backed dispatcher helper, not a hosted daemon:

- Inbox path: `<workspace>/.harness/inbox/factory/*.json`.
- Each inbox JSON is a `FactoryWorkItem`.
- New command:

```bash
harness factory dispatch --workspace /path/to/repo --dry-run
```

If adding a top-level `factory` command feels too broad, add only a helper
function and defer the command. Do not force this into `harness run` if it reads
multiple inbox items; `harness run` should remain one workflow execution.

Dispatcher behavior:

- Sort inbox files by name for deterministic processing.
- For each item, invoke the same triage workflow path as Step 4.
- On success, move the inbox file to
  `.harness/inbox/factory/processed/<run-id>-<basename>.json`.
- On failure, move it to `.harness/inbox/factory/failed/<run-id>-<basename>.json`
  and write a sibling `.error.json`.
- In `--dry-run`, do not move files.

This is the local precursor to GitHub Actions/Linear polling/Inngest. Do not
add polling or webhooks in this PR.

Inbox relationship to existing roadmap:

- `.harness/inbox/review.json` from `dev/plans/260621-agent-harness-handoff.md`
  is the future review-trigger inbox.
- `.harness/inbox/factory/*.json` is a separate factory-intake namespace.
- If the handoff roadmap lands a generic inbox contract first, adapt PR 2 to
  that contract instead of creating a conflicting one.

**Verify**:

- `pnpm test -- test/factory-intake.test.ts test/cli.test.ts` -> dispatcher
  tests pass.
- `pnpm test -- test/factory-dispatch.test.ts` -> inbox move/retain behavior
  passes if dispatcher tests are split into their own file.
- Manual dry run in a temp workspace leaves inbox files unmoved.

### Step 7: Follow-up PR 3: add operating skill after runtime behavior exists

Do not create a packaged `factory-triage-workflow` skill in PR 1. Add it only
after the CLI behavior is stable.

When added, the skill should explain how to operate factory intake:

- Prepare or fetch one work item.
- Run `harness run factory-triage`.
- Read `factory-route.json` and `summary.md`.
- Decide whether to proceed to direct implementation, `planning-workflow`, human
  questions, or parking.
- Avoid tracker mutation unless a tracker adapter command explicitly owns it.

This skill should not duplicate the prompt or schema.

**Verify**: no skill files are added before PR 1 runtime command and tests pass.

### Step 8: Update docs as planned/current truth

After code lands:

- Update `README.md` with a concise "Factory Intake" section showing:

```bash
harness run factory-triage --workspace /path/to/repo --item-file work-item.json --dry-run
```

Keep the README addition to one short example plus links; `test/docs-contracts`
enforces a README size ceiling.

- Update `docs/contributing/architecture.md`:
  - Add `harness run factory-triage` to current public CLI surfaces.
  - Add factory run artifacts under `.harness/runs/factory/<run-id>/`.
  - State that `file` is the only current source.
  - Keep Inngest, GitHub/Linear/Jira adapters, tracker mutation, and automatic
    implementation in the future work section unless implemented.
- Update `docs/contributing/script-command-surface.md`:
  - Add `harness run factory-triage`.
  - Document dry-run mutability and factory run artifact paths.
  - Add `harness factory dispatch` only in PR 2, not PR 1.
- Update `docs/contributing/setup-manifest.md`:
  - Add `.harness/runs/factory/<run-id>/`.
  - Document ownership/mutability parallel to review runs.
  - State that target repos do not own
    `schemas/factory-triage-output.schema.json`; it resolves from the harness
    checkout.
- Update `dev/plans/README.md` only if this plan status changes.
- Add a lightweight `scripts/smoke-dist.ts` assertion for
  `harness run factory-triage --help` after the command ships. PR 1 does not
  need a full dist dry-run smoke; CLI/unit tests own behavior coverage.

**Verify**:

- `pnpm test -- test/docs-contracts.test.ts` -> docs contract tests pass.
- `pnpm check` -> full gate passes.

### Step 9: Review and close each PR

Run the change review workflow for each scoped PR with a self-contained handoff
that includes:

- What factory intake does and does not do.
- New route contract.
- Artifact paths.
- Verification commands and results.
- Explicit note that tracker mutation and hosted orchestration are out of
  scope.

Use:

```bash
printf '%s\n' "$HANDOFF" | node bin/harness.ts run change-review --workspace . --base main --head HEAD --handoff-stdin --verbose
```

Run this from the harness repo root when dogfooding the harness checkout.

Triage reviewer findings using `change-review-workflow`, apply accepted fixes,
and rerun relevant tests.

**Verify**: final `pnpm check` -> exit 0.

## Test plan

- `test/factory-intake.test.ts`
  - Parses valid `FactoryWorkItem` input.
  - Rejects missing `id`/`title`.
  - Accepts exactly four route values.
  - Rejects `needs-info` with no questions.
  - Rejects `wait-to-implement` with no `reconsiderWhen`.
  - Rejects every route whose `suggestedNext.action` does not match the route
    validation table.
  - Maps each route to the expected deterministic next action.
  - Renders summaries without leaking raw provider output.
- `test/factory-triage-output-schema-sync.test.ts`
  - Runtime and exported factory triage schemas accept/reject the same
    representative fixtures.
- `test/cli.test.ts`
  - `harness run factory-triage --help` exits 0.
  - Missing `--item-file` exits 2.
  - Invalid item JSON exits 1 with a concise error.
  - Absolute and workspace-relative `--item-file` paths both work.
  - `--dry-run` writes prompt/meta/summary artifacts and does not call provider.
- Workflow/context tests
  - Fake provider output is parsed through `FactoryTriageOutputSchema`.
  - Live fake-provider run passes an absolute harness-root
    `schemas/factory-triage-output.schema.json` path into `Agent.run`.
  - Live fake-provider run writes `events.jsonl` with `run:start`,
    `step:start`, `step:end`, `run:end`.
  - Run setup writes `context/work-item.json`.
  - Dry-run omits provider call and still writes deterministic artifacts.
  - Dry-run omits `events.jsonl`, `eventsFile`, `scope`, and
    `context/diff.patch`.
- Docs/schema tests
  - Exported schema and runtime schema accept the same representative fixtures.
  - Architecture docs list only implemented current behavior.

## Done criteria

ALL must hold:

- [x] `harness run factory-triage --help` exits 0.
- [x] `harness run factory-triage --workspace <tmp-repo> --item-file <tmp-json> --dry-run`
      writes a run under `<tmp-repo>/.harness/runs/factory/<run-id>/`.
- [x] `factory-triage.json` and `factory-route.json` exist for a dry run.
- [x] `FactoryTriageOutputSchema` rejects malformed route output.
- [x] At least one test covers each route.
- [x] `test/factory-triage.workflow.test.ts` exists and uses
      `createFactoryRunContextForTest`.
- [x] PR 1 contains only contract/helpers, prompt, one-item workflow/CLI, tests,
      and docs for current behavior.
- [x] No tracker labels, comments, branches, commits, or PRs are mutated by
      factory triage.
- [x] `README.md` and `docs/contributing/architecture.md` describe only shipped
      factory behavior.
- [x] `pnpm check` exits 0.
- [x] `dev/plans/README.md` remains consistent with this active plan.

## STOP conditions

Stop and report back if:

- Implementing factory triage requires changing provider adapter public
  contracts instead of reusing the existing `Agent.run` shape.
- Implementing `lib/factory-run-context.ts` appears to require copying large
  review-specific logic or depending on review-only types.
- The active `steps.json` plan has landed and changed artifact/run semantics in
  ways this plan no longer matches.
- Tracker mutation becomes necessary to prove value; that is a separate plan.
- The first slice grows to include implementation PR creation or Inngest.
- PR 1 grows to include inbox dispatch, tracker adapters, packaged skills, or
  hosted orchestration.
- `pnpm check` fails twice on unrelated existing failures; capture the failing
  step and stop.

## Maintenance notes

- This plan creates the factory control plane vocabulary. Future plans should
  add tracker adapters, spec/plan generation, implementation PR creation,
  verification, and self-improvement as separate slices.
- The most important review question: is routing truly deterministic after the
  agent returns JSON?
- Keep route labels and state names stable. Renames will affect inbox files,
  future tracker adapters, and automation metrics.
- When `steps.json` lands, factory runs should align step ids and artifact
  status with that contract rather than inventing a parallel durability format.
- Metrics are intentionally deferred, but the route contract should make them
  easy later: count routes, confidence, automation depth, duration, and human
  intervention reason.
