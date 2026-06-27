# Plan 260626-review-stream-jsonl-logs: Archived

## Status

- **Status**: archived
- **Archived**: 2026-06-27
- **Superseded by**: `dev/plans/260627-sdk-agent-stream-logs.md`
- **Original category**: dx

## Why archived

This plan assumed stream logs were Cursor CLI-only and that SDK/Codex runs should record `streamArtifacts.*.status: "unsupported"`. That premise is stale.

Current provider docs and installed SDK declarations support SDK streaming:

- Cursor SDK exposes `Run.stream()` for `SDKMessage` events and `Run.wait()` for the final result.
- Codex SDK exposes `Thread.runStreamed()` for `ThreadEvent` streams and `outputSchema` / `signal` turn options.

## Replacement direction

Use `dev/plans/260627-sdk-agent-stream-logs.md`.

That plan owns:

- `AgentRunInput.logPath`
- SDK event JSONL writing
- workflow per-stage `*.stream.jsonl` paths
- `meta.json` `streamArtifacts` indexing
- tests for partial streams on failure or timeout

Do not implement this archived CLI-gated plan.
