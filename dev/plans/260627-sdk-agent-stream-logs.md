# Plan 260627-sdk-agent-stream-logs: Write SDK agent stream logs for reviewer runs

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: dx
- **Supersedes**: `dev/plans/260626-incremental-stream-json-parsing.md`, `dev/plans/260626-review-stream-jsonl-logs.md`
- **Source docs verified**:
  - OpenAI Codex SDK TypeScript README, read on 2026-06-27: `https://raw.githubusercontent.com/openai/codex/refs/heads/main/sdk/typescript/README.md`
  - Cursor TypeScript SDK docs, read on 2026-06-27: `https://cursor.com/docs/sdk/typescript.md`

## Why this matters

`change-review` currently records final reviewer JSON and raw final envelopes, but not the incremental provider events that explain how a reviewer got there. When a reviewer times out, fails parsing, or returns invalid review JSON, the artifact set loses assistant drafts, tool calls, status changes, and partial output. SDK streaming is the production path now, so this plan logs Cursor SDK and Codex SDK streams directly instead of adding Cursor CLI `stream-json` plumbing.

Streaming is observability and forensics only. Final verdict extraction must still come from the provider's completed result text plus existing structured-output parsing.

## Current state

- `lib/agents.ts` — `AgentRunInput` has `workspace`, `prompt`, `schemaPath`, model/policy fields, and `maxRuntimeMs`; it has no `logPath`.
- `providers/cursor/cursor-sdk-agent.ts` — creates a Cursor SDK agent, sends a wrapped prompt, then calls `run.wait()` and parses `result.result`.
- `providers/codex/codex-agent.ts` — calls `thread.run(input.prompt, { outputSchema, signal })`, then parses `turn.finalResponse`.
- `lib/workflow-context.ts` — writes `<stage>-review.raw.json` and `<stage>-review.json`; it never passes a stream path to the provider and does not index stream artifacts in `meta.json`.
- `dev/plans/260626-incremental-stream-json-parsing.md` and `dev/plans/260626-review-stream-jsonl-logs.md` are Cursor CLI-oriented; this plan replaces them for SDK production runs.

Relevant current excerpts:

```ts
// lib/agents.ts
export type AgentRunInput = {
  workspace: string;
  prompt: string;
  schemaPath?: string;
  model?: string;
  sandboxMode?: AgentSandboxMode;
  approvalPolicy?: AgentApprovalPolicy;
  modelReasoningEffort?: AgentReasoningEffort;
  maxRuntimeMs: number;
};
```

```ts
// providers/cursor/cursor-sdk-agent.ts
run = await withDeadline(
  sdkAgent.send(wrapPrompt(input.prompt, schemaResult.schema)),
  (lateRun) => {
    void cancelRun(lateRun);
  },
);
const result = await withDeadline(run.wait());
```

```ts
// providers/codex/codex-agent.ts
const turnPromise = thread.run(input.prompt, {
  outputSchema,
  signal: controller.signal,
});
const turn = await Promise.race([observedTurnPromise, timeoutPromise]);
const structuredOutput = parseStructuredOutput(turn.finalResponse);
```

```ts
// lib/workflow-context.ts
const result = await reviewProvider.run({
  workspace,
  prompt,
  schemaPath: SCHEMA_PATH,
  model: resolvedAgentModel(reviewProvider.name, options),
  ...agentPolicyMeta,
  maxRuntimeMs: options.maxRuntimeMs,
});
```

Provider docs facts verified:

- Cursor SDK `Agent.send()` returns a `Run`; `Run.stream()` returns async `SDKMessage` events; `Run.wait()` returns the final `RunResult`; `Run.cancel()` cancels a run; `run.supports("stream")` can be checked.
- Cursor final text remains `RunResult.result`.
- Codex SDK `Thread.run()` buffers events until completion.
- Codex SDK `Thread.runStreamed()` returns `{ events }`, an async generator of `ThreadEvent`.
- Codex `turn.completed` carries usage, not final response text.
- Codex final response text is reconstructed from completed `agent_message` items, which is what the SDK's own `run()` implementation does internally.
- Codex `outputSchema` and `signal` are `TurnOptions`, so `runStreamed(input, { outputSchema, signal })` preserves the current structured-output and timeout controls.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `pnpm run typecheck` | exit 0, no TypeScript errors |
| Tests | `pnpm test -- providers/cursor/cursor-sdk-agent.test.ts providers/codex/codex-agent.test.ts test/workflow-context.test.ts` | exit 0, targeted tests pass |
| Full tests | `pnpm test` | exit 0 |
| Lint | `pnpm run lint` | exit 0 |
| Format check | `pnpm run format:check` | exit 0 |

## Suggested executor toolkit

| Skill | Use for |
|-------|---------|
| `node` | File writes, async cleanup, stream/event-loop behavior, timeout handling |
| `typescript-refactor` | Type-safe `AgentRunInput`, event unions, provider helper types without unsafe casts |
| `vitest` | Mock SDK streams, async generator tests, failure/timeout tests |

Reference docs to read before implementing:

- Cursor TypeScript SDK docs: `https://cursor.com/docs/sdk/typescript.md`
- Codex SDK TypeScript README: `https://raw.githubusercontent.com/openai/codex/refs/heads/main/sdk/typescript/README.md`
- Local installed declarations, if docs and package differ:
  - `node_modules/@cursor/sdk/dist/esm/run.d.ts`
  - `node_modules/@cursor/sdk/dist/esm/messages.d.ts`
  - `node_modules/@openai/codex-sdk/dist/index.d.ts`

## Scope

**In scope**:

- `lib/agents.ts` — add `logPath?: string` to `AgentRunInput`.
- `lib/agent-stream-log.ts` — new small helper for JSONL event writing.
- `providers/cursor/cursor-sdk-agent.ts` — mirror `run.stream()` events to `input.logPath`, keep `run.wait()` as final result authority.
- `providers/codex/codex-agent.ts` — switch from `thread.run()` to `thread.runStreamed()` when needed, log events, reconstruct the same `Turn` shape currently returned by `run()`.
- `lib/workflow-context.ts` — pass per-stage stream log paths to reviewer runs and index them in `meta.json`.
- Tests for both providers and workflow metadata.
- `skills/change-review-workflow/SKILL.md` — mention stream logs as failure forensics if the workflow skill documents artifacts.
- `dev/plans/README.md` — mark this plan done/pending appropriately after implementation.

**Out of scope**:

- Cursor CLI `--output-format stream-json`, `--log-path`, or `createJSONLParser`.
- `harness-cursor` subprocess stream mirroring.
- Live UI progress or tailing stream logs during a run; `260626-workflow-step-events.md` remains separate.
- Changing reviewer verdict parsing, `ReviewOutputSchema`, or prompt content.
- Provider structured-output enforcement beyond current behavior.
- Removing Cursor CLI runtime from the repo.

## Design decisions

- Add only `logPath?: string` to the provider contract. Do not add CLI-only `outputFormat`.
- Stream files are best-effort forensic artifacts. A write failure should be surfaced in `streamArtifacts` and raw provider artifact, but should not turn a passing reviewer into a failure unless no safe stream path can be created.
- Use one JSON object per line. Preserve provider-native event shape under a small harness wrapper so event format is explicit:

```ts
type AgentStreamLogRecord = {
  provider: "cursor" | "codex";
  format: "cursor-sdk-message" | "codex-thread-event";
  sequence: number;
  timestamp: string;
  event: unknown;
};
```

- Do not parse stream files for verdicts. Final parsing remains:
  - Cursor: `run.wait()` -> `RunResult.result` -> `parseStructuredOutput`.
  - Codex: collected `finalResponse` -> `JSON.parse`.
- For Codex streamed runs, reproduce the SDK `run()` accumulation behavior:
  - Push `event.item` for every `item.completed`.
  - When `event.item.type === "agent_message"`, set `finalResponse = event.item.text`.
  - On `turn.completed`, save `usage = event.usage`.
  - On `turn.failed`, throw/return the same failure style as current `thread.run()` failures.

## Steps

### Step 1: Add the stream writer helper

Create `lib/agent-stream-log.ts`.

Implementation requirements:

- Export `createAgentStreamWriter(logPath: string, metadata: { provider; format })`.
- Open a Node write stream with `flags: "a"` after ensuring the parent directory exists.
- Maintain a per-writer `sequence` starting at 1.
- Write one JSON line per event with `provider`, `format`, `sequence`, `timestamp`, and `event`.
- Provide `write(event: unknown): void` and `close(): Promise<void>`.
- Track write errors so providers can include them in raw artifacts or `streamArtifacts`.
- Keep the helper independent of Cursor/Codex types.

**Verify**: `pnpm run typecheck` -> exit 0.

### Step 2: Extend `AgentRunInput`

Add `logPath?: string` to `AgentRunInput` in `lib/agents.ts`.

Do not add `outputFormat`. Do not change successful or failed result shapes yet.

**Verify**: `pnpm run typecheck` -> exit 0.

### Step 3: Log Cursor SDK streams without changing final parsing

Edit `providers/cursor/cursor-sdk-agent.ts`.

Implementation shape:

1. After `sdkAgent.send(...)` resolves to `run`, check `input.logPath`.
2. If present and `run.supports("stream")` is true, start a concurrent stream pump:

```ts
const streamTask = input.logPath
  ? mirrorCursorStream(run, input.logPath)
  : undefined;
const result = await withDeadline(run.wait());
await streamTask;
```

3. `mirrorCursorStream` loops `for await (const event of run.stream())` and writes each event.
4. If `run.supports("stream")` is false, skip `run.stream()` and record unsupported stream status in the raw artifact.
5. Ensure timeout/error cleanup closes the stream writer and still calls `cancelRun(run)` on timeout.
6. Keep `parseStructuredOutput(result.result, schemaResult.schema)` unchanged.

Tests in `providers/cursor/cursor-sdk-agent.test.ts`:

- Fake run emits two stream events; `logPath` file contains two JSONL records with `provider: "cursor"`, `format: "cursor-sdk-message"`, and original event payloads.
- Final parsing still uses `wait()` result, not stream assistant text.
- Timeout with partial stream leaves the partial file and still returns exit `124`.
- Unsupported `stream` does not call `run.stream()` and does not fail an otherwise successful run.

**Verify**: `pnpm test -- providers/cursor/cursor-sdk-agent.test.ts` -> exit 0.

### Step 4: Switch Codex to streamed accumulation

Edit `providers/codex/codex-agent.ts`.

Implementation shape:

1. Add a small local `runCodexTurn` helper.
2. If `input.logPath` is absent, it is acceptable to keep `thread.run()` initially; if present, call `thread.runStreamed(input.prompt, { outputSchema, signal })`.
3. Prefer using `runStreamed()` for both paths if the helper exactly preserves current `run()` behavior and tests cover it.
4. While iterating events:
   - write each event to `logPath` when provided,
   - update `thread.id` naturally through SDK,
   - collect completed items,
   - set `finalResponse` from completed `agent_message` item text,
   - set `usage` from `turn.completed`,
   - treat `turn.failed` as an SDK run failure.
5. Return the same `{ items, finalResponse, usage }` shape that the existing code expects.
6. Keep current timeout `AbortController` behavior and delayed rejection handling.

Tests in `providers/codex/codex-agent.test.ts`:

- Update fake thread type to support `runStreamed`.
- Streamed events produce the same `structuredOutput`, `sessionId`, and `usage` as current `run()` tests.
- `logPath` file contains `provider: "codex"`, `format: "codex-thread-event"`, and raw event payloads.
- Final response is taken from `item.completed` `agent_message`, not from `turn.completed`.
- `turn.failed` returns `ok: false` with the failure message.
- Timeout aborts the `signal` and leaves partial stream JSONL when events were emitted before hanging.

**Verify**: `pnpm test -- providers/codex/codex-agent.test.ts` -> exit 0.

### Step 5: Pass per-review stream paths from workflow

Edit `lib/workflow-context.ts`.

For each reviewer config, derive:

```ts
streamFile: `${config.stage}-review.stream.jsonl`
streamPath: join(runDir, streamFile)
```

Pass `logPath: streamPath` to `reviewProvider.run(...)` for non-dry-run reviewer calls.

Track stream artifacts in a mutable object keyed by stage:

```ts
streamArtifacts: {
  implementation?: {
    path: "implementation-review.stream.jsonl";
    status: "written" | "missing" | "error";
    provider: "cursor" | "codex";
    format: "cursor-sdk-message" | "codex-thread-event";
    bytes?: number;
    error?: string;
  };
}
```

After each provider call settles, stat the stream file:

- `written` when file exists and `size > 0`.
- `missing` when no file exists or `size === 0`.
- `error` only when the provider reports a stream writer error in `raw`.

Merge `streamArtifacts` into completed and failed `meta.json`. For dry runs, omit `streamArtifacts`.

Tests in `test/workflow-context.test.ts`:

- Mock provider receives `input.logPath` ending in `implementation-review.stream.jsonl`.
- Mock provider writes a fake stream file; exported `meta.json` indexes it as `written`.
- Failed reviewer still has `streamArtifacts.<stage>.status === "written"` when the provider wrote a partial stream before returning `ok: false`.
- Dry-run meta omits `streamArtifacts`.
- Codex provider meta uses `format: "codex-thread-event"`; Cursor SDK uses `format: "cursor-sdk-message"`.

**Verify**: `pnpm test -- test/workflow-context.test.ts` -> exit 0.

### Step 6: Document operator use

Update `skills/change-review-workflow/SKILL.md` only if it documents review output artifacts.

Add guidance:

- On reviewer failure, read `meta.json`.
- If `streamArtifacts.<stage>.status === "written"`, inspect the referenced `*.stream.jsonl`.
- Use stream logs to diagnose tool activity, partial assistant output, and timeout location.
- Do not use stream logs as verdict source; use `*-review.json` or final raw artifact.

**Verify**: `rg -n "streamArtifacts|stream\\.jsonl" skills/change-review-workflow/SKILL.md dev/plans/260627-sdk-agent-stream-logs.md` -> finds the new guidance and this plan.

### Step 7: Full verification and plan index

Run:

```bash
pnpm run typecheck
pnpm test
pnpm run lint
pnpm run format:check
```

Expected: all exit 0.

Update `dev/plans/README.md` after implementation status changes.

## Test plan

- Provider unit tests cover stream mirroring for Cursor and Codex.
- Provider tests prove stream text is not used for verdict parsing.
- Timeout tests prove partial stream files survive.
- Workflow tests prove `logPath` propagation and `meta.json` indexing on success and failure.
- Dry-run test proves no stream artifacts are promised when no provider ran.

## Done criteria

- [x] `AgentRunInput.logPath` exists.
- [x] `lib/agent-stream-log.ts` writes provider-tagged JSONL records and closes cleanly.
- [x] Cursor SDK run writes stream events through `run.stream()` and still parses final output from `run.wait()`.
- [x] Codex run writes `runStreamed()` events and reconstructs `Turn.finalResponse` from completed `agent_message` items.
- [x] Workflow passes per-stage `logPath` to every non-dry-run reviewer.
- [x] Completed and failed `meta.json` include `streamArtifacts`; dry-run meta omits it.
- [x] Stream files remain on parse failure or timeout when partial events were emitted.
- [x] No Cursor CLI stream-json/log-path implementation is added by this plan.
- [x] Targeted provider/workflow tests pass.
- [x] `pnpm run typecheck`, `pnpm test`, `pnpm run lint`, and `pnpm run format:check` pass.
- [x] `dev/plans/README.md` reflects the new plan status.

## STOP conditions

Stop and report if:

- Installed SDK versions lack `Run.stream()` or `Thread.runStreamed()` despite the docs.
- Cursor `run.stream()` cannot run concurrently with `run.wait()` in practice; report whether `onStep`/`onDelta` send options are a better supported path.
- Codex streamed accumulation cannot reproduce `thread.run()` final `Turn` semantics.
- Stream writer errors would require changing reviewer pass/fail semantics.
- Adding stream artifacts requires touching CLI subprocess files.

## Maintenance notes

- `260626-workflow-step-events.md` can later reference these stream artifact paths from step events.
- `260626-agent-abort-signal.md` should compose with stream logging so aborts close stream files and preserve partial JSONL.
- A future CLI deprecation plan can remove or freeze `harness-cursor` separately; do not bundle that cleanup with stream logs.
