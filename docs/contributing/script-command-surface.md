# Script and Command Surface

This document maps public commands to their owner, mutability, and intended use.
Generated CLI help owns flags and defaults. `Makefile` and `package.json` own the
current gate composition.

## Command ownership

| Surface | Owner file       | Public commands                                                                                                                                                                                                                                                       | Mutability                | Use when                                                                      |
| ------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------- |
| Make    | `Makefile`       | `make help`; `make ensure-node`; `make setup-worktree`; `make build`; `make lint`; `make typecheck`; `make test`; `make smoke-dist`; `make format`; `make check-format`; `make fix`; `make fix-plan`; `make check-plan`; `make check`; `make check-v`                 | Mixed                     | Contributor setup, focused checks, fixes, and completion gates                |
| pnpm    | `package.json`   | `pnpm build`; `pnpm check`; `pnpm check:plan`; `pnpm check:v`; `pnpm codex:proxy`; `pnpm fix`; `pnpm fix:plan`; `pnpm format`; `pnpm format:check`; `pnpm lint`; `pnpm lint:fix`; `pnpm prepare`; `pnpm smoke:dist`; `pnpm test`; `pnpm test:watch`; `pnpm typecheck` | Mixed                     | Package-script equivalents and focused development loops                      |
| CLI     | `bin/harness.ts` | `harness init`; `harness models`; `harness run change-review`; `harness run plan-review`; `harness runs prune`; `harness skills install`                                                                                                                              | Mixed                     | Target-repo initialization, reviews, artifact cleanup, and skill installation |
| Install | `install`        | `./install`                                                                                                                                                                                                                                                           | Writes user install state | Install dependencies and the user-level shim                                  |

## Read-only and mutating behavior

| Class                     | Commands                                                                             | Effects                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Source checks             | `make lint`, `make typecheck`, `make test`, `make check-format` and pnpm equivalents | Read tracked source; tools may use temporary OS files.                                                                               |
| Build and full checks     | `make build`, `make smoke-dist`, `make check`, `make check-v` and pnpm equivalents   | Refresh ignored `dist/`; smoke and full checks may create ignored dry-run review artifacts.                                          |
| Source fixes              | `make format`, `make fix`, `make fix-plan` and pnpm equivalents                      | Rewrite files in their documented scope.                                                                                             |
| Review workflows          | `harness run change-review`, `harness run plan-review`                               | Read the reviewed workspace and write ignored `.harness/runs/reviews/<run-id>/` evidence.                                            |
| Initialization and skills | `harness init`, `harness skills install`                                             | Write target config, ignore rules, a local shim, or one installed skill. Both support scoped dry-run behavior where exposed by help. |
| Artifact cleanup          | `harness runs prune`                                                                 | Deletes selected old local run directories; `--dry-run` previews the selection.                                                      |
| Provider inspection       | `pnpm codex:proxy`                                                                   | Starts a loopback proxy and writes ignored, potentially sensitive request audits.                                                    |

Review commands do not edit tracked target files. Their workspace protection
fails the run if a provider changes the reviewed workspace.

## Commit hygiene hooks

The pre-commit hook runs `lint-staged` formatting and lint fixes, then
`pnpm typecheck`. They do not run `pnpm check`, tests, smoke-dist, or provider
calls. Hooks keep commits tidy but do not define completion.

CI does not depend on local Git hooks.

## Gate output runner

Make-owned checks wrap long commands with `scripts/run-gate-step.ts`. This is an
implementation detail behind Make-owned public targets. Quiet success prints a
short PASS line. Failure prints a bounded tail, the retained log path, and a
rerun hint. `VERBOSE=1` streams full output. See
[Harness engineering](./harness-engineering.md#gate-output-contract) for the
output contract and [Setup manifest](./setup-manifest.md) for log ownership.

## Internal executable scripts

| Path                                  | Owner and purpose                                                                                           |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `scripts/classify-plan-only.ts`       | CI helper that writes whether a validated commit range changes only `dev/plans/**/*.md` to `GITHUB_OUTPUT`. |
| `scripts/codex-proxy.mjs`             | Local loopback proxy for inspecting Codex Responses API requests with credential headers redacted.          |
| `scripts/run-gate-step.ts`            | Make gate output, retained failure logs, and verbose reruns.                                                |
| `scripts/smoke-dist.ts`               | Built CLI, shim, skill install, and provider-free dry-run review smoke.                                     |
| `workflows/change-review.workflow.ts` | Callable implementation and code-quality review composition.                                                |
| `workflows/plan-review.workflow.ts`   | Callable specification review composition.                                                                  |
| `workflows/review-steps.ts`           | Shared reviewer execution and result handling.                                                              |

Skill-local scripts belong to the skill that contains them and are reached
through that skill's instructions.

## Inventory rules

Treat `install`, `bin/harness.ts`, `scripts/*`, `workflows/*.ts`, and
`skills/*/scripts/*` as executable command surfaces. Tests, fixtures,
`node_modules`, and skill-local library helpers are excluded from this command
inventory.

When adding or removing a public command or executable script, update its source
and this ownership map in the same change. Use generated CLI help for flag-level
documentation:

```bash
harness --help
harness run change-review --help
harness run plan-review --help
harness runs prune --help
harness skills install --help
```
