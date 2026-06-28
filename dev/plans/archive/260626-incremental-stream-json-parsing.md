# Plan 260626-incremental-stream-json-parsing: Archived

## Status

- **Status**: archived
- **Archived**: 2026-06-27
- **Superseded by**: `dev/plans/260627-sdk-agent-stream-logs.md`
- **Original category**: dx

## Why archived

This plan targeted Cursor CLI subprocess NDJSON plumbing:

- Cursor CLI `--output-format stream-json`
- `harness-cursor --log-path`
- parent/child process mirroring
- CLI stdout byte parsing

`change-review` now defaults to SDK providers, and both supported SDK paths have first-class streaming APIs. Implementing this CLI bridge would not improve production reviewer observability.

## Replacement direction

Use `dev/plans/260627-sdk-agent-stream-logs.md`.

That plan adds provider-level `logPath` support and writes SDK-native stream events:

- Cursor SDK: `run.stream()`
- Codex SDK: `thread.runStreamed()`

Do not implement this archived plan unless a future decision explicitly restores Cursor CLI streaming as a supported review path.
