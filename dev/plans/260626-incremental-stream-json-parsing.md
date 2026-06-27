# Plan 260626-incremental-stream-json-parsing: Parse Cursor stream-json incrementally with logPath across process boundary

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none (enables `260626-review-stream-jsonl-logs.md`)
- **Category**: dx
- **Source**: GNHF adoption item #2
- **Revised**: 2026-06-26 — round 2: infra-only (no `workflow-context`); `--log-path` surface; log stream cleanup

## Why this matters

Harness's Cursor path is **two processes deep**:

```
harness run change-review
  → lib/cursor-agent.ts              (parent: expects one JSON envelope)
    → providers/cursor/cursor-agent.ts   (child: harness-cursor)
      → providers/cursor/lib/runner.ts   (spawns real `agent` CLI)
```

Incremental parsing inside `runner.ts` alone does **not** benefit the workflow or the AI agent caller unless `logPath` bytes are written where the parent requests them. Parent-owned `logPath` before spawn would capture the wrapper envelope, not raw Cursor NDJSON.

This plan adds incremental NDJSON parsing, **`harness-cursor --log-path`** side-channel for raw stream mirroring, and optional parent callbacks when same-process. Default `change-review` behavior unchanged.

**Primary caller:** AI agent runs `harness run change-review`, parses **one JSON object on stdout** at end. No live progress until workflow opts in; `logPath` must work through the bridge for plan 4.

**Reference (GNHF, read-only):**
- `/Users/frueda/dev/gnhf/src/core/agents/stream-utils.ts`
- `/Users/frueda/dev/gnhf/src/core/agents/claude.ts`

## Process boundary contract (required)

| Layer | Responsibility |
|-------|----------------|
| `runner.ts` | Incremental `createJSONLParser`; write raw bytes to `logPath`; parse `result` for final text |
| `cursor-agent.ts` (wrapper) | New flag `--log-path <file>`; pass to `runAgent({ logPath })`; envelope stdout unchanged (single JSON) |
| `lib/cursor-agent.ts` (parent) | When `input.logPath` set: pass `--log-path` + `--output-format stream-json` to wrapper; **do not** expect NDJSON on wrapper stdout |
| `lib/workflow-context.ts` | Pass `logPath`/`outputFormat` only when provider is Cursor **and** runtime is **CLI** (not SDK/Codex) |

Parent `onStreamEvent` / `onUsage` callbacks: **optional, same-process only** in this plan. Workflow gets value via `logPath` file, not live callbacks.

## Current state

| File | Role |
|------|------|
| `providers/cursor/lib/runner.ts` | Buffers stdout; parses at exit |
| `providers/cursor/cursor-agent.ts` | `harness-cursor`; no `--log-path` today |
| `lib/cursor-agent.ts` | Hardcodes `--output-format json` |
| `lib/agents.ts` | No `logPath` / streaming fields |
| `harness.json` | This repo uses `runtime: "sdk"` — streaming fields are CLI-only |

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `npm run typecheck` | exit 0 |
| Tests | `npm test -- providers/cursor/` | all pass |
| Workflow | `npm test -- test/workflow-context.test.ts` | all pass |
| Full suite | `npm test` | exit 0 |

## Scope

**In scope:**
- `providers/cursor/lib/stream-utils.ts` — **create**
- `providers/cursor/lib/runner.ts`
- `providers/cursor/cursor-agent.ts` — `--log-path` flag
- `lib/cursor-agent.ts` — thread `logPath` + `outputFormat`
- `lib/agents.ts` — optional fields (CLI-capable only)
- `lib/workflow-context.ts` — **out of scope** (plan `260626-review-stream-jsonl-logs` is sole owner of `ctx.agent` streaming opts)
- `providers/cursor/lib/runner.test.ts` — **create**
- `lib/cursor-agent.test.ts` — **create** or extend bridge tests

**Out of scope:**
- `cursor-sdk-agent.ts`, `codex-agent.ts` streaming
- Parent `onStreamEvent` through subprocess (defer; use `logPath` file)
- Workflow live progress / TUI
- Leaking NDJSON to `harness run` stdout

## Steps

### Step 1: Create `stream-utils.ts` with owned flush

Create `providers/cursor/lib/stream-utils.ts`:

```typescript
export function createJSONLParser<T>(options: {
  logStream?: WriteStream | null;
  onLine: (event: T) => void;
}): {
  push: (chunk: Buffer | string) => void;
  flush: () => void;
}
```

- `push`: buffer incomplete lines, mirror raw bytes to `logStream`, call `onLine` per valid JSON line
- `flush`: parse trailing buffer on stream `end`
- Do **not** export orphan `flushJSONLBuffer(buffer)` without parser state

**Verify**: `npm run typecheck` → exit 0

### Step 2: Extend `AgentRunInput` (CLI-capable fields)

```typescript
export type AgentRunInput = {
  // ...existing...
  signal?: AbortSignal;  // wired in abort-signal plan
  logPath?: string;
  outputFormat?: "json" | "stream-json";  // default "json"
  // onStreamEvent / onUsage: omit from workflow path this plan; runner may accept internally
};
```

Document in `lib/agents.ts` comment: `logPath` and `outputFormat` honored by **Cursor CLI** path only.

**Verify**: `npm run typecheck` → exit 0

### Step 3: Refactor `runAgent` for incremental stream-json

In `providers/cursor/lib/runner.ts`:

1. **Keep `recordActivity()` on stdout/stderr chunks** (byte-level idle timeout — do not replace with parsed-line-only activity)
2. When `outputFormat === "stream-json"`:
   - Use `createJSONLParser` on stdout
   - Track terminal state from `type === "result"` events (reuse `terminalFromEvent`)
   - Open `createWriteStream(logPath)` when `logPath` provided; **`end()`/`destroy()` in shared `finally`** (normal close, timer kill, future abort)
3. When `json` / `text`: keep buffer-at-exit behavior

Extend `AgentRunOptions` in runner (not global `AgentRunInput` callbacks) with optional `onLine` for tests.

**Verify**: `npm test -- providers/cursor/cursor-agent.test.ts` → pass

### Step 4: Add `harness-cursor --log-path` and thread through bridge

**`providers/cursor/cursor-agent.ts`:**
- Add `logPath?: string` to `CursorAgentOptions`
- Parse `--log-path <file>`; document in `printHelp()`
- Pass to `runAgent({ ..., logPath, outputFormat })` in `runInvoke`
- stdout remains single envelope JSON (no NDJSON leak)

**`lib/cursor-agent.ts`:**
- When **`input.logPath` is set** (derive `stream-json` from log path — do not enable stream-json without logPath):
  - Add `--output-format stream-json`
  - Add `--log-path`, `input.logPath`
- Default unchanged: `--output-format json`, no log path

**Verify**: extend `test/cursor-agent.test.ts` — default `--output-format json`; with `logPath` passes `--log-path` + `stream-json` to wrapper spawn args

### Step 5: Tests

**`providers/cursor/lib/runner.test.ts`:**
- Incremental NDJSON → correct `resultText`
- `logPath` file contains raw mirrored bytes
- `json` format regression (buffer at exit)
- Idle timeout: activity on partial line without newline (byte chunks)
- `logStream` closed on timeout kill

**`test/cursor-agent.test.ts`:**
- Bridge spawn-arg tests (see Step 4)

**CLI stdout guard:** No test asserts NDJSON on harness stdout.

**Verify**: `npm test` → exit 0

### Step 6: Full verification

**Verify**: `npm test` && `npm run lint` → exit 0

**Note:** Workflow streaming verification uses `cursorRuntime: "cli"` in tests (`test/workflow-context.test.ts` pattern). This repo's `harness.json` defaults to SDK — infra is still correct when plan 4 wires workflow.

## Workflow / CLI / agent impact

| Surface | Default | With logPath (plan 4) |
|---------|---------|----------------------|
| `harness run change-review` stdout | Single JSON meta | Unchanged |
| Wrapper stdout | Single envelope | Unchanged |
| Run dir | Same artifacts | + `*.stream.jsonl` (plan 4) |
| Cursor SDK runtime | Batch `run.wait()` | No stream logs |
| AI agent | Same invoke pattern | Discovers stream files via meta (plan 4) |

## Done criteria

- [ ] `createJSONLParser` with `push`/`flush` exists
- [ ] `runAgent` incremental parse for `stream-json`
- [ ] `harness-cursor --log-path` (types, help, pass-through) writes raw NDJSON via runner
- [ ] `lib/cursor-agent.ts` threads `logPath` when set
- [ ] **No** `workflow-context.ts` changes in this plan
- [ ] Byte-level idle timeout preserved; log stream closed on all exit paths
- [ ] Default review path unchanged
- [ ] `npm test` exits 0
- [ ] `dev/plans/README.md` updated

## STOP conditions

Stop and report if:

- `--log-path` cannot be added without breaking `harness-cursor` TOON/JSON envelope contract.
- `stream-json` breaks structured output in envelope — fix runner terminal extraction first.
- Tests require real `agent` binary for unit tests.

## Maintenance notes

- Plan 4 depends on this `logPath` contract.
- Plan 3 (`abort-signal`): `setupAbortHandler` in same `runAgent` spawn path; wrapper must forward abort to nested `agent`.
- SDK streaming: separate future plan.
