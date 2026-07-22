# Decompose proven module responsibilities

## Goal

Complete FER-280 as a behavior-preserving ownership refactor. Split the standalone
Linear read implementation and review runtime at the capability seams already
proved by their callers and tests. Keep `LinearService`, `createWorkflowContext`,
serialized Linear data, review artifacts, error messages, and ordering stable.

The post-FER-279 worker review found no matching change: `lib/linear-automation/worker.ts`
has one process-entry responsibility with explicit test seams for environment,
authentication, function composition, and hosting. Leave it intact rather than
create a line-count-only split.

## Changes

1. `lib/linear/read.ts`, `lib/linear/client.ts`, and new focused files under
   `lib/linear/` — remove the combined read module. Put public JSON-safe read
   contracts in `types.ts`, the narrow SDK seam in `sdk-types.ts`, issue snapshot
   loading and normalization in `issue-context.ts`, Backlog revision listing in
   `revisions.ts`, and comment/workflow/issue lookup operations in `lookups.ts`.
   Keep shared SDK value validation and normalization in one subsystem-owned
   module, and keep `client.ts:createLinearForClient` as the consumer facade.
   Update direct type consumers to the owning type module; do not add a barrel or
   compatibility copy of `read.ts`. Follow the repository's TypeScript refactor
   guidance to preserve inference and avoid casts at the new boundaries.

2. `lib/linear/read.test.ts`, `lib/linear/write.test.ts`, and focused Linear test
   files — move existing cases beside the capability they prove. Preserve the
   rich-context fixtures and exact assertions for pagination, truncation,
   relation direction, normalization, lookup ambiguity, and upstream error
   translation. Do not add lower-level tests where the facade tests already prove
   the same behavior.

3. `lib/review/runtime.ts`, new `lib/review/reviewer.ts`, and new
   `lib/review/run-report.ts` — keep context creation and orchestration in
   `runtime.ts`; move reviewer configuration, prompt/provider execution, and
   structured-output validation to `reviewer.ts`; move final summary/metadata,
   stream artifact recording, and orphan cleanup to `run-report.ts`. Re-export
   `ReviewAgentName` and `cleanupOrphanedRunDir` from `runtime.ts` so workflow and
   CLI callers retain their current contract. Do not change prompt text, agent
   options, artifact names, JSON shape, or cleanup rules.

4. `test/workflow-context.test.ts` and any focused review tests created during
   extraction — redistribute assertions only when they have a clear new owner.
   Continue testing through `createWorkflowContextForTest` for provider execution
   and through the existing public cleanup seam for run-directory behavior.

5. `docs/contributing/architecture.md` and import-boundary fixtures — update the
   source map only for durable new owners, and keep cross-subsystem consumers on
   `lib/linear/client.ts` or public JSON-safe types. Add no new dependency
   exemption or cross-module cycle.

## Verify

- `pnpm vitest run lib/linear test/workflow-context.test.ts test/workflow-events.test.ts test/import-boundaries.test.ts`
- `make check`

## Boundaries

- No Linear, provider, CLI, configuration, event, or durable artifact behavior
  changes.
- Do not split `lib/linear-automation/worker.ts` in this issue; revisit only when
  one of its process concerns gains a separate consumer or lifecycle.
- No barrel files, generic helper directories, compatibility modules, or one-file-
  per-helper layout.
