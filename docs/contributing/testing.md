# Testing

## Principles

- Prove behavior at the highest stable seam that observes the acceptance
  criterion.
- Add a lower seam only for a distinct failure mode.
- Prefer real local files, Git repositories, and built entrypoints when they are
  cheap and deterministic.
- Keep network protocols behind injected transports. Optional live checks need
  explicit authority and disposable state.
- Fix failures caused by the current change, then rerun the affected check.
  Broaden only when a new failure or uncertainty justifies it.
- Test policy and boundaries rather than copying implementation details into
  assertions.

Pre-commit hooks provide cheap commit hygiene. They format/lint staged files and
run `pnpm typecheck`; they do not replace `pnpm check` as the completion gate.

## Layers

| Layer                      | Proves                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `lib/` unit tests          | Agent contract, configuration, review aggregation, artifacts, and skill installation                                                 |
| `providers/` adapter tests | Provider request translation, streams, cancellation, schema handling, and workspace protection                                       |
| `workflows` tests          | Role selection, exact review scope, verdicts, and failure reporting                                                                  |
| `test/cli.test.ts`         | Command parsing, workspace resolution, config precedence, and user-visible failures                                                  |
| Contract tests             | Docs, schemas, import boundaries, package layout, and instruction surfaces                                                           |
| `test/gate-output.test.ts` | Quiet success, bounded failure tails, retained logs, and rerun hints from `scripts/run-gate-step.ts`                                 |
| Distribution smoke         | Built package layout, installed entrypoint, generated shim, skill install, and dry-run review wiring through `scripts/smoke-dist.ts` |
| Optional live              | Provider authentication and protocol behavior that deterministic tests cannot prove                                                  |

Use target-repo fixtures for public behavior. A test target should own its own
`harness.json`, Git state, instructions, and expected `.harness/` artifacts.

## Where to Put New Tests

- Put pure policy and data-shape tests beside the module in `lib/`.
- Put provider SDK translation and cancellation tests beside the adapter in
  `providers/`.
- Put workflow composition and result-shape tests beside `workflows/*.ts` or in
  the existing workflow contract suite.
- Put command parsing and end-to-end source CLI behavior in `test/cli.test.ts`.
- Put cross-file invariants in focused `test/*contract*.test.ts` files.
- Keep built-distribution coverage in `scripts/smoke-dist.ts`; do not duplicate
  the same path in Vitest unless the lower test isolates a separate failure.
- Add a skill fixture only when it proves package discovery, local-reference
  copying, script execution, or another installer boundary.

Prefer assertions on structured results and durable artifacts. Use snapshots
only when the complete output is itself the contract. Keep fixtures small and
generic so they do not import downstream repository assumptions.

## System and live checks

`scripts/smoke-dist.ts` builds and packs Harness, installs it in a temporary
target repo, exercises the entrypoint and shim, installs a packaged skill, and
runs provider-free dry-run reviews. It is the only required system smoke and is
part of `make check`.

Live provider calls are optional. Use them only when a provider protocol or
authentication path changed and local adapter tests cannot prove it. State the
expected external mutation, use a disposable target when needed, and report why
the live check was run or skipped.

## Verification Commands

During iteration, run the narrowest relevant command, for example:

```bash
pnpm exec vitest run providers/codex/codex-agent.test.ts
pnpm exec vitest run test/docs-contracts.test.ts test/instruction-surface.test.ts
pnpm exec vitest run test/import-boundaries.test.ts
```

- `pnpm test` runs the Vitest suite.
- `pnpm smoke:dist` / `make smoke-dist` proves built distribution wiring.
- `pnpm check` / `make check` is the normal local handoff gate.
- CI runs `make check` as the same full gate.
- Approved plan-only changes use `make fix-plan` and `make check-plan`; CI runs
  the same focused plan check.
- Other docs-only or skill changes follow the normal full gate because they can
  change agent behavior or public guidance.

Before handoff, report tests added or changed, commands run, and checks skipped
with the concrete reason.

## Drift Checks

- Command/docs drift uses `Makefile` and `package.json` as source truth, with
  `docs/contributing/script-command-surface.md` as the documented command
  surface under test.
- The command subset check parses only the `## Command ownership` table's public
  commands column.
- Script inventory and gate-output checks cover executable surfaces and the Make
  runner wiring.
- Private-reference scans cover durable docs and `automations/*.md`.
- Developer-local path checks remain generic; do not add downstream-specific
  allow or deny names.
- `docs/` remains covered by `format:check` or an explicit docs check.

## Maintenance Notes

When the same review feedback repeats, strengthen Harness proportionally:
clarify this guide, add focused coverage, add a lint or schema guard, add a
script, then add CI enforcement when the rule is stable enough to block a merge.

Keep one source of truth for every command and contract. Tests may enforce the
source, but prose should not maintain a second exhaustive copy of generated CLI
help or package metadata.
