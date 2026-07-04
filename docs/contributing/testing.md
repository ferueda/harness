# Testing

## Principles

- Tests prove contracts, not prose wording.
- Prefer deterministic local checks over agent memory.
- Keep tests offline and fast unless a layer explicitly names external auth.
- Add regression coverage for bugs when it fits.

## Layers

- Module and unit tests live near `lib/` and `providers/` source when colocated
  tests fit the module boundary.
- `workflows` logic is covered by root `test/*.test.ts` files such as
  `test/review-steps.test.ts` and `test/workflow-context.test.ts`.
- CLI behavior belongs in `test/cli.test.ts`.
- Provider SDK behavior belongs under `providers/*/*.test.ts` and related root
  tests.
- Dist smoke coverage lives in `scripts/smoke-dist.ts` and `pnpm smoke:dist`.
- Gate-output behavior lives in `test/gate-output.test.ts`.
- Skill-owned suites stay inside the owning skill directory, such as
  `skills/sessions/test/**` and `skills/cursor-cli/**/*.test.ts`.
- Harness self-tests cover docs, command surfaces, script inventories, and
  packaged-skill sync.
- Future target-repo fixture or integration tests should be marked as future
  until real target-repo contracts exist.

## Where to Put New Tests

- Put repo-level contract tests in `test/`.
- Put module tests next to source under `lib/` or `providers/` when the module
  already uses that pattern.
- Put skill-owned tests inside the owning skill directory.

## Verification Commands

- `pnpm test -- test/docs-contracts.test.ts`
- `pnpm test -- test/skills.test.ts`
- `pnpm test`
- `pnpm check`

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

Pre-commit hooks provide cheap commit hygiene after deterministic checks exist:
they format/lint staged files and run `pnpm typecheck`. They do not run the full
test suite or smoke-dist, and they do not replace `pnpm check` as the final
verification gate before handoff.
