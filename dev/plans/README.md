# Plans & handoffs

## Active queue

| File | Status | Summary |
| ---- | ------ | ------- |
| [260621-agent-harness-handoff.md](./260621-agent-harness-handoff.md) | `in_progress` | Roadmap: `change-review`, durable orchestration (Phase 2), graders, triggers |
| [260627-remove-cursor-cli-review-runtime.md](./260627-remove-cursor-cli-review-runtime.md) | `pending` | Remove Cursor CLI review runtime after SDK parity (stream logs + abort landed) |

**Build next:** `260627-remove-cursor-cli-review-runtime` → then `steps.json` / graders per [handoff](./260621-agent-harness-handoff.md).

Optional follow-up (todo, not a plan): [parse-resilience](../todo/260627-reviewer-json-parse-resilience.md) — diagnostics, structured output spike, retry.

---

## Completed (archived from active queue)

| File | Merged | Summary |
| ---- | ------ | ------- |
| [260626-json-extract-rightmost-object.md](./260626-json-extract-rightmost-object.md) | [#33](https://github.com/ferueda/harness/pull/33) | Rightmost JSON + schema-aware `parseStructuredOutput` |
| [260627-sdk-agent-stream-logs.md](./260627-sdk-agent-stream-logs.md) | [#34](https://github.com/ferueda/harness/pull/34) | SDK `run.stream()` / `runStreamed()` JSONL + `streamArtifacts` meta |
| [260626-workflow-step-events.md](./260626-workflow-step-events.md) | [#34](https://github.com/ferueda/harness/pull/34) | `events.jsonl`, `WorkflowEventSink`, `--verbose` heartbeats |
| [260626-agent-abort-signal.md](./260626-agent-abort-signal.md) | [#36](https://github.com/ferueda/harness/pull/36) | SDK `AbortSignal`, `aborted` result, stream writer cleanup on cancel |

Historical executor steps remain in each file for reference. Do not re-run them.

---

## Superseded (never implement)

| File | Replaced by |
| ---- | ----------- |
| [260626-incremental-stream-json-parsing.md](./260626-incremental-stream-json-parsing.md) | `260627-sdk-agent-stream-logs` |
| [260626-review-stream-jsonl-logs.md](./260626-review-stream-jsonl-logs.md) | `260627-sdk-agent-stream-logs` |

---

## SDK pivot — shipped vs remaining

| Area | Status |
| ---- | ------ |
| Schema-aware JSON extraction | ✅ PR #33 |
| SDK stream logs (Cursor + Codex) | ✅ PR #34 |
| Workflow `events.jsonl` + `--verbose` | ✅ PR #34 |
| SDK abort / `aborted` contract | ✅ PR #36 |
| Cursor CLI review runtime removal | ⏳ `260627-remove-cursor-cli-review-runtime` |
| Parse resilience (syntax errors, structured output) | 📋 [todo](../todo/260627-reviewer-json-parse-resilience.md) |
| `steps.json` resumability | 📋 handoff Phase 0.6 |

---

## Completed implementation phases

```
Phase A — correctness                    ✅ 260626-json-extract-rightmost-object
Phase B — SDK stream logs                ✅ 260627-sdk-agent-stream-logs
Phase C — workflow step events           ✅ 260626-workflow-step-events
Phase D — SDK cancellation               ✅ 260626-agent-abort-signal
Phase E — remove legacy Cursor CLI path  ⏳ 260627-remove-cursor-cli-review-runtime
```

---

## Doc refresh after Phase E

| Artifact | When |
|----------|------ |
| [README.md](../../README.md) | Remove / gate `--runtime cli` user docs |
| [skills/cursor-cli/](../../skills/cursor-cli/) | Keep, archive, or split — Step 1 of removal plan |

**New plans:** `YYMMDD-short-slug.md` — reconcile here before adding.
