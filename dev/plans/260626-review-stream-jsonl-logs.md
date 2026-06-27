# Plan 260626-review-stream-jsonl-logs: Archive raw reviewer NDJSON streams with meta.json index

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `260626-incremental-stream-json-parsing.md` (`--log-path` process boundary must be landed)
- **Category**: dx
- **Source**: GNHF adoption item #4
- **Revised**: 2026-06-26 — round 2: `codeQuality` keys; context accumulation; required stdout test

## Why this matters

Harness writes `*-review.raw.json` and `*-review.json` but not raw Cursor NDJSON streams. When reviewers fail validation or timeout, the final envelope omits tool events and partial text.

**Primary caller:** An AI agent runs `harness run change-review`, then reads `meta.json`, `summary.md`, and `*-review.json`. New `*.stream.jsonl` files are **invisible** unless indexed in `meta.json` and documented in `skills/change-review-workflow/SKILL.md`.

**Runtime note:** This repo's `harness.json` uses Cursor `runtime: "sdk"`. Stream logs are **CLI-only**. SDK/Codex runs must record `streamArtifacts.*.status: "unsupported"` in meta — not fail the review.

**Reference (GNHF):** `/Users/frueda/dev/gnhf/src/core/orchestrator.ts` — `logPath` per iteration

## Dependency gate

Before starting, verify `260626-incremental-stream-json-parsing`:

```bash
grep -n "logPath\|--log-path" lib/agents.ts lib/cursor-agent.ts providers/cursor/cursor-agent.ts providers/cursor/lib/runner.ts
```

All four must show wiring. If not, **STOP**.

## Current state

`lib/workflow-context.ts` `REVIEWER_CONFIGS` — `rawFile` only, no `streamFile`.

`ctx.agent` calls `reviewProvider.run` without `logPath` or `outputFormat`.

## Scope

**In scope:**
- `lib/workflow-context.ts` — `streamFile`, CLI streaming opts, mutable `streamArtifacts`, meta merge
- `skills/change-review-workflow/SKILL.md` — After Results artifact discovery
- `README.md` — artifacts line if section exists
- `test/workflow-context.test.ts` — mock CLI + SDK default tests
- `test/cursor-agent.test.ts` or `providers/cursor/cursor-agent.test.ts` — boundary test with `logPath`

**Out of scope:**
- Codex / SDK stream logs
- Parsing streams for verdict
- Full `steps.json` (plan 6)

## Steps

### Step 1: Add `streamFile` to reviewer configs

```typescript
streamFile: "implementation-review.stream.jsonl",
// quality-review.stream.jsonl, simplify-review.stream.jsonl
```

**Verify**: `npm run typecheck` → exit 0

### Step 2: Enable stream-json + logPath (CLI only)

In `ctx.agent`:

```typescript
const streamPath = join(runDir, config.streamFile);
const useCliStreaming =
  reviewProvider.name === "cursor" &&
  !isCursorSdkRuntime(reviewProvider.name, options.cursorRuntime);

const result = await reviewProvider.run({
  workspace,
  prompt,
  schemaPath: SCHEMA_PATH,
  model: resolvedAgentModel(...),
  maxRuntimeMs: options.maxRuntimeMs,
  ...(useCliStreaming
    ? { logPath: streamPath, outputFormat: "stream-json" as const }
    : {}),
});
```

Dry-run: skip provider call and stream files; **omit `streamArtifacts` from dry-run meta** (or document explicit choice in code comment).

After `reviewProvider.run` (success or failure), update **mutable `streamArtifacts` on context** (safe under parallel reviewers — one key per stage). Merge into `finalizeRun` / `exportFailed` `baseMeta`.

**Verify**: mock test records `logPath` when `cursorRuntime: "cli"`

### Step 3: Index streams in `meta.json`

Use keys aligned with `meta.reviews`: `implementation`, `codeQuality`, `simplify` (not `quality`).

```typescript
streamArtifacts: {
  implementation: {
    path: "implementation-review.stream.jsonl",
    status: "written" | "unsupported" | "missing",
    bytes?: number,
  },
  codeQuality: { /* quality-review.stream.jsonl */ },
  simplify: { /* simplify-review.stream.jsonl */ },
}
```

- `written`: file exists; include `bytes` via `statSync` when cheap
- `unsupported`: Cursor SDK **or Codex** runtime (record all three reviewers when not CLI streaming)
- `missing`: CLI but file not created (failure before flush)

Do **not** use a separate `streamLog` field — `streamArtifacts[].status` only.

Include in `finalizeRun` / `exportFailed` — **not** stream contents in meta.

**Verify**: workflow test with `cursorRuntime: "sdk"` → all `streamArtifacts.*.status === "unsupported"` and provider not passed `logPath`

### Step 4: Stdout regression guard

**Required** test (extend `test/cli.test.ts` or workflow test):

- Mock provider + `cursorRuntime: "cli"` with internal `stream-json`/`logPath` enabled
- Assert `harness run change-review` stdout is **one** parseable JSON object (no NDJSON leak)

**Verify**: test passes; existing dry-run CLI tests remain green

### Step 5: Partial stream files on failure

- Keep partial `*.stream.jsonl` if bytes written (GNHF behavior)
- Do not delete on `exportFailed`
- `streamArtifacts[].status: "written"` even when review fails

**Verify**: mock fails mid-run with pre-written stream bytes → file kept

### Step 6: Update agent-facing docs

**`skills/change-review-workflow/SKILL.md`** (required) — **After Results** §1:

1. Read `meta.json` → check `streamArtifacts.<stage>.status`
2. Open `*-review.stream.jsonl` only when `status === "written"`
3. SDK/Codex: expect `unsupported` (this repo's `harness.json` defaults to SDK)

**`README.md`:** one line under artifacts if section exists.

**Verify**: grep `stream.jsonl` in skill file

### Step 7: Provider boundary test

One test crossing `lib/cursor-agent.ts` → wrapper with `logPath`:

- Fake/mocked child writes stream file via runner contract
- Final envelope still `status: completed` with `structuredOutput`

**Note:** If `260626-incremental-stream-json-parsing` landed without workflow edits, this plan is the **sole owner** of `ctx.agent` streaming spread.

**Verify**: `npm test` → exit 0

## Workflow / CLI / agent impact

| Surface | Impact |
|---------|--------|
| `harness run` stdout | Unchanged — single JSON meta |
| `meta.json` | New `streamArtifacts` index |
| Run dir | +0–3 `*.stream.jsonl` (CLI only) |
| AI agent | Read `meta.json` first; then stream files for debug |
| `runs prune` | Deletes whole run dir — streams included (verify) |
| SDK default (`harness.json`) | No stream files; meta says unsupported |

## Done criteria

- [ ] `streamFile` on all reviewers
- [ ] CLI reviews pass `logPath` + `stream-json`
- [ ] `meta.json` indexes stream artifacts with status
- [ ] `change-review-workflow/SKILL.md` updated
- [ ] Stdout single-JSON contract documented/tested
- [ ] Provider boundary test exists
- [ ] `npm test` exits 0
- [ ] `dev/plans/README.md` updated

## STOP conditions

Stop if stream-json plan not merged, or enabling stream-json breaks envelope structured output.

## Maintenance notes

- Plan 6 should list `streamFile` in step `outputs` when events land.
- `session-evidence` can grep `*.stream.jsonl` later.
