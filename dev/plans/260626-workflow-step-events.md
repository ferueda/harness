# Plan 260626-workflow-step-events: Step lifecycle sink with durable events.jsonl for AI agents

> **Archive note:** Implemented and removed from the active queue. Historical reference only — do not execute step-by-step. Next work: [`260627-remove-cursor-cli-review-runtime.md`](./260627-remove-cursor-cli-review-runtime.md).

## Status

- **Status**: done (archived from active queue)
- **Completed**: 2026-06-27
- **Merged**: [#34](https://github.com/ferueda/harness/pull/34)
- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none (feeds Phase 0.6 `steps.json` in `260621-agent-harness-handoff.md`)
- **Category**: direction
- **Revised**: 2026-06-27 — implemented with durable file sink, `--verbose` stderr mirror, and step heartbeats

## Why this matters

`runReviewSteps` exports results in one batch. The **primary caller** is an AI agent that invokes `harness run change-review` **out-of-process** — it never sees in-process `EventEmitter` events unless they land in artifacts it already reads.

In-process event emitters are not enough for harness because the primary caller is usually another agent invoking `harness run change-review` out-of-process. Harness needs lifecycle data in **durable run-dir files**, not only optional stderr.

This plan adds:
1. Typed **`WorkflowEventSink`** callback (simpler than EventEmitter for v1)
2. Default subscriber: append **`events.jsonl`** under run dir (one JSON object per line)
3. Optional `--verbose` stderr mirror for live caller feedback while stdout remains final JSON
4. Canonical **step ID mapping** aligned with CLI `--steps` and future `steps.json`

Full `steps.json` resumability remains Phase 0.6 — this plan writes `events.jsonl` only.

## Canonical step ID contract (required)

| CLI `--steps` | `ReviewAgentName` | Artifact prefix | `steps.json` id (future) | Event `id` |
|---------------|-------------------|-----------------|--------------------------|------------|
| `implementation` | `review-implementation` | `implementation-review` | `review-implementation` | `review-implementation` |
| `quality` | `code-quality-review` | `quality-review` | `code-quality-review` | `code-quality-review` |
| `simplify` | `simplify` | `simplify-review` | `simplify-review` | `simplify-review` |

Source of truth for CLI flags: `workflows/change-review.workflow.ts` `CHANGE_REVIEW_STEPS = ["implementation", "quality", "simplify"]`.

Export `STEP_ID_BY_AGENT` **only** from `lib/workflow-events.ts` — tests import `CHANGE_REVIEW_STEPS` / `STEP_AGENTS` from workflow for consistency.

**`prepare-context`:** Out of scope for this plan — context is built in `createWorkflowContext` before `runReviewSteps`. Phase 0.6 adds `prepare-context` via context-factory events separately.

## Primary caller / CLI contract

| Output | Behavior |
|--------|----------|
| stdout | **Unchanged** — final single JSON `meta` only |
| stderr | `--verbose` emits duplicate event lines (optional); default silent |
| `<runDir>/events.jsonl` | **Always written** during non-dry-run `change-review` |
| `meta.json` | Add `eventsFile: "events.jsonl"` on completed/failed only (omit dry-run) |

AI agent workflow: run with `--verbose` to receive live JSONL events on stderr, or after run read `meta.json` → open `events.jsonl` for step timeline.

## Current state

| File | Role |
|------|------|
| `workflows/review-steps.ts` | No lifecycle hooks |
| `workflows/change-review.workflow.ts` | `CHANGE_REVIEW_STEPS` |
| `lib/workflow-context.ts` | Builds context before workflow |
| `bin/harness.ts` | Prints meta to stdout at end |

## Scope

**In scope:**
- `lib/workflow-events.ts` — types, `STEP_ID_BY_AGENT`, `WorkflowEventSink`, `createFileEventSink`, `noopEventSink`
- `workflows/review-steps.ts` — emit via `ctx.eventSink`; extend `WorkflowContext` with `eventSink?`, `runId`
- `workflows/change-review.workflow.ts` — `run:start` / `run:end`
- `lib/workflow-context.ts` — optional `eventSink`; default file sink; `eventsFile` on completed/failed meta only
- `bin/harness.ts` — `--verbose` composite sink (Step 5)
- `test/workflow-events.test.ts` — **create**
- `skills/change-review-workflow/SKILL.md` — After Results + `events.jsonl`

**Out of scope:**
- Full `steps.json` resumability
- `prepare-context` events
- Inngest, TUI
- Changing aggregation semantics

## Steps

### Step 1: Define types and step mapping

Create `lib/workflow-events.ts`:

```typescript
export type WorkflowStepStatus = "pending" | "running" | "completed" | "failed" | "skipped" | "cancelled";

export type WorkflowEvent = {
  type: "run:start" | "run:end" | "step:start" | "step:heartbeat" | "step:end";
  runId: string;
  workspace?: string;
  stepId?: string;       // canonical id from STEP_ID_BY_AGENT
  cliStep?: string;      // implementation | quality | simplify
  status?: WorkflowStepStatus;
  startedAt?: string;
  durationMs?: number;
  error?: string;
  elapsedMs?: number;   // heartbeats
  outputs?: string[];    // relative paths, e.g. implementation-review.json
};

export type WorkflowEventSink = (event: WorkflowEvent) => void;

export const STEP_ID_BY_AGENT: Record<ReviewAgentName, string> = {
  "review-implementation": "review-implementation",
  "code-quality-review": "code-quality-review",
  "simplify": "simplify-review",
};

export function createFileEventSink(runDir: string, runId: string): WorkflowEventSink {
  // appendFileSync events.jsonl — one JSON line per event; sync OK for low volume
}
```

**Verify**: `npm run typecheck` → exit 0

### Step 2: Wire sink in workflow context

In `createWorkflowContext`:

1. `const eventSink = options.eventSink ?? (options.dryRun ? noopEventSink : createFileEventSink(runDir, runId))`
2. Expose on returned context: `eventSink`, `runId` (add to `WorkflowContext` in `review-steps.ts`)
3. Add `eventsFile: "events.jsonl"` to **completed/failed** meta only — **omit on dry-run** meta

**Verify**: `test/workflow-context.test.ts` passes

### Step 3: Emit from `runReviewSteps` only (single emission site)

Extend `WorkflowContext` in `workflows/review-steps.ts`:

```typescript
eventSink?: WorkflowEventSink;
runId?: string;
```

In `runReviewSteps`:

- Per task: `ctx.eventSink?.({ type: "step:start", runId: ctx.runId!, stepId, cliStep: reviewInfo.stage, status: "running", startedAt })` before `ctx.agent`
- While running: emit `step:heartbeat` periodically with `elapsedMs`
- On success/failure: `step:end` with `durationMs`, `outputs`, `error` as needed
- `stepId` from `STEP_ID_BY_AGENT[agentName]`; `cliStep` from `ctx.reviewInfo(agentName).stage` (no separate reverse map)
- **Parallel:** every started step gets `step:end` (`completed` or `failed`); interleaved `step:start` OK
- Serial failure: `step:end` failed, then stop

**Do not** emit from `ctx.agent`.

**Verify**: `npm run typecheck` → exit 0

### Step 4: Run-level events in change-review workflow

```typescript
ctx.eventSink?.({ type: "run:start", runId: ctx.runId!, workspace: ctx.workspace });
const meta = await runReviewSteps(ctx, title, steps, stepMetadata);
ctx.eventSink?.({ type: "run:end", runId: ctx.runId!, status: meta.status === "completed" ? "completed" : "failed" });
```

**Verify**: `test/workflow-events.test.ts`

### Step 5: `--verbose` CLI — composite sink in harness

In `bin/harness.ts` **before** `createWorkflowContext`:

```typescript
const verbose = options.verbose; // new flag
const eventSink = verbose
  ? (e) => { fileSinkPlaceholder; console.error(JSON.stringify(e)); }
  : undefined; // default: context creates file sink only
```

**Pattern B (required):** harness builds composite sink when `--verbose`, passes `eventSink` into `createWorkflowContext({ eventSink: composite })` where composite calls `createFileEventSink` + stderr.

- Default: stdout = final meta JSON only (existing `console.log(JSON.stringify(meta))`)
- `--verbose`: stderr one JSON line per event; stdout unchanged
- Test: parse stdout as single JSON; with `--verbose`, stderr lines are valid `WorkflowEvent` JSON

**Verify**: extend `test/cli.test.ts` or `test/workflow-events.test.ts`

### Step 6: Tests

`test/workflow-events.test.ts`:

1. Collecting sink — start/end pairs per step
2. File sink — `events.jsonl` lines parse as `WorkflowEvent[]`
3. Failed step — `status: "failed"`, `error` set
4. `STEP_ID_BY_AGENT` matches `CHANGE_REVIEW_STEPS` mapping table
5. Dry-run — no `events.jsonl` created
6. Omitted steps (`--steps implementation`) — only executed steps emit

**Verify**: `npm test -- test/workflow-events.test.ts` → pass

### Step 7: Update skill doc

`skills/change-review-workflow/SKILL.md` — **After Results** §1: read `meta.eventsFile` → `events.jsonl` for step timeline; `--verbose` emits live JSONL events to stderr; `summary.md` + reviewer JSON remain primary for findings.

**Verify**: `grep events.jsonl skills/change-review-workflow/SKILL.md`

## EventEmitter vs sink (decision)

Use **`WorkflowEventSink` callback** for v1. Multiple subscribers = `const sink = (e) => { fileSink(e); verboseSink?.(e); }`. Promote to `EventEmitter` when Inngest heartbeat + TUI + file writer all exist.

## Workflow / CLI / agent impact

| Surface | Default | `--verbose` |
|---------|---------|-------------|
| stdout | Single JSON meta | Unchanged |
| stderr | Silent | JSONL event lines |
| Run dir | + `events.jsonl` | Same |
| AI agent | Read `events.jsonl` for timeline | Optional live stderr watch |

## Done criteria

- [x] `lib/workflow-events.ts` with `WorkflowEventSink` + `STEP_ID_BY_AGENT`
- [x] `events.jsonl` written on non-dry-run change-review
- [x] `meta.json` includes `eventsFile` on completed/failed only
- [x] `ctx.eventSink` + `runId` on `WorkflowContext`; single emission site in `review-steps.ts`
- [x] `step:heartbeat` events emitted during long-running reviewer steps
- [x] `--verbose` uses composite sink passed into `createWorkflowContext`
- [x] Skill doc After Results updated
- [x] `npm test` exits 0
- [x] `dev/plans/README.md` updated

## STOP conditions

Stop if:

- Circular imports between workflow-context and review-steps — keep types in `workflow-events.ts`
- Implementing full `steps.json` required to test sink — file sink + unit tests sufficient

## Maintenance notes

- Phase 0.6: migrate `events.jsonl` → `steps.json` or dual-write; reuse `stepId` values from this plan
- Stream artifact paths are indexed in `meta.streamArtifacts` (shipped in PR #34); include in `outputs` on `step:end` when `steps.json` lands
- Workflow-level `signal` cancellation can mark parallel peers `cancelled` when orchestration adds peer abort (PR #36 shipped provider `aborted` contract)
