# Testing

## Purpose

Tests are part of the engineering harness. They let humans and agents change
Harness repeatedly while keeping lifecycle correctness, provider boundaries,
artifacts, command behavior, and packaged guidance visible.

The goal is not maximum test count. The goal is high-confidence feedback at the
cheapest stable boundary that can prove the behavior. This document is the
canonical testing strategy and authoring guide for the Harness repository.
Other contributor docs should link here instead of maintaining a competing test
taxonomy. Exact command ownership and mutability live in
[Script and command surface](./script-command-surface.md).

## Principles

### Tests encode intent

A useful test explains which behavior must survive a change. It should fail when
a stable contract breaks, not whenever an incidental implementation detail or
sentence moves.

Prefer assertions about:

- lifecycle state, reactions, and durable events;
- structured CLI or provider output;
- schemas and parsing at trust boundaries;
- artifact identity, hashes, Git refs, and workspace effects;
- public command behavior and failure semantics;
- installed skill structure and other repository-owned contracts.

Avoid tests for private call order, TypeScript-only guarantees, broad snapshots,
or copy that has no stable behavioral meaning.

### Choose the smallest credible layer

Use the narrowest existing stable seam that proves the acceptance criterion or
failure mode. Add a lower or broader seam only when it protects a distinct
invariant that the existing seam cannot observe.

Fast module and contract tests are the default. CLI integration, distribution
smokes, system smokes, and live protocols need an explicit cross-boundary reason.

### Prefer fewer, coherent workflow tests

When assertions belong to one workflow, keep them in one test. Treat the test
like a manual tester's script:

1. Set up the world.
2. Perform the meaningful actions.
3. Assert important intermediate and final outcomes.

Multiple related assertions are useful when they explain one journey. Do not
split a flow into tiny cases to satisfy a one-assertion convention. Conversely,
do not turn one test file into an inventory of unrelated behavior; split by the
owned contract when that improves navigation or isolation.

### Keep setup explicit

Prefer top-level `test(...)`, inline setup, and ready-to-run fixture factories.
Avoid shared mutable state and broad `beforeEach` fixtures that hide the behavior
under test. Lifecycle hooks are appropriate for unavoidable cleanup or mock
restoration, not for order-dependent setup.

Helpers should return the workspace, store, adapter, provider, or context a test
needs. They should not mutate unrelated globals or require readers to know which
test ran first.

### Stay local and deterministic

Tests in routine local and CI lanes should run offline. Use temporary
repositories, isolated Factory stores, deterministic IDs, provider fakes, and
local bare remotes. A test that truly requires external resolution or auth
belongs in an explicit integration or live lane. Do not call live Codex, Cursor,
Linear, GitHub, or the public internet from the default suite.

Avoid arbitrary sleeps, ambient user state, inherited credentials, and fixture
state that survives between cases. Wait for the promise, event, file, process,
or durable state that is the real contract.

### Add regression coverage when it earns its cost

For bug work, reproduce the root failure with a failing test first when the
stable seam exists. Do not add a slow or brittle regression merely to record a
one-off symptom. If useful proof would be disproportionate, report that judgment
instead of manufacturing weak coverage.

## Layers

| Layer                    | Use for                                                                                       | Avoid                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Static checks            | Type contracts, impossible states, import or schema drift, formatting, lint rules             | Runtime behavior driven by Git, files, processes, or external data               |
| Pure module              | Reducers, reactions, parsers, validators, mappers, helpers, command construction              | Process, filesystem, provider, or Git integration                                |
| Workflow and action      | Planning/review workflows, Factory action behavior, recovery, idempotency, immutable evidence | Re-proving every pure branch already covered below                               |
| Provider adapter         | SDK/CLI translation, streaming, session handling, schemas, timeout and abort behavior         | Live provider quality or network availability                                    |
| CLI integration          | Argument parsing, command selection, structured output, separate-process behavior             | Provider intelligence or full lifecycle journeys                                 |
| Repository self-contract | Packaged skill sync, command inventory, documentation structure, private-path exclusion       | Pinning incidental prose or duplicating implementation tests                     |
| Distribution smoke       | Built package layout, installed entrypoint, generated shim, basic public command wiring       | Complete Factory behavior or capability matrices                                 |
| System smoke             | One product-critical journey whose process and transport wiring cannot be proven cheaply      | Edge-case matrices, provider quality, or bugs already protected by focused tests |
| Live protocol            | Authenticated external integration and real-provider behavior                                 | Routine CI, default local gates, or deterministic correctness claims             |

## Harness proof decisions

| Change                                     | Preferred proof                                                                   |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| Schema, parser, reducer, or reaction       | Focused module test beside the owning contract                                    |
| Planning or implementation action          | Workflow-shaped action test with isolated workspace and Factory store             |
| Recovery, replay, or Git authority         | Action test that proves the interruption boundary and no duplicate provider work  |
| Provider translation or session behavior   | Provider-adapter test with an injected SDK/CLI fake                               |
| Public option or JSON output               | CLI integration test, using a separate process only when process behavior matters |
| Skill installation or synchronization      | Repository self-contract or skill-owned test at the installed boundary            |
| Documentation or command inventory         | Structural contract test derived from the source-of-truth surface                 |
| Built CLI/package wiring                   | Distribution smoke                                                                |
| Complete manually stepped Factory chain    | One explicit offline system smoke outside default Vitest discovery                |
| Real provider, tracker, or GitHub behavior | Opt-in live operator protocol with explicit credentials and cleanup               |

Do not duplicate the same acceptance criterion across every layer. Add another
layer only when it can fail for a materially different reason.

## Where to Put New Tests

- Put repository-level workflow, CLI, and self-contract tests under `test/`.
- Colocate module tests under `lib/` or provider tests under `providers/` when
  the owning module already follows that pattern.
- Keep workflow behavior in focused root tests such as
  `test/review-steps.test.ts` and `test/workflow-context.test.ts`.
- Keep public CLI behavior in `test/cli.test.ts` or a focused station CLI file
  when the command surface is large enough to own one.
- Keep skill-owned suites inside the owning skill, such as
  `skills/sessions/test/**` and `skills/cursor-cli/**/*.test.ts`.
- Keep built-distribution coverage in `scripts/smoke-dist.ts`; do not duplicate
  packaging assertions in workflow tests.
- Keep gate-output behavior in `test/gate-output.test.ts`.
- Keep target-repo fixtures isolated from the Harness checkout and user state.

Use existing placement before inventing another test directory or suffix.

## Authoring patterns

### File shape and naming

- Prefer flat files with top-level `test(...)` calls.
- Use `describe` only when it materially improves navigation in a large file.
- Name tests as behavior plus consequence, for example
  `revision resumes the producer session with accepted blockers`.
- Keep setup close enough that the journey is readable without opening several
  unrelated helpers.
- Follow the repository's file-size guideline when extraction improves clarity;
  "fewer tests" does not require one giant test file.
- Apply these conventions to new or materially changed tests. Do not churn
  unrelated coverage solely to normalize style.

### Fixtures and cleanup

- Use realistic, obviously local fixture values and fake credentials.
- Use deterministic IDs when identity is part of the assertion; use generated
  IDs only to prevent collisions.
- Make temporary resources disposable when they have real cleanup. `using` or
  `await using` is appropriate when it makes file, server, or process teardown
  explicit.
- New unit and integration fixtures should clean their resources. A diagnostic
  smoke may retain its temporary root on failure when it prints that path and
  cleans it on success.
- Never write routine tests into the user's Factory store, provider state, or
  repository checkout.

### Assertions

Prefer exact matches for the stable contract and partial matches for unrelated
fields. Assert both the durable result and absence of forbidden side effects
when correctness depends on idempotency or authority.

Prompt, skill, help, and documentation text need special care because prose is
sometimes executable product surface in Harness:

- Test rendered structure, schemas, placeholders, routing, or observable agent
  inputs when possible.
- When wording carries a required safety or authority rule, assert the smallest
  stable sentinel that proves that rule.
- Do not pin full paragraphs, descriptions, usage hints, or formatting solely
  to resist harmless editing.
- Structural docs tests should derive commands and inventories from their real
  source rather than maintain a second handwritten list.

Avoid arbitrary timing assertions and snapshots too broad for a reviewer to
audit. A performance target may guide a smoke design without becoming a flaky
wall-clock test.

### Output and failures

Tests and child processes should stay quiet on success. Capture expected
subprocess output and include bounded diagnostics only on failure. An expected
error should be asserted, not leaked as stray `fatal`, warning, or stack output.

Failure messages should identify the violated contract, relevant action or
station, and retained diagnostic path when one exists.

## Smoke and live-test policy

Add a system smoke only when the flow is both critical and weakly proven by
faster layers. Keep it to one broad journey through the real seams. Cover
branches, tampering, malformed data, and retry permutations beside their owning
modules or actions.

System smokes:

- live outside default Vitest discovery and watch mode;
- use an explicit script or package command;
- use local fake executables or adapters through production-supported seams;
- never weaken production validation or add a generic test-only runtime;
- run offline with isolated repositories and stores;
- clean on success and preserve bounded evidence on failure;
- stay out of pre-commit and the ordinary local edit loop;
- may join the CI-specific gate when their runtime is bounded and their contract
  is important enough to block a merge.

Distribution smoke and system smoke are different. Distribution smoke proves
that the package and basic command surface work after build. A system smoke
proves that a critical multi-process journey still connects. Neither replaces
focused action or module tests.

Live protocols are never routine CI. They require explicit authority, known
credentials, a disposable target, stop conditions, and cleanup. Their result is
operational evidence, not deterministic regression coverage.

## Verification Commands

While iterating, run the narrowest relevant test path, for example:

```bash
pnpm test -- test/factory-implementation-actions.test.ts
pnpm test -- providers/codex/codex-agent.test.ts
pnpm test -- test/docs-contracts.test.ts
```

Escalate based on the change:

- `pnpm test` runs the current Vitest suite.
- `pnpm smoke:dist` proves built distribution wiring.
- `pnpm check` / `make check` is the ordinary local handoff gate.
- `pnpm check:ci` / `make check-ci` is the CI-owned gate.
- Plan-only pull requests use the documented focused CI path; other docs-only
  behavior follows the current command contract until that contract changes.
- Explicit live protocols run only when the changed boundary requires them.

Pre-commit hooks provide cheap commit hygiene after deterministic checks exist.
They format/lint staged files and run `pnpm typecheck`; they do not define done
and do not replace `pnpm check` as the final handoff gate.

Before handoff, report tests added or changed, commands run, and checks skipped
with the concrete reason.

## Drift Checks

- Command/docs drift uses `Makefile` and `package.json` as source truth, with
  `docs/contributing/script-command-surface.md` as the documented command
  surface under test.
- Command subset checks parse the `## Command ownership` public-commands column.
  Other command tables are explanatory and are not the automated command matrix.
- Command drift checks catch stale documented `make` and `pnpm` examples. They
  do not require docs to exhaustively catalog every Make target or package
  script.
- Script inventory drift uses actual executable and script surfaces as source
  truth.
- Gate-output drift checks guard Make runner wiring and contributor-doc links to
  `scripts/run-gate-step.ts`.
- Absolute developer-checkout path scans cover durable non-skill docs, not
  planning artifacts.
- `automations/*.md` is included in private-reference scans but is not part of
  the `docs` formatting scope unless a plan explicitly adds it.
- Developer-local absolute path patterns are maintained as generic docs-contract
  checks, not downstream-repo-specific allow or deny names.
- Handoff updates that introduce a new durable local absolute path shape must
  update the docs-contract scan in the same change.
- Docs formatting/check coverage means `docs/` must be included in `format` and
  `format:check`, or an explicit docs-check command must cover docs in the final
  gate.

## Maintenance Notes

### Anti-patterns and escalation

Avoid:

- adding E2E coverage because it appears more complete than a focused test;
- live provider or tracker calls in routine CI;
- global setup that hides the behavior under test;
- asserting implementation call order instead of durable outcomes;
- tests for type-system guarantees;
- large snapshots or string blobs with no stable contract;
- treating hooks, scoped checks, or a smoke as the complete handoff gate;
- fixing a repeatable bug without regression coverage when a stable seam fits.

When the same mistake repeats, strengthen the engineering harness in this order:

1. Clarify this guide or the owning contributor document.
2. Add or improve focused regression coverage.
3. Add a lint, schema, or structural guardrail.
4. Add a script or gate when repeatable execution is the missing boundary.
5. Add CI enforcement when the rule is stable and important enough to block a
   merge.

Do not keep adding prose when a mechanical guardrail can prevent the regression.
