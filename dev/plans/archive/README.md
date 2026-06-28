# Archived plans

Completed or superseded implementation plans. **Do not re-run** executor steps — historical reference only.

Active work: [`../README.md`](../README.md).

## Completed

| File | Merged | Summary |
| ---- | ------ | ------- |
| [260628-shared-review-json-parse.md](./260628-shared-review-json-parse.md) | (branch) | Shared `lib/` review parser; Codex wiring; syntax-error diagnostics |
| [260627-remove-cursor-cli-review-runtime.md](./260627-remove-cursor-cli-review-runtime.md) | [#37](https://github.com/ferueda/harness/pull/37) | SDK-only reviews; `cursor-cli` skill launcher |
| [260626-agent-abort-signal.md](./260626-agent-abort-signal.md) | [#36](https://github.com/ferueda/harness/pull/36) | Provider `AbortSignal`, `aborted` result |
| [260627-sdk-agent-stream-logs.md](./260627-sdk-agent-stream-logs.md) | [#34](https://github.com/ferueda/harness/pull/34) | SDK stream JSONL + `streamArtifacts` |
| [260626-workflow-step-events.md](./260626-workflow-step-events.md) | [#34](https://github.com/ferueda/harness/pull/34) | `events.jsonl`, `--verbose` |
| [260626-json-extract-rightmost-object.md](./260626-json-extract-rightmost-object.md) | [#33](https://github.com/ferueda/harness/pull/33) | Rightmost JSON + schema-aware parse |

## Superseded (never implement)

| File | Replaced by |
| ---- | ----------- |
| [260626-incremental-stream-json-parsing.md](./260626-incremental-stream-json-parsing.md) | `260627-sdk-agent-stream-logs` |
| [260626-review-stream-jsonl-logs.md](./260626-review-stream-jsonl-logs.md) | `260627-sdk-agent-stream-logs` |
