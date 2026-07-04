# Architecture

## Runtime flow

```text
CLI (bin/harness.ts)
  -> workspace/config resolution (lib/config.ts, harness.json)
  -> workflow context (lib/workflow-context.ts, using lib/context.ts helpers)
  -> provider selection (providers/registry.ts and provider adapters)
  -> workflow definition (workflows/change-review.workflow.ts or workflows/plan-review.workflow.ts)
  -> shared review runner (workflows/review-steps.ts, invokes provider per step,
     aggregates through lib/aggregate.ts)
  -> artifacts (.harness/runs/reviews/<run-id>/)
```

Current public CLI surfaces:

- `harness init`
- `harness run change-review`
- `harness run plan-review`
- `harness runs prune`
- `harness models`
- `harness skills install`

## Harness repo responsibilities

The harness repo owns the reusable workflow system:

- `bin/` - CLI entrypoints.
- `lib/` - config, context, schemas, prompts, aggregation, events, runs, and
  skill installation helpers.
- `providers/` - Cursor and Codex provider adapters plus `providers/registry.ts`.
- `workflows/` - callable workflow definitions and shared review-step execution.
- `skills/` - packaged skills that can be installed into target repos.
- `.agents/skills/` - repo-local development skills for this checkout.
- `automations/` - background task definitions.
- `schemas/` - exported JSON schema artifacts.
- `scripts/` - local helper scripts such as the dist smoke test and Make gate
  output runner (`scripts/run-gate-step.ts`).
- `dev/plans/` - active plans and handoffs.

Reviewer prompt templates live under `lib/prompts/` and are loaded through the
review configuration in `lib/workflow-context.ts`.

`lib/schemas.ts` owns runtime Zod validation. `schemas/` owns exported JSON
schema artifacts. Changes to one side may require checking the other.

## Target repo responsibilities

Target repositories own their local harness state:

- `harness.json` for repo-local defaults.
- `.harness/bin/harness` as an ignored shim written by `harness init`.
- `.harness/runs/reviews/<run-id>/` for review artifacts.
- local `.agents/skills/` installs when a target repo chooses to install skills.

Target repositories also own their project docs, source code, tests, CI, and
final gates. Harness can invoke workflows against them, but it does not own
their product decisions.

## Major source areas

`bin/harness.ts` defines the CLI and routes commands into runtime helpers.

`lib/config.ts` resolves the workspace, reads `harness.json`, defaults base to
`main`, defaults the provider to Cursor, resolves provider config, and writes
target-repo shims during `harness init`.

`lib/context.ts` supplies git-scope and context-artifact helpers invoked by the
workflow context. When git scope is included, it prepares the merge-base diff
and writes `context/diff.patch`. It also copies plan and handoff inputs under
`context/` and builds prompt reference sections for plan, diff, and handoff
inputs.

`lib/aggregate.ts` computes aggregate review verdicts from reviewer outputs.

`lib/workflow-context.ts` creates run directories, honors the caller's
`includeGitScope` setting, wires providers, selects reviewer prompts, exports
prompts and reviewer JSON, writes metadata and summaries, emits events, and
cleans up orphaned run directories. CLI and workflow entrypoints choose whether
git scope is included for each workflow.

`workflows/change-review.workflow.ts` runs the default review set:
implementation, quality, and simplify. Full default runs execute these
reviewers in parallel, then results are aggregated in workflow order. Callers
may request a subset of reviewers.

`workflows/plan-review.workflow.ts` runs one fixed spec-review step. The
plan-review command/runtime omits git diff scope and relies on `context/plan.md`
plus optional `context/handoff.md`.

`workflows/review-steps.ts` is the shared review runner for workflow steps,
current parallel review execution, test-only serial execution, step events,
failure aggregation, and export metadata.

`providers/registry.ts` creates the selected provider adapter. Provider
adapters under `providers/cursor/` and `providers/codex/` implement invocation.
Workflows should stay provider-agnostic.

## Review artifact lifecycle

Each review run creates `.harness/runs/reviews/<run-id>/` under the selected
workspace or explicit runs directory.

Common artifacts include:

- `summary.md`
- `meta.json`
- reviewer prompt files
- structured reviewer JSON
- raw provider artifacts
- stream artifacts when the provider emits them
- `events.jsonl` when events are available

Context artifacts live under `context/`:

- `context/plan.md` when a plan is supplied.
- `context/handoff.md` when a handoff file path or stdin handoff text is
  supplied via CLI options.
- `context/diff.patch` for `change-review` when git diff scope is included.

`plan-review` depends on `context/plan.md`. `change-review` includes git diff
scope by default and may also include a plan or handoff.

## Provider boundary

Provider-specific auth, model, streaming, and sandbox behavior should stay in
provider adapters or provider-scoped config. Workflow definitions should depend
on the shared review interface, not on provider implementation details.
`lib/config.ts` resolves provider selection and defaults; `providers/registry.ts`
instantiates the selected adapter.

## What is not in this map yet

Active runtime roadmap items such as `steps.json`, graders, triggers, and
Inngest are future work. They should be added to this map only after they
describe current behavior in the repo.
