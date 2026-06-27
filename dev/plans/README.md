# Plans & handoffs

| File | Status | Summary |
| ---- | ------ | ------- |
| [260621-agent-harness-handoff.md](./260621-agent-harness-handoff.md) | `in_progress` | Roadmap: `change-review`, durable orchestration (Phase 2), graders, triggers |
| [260626-json-extract-rightmost-object.md](./260626-json-extract-rightmost-object.md) | `pending` | Rightmost JSON + schema-aware `parseStructuredOutput` (round 2) |
| [260626-incremental-stream-json-parsing.md](./260626-incremental-stream-json-parsing.md) | `pending` | Infra: `createJSONLParser`, `--log-path`, parent bridge (no workflow edits) |
| [260626-agent-abort-signal.md](./260626-agent-abort-signal.md) | `pending` | Provider `AbortSignal` + envelope `aborted` (no CLI/workflow signal yet) |
| [260626-review-stream-jsonl-logs.md](./260626-review-stream-jsonl-logs.md) | `pending` | `*.stream.jsonl` + `streamArtifacts` meta (depends on stream-json infra) |
| [260626-workflow-step-events.md](./260626-workflow-step-events.md) | `pending` | `events.jsonl` + `WorkflowEventSink` (independent) |

## Implementation order

```
Phase A — correctness (no deps)
  1. 260626-json-extract-rightmost-object

Phase B — provider infra (sequential)
  2. 260626-incremental-stream-json-parsing
  3. 260626-review-stream-jsonl-logs        ← requires 2

Phase C — parallel OK after Phase A
  4. 260626-workflow-step-events            ← independent; ship anytime after A

Phase D — merge carefully with 2
  5. 260626-agent-abort-signal              ← same runAgent as 2; land 2 first or one PR
```

**Recommended single-threaded order:** `1 → 2 → 4 → 3 → 5` (events before stream meta so `outputs` can reference streams; abort last to avoid `runAgent` conflicts).

**Parallel option:** `1` + `6-events` in parallel; then `2` → `4` → `3` → `5`.

GNHF reference: `/Users/frueda/dev/gnhf` (read-only).

**New plans:** `YYMMDD-short-slug.md` — reconcile here before adding.
