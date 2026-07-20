# Testing

## Purpose

Tests are part of the engineering harness. They let humans and agents change
Harness while keeping lifecycle behavior, provider boundaries, artifacts, and
commands visible.

The goal is high-confidence feedback at the cheapest stable boundary, not the
largest possible suite. This is the canonical testing guide; broader contributor
docs should link here. Exact command ownership lives in
[Script and command surface](./script-command-surface.md).

## Principles

- Test durable behavior and public contracts, not private call order, incidental
  prose, broad snapshots, or guarantees already enforced by TypeScript.
- Choose the narrowest credible layer. Do not repeat the same acceptance
  criterion across module, CLI, and smoke tests without a distinct failure mode.
- Prefer fewer, coherent workflow tests when setup, actions, and assertions
  describe one journey. Multiple related assertions are useful.
- Keep setup explicit. Prefer top-level `test(...)`, inline setup, and factories
  that return ready-to-run objects over shared mutable fixtures.
- Use disposable helpers only for real cleanup. Keep temporary repositories,
  stores, processes, and ports isolated from user state.
- Keep routine tests deterministic and offline. Use provider fakes, local bare
  remotes, deterministic IDs, and observable events instead of sleeps.
- Add regression coverage when it protects an important or repeatable failure.
  Do not add slow or brittle coverage only to record a one-off symptom.
- Keep tests quiet on success. Expected failures and subprocess output should be
  asserted and produce bounded diagnostics when they fail.

## Layers

| Layer                    | Use for                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------- |
| Static and module        | Types, reducers, reactions, parsers, validators, mappers, and helpers                   |
| Workflow and action      | Factory behavior, recovery, idempotency, immutable evidence, and Git authority          |
| Provider adapter         | SDK/CLI translation, streaming, sessions, schemas, timeout, and abort behavior          |
| CLI integration          | Argument parsing, command selection, structured output, and separate-process behavior   |
| Repository self-contract | Packaged skills, command inventory, documentation structure, and private-path exclusion |
| Distribution smoke       | Built package layout, installed entrypoint, generated shim, and basic public wiring     |
| Factory system smoke     | Offline Factory CLI, Inngest delivery, and Grove recovery                               |
| Linear automation smoke  | Offline Inngest Dev Server, Connect registration, routing, triage, and projection       |
| Optional live            | Explicitly authorized external integration proof                                        |

Use fast module and contract tests by default. Add broader proof only when the
changed behavior crosses a boundary the cheaper layer cannot observe.

## Where to Put New Tests

- Put repository-level workflow, CLI, and self-contract tests under `test/`.
- Colocate focused module tests under `lib/` and provider tests under
  `providers/` when the owning module already follows that pattern.
- Keep `workflows` behavior in focused root tests such as
  `test/review-steps.test.ts` and `test/workflow-context.test.ts`.
- Keep public CLI behavior in `test/cli.test.ts` or an existing station-specific
  CLI test.
- Keep skill-owned suites inside the owning skill when a packaged skill needs
  its own test boundary.
- Keep built-distribution coverage in `scripts/smoke-dist.ts`, Factory smokes in
  `scripts/smoke-factory.ts` and `scripts/smoke-factory-grove.ts`, the independent
  Linear journey in `scripts/smoke-linear-automation.ts`, and gate-output behavior
  in `test/gate-output.test.ts`.
- Keep target-repo fixtures isolated from the Harness checkout and user state.

Use an existing location before inventing another test directory or suffix.

## Authoring Rules

- Name tests as behavior plus consequence.
- Use `describe` only when it materially improves navigation.
- Keep setup close enough that the journey is readable without opening several
  unrelated helpers.
- Assert exact stable contracts and partial unrelated fields. For idempotency or
  authority, also assert the absence of forbidden side effects.
- For prompts, skills, help, and docs, prefer structure, schemas, routing, or the
  smallest safety sentinel over pinning full paragraphs.
- Clean new fixtures on success. Diagnostic smokes may retain a bounded temporary
  root on failure when they print its path.
- Apply these rules to new or materially changed tests; do not churn unrelated
  coverage for stylistic consistency.

## Smoke and Live Tests

Add a system smoke only for a critical journey that faster layers cannot prove.
Keep branches, malformed input, tampering, and retry matrices beside their owning
modules or actions.

System smokes should:

- use an explicit command outside default Vitest discovery and watch mode;
- use local fakes through production-supported seams;
- run offline with isolated repositories and Factory stores;
- stay out of pre-commit and the ordinary edit loop;
- clean on success and preserve bounded evidence on failure;
- avoid generic test-only runtimes or weakened production validation.

Distribution smoke proves packaging and command wiring. Factory smoke runs local
fakes in a temporary repository and store, then proves Inngest execution and
recovery around Grove release. Linear automation smoke runs a real local Inngest
Dev Server and Connect worker with fake Linear and agent boundaries, then proves
the signed webhook-to-projection journey. Both clean on success and retain bounded
diagnostics on failure. Live protocols require explicit authority, credentials,
stop conditions, disposable targets, and cleanup; they are not routine CI coverage.

## Verification Commands

During iteration, run the narrowest relevant path, for example:

```bash
pnpm exec vitest run test/factory-implementation-actions.test.ts
pnpm exec vitest run providers/codex/codex-agent.test.ts
pnpm exec vitest run test/docs-contracts.test.ts
```

- `pnpm test` runs the Vitest suite.
- `pnpm smoke:dist` proves built distribution wiring.
- `pnpm smoke:factory` / `make smoke-factory` runs the offline Factory, Inngest,
  and Grove recovery journey. It is not part of Vitest, watch mode, pre-commit, or
  ordinary local `pnpm check`.
- `pnpm smoke:linear-automation` / `make smoke-linear-automation` runs the
  independent Linear automation journey. It is not part of Vitest, watch mode,
  pre-commit, or ordinary local `pnpm check`.
- `pnpm check` / `make check` is the normal local handoff gate.
- `pnpm check:ci` / `make check-ci` is the CI-owned gate and runs both system
  smokes after the ordinary checks.
- Approved plan-only changes use `make fix-plan` and `make check-plan`. CI runs
  the same focused check; it bypasses the full gate and Factory smoke.
- Other docs-only behavior follows the normal command contract.
- Run an explicit system smoke or live protocol only when the changed boundary
  requires it.

Before handoff, report tests added or changed, commands run, and checks skipped
with the concrete reason.

## Drift Checks

- Command/docs drift uses `Makefile` and `package.json` as source truth, with
  `docs/contributing/script-command-surface.md` as the documented command
  surface under test.
- Command subset checks parse the `## Command ownership` public-commands column.
  Other command tables are explanatory, not a second command matrix.
- Script inventory and gate-output checks cover executable surfaces, Make runner
  wiring, and contributor links to `scripts/run-gate-step.ts`.
- Private-reference scans cover durable non-skill docs and `automations/*.md`.
  Planning artifacts remain outside that scan.
- Developer-local path checks stay generic; do not add downstream-repo-specific
  allow or deny names.
- `docs/` must remain covered by `format:check` or an explicit docs-check command.

## Maintenance Notes

Pre-commit hooks provide cheap commit hygiene after deterministic checks exist.
They format/lint staged files and run `pnpm typecheck`; they do not define done
and do not replace `pnpm check` as the final handoff gate.

When the same review feedback repeats, strengthen the harness proportionally:
clarify this guide, add focused coverage, add a lint/schema guard, add a script,
then add CI enforcement when the rule is stable enough to block a merge.
