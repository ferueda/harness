# Script and Command Surface

Contributor and agent reference for command ownership, mutability, and where to
inspect generated help. Use this page to understand who owns each command
surface; use generated help for exact flags and target text.

See [Architecture](./architecture.md) for runtime flow and artifact lifecycle,
[Harness engineering](./harness-engineering.md) for the workflow-quality loop,
[Factory operation](./factory.md) for station operation, and
[Setup Manifest](./setup-manifest.md) for generated artifacts and auth.

## Command ownership

| Surface                     | Owner file                   | Public commands                                                                                                                                                                                                                                                                                                                                                             | Use when                                                                                                                                                                                          |
| --------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Make targets                | `Makefile`                   | `make help`, `make check`, `make check-v`, `make check-ci`, `make format`, `make fix`, `make lint`, `make typecheck`, `make test`, `make smoke-dist`, `make build`, `make ensure-node`                                                                                                                                                                                      | Local development gates and wrappers around package scripts. Wrapped gate targets use `scripts/run-gate-step.ts` for quiet success and bounded failure output.                                    |
| pnpm scripts                | `package.json`               | `pnpm check`, `pnpm check:v`, `pnpm check:ci`, `pnpm format`, `pnpm fix`, `pnpm format:check`, `pnpm lint`, `pnpm lint:fix`, `pnpm typecheck`, `pnpm test`, `pnpm test:watch`, `pnpm build`, `pnpm smoke:dist`, `pnpm codex:proxy`                                                                                                                                          | Direct package-level commands under Make targets plus local inspection utilities.                                                                                                                 |
| Source CLI                  | `bin/harness.ts`             | `harness init`, `harness factory status`, `harness factory linear fetch`, `harness factory triage`, `harness factory planning run`, `harness factory planning publish`, `harness factory planning mark-plan-merged`, `harness run change-review`, `harness run factory-triage`, `harness run plan-review`, `harness runs prune`, `harness models`, `harness skills install` | User-facing harness workflow commands, tracker read adapters, local factory inbox management, and planning handoff metadata commands. Workflow implementations live in `workflows/*.workflow.ts`. |
| Dist smoke test             | `scripts/smoke-dist.ts`      | `pnpm smoke:dist`, `make smoke-dist`                                                                                                                                                                                                                                                                                                                                        | Verify built CLI behavior, factory command help, init shim creation, skills install, dry-run review metadata, and handoff artifacts.                                                              |
| Codex request proxy         | `scripts/codex-proxy.mjs`    | `pnpm codex:proxy`                                                                                                                                                                                                                                                                                                                                                          | Inspect local Codex Responses API requests, request byte contributors, tool definition size, and reported input-token usage.                                                                      |
| Sessions skill CLI          | `skills/sessions/scripts/`   | `sessions ...` after `skills/sessions/scripts/install.sh`                                                                                                                                                                                                                                                                                                                   | Browse and index local Cursor or Codex session history.                                                                                                                                           |
| Cursor delegation skill CLI | `skills/cursor-cli/scripts/` | `cursor-cli ...` after `skills/cursor-cli/scripts/install.sh`                                                                                                                                                                                                                                                                                                               | Run ad-hoc Cursor delegation outside harness review workflows.                                                                                                                                    |
| User install shim           | `install`                    | `harness ...` from the installed user-level shim                                                                                                                                                                                                                                                                                                                            | Install or refresh the user command, usually under `~/.local/bin/harness`.                                                                                                                        |
| Target-repo shim            | `harness init`               | `.harness/bin/harness ...` inside the target repo                                                                                                                                                                                                                                                                                                                           | Pin a target repo to the harness checkout that initialized it.                                                                                                                                    |

## Read-only vs mutating commands

| Class                                   | Commands                                                                                                                                                                                                                                         | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Read-only/checking                      | `make help`, `make ensure-node`, `make check-format`, `make lint`, `make typecheck`, `make test`, `harness models`, `harness factory status`, `harness factory linear fetch`, `harness runs prune --dry-run`, `harness skills install --dry-run` | These inspect or verify current state without changing tracked source, moving inbox items, or deleting local state. `harness factory linear fetch` requires `LINEAR_API_KEY`, calls the live Linear API, and validates configured team/status/project scope, but only prints normalized JSON and does not mutate repo files or Linear state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Checking with ignored artifacts         | `make build`, `pnpm build`, `make smoke-dist`, `pnpm smoke:dist`, `make check`, `make check-v`, `make check-ci`, `pnpm check`, `pnpm check:v`, `pnpm check:ci`, `harness factory triage --dry-run`, `harness factory planning run --dry-run`     | Build and gate paths may refresh ignored `dist/`. Smoke and full check paths also run dry-run `change-review` against the harness checkout and leave ignored `.harness/runs/reviews/<run-id>/` artifacts. Factory dry-runs write ignored `.harness/runs/factory/<run-id>/` artifacts and do not invoke providers. `harness factory triage --linear-issue ... --dry-run` and `harness factory planning --linear-issue ... --dry-run` also call the live Linear API but do not mutate Linear.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Local inspection with ignored artifacts | `pnpm codex:proxy`                                                                                                                                                                                                                               | Starts a local HTTP proxy, forwards matching Codex requests to the configured upstream, and writes ignored request audits under `logs/codex-proxy/`. It does not mutate tracked source, but captured logs may contain private prompt or tool context.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Mutating/preparing                      | `make format`, `make fix`, `./install`, `harness init`, `harness skills install`, `harness runs prune` without `--dry-run`                                                                                                                       | These write files, install shims, copy skills, delete run artifacts, or rewrite formatted source. Live `harness skills install` writes into the target repo `.agents/skills/` tree.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Review artifact writing                 | `harness run change-review`, `harness run plan-review`                                                                                                                                                                                           | Live and dry-run review commands write ignored run artifacts under `.harness/runs/reviews/<run-id>/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Factory artifact writing                | `harness run factory-triage`, `harness factory triage`, `harness factory planning run`, `harness factory planning publish`, `harness factory planning mark-plan-merged`                                                                          | Live and dry-run factory station commands write ignored run artifacts under `.harness/runs/factory/<run-id>/`. Planning runs also create nested plan-review artifacts under `.harness/runs/reviews/<run-id>/`. Dry-run writes placeholders and does not invoke providers or reviewers. Any `harness factory triage --linear-issue ...` or `harness factory planning --linear-issue ...` run performs a Linear fetch first and validates configured team/status/project scope. `harness factory triage --linear-issue ... --apply`, `harness factory planning run --linear-issue ... --apply`, and planning publication commands with `--linear-issue ... --apply` mutate Linear status and write marker comments. Live planning can write a tracked `dev/plans/*.md` file after approval; tracker-backed plans should land through a plan PR before implementation. Planning publication commands without `--apply` only update local run `meta.json` and `summary.md`; they do not mutate Linear or GitHub. |
| Skill-owned CLIs                        | `sessions ...`, `cursor-cli ...`                                                                                                                                                                                                                 | Mutability depends on the skill command. For example, `sessions <provider> reindex` writes user-level caches documented in [Setup Manifest](./setup-manifest.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

`harness run ... --dry-run` is lower risk than a live review because it does not
invoke reviewers, but it is not as side-effect-free as
`harness runs prune --dry-run`.

## Codex Request Proxy

Run the local Responses API logging proxy:

```bash
pnpm codex:proxy
```

Point Codex CLI at it in another terminal:

```bash
codex exec \
  -c 'model_provider="openai-proxy"' \
  -c 'model_providers.openai-proxy={name="OpenAI Proxy", base_url="http://127.0.0.1:8787", wire_api="responses", requires_openai_auth=true, supports_websockets=false}' \
  'Say hi'
```

Each `POST /responses` request writes a readable Markdown audit under
`logs/codex-proxy/`, led by a ranked tool-size table. Set `PORT` to change the
local listen port, and set `CODEX_PROXY_WRITE_RAW=1` to also write the parsed
raw request JSON. By default, the proxy forwards to Codex's ChatGPT backend.
API-key users can set `CODEX_PROXY_UPSTREAM_ORIGIN=https://api.openai.com/v1`.

## Gate output runner

Wrapped Make targets call `scripts/run-gate-step.ts` for quiet success output,
saved local failure logs, bounded failure tails, and verbose rerun hints. The
runner is an implementation detail behind Make-owned public targets, not a new
public command row. Use `make check-v` or `VERBOSE=1 make <target>` for full
live command output.

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
- `harness factory linear --help`
- `harness factory linear fetch --help`
- `harness factory triage --help`
- `harness factory planning --help`
- `harness factory planning run --help`
- `harness factory planning publish --help`
- `harness factory planning mark-plan-merged --help`
- `harness factory status --help`
- `harness run --help`
- `harness run factory-triage --help`
- `harness run plan-review --help`
- `make help`

When generated help changes, update this page only if the command ownership or
mutability model changes.

## Inventory rules

- Treat `install`, `bin/harness.ts`, `scripts/*`, `workflows/*.ts`,
  and `skills/*/scripts/*` as executable command surfaces.
  Current concrete root script entries include `scripts/smoke-dist.ts` for dist
  smoke coverage, `scripts/run-gate-step.ts` for wrapped Make gate output, and
  `scripts/codex-proxy.mjs` for local Codex request inspection.
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
