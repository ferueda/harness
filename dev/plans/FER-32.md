# Plan 260708-factory-implementation-input-contract: Add implementation input resolver

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the next
> step. If anything in "STOP conditions" occurs, stop and report; do not
> improvise.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none. FER-34's lifecycle event log/read model is already shipped
  in this tree.
- **Category**: dx, direction
- **Linear issue**: FER-32

## Why this matters

The planning station can now move planned tracker work to `Ready to Implement`,
but the future implementation station still lacks a small, deterministic input
contract. Without that contract, an implementation runner could accidentally use
stale Linear comments, ignore the lifecycle read model, or start planned work
without an approved plan file and commit marker. This plan adds a library-only
resolver for implementation readiness. It does not build the implementation
station, branch/worktree orchestration, or tracker mutation.

## Requirements

- Define a tracker-neutral implementation input contract on top of the existing
  `FactoryWorkItem` and lifecycle read model.
- Planned implementation input:
  - consume resolved factory state, not Linear comments as source of truth;
  - require `factoryStage: "plan-approved"`;
  - require `approvedPlanPath`;
  - require `approvedPlanCommit`;
  - require `approvedPlanPath` to exist in the current workspace;
  - return the approved plan path and commit pin for the future implementer.
- Direct implementation input:
  - require `factoryStage: "ready-to-implement"`;
  - require explicit route marker `factoryRoute: "ready-to-implement"`;
  - require explicit action marker `factoryNextAction: "implement-directly"`;
  - return tracker/imported work item source material: title, body, labels, url,
    and tracker metadata when present.
- Linear-backed implementation input must only accept issues whose current Linear
  status equals configured `factory.linear.statuses.readyToImplement`.
- Preserve lifecycle state as canonical machine state. Linear status is a
  projection guard only.
- Fail closed with clear errors for partial planning handoffs, stale Linear
  status, missing direct route markers, invalid metadata, and missing plan files.
- Keep this as a contract/helper and tests. Do not add a CLI command or run
  provider agents.

## Current State

- `docs/contributing/factory.md:73-78` states metadata keys are transport fields,
  lifecycle state is canonical when present, and `approvedPlanCommit` pins the
  merged plan version.
- `docs/contributing/factory.md:89-102` states
  `.harness/factory/events/*.jsonl` is canonical local lifecycle truth and
  terminal events own durable transitions.
- `docs/contributing/factory.md:270-278` maps Linear `Ready to Implement` to
  `factoryStage: "ready-to-implement"` only as a bootstrap fallback when no
  lifecycle state exists.
- `lib/factory-schemas.ts:19-39` already defines implementation-era stages:
  `implementation-started`, `implementation-complete`, `review-running`,
  `review-complete`, and `ready-for-human`.
- `lib/factory-schemas.ts:91-102` already reserves
  `factoryRoute`, `factoryNextAction`, `factoryStage`, `approvedPlanPath`,
  `approvedPlanPrUrl`, and `approvedPlanCommit` in work-item metadata.
- `lib/factory-lifecycle.ts:178-195` validates lifecycle read-model state with
  the same handoff fields.
- `lib/factory-lifecycle.ts:376-392` reduces `plan_pr.opened` to
  `plan-pr-open` without a commit and `plan_pr.merged` to `plan-approved` with
  `approvedPlanPath`, `approvedPlanPrUrl`, and `approvedPlanCommit`.
- `lib/factory-lifecycle.ts:453-462` overlays lifecycle fields into work-item
  metadata for station input.
- `lib/factory-triage-input.ts:39-91` is now the shared station input resolver:
  file input reads a `FactoryWorkItem`, Linear input fetches through the adapter,
  then both merge lifecycle state over tracker fallback metadata.
- `lib/factory-planning-input.ts:5-29` is the nearest station-specific guard.
  It accepts only planning entry states for Linear input and currently rejects
  `ready-to-implement`.
- `bin/factory-commands.ts:303-336` shows the station command pattern: validate
  flags, resolve config and roles, resolve work item input, then apply a
  station-specific input guard before creating the run context.
- `lib/factory-planning-handoff.ts:139-162` already implements planned-work
  fail-closed checks for `plan-approved`, `approvedPlanPath`,
  `approvedPlanCommit`, and on-disk plan existence. This should be reused, not
  duplicated.
- `test/factory-planning-handoff.test.ts:151-168` covers the existing planned
  handoff happy path and plan-pr-open rejection.
- `test/factory-planning-input.test.ts:90-136` covers the current planning guard
  accepted and rejected states. `test/factory-planning-input.test.ts:216-236`
  proves `ready-to-implement` is currently rejected by planning before run
  directories are touched.
- `dev/plans/README.md` lists "Factory lifecycle event log and read model" as
  shipped in PR #85, so the old FER-32 dependency on FER-34 is satisfied.

## Commands You Will Need

| Purpose         | Command                                                                                                                          | Expected on success                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Install         | `pnpm install --frozen-lockfile`                                                                                                 | exit 0                                                             |
| Focused tests   | `pnpm test -- test/factory-implementation-input.test.ts test/factory-planning-handoff.test.ts test/factory-triage-input.test.ts` | exit 0; all selected tests pass                                    |
| Typecheck       | `pnpm typecheck`                                                                                                                 | exit 0, no TypeScript errors                                       |
| Lint            | `pnpm lint`                                                                                                                      | exit 0, no lint errors                                             |
| Full tests      | `pnpm test`                                                                                                                      | exit 0; all tests pass                                             |
| Full local gate | `pnpm check`                                                                                                                     | exit 0; format, lint, typecheck, tests, build, and smoke-dist pass |

## Skills for the Executor

| Step                 | Skill/tool                                                           | Why                                                                                                           |
| -------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| All steps            | `implement-plan`                                                     | Execute this approved plan phase by phase and update checkboxes if this plan is later copied to `dev/plans/`. |
| Steps 1-3            | `typescript-refactor`                                                | Keep the new discriminated union and exported helper types idiomatic for strict TypeScript.                   |
| Steps 1-3            | `node`                                                               | Preserve Node 24 native TypeScript conventions: `.ts` imports, `import type`, erasable syntax.                |
| Steps 1-3            | `zod`                                                                | Use existing Zod metadata parsing patterns and boundary validation; do not trust raw metadata.                |
| Steps 2-3            | `vitest`                                                             | Add isolated regression tests matching the repo's Vitest style.                                               |
| After implementation | `review-spec` or `harness run plan-review --plan <copied-plan-path>` | Validate plan/implementation alignment if this plan is promoted to `dev/plans/`.                              |
| Final review         | `change-review-workflow`                                             | Run implementation, quality, and simplify review after code changes.                                          |
| Factory context      | `factory-operator`                                                   | Confirm current lifecycle, Linear, and factory artifact semantics while documenting the contract.             |

Verified discovery sources: host injected skill list, repo `skills/`, and repo
`.agents/skills/`. No `.cursor/skills` or `.claude/skills` directory was present
in this checkout during planning.

## Scope

**In scope, and the only source files to modify:**

- `lib/factory-implementation-input.ts` (create)
- `test/factory-implementation-input.test.ts` (create)
- `docs/contributing/factory.md`
- `docs/contributing/architecture.md`

**Out of scope:**

- `bin/factory-commands.ts`: do not add `harness factory implementation` yet.
- `workflows/`: do not add an implementation workflow or provider prompt.
- `providers/`: do not invoke agents.
- `lib/factory-lifecycle.ts` and `lib/factory-lifecycle-writes.ts`: do not add
  implementation lifecycle events in this slice.
- `lib/factory-linear-adapter.ts`: do not mutate Linear or add adapter methods.
- `schemas/`: no new structured agent-output schema is needed for this
  library-only input resolver.
- Branch/worktree orchestration: belongs to FER-30.
- GitHub issue adapter and Inngest backend: future work.
- Commit creation, PR creation, tracker labels, issue comments, or tracker state.

## Design

Add a new pure helper module that consumes the existing resolved station input
instead of adding another fetch path:

```ts
import { validatePlannedWorkHandoff } from "./factory-planning-handoff.ts";
import { parseFactoryWorkItemMetadata, type FactoryWorkItemMetadata } from "./factory-schemas.ts";
import type { FactoryResolvedWorkItemInput } from "./factory-triage-input.ts";

export class FactoryImplementationInputError extends Error { ... }

export type FactoryImplementationSourceMaterial = {
  title: string;
  body: string;
  labels: string[];
  url?: string;
  tracker?: FactoryWorkItemMetadata["tracker"];
};

export type FactoryPlannedImplementationInput = {
  mode: "planned";
  source: FactoryResolvedWorkItemInput["source"];
  workItem: FactoryResolvedWorkItemInput["workItem"];
  metadata: FactoryWorkItemMetadata;
  approvedPlanPath: string;
  planPath: string;
  approvedPlanCommit: string;
};

export type FactoryDirectImplementationInput = {
  mode: "direct";
  source: FactoryResolvedWorkItemInput["source"];
  workItem: FactoryResolvedWorkItemInput["workItem"];
  metadata: FactoryWorkItemMetadata;
  sourceMaterial: FactoryImplementationSourceMaterial;
};

export type FactoryImplementationInput =
  | FactoryPlannedImplementationInput
  | FactoryDirectImplementationInput;

export function resolveFactoryImplementationInput(input: {
  workspace: string;
  resolvedInput: FactoryResolvedWorkItemInput;
  linearReadyStatus?: string;
}): FactoryImplementationInput;
```

Implementation rules:

- Parse `resolvedInput.workItem.metadata` with `parseFactoryWorkItemMetadata`.
  Wrap parse failures in `FactoryImplementationInputError` with message
  `Invalid factory work item metadata for implementation input.`
- For `resolvedInput.source === "linear"`, require a non-empty
  `linearReadyStatus` and require `metadata.linearStatus === linearReadyStatus`.
  Use the configured ready status from `factory.linear.statuses.readyToImplement`
  when future CLI wiring is added. Do not hardcode status config in this helper.
- Use this exact ordered algorithm:

```ts
const metadata = parseFactoryWorkItemMetadata(resolvedInput.workItem.metadata);
if (resolvedInput.source === "linear") {
  requireConfiguredReadyStatus(input.linearReadyStatus);
  require(metadata.linearStatus === input.linearReadyStatus);
}
if (hasAnyPlannedPublicationSignal(metadata)) {
  const handoff = validatePlannedWorkHandoff(metadata, workspace);
  return plannedResult(handoff);
}
if (hasAllDirectMarkers(metadata)) {
  return directResult();
}
throw new FactoryImplementationInputError(
  `Factory work item is not ready for implementation: factoryStage=${metadata.factoryStage ?? "none"}, factoryRoute=${metadata.factoryRoute ?? "none"}, factoryNextAction=${metadata.factoryNextAction ?? "none"}, linearStatus=${String(metadata.linearStatus ?? "none")}`,
);
```

- `hasAnyPlannedPublicationSignal(metadata)` is true when any of these exists:
  `metadata.factoryStage === "plan-approved"`,
  `metadata.factoryStage === "plan-pr-open"`, `metadata.approvedPlanPath`,
  `metadata.approvedPlanPrUrl`, or `metadata.approvedPlanCommit`.
- Planned publication signals take precedence over direct route markers. If a
  work item somehow has both, validate it as planned work and let
  `validatePlannedWorkHandoff` fail closed if the handoff is incomplete.
- For planned candidates, call
  `validatePlannedWorkHandoff(metadata, workspace)`. Return `mode: "planned"`
  with the absolute `planPath`, relative `approvedPlanPath`, and
  `approvedPlanCommit`.
- Planned-path handoff failures should propagate `FactoryPlanningError`
  unchanged from `validatePlannedWorkHandoff`; do not wrap or reword those
  errors. Parse failures and direct/mode-classification failures should use
  `FactoryImplementationInputError`.
- `hasAllDirectMarkers(metadata)` is true only when all of these hold:
  `metadata.factoryStage === "ready-to-implement"`,
  `metadata.factoryRoute === "ready-to-implement"`, and
  `metadata.factoryNextAction === "implement-directly"`.
- Direct mode must not infer readiness from Linear `Ready to Implement` alone.
  Linear is only the projection guard; lifecycle or explicit metadata route
  fields are the factory readiness signal.
- Direct `sourceMaterial` should copy title/body/labels/url from the resolved
  work item and include `metadata.tracker` when present.
- The Linear projection guard always runs before returning either mode, so stale
  Linear board state cannot be masked by otherwise valid factory metadata.
- Mode-classification error messages should include the bad stage, route, action,
  and Linear status. Match existing factory style: short, deterministic,
  regex-testable.

## Steps

### Step 1: Add the implementation input helper

Create `lib/factory-implementation-input.ts` with the types and resolver above.

Use these existing patterns:

- `lib/factory-planning-input.ts:5-29` for station-specific guard shape and
  metadata parse wrapping.
- `lib/factory-planning-handoff.ts:139-162` for planned-work validation.
- `lib/factory-triage-input.ts:39-91` as the upstream resolver this helper
  should consume.

Do not import Linear adapter types. This helper should know only about
`FactoryResolvedWorkItemInput`, metadata, workspace path, and optional configured
Linear ready status.

**Verify**:
`pnpm typecheck` -> exits 0 with no TypeScript errors.

### Step 2: Add focused regression tests

Create `test/factory-implementation-input.test.ts`.

Model structure after:

- `test/factory-planning-input.test.ts` for station input guard cases;
- `test/factory-planning-handoff.test.ts` for temporary workspace and plan-file
  setup;
- `test/factory-triage-input.test.ts` for lifecycle overlay through
  `resolveFactoryWorkItemInput`.

Cover these cases:

1. Planned Linear input in `Ready to Implement` resolves to `mode: "planned"`
   when metadata has `factoryStage: "plan-approved"`, `approvedPlanPath`,
   `approvedPlanCommit`, and the plan file exists.
2. Planned input fails when `approvedPlanPath` is missing on disk.
3. Item-file planned input fails with the existing handoff error when only
   `plan-pr-open` / `approvedPlanPrUrl` exists without `approvedPlanCommit`.
   Use item-file input here so the test reaches `validatePlannedWorkHandoff`
   instead of failing earlier on the Linear ready-status projection guard.
4. Direct Linear input in `Ready to Implement` resolves to `mode: "direct"` only
   when `factoryStage`, `factoryRoute`, and `factoryNextAction` are all explicit
   direct markers.
5. Direct input fails if route or nextAction is missing, even when Linear status
   is `Ready to Implement`.
6. Linear projection guard fails if `metadata.linearStatus` is not the configured
   ready status, even for otherwise valid planned metadata.
7. Linear input in `Plan Needs Review` with `plan-pr-open` metadata fails on the
   projection guard before planned handoff validation. Use
   `test/factory-linear-test-helpers.ts` and the source-branching style from
   `assertFactoryPlanningLinearEntry` tests.
8. Item-file input skips the Linear projection guard but still enforces planned
   or direct readiness.
9. Invalid metadata shape fails closed with
   `Invalid factory work item metadata for implementation input`.
10. Lifecycle overlay integration: append `work_item.imported` and
    `plan_pr.merged` events, resolve a Linear work item through
    `resolveFactoryWorkItemInput`, then verify the implementation resolver sees
    lifecycle-derived `plan-approved`, `approvedPlanPath`, and
    `approvedPlanCommit`.

Use temp directories under `tmpdir()`. Write only temp workspace plan files, not
repo files. Keep fake Linear status data from `test/factory-linear-test-helpers.ts`.

**Verify**:
`pnpm test -- test/factory-implementation-input.test.ts test/factory-planning-handoff.test.ts test/factory-triage-input.test.ts`
-> exits 0; new implementation input tests and existing adjacent tests pass.

### Step 3: Document the library-only contract

Update `docs/contributing/factory.md` with a short subsection named
`### Implementation Input Contract`. Insert it after the manual publication
apply paragraphs in `## Planning Station` and before `## Local Inbox`; current
anchor during planning was the paragraph ending with "non-Linear tracker
metadata before local metadata writes." around lines 405-411.

- State there is still no implementation station CLI.
- State future implementation station input should first use
  `resolveFactoryWorkItemInput`, then `resolveFactoryImplementationInput`.
- State planned mode requires lifecycle/factory metadata `plan-approved`,
  `approvedPlanPath`, `approvedPlanCommit`, and a plan file present in the
  current workspace.
- State direct mode requires `ready-to-implement` plus explicit
  `ready-to-implement` / `implement-directly` route markers.
- State Linear `Ready to Implement` is a projection consistency guard, not the
  source of truth.

Update `docs/contributing/architecture.md` in "Major source areas" to add
`lib/factory-implementation-input.ts` immediately after the
`lib/factory-planning-handoff.ts` entry. Describe it as the owner of the
library-only future implementation station input contract. Keep wording
present-tense but library-specific; do not claim an implementation station
command exists.

**Verify**:
`pnpm test -- test/docs-contracts.test.ts` -> exits 0.

### Step 4: Run full verification

Run the gates in this order:

1. `pnpm typecheck`
2. `pnpm lint`
3. `pnpm test`
4. `pnpm check`

Expected result: every command exits 0. If `pnpm check` fails only after a prior
target passed, inspect the failing Make step and fix within the in-scope files
only.

## Test Plan

- New file: `test/factory-implementation-input.test.ts`.
- Primary behavior under test: planned/direct mode classification and fail-closed
  validation from resolved factory work items.
- Regression focus:
  - no implementation input from stale Linear status;
  - no direct implementation without explicit route/action markers;
  - no planned implementation without approved plan file and commit marker;
  - lifecycle read model wins over tracker fallback metadata when resolving
    implementation input.
- Existing tests to keep passing:
  - `test/factory-planning-input.test.ts`
  - `test/factory-planning-handoff.test.ts`
  - `test/factory-triage-input.test.ts`
  - `test/factory-lifecycle.test.ts`
  - `test/docs-contracts.test.ts`

## Done Criteria

All must hold:

- [ ] `lib/factory-implementation-input.ts` exists and exports
      `resolveFactoryImplementationInput`.
- [ ] Planned mode reuses `validatePlannedWorkHandoff`; it does not duplicate
      path containment or plan existence logic.
- [ ] Direct mode requires `factoryStage`, `factoryRoute`, and
      `factoryNextAction`; Linear status alone is insufficient.
- [ ] Linear input requires configured ready status via `linearReadyStatus`.
- [ ] New tests cover planned success, direct success, missing plan file, missing
      commit/plan-pr-open via item-file input, stale Linear status/projection guard,
      missing direct markers, item-file input, invalid metadata, and lifecycle
      overlay.
- [ ] `docs/contributing/factory.md` contains a
      `### Implementation Input Contract` subsection before `## Local Inbox`.
- [ ] `docs/contributing/architecture.md` includes
      `lib/factory-implementation-input.ts` after the
      `lib/factory-planning-handoff.ts` entry in "Major source areas".
- [ ] Docs state this is a library-only input contract and that no implementation
      station command exists yet.
- [ ] `pnpm test -- test/factory-implementation-input.test.ts test/factory-planning-handoff.test.ts test/factory-triage-input.test.ts` exits 0.
- [ ] `pnpm typecheck` exits 0.
- [ ] `pnpm lint` exits 0.
- [ ] `pnpm test` exits 0.
- [ ] `pnpm check` exits 0.
- [ ] `git status --short` shows only in-scope files changed.

## STOP Conditions

Stop and report back if:

- Current code no longer has `resolveFactoryWorkItemInput` merging lifecycle
  state over work-item metadata.
- `validatePlannedWorkHandoff` no longer checks `factoryStage`,
  `approvedPlanPath`, `approvedPlanCommit`, and plan file existence.
- Implementing the contract appears to require adding a CLI command, workflow,
  provider prompt, lifecycle implementation events, branch/worktree handling, or
  tracker mutation.
- You conclude the contract must verify the plan file at `approvedPlanCommit`
  with Git object lookup. The current issue decision requires the commit marker
  and current workspace plan file; adding commit-object validation is a separate
  product decision.
- The Linear ready-status guard cannot be implemented without hardcoding
  `"Ready to Implement"` in library code.
- A verification failure requires touching an out-of-scope file.

## Maintenance Notes

- Future `harness factory implementation ...` CLI should use the same command
  shape as planning: resolve flags/config, call `resolveFactoryWorkItemInput`,
  call `resolveFactoryImplementationInput`, then create any implementation run
  context.
- When implementation lifecycle events are added later, the direct/planned
  readiness checks here should remain the entry gate before appending
  `implementation-started`.
- Reviewers should scrutinize fail-closed order: stale Linear status should not
  be masked by planned/direct success, and direct implementation should not be
  inferred from tracker status alone.
- Do not expand this helper into a generic station framework. One small resolver
  is enough for this slice.
