# Setup Manifest

Contributor reference for local requirements, install behavior, generated
artifacts, provider auth, and harness-repo vs target-repo ownership.

See [Script and Command Surface](./script-command-surface.md) for command
mutability, and [Architecture](./architecture.md) for runtime flow, review
artifact lifecycle, and directory ownership.

## Local requirements

| Requirement                            | Needed for                                   | Notes                                                                         |
| -------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------- |
| Node 24 or newer                       | Source CLI, tests, build, and skill CLIs     | The source checkout runs TypeScript directly through Node type stripping.     |
| `pnpm` on `PATH`                       | Install, package scripts, and gates          | The Harness installer and repository gates use pnpm.                          |
| POSIX shell with `bash`                | `install`, generated shims, target-repo shim | Shims use `#!/usr/bin/env bash` and `set -euo pipefail`.                      |
| Git checkout of this Harness repo      | Source install and development               | The checkout can live anywhere; use generic paths such as `/path/to/harness`. |
| Optional PATH entry for installed shim | Interactive `harness ...` command            | See Install and update for the default shim path.                             |

## Linear automation worker

`harness linear worker` reads stable project, team, workflow-state, and
Agent-action label IDs from the target repository's `linearAutomation` section.
The first consumer requires `triage.agent: "codex"` and also accepts a timeout
plus optional model and reasoning overrides. Unsupported providers fail during
startup configuration loading, before Connect accepts work. The section does
not contain secrets.

The worker requires `LINEAR_API_KEY`. Self-hosted Inngest requires
`INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`, `INNGEST_DEV=0`, and
`INNGEST_BASE_URL`; `INNGEST_CONNECT_GATEWAY_URL` may point Connect at the
local gateway. SDK development mode uses `INNGEST_DEV=1` and does not require
keys or a base URL. `HARNESS_WORKER_HOST` and `HARNESS_WORKER_PORT` default to
`0.0.0.0:8080`. `HARNESS_WORKER_INSTANCE_ID` and `HARNESS_APP_VERSION` are
optional deployment metadata. See [Linear automation](./linear-automation.md)
for the self-hosted deployment commands.

## Install and update

Run `./install` from the harness checkout, or run `/path/to/harness/install`
from elsewhere. The installer validates Node 24 or newer, runs
`pnpm install --frozen-lockfile`, writes the user-level `harness` shim, and
verifies `harness --help`.

Set `HARNESS_INSTALL_SKIP_PNPM=1` only for tests that need to skip dependency
installation. Normal installs should let the installer run pnpm.

The default user-level shim path is `~/.local/bin/harness`. If the harness
checkout moves, rerun `./install` from the new checkout so the shim points at the
current `bin/harness.ts`.

## Isolated worktree readiness

After verifying a fresh Harness worktree's Git baseline, run `make
setup-worktree` before source edits or provider work. It runs
`CI=1 SKIP_INSTALL_SIMPLE_GIT_HOOKS=1 pnpm install --frozen-lockfile --offline`
against the ordinary shared pnpm store. Repository-owned Make gates resolve that
store without ambient pnpm store overrides, then pass it to pnpm explicitly. A
cache miss fails immediately; warm the store from an accepted lockfile before
delegation rather than adding an online fallback. Non-interactive mode lets pnpm
refresh the ignored dependency tree when its install metadata changes.

The command creates only the normal ignored `node_modules/`, skips shared Git
hook mutation, and does not copy or link dependencies from another worktree or
create a worktree-local package store. `.pnpm-store/` is also ignored as defense
in depth so transient cache files cannot become candidate source evidence.
Manual executors run setup after their before-edit checkpoint is acknowledged.
Workspace hosts may run the same repository-owned command as an acquire hook.
Readiness does not replace the final `make check` gate.

Keep the self-hosted Inngest database on a persistent worker filesystem or
Compose volume. The worker itself is stateless apart from an optional dedicated
Codex credential volume.

## Hook activation

Fresh checkout installs run `pnpm install --frozen-lockfile`, which runs the
package `prepare` script and installs the local `.git/hooks/pre-commit` hook via
`simple-git-hooks`. The hook is local commit hygiene: it runs staged
format/lint fixes through `lint-staged`, then runs `pnpm typecheck`.

`pnpm-workspace.yaml` scopes the workspace to the root package and approves the
`simple-git-hooks` install script so noninteractive pnpm installs can activate
the hook. If hooks need to be refreshed without reinstalling dependencies, run
`pnpm exec simple-git-hooks`.

Hooks do not replace `pnpm check` before handoff. CI uses `pnpm check:ci` for
pushes and non-plan-only pull requests; pull requests changing only
`dev/plans/**/*.md` run `make check-plan` instead. CI does not depend on local
Git hooks.

## Generated artifacts and ownership

| Path                                                                                  | Created by                                                                                                                                                     | Repo boundary                                                              | Commit policy                        | Notes                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.git/hooks/pre-commit` in the harness checkout                                       | `pnpm install --frozen-lockfile`, `pnpm exec simple-git-hooks`                                                                                                 | Harness repo local Git metadata                                            | Do not commit                        | Runs staged format/lint fixes and `pnpm typecheck` before local commits.                                                                                                                                    |
| `node_modules/` and defensive `.pnpm-store/` ignore in a Harness checkout or worktree | `pnpm install --frozen-lockfile`, `make setup-worktree`                                                                                                        | Harness checkout or isolated executor worktree                             | Ignored; do not commit               | Repository-owned Make gates use the ordinary shared pnpm store and skip shared Git-hook mutation during setup.                                                                                              |
| `dist/` in the harness checkout                                                       | `pnpm build`, `make build`, `pnpm smoke:dist`, `make smoke-dist`, `make check`, `make check-v`, `make check-ci`, `pnpm check`, `pnpm check:v`, `pnpm check:ci` | Harness repo local build output                                            | Ignored; do not commit               | Built JavaScript used by smoke tests and future package paths.                                                                                                                                              |
| OS temp `harness-gate-*` dirs or `GATE_LOG_DIR`                                       | Wrapped Make targets via `scripts/run-gate-step.ts`                                                                                                            | Harness repo local gate diagnostics                                        | Do not commit; review before sharing | Failed gate logs are kept for diagnosis. Successful logs are deleted unless `KEEP_GATE_LOGS=1`.                                                                                                             |
| `logs/codex-proxy/` in the harness checkout                                           | `pnpm codex:proxy` / `scripts/codex-proxy.mjs`                                                                                                                 | Local Codex Responses API request audits                                   | Ignored; do not commit               | Contains Markdown request audits and, when `CODEX_PROXY_WRITE_RAW=1`, parsed request JSON. Treat as sensitive because captured prompts, tool definitions, and request metadata may include private context. |
| `.harness/` in the harness checkout                                                   | Dogfooded `harness run ...`, `make smoke-dist`, `pnpm smoke:dist`, `make check`, `pnpm check`                                                                  | Harness repo local run state                                               | Ignored; do not commit               | Contains local workflow artifacts when running against this repo. Smoke and full check paths use dry-run `change-review` and leave ignored run directories.                                                 |
| `harness.json` in a target repo                                                       | `harness init`                                                                                                                                                 | Target repo config                                                         | Target repo decides                  | Stores repo-local defaults such as base branch and default agent.                                                                                                                                           |
| `.harness/bin/harness` in a target repo                                               | `harness init`                                                                                                                                                 | Target repo local shim                                                     | Ignored; do not commit               | Points back to the harness checkout that initialized the repo.                                                                                                                                              |
| `.harness/runs/reviews/<run-id>/` in a workspace                                      | `harness run change-review`, `harness run plan-review`, dry-run review commands                                                                                | Workspace-local run state, either external target repo or harness checkout | Ignored; do not commit               | Holds context, prompts, reviewer JSON, streams, events, `summary.md`, and `meta.json`.                                                                                                                      |
| Protected Linear automation environment file outside a repo                           | Deployment operator                                                                                                                                            | Local deployment secrets                                                   | User data; do not commit             | Holds Linear, Inngest, and optional Codex keys with owner-only permissions. Stable IDs stay in target-repo `harness.json`.                                                                                  |
| Compose volumes for Inngest SQLite and optional Codex credentials                     | `compose.linear-automation.yaml`                                                                                                                               | Local deployment state                                                     | User data; do not commit             | Preserves Inngest history and unattended Codex login across normal container restarts.                                                                                                                      |
| `.agents/skills/` in a target repo                                                    | `harness skills install`                                                                                                                                       | Target repo local skill installs                                           | Target repo decides                  | Live installs copy packaged skills into the target repo.                                                                                                                                                    |
| `~/.codex/state_5.sqlite`                                                             | Codex CLI                                                                                                                                                      | User-level Codex state                                                     | Do not commit                        | Source of truth for Codex session indexing.                                                                                                                                                                 |
| `~/.codex/sqlite/state_5.sqlite`                                                      | Older or alternate Codex CLI state layout                                                                                                                      | User-level Codex state                                                     | Do not commit                        | Missing-root fallback for Codex session indexing.                                                                                                                                                           |

Review artifacts are workspace-relative ignored local state: they live under an
external target repo when reviewing another repo, and under this harness checkout
when dogfooding reviews against harness itself.

Harness-owned schemas resolve from the Harness checkout `schemas/` directory.
`harness runs prune` targets workspace-local review runs.

## Provider auth assumptions

Cursor SDK review provider runs require `CURSOR_API_KEY` in the environment.

Codex SDK provider follows local Codex CLI auth via `codex login`, or
`CODEX_API_KEY` in the environment.

The Linear automation worker uses `LINEAR_API_KEY` to read and project issues in
its configured team and project. Keep the key in the protected worker
environment file, not `harness.json`.

Do not write secrets into docs, plans, generated artifacts, committed
`harness.json`, or checked-in config.

## Harness repo vs target repo

| Owner        | Owns                                                                                                                                                                                                              | Does not own                                                                      |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Harness repo | Source under `bin/`, `lib/`, `providers/`, and `workflows/`; packaged skills under `skills/`; the `install` script; build artifacts; contributor docs; workspace-local review artifacts when dogfooding this repo | Target repo product docs, source, tests, gates, and local policy choices          |
| Target repo  | `harness.json`, `.harness/bin/harness`, optional installed workflow skills under `.agents/skills/`, and workspace-local review artifacts when reviewing that repo                                                 | Harness provider internals, packaged fallback skills, or harness release behavior |

Use `/path/to/repo` in durable examples for external target repositories. Keep
private local paths out of committed docs.
