# Remove Factory from Harness

## Goal

Remove Factory completely now that the supported automation direction is small,
independent Inngest functions backed by standalone service and provider
primitives. Factory triage, planning, implementation, lifecycle authority,
hosted delivery, Linear projection, publication, recovery, inspection, and
operator tooling all leave the product together; keeping a partial station
model would preserve the complexity this work is meant to retire.

The supported Harness surface after this change is review and planning
workflows, packaged non-Factory skills, reusable provider adapters, standalone
Linear primitives, and the independent self-hosted Linear automation pipeline.
Existing external Factory stores and run artifacts are user data: do not read,
migrate, rewrite, or delete them. They become inert when the commands and
runtime are removed.

## Changes

1. Remove Factory from the public CLI and configuration boundary. In
   `bin/harness.ts`, delete `addFactoryCommands` and make `factory` an unknown
   command; fold the remaining generic error-to-message behavior into the CLI
   before deleting `lib/factory-cli-errors.ts`. Delete `bin/factory-*.ts`. In
   `lib/schemas.ts` and `lib/config.ts`, remove every Factory role, Linear
   status, store, execution-profile, snapshot, and resolver contract while
   retaining review and `linearAutomation` configuration. Keep the top-level
   extension policy, but explicitly reject a legacy `factory` key with a clear
   removal error instead of silently accepting it. Remove the `factory` block
   from this repository's `harness.json`; no compatibility alias or ignored
   field remains. Update `test/cli.test.ts` and `test/config.test.ts` to prove
   the command is absent, legacy config fails clearly, and the independent
   Linear worker and review commands still resolve their settings.

2. Delete the complete Factory implementation and its exported contracts:
   `lib/factory-*.ts`, `lib/prompts/factory-*.ts`,
   `workflows/factory-*.ts`, and `schemas/factory-*.json`, together with all
   colocated and `test/factory-*.ts` coverage and `test/fixtures/factory/`.
   Remove the Factory prompt exports from `lib/prompts/index.ts` and any
   remaining imports from neutral entrypoints. Do not retain lifecycle event or
   state decoders, store readers, Grove repair paths, Linear list/create
   commands, planning/implementation actions, or publication helpers: none has
   a supported non-Factory caller, and historical data is preserved by leaving
   its external files untouched rather than by keeping executable compatibility
   code. Re-run TypeScript and import searches after deletion so no neutral
   module keeps a dangling Factory type or dead adapter.

3. Remove Factory-only packaging and execution infrastructure. Delete
   `scripts/smoke-factory.ts` and `scripts/smoke-factory-grove.ts`; remove
   `smoke:factory`, `make smoke-factory`, its phony target, and the Factory leg
   of `check-ci` from `package.json` and `Makefile`. Remove
   `@ferueda/grove` from `package.json`, its release-age exception from
   `pnpm-workspace.yaml`, and regenerate `pnpm-lock.yaml` through pnpm. Keep
   Inngest and its local smoke targets because the independent Linear worker
   still uses them. Rewrite `scripts/smoke-dist.ts` to assert the installed CLI
   rejects `factory` while continuing to prove init, reviews, the Linear worker,
   skills, models, and run pruning. `make smoke-linear-automation` replaces the
   deleted Factory system smoke as the end-to-end automation proof.

4. Remove Factory documentation and packaged operating guidance. Delete
   `docs/contributing/factory.md` and `skills/factory-operator/`. Rewrite
   `README.md`, `docs/project-intent.md`,
   `docs/contributing/architecture.md`, `docs/contributing/index.md`,
   `docs/contributing/harness-engineering.md`,
   `docs/contributing/testing.md`,
   `docs/contributing/setup-manifest.md`, and
   `docs/contributing/script-command-surface.md` as present-tense descriptions
   of the smaller Harness. Remove Factory lifecycle/store invariants, commands,
   generated paths, smoke requirements, and navigation links; state that
   independent operations—not a shared station lifecycle—are the automation
   model. Remove the Factory-specific smoke rule from `AGENTS.md`. Update
   `test/docs-contracts.test.ts` to cover the new command, gate, dependency,
   skill, and documentation inventory instead of retaining historical Factory
   assertions.

5. Finish with targeted tracked-source absence checks rather than leaving
   product tombstones. Remove Factory-owned file paths, `addFactoryCommands`,
   Factory command/config imports, hosted handler names, exported Factory
   schemas, smoke targets, the operator skill, and the Grove dependency. Any
   remaining literal `factory` references must be limited to the explicit CLI
   and config rejection tests that prove the removed surface stays unavailable.
   Do not rename unrelated software-pattern identifiers or guidance such as
   `agentProviderFactory`, `CodexFactory`, or generic factory functions. This
   change must not touch the standalone `lib/linear/`, `lib/triage/`, readiness
   router, Linear poller/consumer/worker, provider adapters, ordinary review
   workflows, or generic `.harness/runs` artifact handling except where a
   shared doc or config import is simplified.

## Verify

- `pnpm exec vitest run test/cli.test.ts test/config.test.ts test/docs-contracts.test.ts lib/linear-automation-worker.test.ts lib/linear-triage.test.ts`
- `pnpm smoke:dist`
- `make smoke-linear-automation`
- `make check`
- `git ls-files ':(exclude)dev/plans/**' | rg '(^|/)(factory-|factory/)|(^|/)factory\.md$|schemas/factory-|smoke-factory|factory-operator'` returns no Factory-owned paths.
- `git grep -nE 'addFactoryCommands|harness factory|triageWorkItem|smoke:factory|smoke-factory|factory-operator|@ferueda/grove|schemas/factory-' -- ':!dev/plans/**'` returns only the intentional negative CLI/config assertions, if any; classify those matches explicitly.

## Boundaries

- Do not delete or migrate external Factory stores, run artifacts, inbox files,
  branches, refs, or pull requests. Removing Harness support is not authority to
  remove user data or external state.
- Do not keep read-only Factory inspection, lifecycle decoding, command aliases,
  config compatibility, deprecated schemas, or an archived Factory skill in the
  shipped product.
- Do not build replacement planning or implementation consumers in this issue.
  They should be independent functions designed from current Linear state and
  action labels, not ports of the Factory lifecycle.
- Do not change the live independent triage policy, provider protocol, Linear
  primitives, or self-hosted Inngest deployment beyond references required by
  the removal.
