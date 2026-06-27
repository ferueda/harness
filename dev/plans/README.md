# Plans & handoffs

| File | Status | Summary |
| ---- | ------ | ------- |
| [260621-agent-harness-handoff.md](./260621-agent-harness-handoff.md) | `in_progress` | Roadmap: `change-review`, durable orchestration (Phase 2), graders, triggers |
| [260626-json-extract-rightmost-object.md](./260626-json-extract-rightmost-object.md) | `done` | Rightmost JSON + schema-aware `parseStructuredOutput` (round 2) |
| [260626-incremental-stream-json-parsing.md](./260626-incremental-stream-json-parsing.md) | `archived` | Superseded CLI subprocess NDJSON plan; do not implement for SDK review path |
| [260626-agent-abort-signal.md](./260626-agent-abort-signal.md) | `pending` | SDK-first `AbortSignal` + caller-visible `aborted` result |
| [260626-review-stream-jsonl-logs.md](./260626-review-stream-jsonl-logs.md) | `archived` | Superseded CLI-gated stream-artifact plan |
| [260627-sdk-agent-stream-logs.md](./260627-sdk-agent-stream-logs.md) | `pending` | SDK `run.stream()` / `runStreamed()` JSONL logs + `streamArtifacts` meta |
| [260627-remove-cursor-cli-review-runtime.md](./260627-remove-cursor-cli-review-runtime.md) | `pending` | Remove Cursor CLI runtime from harness reviews after SDK parity |
| [260626-workflow-step-events.md](./260626-workflow-step-events.md) | `pending` | `events.jsonl` + `WorkflowEventSink` (independent) |

## Implementation order

```
Phase A — correctness (no deps)
  1. 260626-json-extract-rightmost-object

Phase B — observability (SDK-first)
  2. 260627-sdk-agent-stream-logs           ← replaces CLI stream-json plans

Phase C — parallel OK after Phase A
  3. 260626-workflow-step-events            ← independent; can reference stream artifacts after 2

Phase D — cancellation
  4. 260626-agent-abort-signal              ← SDK cancellation; coordinate stream-writer cleanup if 2 lands first

Phase E — remove legacy runtime
  5. 260627-remove-cursor-cli-review-runtime ← after SDK logs + abort land
```

**Recommended single-threaded order:** `1 → 2 → 3 → 4 → 5`.

**Parallel option:** `260626-workflow-step-events` can run in parallel with `260627-sdk-agent-stream-logs`; merge carefully if both edit `meta.json` shape.

**Archived from active queue:** `260626-incremental-stream-json-parsing`, `260626-review-stream-jsonl-logs`.

## SDK pivot triage

| Artifact | Disposition | Notes |
|----------|-------------|-------|
| `260626-incremental-stream-json-parsing` | Archived | Cursor CLI subprocess streaming only |
| `260626-review-stream-jsonl-logs` | Archived | Replaced by SDK stream log plan |
| `260626-agent-abort-signal` | Rewritten | SDK `AbortSignal` / `run.cancel()` only |
| `260627-sdk-agent-stream-logs` | New active plan | Cursor SDK + Codex SDK stream logs |
| `260627-remove-cursor-cli-review-runtime` | New active plan | Removes legacy Cursor CLI review runtime after SDK parity |
| `260626-workflow-step-events` | Keep | Harness CLI/events plan; SDK-neutral |
| `260626-json-extract-rightmost-object` | Keep done | Runtime-agnostic parser fix; stale CLI/private refs trimmed |
| `260621-agent-harness-handoff` | Refreshed | SDK-first roadmap |
| `dev/todo/260627-reviewer-json-parse-resilience` | Trimmed | SDK-first structured-output follow-up |
| `README.md` | Refresh in Phase E | User-facing runtime docs; update when `260627-remove-cursor-cli-review-runtime` executes |
| `skills/cursor-cli/` | Decide in Phase E | Fate decided in `260627-remove-cursor-cli-review-runtime` Step 1 |

**New plans:** `YYMMDD-short-slug.md` — reconcile here before adding.
