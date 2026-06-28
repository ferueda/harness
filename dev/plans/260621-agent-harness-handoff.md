# Agent Harness — Work Handoff

**Status:** `in_progress`  
**Created:** 2026-06-21  
**Updated:** 2026-06-27
**Repo:** `harness` (this repo)  
**Owner:** Felipe

---

## Executive summary

**`harness`** is the single repo for agent instructions, callable workflows, and the runner that orchestrates multi-agent coding workflows (review, implement, verify) across **many target repos**, with **durable execution** as the long-term goal.

**Done today:** TypeScript CLI (`harness run change-review`), three-step review workflow (`implementation` → `quality` → `simplify`), SDK reviewers (Cursor SDK default, Codex SDK), `*.stream.jsonl` + `events.jsonl` observability, SDK `AbortSignal` / `aborted` results, schema-aware JSON extraction, artifact export to `<target-repo>/.harness/runs/reviews/`, user install, `harness init`, partial runs via `--steps`, handoff stdin, run pruning. Ad-hoc Cursor delegation via `skills/cursor-cli/` (`cursor-cli` launcher).

**Next priorities:** `steps.json` resumability, `digestReview()`, deterministic graders, inbox triggers (Phase 1.5), and **Inngest orchestrator** (Phase 2).

---

## Context

### Goal

Build production-grade **agent loop architecture** for Felipe's personal coding workflow:

1. Run agents against **external repos** (`--workspace /path/to/app`)
2. Keep **one `harness` repo** to maintain; target repos stay clean
3. Persist **audit artifacts** in each target repo (`.harness/`)
4. Compose existing **skills** (`implement-plan`, `handoff-work`, `review-implementation`, `code-quality-review`, `simplify-review`, `react-to-review`) into automated pipelines
5. Evolve toward **durable orchestration** (checkpointed steps, retries, triggers, hill-climbing meta-loops)

### What “done” looks like (north star)

| Layer | Primitive | End state |
|-------|-----------|-----------|
| **Instructions** | `skills/*/SKILL.md` in `harness` | Model-agnostic playbooks; installed to target `~/.agents/skills/` or packaged fallback |
| **Workflows** | `workflows/*.workflow.ts` in `harness` | Multi-step pipelines: verify → review → export |
| **Orchestrator** | Inngest (planned Phase 2) | `step.run()` checkpointing, cron/webhooks, `onFailure`, concurrency |
| **Artifacts** | `.harness/` in target repos | Step traces, JSON reviews, `summary.md`, resumable `steps.json` |
| **Triggers** | GH Actions → inbox → Inngest | Loop 3: event-driven, not manual-only |

### Constraints (locked decisions)

1. **Single repo:** `harness` owns instructions, workflows, runner, and future orchestrator code
2. **Invocation:** harness always takes `--workspace <target-repo>`; never copy harness into each app
3. **Artifacts:** live in **target repo** at `.harness/` (gitignored); not in harness repo
4. **Export rule:** LLM produces structured JSON; **code** produces human reports (`summary.md`) — never ask an LLM to write final artifacts
5. **Human gates:** `react-to-review` and merge remain human/agent decisions; harness does not auto-merge or auto-fix without explicit future phase
6. **Terminology:** use **skills** only for `SKILL.md` instructions; use **workflows** or **pipelines** for runnable orchestration

### Out of scope (for now)

- Self-authoring loops (Inngest utah sidecar pattern)
- Auto-mutating skill prompts without human PR (Loop 4 hill-climbing is Phase 3+)
- Full Inngest deployment (Phase 2)
- Moving `cursor-cli` outside `skills/`

---

## Reference material

### Articles (frameworks to design against)

**1. Agent Loop Architecture (Inngest)**  
Three layers:

- **Loop** — cron/trigger + LLM decision-maker
- **Skill** (their term) — durable multi-step workflow with checkpointing
- **Orchestrator** — retries, concurrency, run history, `onFailure`

Key requirements durability enables: independent step retry, sub-agent lifecycle, guaranteed delivery, post-hoc observability, hot-deploy, concurrency control. Step-level checkpointing saves tokens on retry.

**2. The Art of Loop Engineering (LangChain / loopcraft)**  
Four stacked loops:

| Loop | Purpose | Our mapping |
|------|---------|-------------|
| 1 Agent | model + tools until done | `implement-plan`, `cursor-cli` |
| 2 Verification | grader + retry with feedback | `change-review` (+ future deterministic graders) |
| 3 Event-driven | triggers at scale | GH Action / inbox / Inngest (not built) |
| 4 Hill climbing | traces → improve harness | meta-review over `.harness/` (not built) |

**3. TradingFlow (Claude Code Dynamic Workflow)**  
https://github.com/lxcong/TradingFlow/blob/main/tradingflow.workflow.js

Reference implementation for **workflow composition** (not durability). Study for DSL shape, not execution engine.

---

## Architecture vision

```
┌─────────────────────────────────────────────────────────────────┐
│  harness (this repo)                                             │
│  skills/           review-implementation, code-quality-review,   │
│                    simplify-review, implement-plan, ...          │
│  workflows/        change-review.workflow.ts, review-steps.ts    │
│  lib/              workflow-context, aggregate, config, ...      │
│  providers/        cursor sdk, codex sdk, legacy cursor cli       │
│  orchestrator/     (Phase 2: Inngest functions — not built)    │
└────────────────────────────┬────────────────────────────────────┘
                             │ CLI runs with --workspace
┌────────────────────────────▼────────────────────────────────────┐
│  target-repo (any app)                                           │
│  harness.json, src/..., dev/plans/ (optional)                    │
│  .harness/runs/reviews/<run-id>/  ← artifacts                  │
└─────────────────────────────────────────────────────────────────┘
```

### End-to-end workflow (target)

```
implement-plan → handoff-work → [harness: verify → change-review → export]
  → react-to-review (human/agent triage) → human merge
```

---

## Current codebase (2026-06-25)

### Repo layout

```
harness/
├── bin/harness.ts                  # CLI entrypoint
├── workflows/
│   ├── change-review.workflow.ts   # implementation + quality + simplify
│   └── review-steps.ts             # shared step runner, WorkflowContext type
├── lib/
│   ├── workflow-context.ts         # ctx.agent, ctx.aggregate, ctx.export
│   ├── aggregate.ts                # verdict rollup, renderSummary()
│   ├── context.ts                  # git scope, run context, run ID
│   ├── config.ts                   # harness.json resolution
│   ├── agent-provider.ts           # cursor / codex factory
│   ├── agents.ts                   # provider contract
│   ├── handoff.ts                  # --handoff-stdin validation
│   ├── runs.ts                     # runs prune
│   ├── schemas.ts                  # Zod review output
│   └── review-prompts.ts
├── providers/
│   ├── cursor/                     # Cursor SDK provider
│   └── codex/                      # Codex SDK
├── schemas/review-output.schema.json
├── skills/                         # packaged skills (review, plan, handoff, ...)
├── .agents/skills/                 # repo-local dev skills (change-review-workflow)
├── automations/                    # find-bugs, test-coverage (markdown specs)
├── install                         # user-level harness install
└── dev/plans/
```

### CLI surface

```bash
harness init [--workspace <path>]
harness run change-review [--workspace <path>] [--base main] [--head HEAD]
  [--plan <path>] [--handoff <path>] [--handoff-stdin]
  [--steps implementation,quality,simplify] [--agent cursor|codex]
  [--dry-run]
harness runs prune --older-than 30d [--dry-run]
harness skills install <skill> [--workspace <path>]
harness models
```

Default workflow: all three reviewers. Partial runs:

```bash
harness run change-review --steps implementation
harness run change-review --steps implementation,quality
```

Handoff pipe:

```bash
printf '%s\n' "$HANDOFF" | harness run change-review --handoff-stdin
```

Pinned target-repo command after `harness init`:

```bash
/path/to/repo/.harness/bin/harness run change-review
```

### Review workflow behavior

`change-review.workflow.ts` maps steps to skills:

| Step ID | Agent / skill |
|---------|---------------|
| `implementation` | `review-implementation` |
| `quality` | `code-quality-review` |
| `simplify` | `simplify-review` |

`review-steps.ts` runs selected steps and aggregates. **Concurrency today:** all review providers run reviewers in parallel. The Cursor SDK runtime uses a final git status guard to reject review runs that modify tracked workspace status outside `.harness/`.

On partial failure: `status: "failed"`, `failedReviews` in `meta.json`, successful peer reviews preserved, `summary.md` written, exit `1`.

### Agent providers

| Provider | Runtime | Notes |
|----------|---------|-------|
| Cursor | `sdk` (default) | in-process `@cursor/sdk`; requires `CURSOR_API_KEY`; parallel reviewers; git status guard |
| Codex | SDK | `@openai/codex-sdk`; `codex login` or `CODEX_API_KEY`; parallel reviewers |
| Cursor | SDK | `providers/cursor/cursor-sdk-agent.ts` — default review provider |
| Cursor (ad-hoc) | skill | `skills/cursor-cli/` — `cursor-cli` launcher for delegation outside harness |

Configured per target repo in `harness.json` under `agents.{cursor,codex}`.

### Artifact layout (current)

`<workspace>/.harness/runs/reviews/<run-id>/`:

```
meta.json                         # run metadata, verdict, scope, step metadata, streamArtifacts, eventsFile
summary.md                        # human rollup (deterministic renderSummary)
events.jsonl                      # step lifecycle timeline (non-dry-run)
implementation-review.json
quality-review.json
simplify-review.json
implementation-review.stream.jsonl
quality-review.stream.jsonl
simplify-review.stream.jsonl
implementation-review.raw.json
quality-review.raw.json
simplify-review.raw.json
implementation-review.prompt.md
quality-review.prompt.md
simplify-review.prompt.md
context/diff.patch
context/plan.md                   # if --plan provided
context/handoff.md                # if --handoff or --handoff-stdin
```

`meta.json` includes `WorkflowStepMetadata` (`workflow`, `requestedSteps`, `executedSteps`, `omittedSteps`, `partial`), `streamArtifacts` (per-stage SDK stream log index), and `eventsFile` on completed/failed runs. **No** separate `steps.json` yet.

### Verification

```bash
pnpm check          # format, lint, typecheck, test, build smoke
# full check: format, lint, typecheck, tests, build smoke
```

### Known limitations (today)

- **Not durable:** process death mid-run → full re-run, duplicate tokens
- **No `steps.json` resumability:** step status not persisted for restart
- **No `digestReview()`:** full prior review JSON inlined where prompts need prior context
- **LLM-only verification:** no deterministic pre-checks (tests/lint)
- **No triggers:** manual CLI only (no inbox, no Inngest)
- **No orchestrator/** folder yet

### Completed since original plan (2026-06-21)

| Item | Notes |
|------|-------|
| `harness` repo created | migration from `agent-skills` done |
| `change-review` workflow | replaced `dual-review` / `review` / `review-full` |
| TypeScript runner | `bin/harness.ts`, not `.mjs` |
| `--steps` partial runs | `change-review --steps implementation,quality` |
| User install | `install` script → `~/.local/bin/harness` |
| `harness init` | `harness.json`, `.gitignore`, `.harness/bin/harness` shim |
| Multi-provider | Cursor SDK default + Codex SDK + legacy Cursor CLI |
| Handoff stdin | `--handoff-stdin` |
| Run pruning | `harness runs prune` |
| Simplify reviewer | third step in change-review |
| Cursor SDK default model | `composer-2.5` via `DEFAULT_AGENT_MODELS.cursor` |
| Schema-aware JSON extraction | PR [#33](https://github.com/ferueda/harness/pull/33) |
| SDK stream logs | PR [#34](https://github.com/ferueda/harness/pull/34) — `streamArtifacts`, `*.stream.jsonl` |
| Workflow step events | PR [#34](https://github.com/ferueda/harness/pull/34) — `events.jsonl`, `--verbose` |
| SDK abort signal | PR [#36](https://github.com/ferueda/harness/pull/36) — `signal`, `aborted` result |

---

## Inngest — where it fits, when, and how

### What Inngest is (in our model)

Inngest is the **orchestrator layer** — not a skill, not a workflow definition, not artifact storage. It sits between **triggers** and **workflow code**.

| Piece | Owner |
|-------|-------|
| What to review, prompts, verdict logic | `workflows/` + `lib/` (unchanged) |
| Where results go | target repo `.harness/runs/reviews/<run-id>/` (unchanged) |
| When a review starts | Inngest event (webhook, cron, GH Action → inbox) |
| Running steps reliably across failures/deploys | Inngest `step.run()` |
| Don't run two reviews on the same SHA | Inngest concurrency key |
| Tell me when it failed | Inngest `onFailure` + notifier |

**Mental model:** `harness run change-review` becomes an Inngest function where each logical step in that command is wrapped in `step.run()`.

### When to adopt

| Phase | Deliverable | Inngest role |
|-------|-------------|--------------|
| **0.6** | `steps.json` resumability (local file contract) | None — same semantics, no external deps |
| **1.5** | GH Action + `.harness/inbox/review.json` | Optional: inbox watcher can POST to Inngest; GH Actions alone is acceptable |
| **2** | `orchestrator/` + Inngest deployment | **Primary adoption** — durable `step.run()`, concurrency, `onFailure` |
| **2.5** | Capped fix-and-re-review loop | Inngest hosts multi-round state between rounds |
| **3** | Hill-climbing meta-review | Cron-triggered Inngest function |

Do **not** block workflow/artifact work on Inngest. Prove the DSL and file contract first; promote to Inngest when triggers at scale, cross-machine durability, and operational controls matter.

### Today vs with Inngest

**Today:** one command, one Node process, everything in memory.

```bash
harness run change-review \
  --workspace /path/to/my-app \
  --base main --head HEAD \
  --handoff .harness/handoff.md
```

Inside that process: `createWorkflowContext` → `runReviewSteps` → `ctx.agent()` per reviewer → `ctx.export()`. Process death after reviewer 1 = full re-run.

**With Inngest:** same harness code, but each durable boundary is an Inngest step. Completed steps skip on retry; only the failed step re-runs.

### End-to-end flow: review for an implementation

#### 1. Something requests a review

**Manual (keep for local dev):**

```bash
harness run change-review --workspace /path/to/app --steps implementation ...
```

**Event-driven (Phase 1.5 → 2):**

GitHub Action on `pull_request` (or post-`handoff-work`) writes:

```json
// my-app/.harness/inbox/review.json
{
  "workflow": "change-review",
  "workspace": "/path/to/my-app",
  "base": "main",
  "head": "feature/auth",
  "headSha": "def...",
  "steps": ["implementation", "quality"],
  "handoff": ".harness/handoff.md",
  "plan": "dev/plans/260621-auth.md"
}
```

Watcher or GH Action sends Inngest event:

```json
{
  "name": "harness/review.requested",
  "data": { /* same fields */ }
}
```

#### 2. Inngest function registration

```typescript
// orchestrator/change-review.ts (planned — not built)
inngest.createFunction(
  {
    id: "harness-change-review",
    concurrency: { key: "event.data.headSha", limit: 1 },
    onFailure: async ({ error, event }) => notifyFailure(event.data, error),
  },
  { event: "harness/review.requested" },
  async ({ event, step }) => { /* steps below */ },
);
```

Concurrency key: one in-flight review per HEAD SHA.

#### 3. Checkpointed steps (mapped to harness)

```
GitHub / inbox
      ↓
Inngest: harness/review.requested
      ↓
step: prepare-context     → createWorkflowContext, write run-id/, diff.patch
step: grader:test         → optional; Phase 1c
step: review-implementation → ctx.agent("review-implementation")
step: code-quality-review   → ctx.agent("code-quality-review") + digestReview(impl)
step: simplify-review       → optional; ctx.agent("simplify")
step: export                → aggregateVerdict, summary.md, meta.json
      ↓
.harness/runs/reviews/<run-id>/   (canonical artifacts — unchanged)
      ↓
react-to-review (human/agent — harness does not auto-fix)
```

#### 4. Conceptual Inngest function body

Refactor target: extract `runSingleReview(ctx, agentName, options?)` from `workflow-context.ts` so steps are callable outside the monolithic `runReviewSteps` loop. Inngest imports harness lib directly (preferred over shelling out per step).

```typescript
import { createWorkflowContext } from "../lib/workflow-context.ts";
import { runSingleReview, finalizeReview } from "../lib/review-runner.ts"; // planned extract
import { runTestGrader } from "../lib/graders/test.ts"; // Phase 1c
import { digestReview } from "../lib/digest.ts"; // Phase 1c

export const changeReview = inngest.createFunction(
  { id: "harness-change-review", concurrency: { key: "event.data.headSha", limit: 1 } },
  { event: "harness/review.requested" },
  async ({ event, step }) => {
    const { workspace, base, head, handoff, plan, steps: requestedSteps } = event.data;

    const ctx = await step.run("prepare-context", () =>
      createWorkflowContext({
        workspace,
        baseRef: base,
        headRef: head,
        handoffPath: handoff,
        planPath: plan,
        maxRuntimeMs: 30 * 60 * 1000,
      }),
    );
    // Returns serializable handle: { runId, runDir, scopeMeta, workspace }

    const testResult = await step.run("grader:test", () => runTestGrader(workspace));
    if (testResult.status === "failed") {
      await step.run("export-early-fail", () => exportGraderFailure(ctx, testResult));
      return { verdict: "blocked", runId: ctx.runId };
    }

    const implReview = await step.run("review-implementation", () =>
      runSingleReview(ctx, "review-implementation"),
    );

    const qualityReview = await step.run("code-quality-review", () =>
      runSingleReview(ctx, "code-quality-review", {
        priorReviewDigest: digestReview(implReview),
      }),
    );

    // Optional simplify step — skip when not in requestedSteps
    const reviews = [implReview, qualityReview];
    if (requestedSteps?.includes("simplify")) {
      const simplifyReview = await step.run("simplify-review", () =>
        runSingleReview(ctx, "simplify"),
      );
      reviews.push(simplifyReview);
    }

    return await step.run("export", () => finalizeReview(ctx, reviews));
  },
);
```

**What each `step.run()` buys:**

- Persisted return value — replay skips completed steps
- Independent retry — agent timeout on step 3 does not re-run prepare-context
- Survives worker crash, deploy, or restart between steps
- Token savings on retry (the main motivation for LLM steps)

#### 5. Two ways to invoke harness from Inngest

| Approach | Pros | Cons |
|----------|------|------|
| **A. Shell out** per step | Simple migration; artifacts on disk = resume source | Subprocess overhead; harder typing |
| **B. Import lib** (preferred) | Clean steps; shared types; matches plan direction | Requires extracting `runSingleReview`, `finalizeReview` |

Shell-out sketch:

```typescript
await step.run("review-implementation", () =>
  execFile("harness", [
    "run", "change-review",
    "--workspace", workspace,
    "--steps", "implementation",
    // ...need run-id reuse contract for multi-step CLI invocations
  ]),
);
```

Import-lib is the target once `steps.json` and per-step entrypoints exist.

#### 6. What Inngest stores vs what harness stores

| Store | Contents |
|-------|----------|
| **Inngest** | Orchestration state: which steps completed, step return payloads for replay, run history, concurrency locks |
| **Target `.harness/`** | Audit artifacts: reviews, prompts, diff, `summary.md`, `meta.json`, future `steps.json` |

Files remain canonical. Inngest is not a replacement for `.harness/`.

#### 7. Minimal example: implementation review only

CLI today:

```bash
harness run change-review --steps implementation
```

Inngest equivalent — fewer steps:

```typescript
const ctx = await step.run("prepare-context", ...);
const impl = await step.run("review-implementation", () =>
  runSingleReview(ctx, "review-implementation"),
);
return await step.run("export", () => finalizeSingleReview(ctx, [impl]));
```

Pass `steps: ["implementation"]` in the event payload.

### Inngest gaps the plan closes

| Gap | Fix | Phase |
|-----|-----|-------|
| No checkpointing | `steps.json` locally, then Inngest `step.run()` | 0.6 → 2 |
| No retry-with-feedback | Capped fix-and-re-review loop | 2.5 |
| No triggers | GH Action + `.harness/inbox/` | 1.5 |
| No concurrency guard | Lock per branch SHA | 2 |
| No `onFailure` notify | Pluggable notifier (file → slack) | 2 |

---

## Design lessons (still apply)

### From TradingFlow — adopt

**1. Workflow-as-code, proven first**  
`change-review.workflow.ts` is the concrete workflow. Generalize primitives only after live runs.

**2. `meta` block for workflow discovery**  
Each workflow exports `meta` (`name` today; extend when CLI help or dashboard needs it).

**3. Parallel vs sequential discipline**

- **Parallel:** independent deterministic graders (test, lint, typecheck); current reviewer steps when they only share base context
- **Sequential:** when a step needs prior output (`digestReview` for quality review)

**4. Digest layer between phases**  
`digestReview(review)` — verdict, summary, findings by severity (~500 tokens). Full JSON stays on disk for `react-to-review`.

### What we already do better than TradingFlow

- **Deterministic file writes in Node** — no LLM used as a dumb file writer
- **Structured artifact contract** in target repo
- **Partial failure handling** with preserved peer reviews

---

## Revised phased roadmap

| Phase | Deliverable | Status |
|-------|-------------|--------|
| **0** | Dual LLM review + artifacts | ✅ Done (in `agent-skills`, ported) |
| **0.5** | `harness` repo; migrate skills and review pipeline | ✅ Done |
| **0.6** | `steps.json` resumability; artifact schema v1 | Pending |
| **1a** | Live `change-review` workflow + smoke test | ✅ Done |
| **1b** | Primitives: `agent`, `aggregate`, `export`, `WorkflowContext` | ✅ Done |
| **1b.5** | SDK stream logs, workflow events, SDK cancellation | ✅ Done (PRs [#34](https://github.com/ferueda/harness/pull/34), [#36](https://github.com/ferueda/harness/pull/36)) |
| **1b.6** | Cursor CLI review-runtime removal | ✅ [`260627-remove-cursor-cli-review-runtime.md`](./archive/260627-remove-cursor-cli-review-runtime.md) |
| **1c** | Deterministic grader; `REVIEW_RULES`; `digestReview()`; split schemas if useful | Pending |
| **1.5** | Triggers: GH Action, `.harness/inbox/review.json` | Pending |
| **2** | Inngest orchestrator in `orchestrator/`; `onFailure`; concurrency per SHA | Pending |
| **2.5** | Capped fix-and-re-review loop | Pending |
| **3** | Hill-climbing meta-review → skill prompt PRs (human-gated) | Pending |

---

## Artifact schema v1 (target — extend current)

Add `steps.json` alongside `meta.json`:

```json
{
  "runId": "20260621-143022-abc123",
  "schemaVersion": 1,
  "workspace": "/path/to/app",
  "scope": {
    "baseRef": "main",
    "headRef": "HEAD",
    "mergeBase": "abc...",
    "headSha": "def...",
    "diffChars": 4200,
    "diffLines": 180
  },
  "steps": [
    {
      "id": "prepare-context",
      "label": "step:prepare",
      "status": "completed",
      "startedAt": "...",
      "durationMs": 120,
      "outputs": ["context/diff.patch"]
    },
    {
      "id": "verify-tests",
      "label": "grader:test",
      "status": "pending"
    },
    {
      "id": "review-implementation",
      "label": "reviewer:impl",
      "status": "completed",
      "sessionId": "uuid",
      "durationMs": 45000,
      "outputs": ["implementation-review.json"]
    },
    {
      "id": "code-quality-review",
      "label": "reviewer:quality",
      "status": "pending"
    }
  ],
  "verdict": null
}
```

**Keep v1 simple:**

- Statuses: `pending`, `running`, `completed`, `failed`, `skipped`
- Write step outputs to temp files, then rename into place
- On restart, skip only `completed` steps whose listed outputs exist
- Treat `running` from a previous process as retryable
- Inngest `step.run()` IDs should align with `steps.json` step `id` values

### Deterministic grader contract (Phase 1c)

- CLI accepts `--test-command`; otherwise auto-detect common package scripts
- Output shape: `{ id, status, command, exitCode, durationMs, stdoutPath, stderrPath }`
- Large stdout/stderr goes to files, not `steps.json`
- Missing command is `skipped`, failing command is `failed`

---

## Skills for the executor

| Step | Skill / resource | Notes |
|------|------------------|-------|
| Workflow DSL | `workflows/change-review.workflow.ts` | Live reference implementation |
| Headless agents | SDK providers + optional `cursor-cli` skill | Cursor SDK, Codex SDK; CLI skill only if retained for ad-hoc delegation |
| Review instructions | `review-implementation`, `code-quality-review`, `simplify-review` | Workflows reference skill paths |
| Run reviews from chat | `change-review-workflow` (`.agents/skills/`) | Installed to target repos |
| Handoff format | `handoff-work` | `--handoff`, `--handoff-stdin` |
| Post-review triage | `react-to-review` | Bundle aggregated JSON as input |
| Inngest Phase 2 | Inngest docs + section above | Extract per-step runners first |

---

## Next steps (ordered)

1. **`steps.json` resumability** — handoff Phase 0.6
2. **Add `steps.json` v1** — file-based resumability; align step IDs with `events.jsonl` / future Inngest steps
3. **Add `digestReview()`** — before changing quality-review prompts to consume prior review
4. **Add one deterministic grader** (`grader:test`) with `--test-command`
5. **Parse resilience follow-ups** (todo) — [`dev/todo/260627-reviewer-json-parse-resilience.md`](../todo/260627-reviewer-json-parse-resilience.md)
6. **Extract `runSingleReview` / `finalizeReview`** from monolithic `runReviewSteps` — prerequisite for Inngest import-lib path
7. **Add inbox trigger** — GH Action writes `.harness/inbox/review.json`; optional watcher emits `harness/review.requested`
8. **Add `orchestrator/`** — Inngest function per workflow; start with `change-review`
9. **Add `onFailure` notifier** — file sink first, Slack later
10. **Phase 2.5** — capped fix-and-re-review loop as additional Inngest function or branch

---

## Open items

| Item | Notes |
|------|-------|
| Inngest hosting | Self-hosted vs Inngest Cloud; decide before Phase 2 |
| Inngest vs alternatives | Inngest is article's choice; GH Actions sufficient for Phase 1.5 triggers only |
| Per-step CLI vs lib | Prefer lib import; shell-out needs run-id reuse contract |
| Review Manager agent | Optional synthesis step; defer unless needed for `react-to-review` input |
| SQLite artifact index | Defer until file artifacts hard to query across many runs |
| Parallel vs serial under Inngest | Graders parallel; LLM steps serial only when later steps consume earlier review digests |

---

## Assumptions (do not re-litigate)

1. Harness runs **against** target repos, not just itself
2. Artifacts belong in **target repo** `.harness/`
3. New repo is **`harness`**, single source of truth — migration done
4. Durability (Inngest) is **Phase 2**, not a blocker for graders or inbox
5. Human gates on `react-to-review` and merge remain until explicitly changed

---

## Related paths

```
dev/plans/260621-agent-harness-handoff.md     ← this file
dev/plans/archive/260627-remove-cursor-cli-review-runtime.md

bin/harness.ts
workflows/change-review.workflow.ts
workflows/review-steps.ts
lib/workflow-context.ts
lib/aggregate.ts
providers/cursor/
providers/codex/
skills/
AGENTS.md
README.md
```

---

## Work Handoff (summary block)

**Status:** `in_progress`

### Context
Multi-repo agent harness with durable orchestration as north star. `harness` repo is live with `change-review` workflow, SDK-first multi-provider agents, install/init, and test coverage.

### What was worked on
Original Phase 0 dual-review in `agent-skills`; full migration to `harness`; `change-review` with `--steps`; Cursor SDK default + Codex SDK providers; schema-aware JSON extraction (PR #33); SDK stream logs + workflow events (PR #34); SDK abort signal (PR #36); user install; handoff stdin; run pruning.

### How it works today
`harness run change-review` → `createWorkflowContext` → parallel SDK reviewer agents → `events.jsonl` + per-reviewer `*.stream.jsonl` → deterministic `summary.md` + JSON artifacts under `.harness/runs/reviews/<run-id>/`. External abort via `AgentRunInput.signal` returns `aborted: true` / exit `130`.

### Why Inngest next
Local `steps.json` first (0.6), then Inngest `step.run()` (2) for cross-machine durability, event triggers, concurrency per SHA, and cheap retries on expensive LLM steps.

### Next steps
`steps.json` → `digestReview()` → grader → parse-resilience todo items → extract per-step runners → inbox → `orchestrator/`.

### Open items
See [Open items](#open-items) table.
