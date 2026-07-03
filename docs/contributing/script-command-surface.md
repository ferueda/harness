# Script and Command Surface

Contributor and agent reference for command ownership, mutability, and where to
inspect generated help. Use this page to understand who owns each command
surface; use generated help for exact flags and target text.

See [Architecture](./architecture.md) for runtime flow and artifact lifecycle,
[Harness engineering](./harness-engineering.md) for the workflow-quality loop,
and [Setup Manifest](./setup-manifest.md) for generated artifacts and auth.

## Command ownership

| Surface                     | Owner file                   | Public commands                                                                                                                                                                                                | Use when                                                                                                                                               |
| --------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Make targets                | `Makefile`                   | `make help`, `make check`, `make check-v`, `make check-ci`, `make format`, `make fix`, `make lint`, `make typecheck`, `make test`, `make smoke-dist`, `make build`, `make ensure-node`                         | Local development gates and wrappers around package scripts.                                                                                           |
| pnpm scripts                | `package.json`               | `pnpm check`, `pnpm check:v`, `pnpm check:ci`, `pnpm format`, `pnpm fix`, `pnpm format:check`, `pnpm lint`, `pnpm lint:fix`, `pnpm typecheck`, `pnpm test`, `pnpm test:watch`, `pnpm build`, `pnpm smoke:dist` | Direct package-level commands under Make targets.                                                                                                      |
| Source CLI                  | `bin/harness.ts`             | `harness init`, `harness run change-review`, `harness run plan-review`, `harness runs prune`, `harness models`, `harness skills install`                                                                       | User-facing harness workflow commands. Workflow implementations live in `workflows/change-review.workflow.ts` and `workflows/plan-review.workflow.ts`. |
| Dist smoke test             | `scripts/smoke-dist.ts`      | `pnpm smoke:dist`, `make smoke-dist`                                                                                                                                                                           | Verify built CLI behavior, init shim creation, skills install, dry-run review metadata, and handoff artifacts.                                         |
| Sessions skill CLI          | `skills/sessions/scripts/`   | `sessions ...` after `skills/sessions/scripts/install.sh`                                                                                                                                                      | Browse and index local Cursor or Codex session history.                                                                                                |
| Cursor delegation skill CLI | `skills/cursor-cli/scripts/` | `cursor-cli ...` after `skills/cursor-cli/scripts/install.sh`                                                                                                                                                  | Run ad-hoc Cursor delegation outside harness review workflows.                                                                                         |
| User install shim           | `install`                    | `harness ...` from the installed user-level shim                                                                                                                                                               | Install or refresh the user command, usually under `~/.local/bin/harness`.                                                                             |
| Target-repo shim            | `harness init`               | `.harness/bin/harness ...` inside the target repo                                                                                                                                                              | Pin a target repo to the harness checkout that initialized it.                                                                                         |

## Read-only vs mutating commands

| Class                           | Commands                                                                                                                                                                               | Notes                                                                                                                                                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read-only/checking              | `make help`, `make ensure-node`, `make check-format`, `make lint`, `make typecheck`, `make test`, `harness models`, `harness runs prune --dry-run`, `harness skills install --dry-run` | These inspect or verify current state without changing tracked source or deleting local state.                                                                                                            |
| Checking with ignored artifacts | `make build`, `pnpm build`, `make smoke-dist`, `pnpm smoke:dist`, `make check`, `make check-v`, `make check-ci`, `pnpm check`, `pnpm check:v`, `pnpm check:ci`                         | Build and gate paths may refresh ignored `dist/`. Smoke and full check paths also run dry-run `change-review` against the harness checkout and leave ignored `.harness/runs/reviews/<run-id>/` artifacts. |
| Mutating/preparing              | `make format`, `make fix`, `./install`, `harness init`, `harness skills install`, `harness runs prune` without `--dry-run`                                                             | These write files, install shims, copy skills, delete run artifacts, or rewrite formatted source. Live `harness skills install` writes into the target repo `.agents/skills/` tree.                       |
| Review artifact writing         | `harness run change-review`, `harness run plan-review`                                                                                                                                 | Live and dry-run review commands write ignored run artifacts under `.harness/runs/reviews/<run-id>/`.                                                                                                     |
| Skill-owned CLIs                | `sessions ...`, `cursor-cli ...`                                                                                                                                                       | Mutability depends on the skill command. For example, `sessions <provider> reindex` writes user-level caches documented in [Setup Manifest](./setup-manifest.md).                                         |

`harness run ... --dry-run` is lower risk than a live review because it does not
invoke reviewers, but it is not as side-effect-free as
`harness runs prune --dry-run`.

## Commit hygiene hooks

Local pre-commit hooks are owned by `package.json` and installed by
`simple-git-hooks` during `pnpm install`. They run staged format/lint fixes
through `lint-staged`, then run `pnpm typecheck`.

Hooks are commit hygiene, not the definition of done. They do not run
`pnpm check`, tests, smoke-dist, provider calls, network work, DB work, or
visual checks. Run `pnpm check` before handoff. CI runs `pnpm check:ci`; it does
not depend on local Git hooks.

Use [Setup Manifest](./setup-manifest.md) for hook activation and generated
artifact ownership.

## Do not duplicate generated help

Docs explain command ownership, intent, and mutability. Generated help owns exact
flags and target text:

- `harness --help`
- `harness run --help`
- `harness run plan-review --help`
- `make help`

When generated help changes, update this page only if the command ownership or
mutability model changes.

## Inventory rules

- Treat `install`, `bin/harness.ts`, `scripts/*`, `workflows/*.ts`,
  and `skills/*/scripts/*` as executable command surfaces.
  `scripts/smoke-dist.ts` is the current concrete script entry.
- Treat `skills/*/SKILL.md`, `skills/*/agents/openai.yaml`, and
  `skills/*/references/*.md` as skill instructions or reference material, not
  command rows.
- Treat `skills/sessions/node_modules/**` and other `node_modules` trees as
  generated local dependency content when present.
- Do not inventory provider/runtime modules under `lib/` or `providers/` as
  command rows unless they expose a direct executable surface.
- Drift tests for command names, script inventory, private-path leakage, and
  docs/gate coverage live in `test/docs-contracts.test.ts`; see
  [Testing](./testing.md) for the contract boundaries.
