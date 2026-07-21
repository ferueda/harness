# Script and Command Surface

Contributor and agent reference for command ownership, mutability, and where to
inspect generated help. Use this page to understand who owns each command
surface; use generated help for exact flags and target text.

Use [Architecture](./architecture.md) for runtime flow and artifacts,
[Harness engineering](./harness-engineering.md) for the workflow-quality loop,
and [Setup Manifest](./setup-manifest.md) for generated artifacts and auth.

## Command ownership

| Surface                 | Owner file                                   | Public commands                                                                                                                                                                                                                                                                                                                                | Use when                                                                                                                                                                        |
| ----------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Make targets            | `Makefile`                                   | `make help`, `make setup-worktree`, `make check`, `make check-v`, `make check-ci`, `make check-plan`, `make format`, `make check-format`, `make fix`, `make fix-plan`, `make lint`, `make typecheck`, `make test`, `make smoke-dist`, `make smoke-linear-automation`, `make smoke-linear-automation-compose`, `make build`, `make ensure-node` | Local worktree setup, development gates, and wrappers around package scripts. Wrapped gate targets use `scripts/run-gate-step.ts` for quiet success and bounded failure output. |
| pnpm scripts            | `package.json`                               | `pnpm check`, `pnpm check:v`, `pnpm check:ci`, `pnpm check:plan`, `pnpm format`, `pnpm fix`, `pnpm fix:plan`, `pnpm format:check`, `pnpm lint`, `pnpm lint:fix`, `pnpm typecheck`, `pnpm test`, `pnpm test:watch`, `pnpm build`, `pnpm smoke:dist`, `pnpm smoke:linear-automation`, `pnpm smoke:linear-automation-compose`, `pnpm codex:proxy` | Direct package-level commands under Make targets plus local inspection utilities.                                                                                               |
| Source CLI              | `bin/harness.ts`                             | `harness init`, `harness linear worker`, `harness run change-review`, `harness run plan-review`, `harness runs prune`, `harness models`, `harness skills install`                                                                                                                                                                              | User-facing reviews, the persistent Linear automation worker, run cleanup, model discovery, and skill installation.                                                             |
| Distribution smoke      | `scripts/smoke-dist.ts`                      | `pnpm smoke:dist`, `make smoke-dist`                                                                                                                                                                                                                                                                                                           | Verify built CLI behavior, init shim creation, skills install, dry-run review metadata, and handoff artifacts.                                                                  |
| Linear automation smoke | `scripts/smoke-linear-automation.ts`         | `pnpm smoke:linear-automation`, `make smoke-linear-automation`                                                                                                                                                                                                                                                                                 | Verify self-hosted Inngest startup, Connect registration, polling, revision routing, triage, and projection through fake boundaries.                                            |
| Linear Compose smoke    | `scripts/smoke-linear-automation-compose.ts` | `pnpm smoke:linear-automation-compose`, `make smoke-linear-automation-compose`                                                                                                                                                                                                                                                                 | Verify the worker image and self-hosted Compose packaging, health, restart, reconnection, and persistence boundaries without live traffic.                                      |
| Codex request proxy     | `scripts/codex-proxy.mjs`                    | `pnpm codex:proxy`                                                                                                                                                                                                                                                                                                                             | Inspect local Codex Responses API requests, request byte contributors, tool definition size, and reported input-token usage.                                                    |
| User install shim       | `install`                                    | `harness ...` from the installed user-level shim                                                                                                                                                                                                                                                                                               | Install or refresh the user command, usually under `~/.local/bin/harness`.                                                                                                      |
| Target-repo shim        | `harness init`                               | `.harness/bin/harness ...` inside the target repo                                                                                                                                                                                                                                                                                              | Pin a target repo to the Harness checkout that initialized it.                                                                                                                  |

## Read-only vs mutating commands

| Class                                   | Commands                                                                                                                                                                                                  | Notes                                                                                                                                                                                                                                                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read-only/checking                      | `make help`, `make ensure-node`, `make check-format`, `make check-plan`, `make lint`, `make typecheck`, `make test`, `harness models`, `harness runs prune --dry-run`, `harness skills install --dry-run` | These inspect or verify current state without changing tracked source or deleting local run state.                                                                                                                                                                                                          |
| Checking with ignored artifacts         | `make build`, `pnpm build`, `make smoke-dist`, `pnpm smoke:dist`, `make check`, `make check-v`, `make check-ci`, `pnpm check`, `pnpm check:v`, `pnpm check:ci`                                            | Build and gate paths may refresh ignored `dist/`. Distribution smoke and ordinary checks may also run dry-run standalone reviews beneath `.harness/runs/reviews/<run-id>/`.                                                                                                                                 |
| Ephemeral system mutation               | `make smoke-linear-automation`, `pnpm smoke:linear-automation`, `make smoke-linear-automation-compose`, `pnpm smoke:linear-automation-compose`                                                            | Creates local Inngest processes or disposable Docker resources. Success cleans them; handled failures retain bounded diagnostics and clean Compose resources. The Compose smoke may retain pulled base images and does not touch external services.                                                         |
| Persistent external automation          | `harness linear worker`                                                                                                                                                                                   | Starts an Inngest Connect worker, reads and projects scoped Linear issues, and may invoke the configured triage provider. It runs until Connect shuts down. Secrets come from environment variables; stable IDs and the triage profile come from `linearAutomation` in `harness.json`.                      |
| Local inspection with ignored artifacts | `pnpm codex:proxy`                                                                                                                                                                                        | Starts a local HTTP proxy, forwards matching Codex requests to the configured upstream, and writes ignored request audits under `logs/codex-proxy/`. Captured logs may contain private prompt or tool context.                                                                                              |
| Mutating/preparing                      | `make setup-worktree`, `make format`, `make fix`, `make fix-plan`, `./install`, `harness init`, `harness skills install`, `harness runs prune` without `--dry-run`                                        | These install ignored dependencies, delete run artifacts, write files or shims, copy skills, or rewrite formatted source. `make setup-worktree` uses the ordinary shared pnpm store offline and skips shared Git-hook mutation. Live skill installation writes into the target repo `.agents/skills/` tree. |
| Review artifact writing                 | `harness run change-review`, `harness run plan-review`                                                                                                                                                    | Live and dry-run review commands write ignored run artifacts under `.harness/runs/reviews/<run-id>/`.                                                                                                                                                                                                       |
| Skill-owned CLIs                        | `sessions ...`                                                                                                                                                                                            | Mutability depends on the skill command. For example, `sessions <provider> reindex` writes user-level caches documented in [Setup Manifest](./setup-manifest.md).                                                                                                                                           |

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
`simple-git-hooks` during `pnpm install`. They run staged format and lint fixes
through `lint-staged`, then run `pnpm typecheck`.

Hooks are commit hygiene, not the definition of done. They do not run
`pnpm check`, tests, smoke-dist, provider calls, network work, DB work, or
visual checks. Run `pnpm check` before handoff. CI runs `pnpm check:ci` for
pushes and pull requests outside the approved `dev/plans/**/*.md`-only class.
Plan-only pull requests run plan formatting and docs contracts instead. CI does
not depend on local Git hooks. The ordinary local `pnpm check` excludes the
Linear automation system smoke; full `pnpm check:ci` runs it after ordinary
checks, while the plan-only CI path bypasses both the full gate and that smoke.

Use [Setup Manifest](./setup-manifest.md) for hook activation and generated
artifact ownership.

## Do not duplicate generated help

Docs explain command ownership, intent, and mutability. Generated help owns
exact flags and target text:

- `harness --help`
- `harness linear worker --help`
- `harness run --help`
- `harness run change-review --help`
- `harness run plan-review --help`
- `make help`

When generated help changes, update this page only if the command ownership or
mutability model changes.

## Inventory rules

- Treat `install`, `bin/harness.ts`, `scripts/*`, `workflows/*.ts`, and
  `skills/*/scripts/*` as executable command surfaces. Current concrete root
  script entries include `scripts/smoke-dist.ts` for distribution coverage,
  `scripts/smoke-linear-automation.ts` for the offline Linear automation
  journey, `scripts/smoke-linear-automation-compose.ts` for the container
  packaging boundary, `scripts/run-gate-step.ts` for wrapped Make gate output,
  and `scripts/codex-proxy.mjs` for local Codex request inspection.
- Treat `skills/*/SKILL.md`, `skills/*/agents/openai.yaml`, and
  `skills/*/references/*.md` as skill instructions or reference material, not
  command rows.
- Treat `node_modules` trees as generated local dependency content when present.
- Do not inventory provider or runtime modules under `lib/` or `providers/` as
  command rows unless they expose a direct executable surface.
- Drift tests for command names, script inventory, private-path leakage, and
  docs or gate coverage live in `test/docs-contracts.test.ts`; see
  [Testing](./testing.md) for the contract boundaries.
