# Setup Manifest

Contributor reference for local requirements, install behavior, generated
artifacts, provider auth, and harness-repo vs target-repo ownership.

See [Script and Command Surface](./script-command-surface.md) for command
mutability, and [Architecture](./architecture.md) for runtime flow, review
artifact lifecycle, and directory ownership.

## Local requirements

| Requirement | Needed for | Notes |
|-------------|------------|-------|
| Node 24 or newer | Source CLI, tests, build, skill CLIs | The source checkout runs TypeScript directly through Node type stripping. |
| `pnpm` on `PATH` | Install, package scripts, gates, skill-local installs | The harness installer and sessions skill installer both use pnpm. |
| POSIX shell with `bash` | `install`, generated shims, target-repo shim | Shims use `#!/usr/bin/env bash` and `set -euo pipefail`. |
| Git checkout of this harness repo | Source install and development | The checkout can live anywhere; use generic paths such as `/path/to/harness`. |
| Optional PATH entry for installed shim | Interactive `harness ...` command | See Install and update for the default shim path. |

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

## Generated artifacts and ownership

| Path | Created by | Repo boundary | Commit policy | Notes |
|------|------------|---------------|---------------|-------|
| `dist/` in the harness checkout | `pnpm build`, `make build`, `pnpm smoke:dist`, `make smoke-dist`, `make check`, `make check-v`, `make check-ci`, `pnpm check`, `pnpm check:v`, `pnpm check:ci` | Harness repo local build output | Ignored; do not commit | Built JavaScript used by smoke tests and future package paths. |
| `.harness/` in the harness checkout | Dogfooded `harness run ...`, `make smoke-dist`, `pnpm smoke:dist`, `make check`, `pnpm check` | Harness repo local run state | Ignored; do not commit | Contains local review artifacts when reviewing this repo. Smoke and full check paths use dry-run `change-review` and leave ignored run directories. |
| `harness.json` in a target repo | `harness init` | Target repo config | Target repo decides | Stores repo-local defaults such as base branch and default agent. |
| `.harness/bin/harness` in a target repo | `harness init` | Target repo local shim | Ignored; do not commit | Points back to the harness checkout that initialized the repo. |
| `.harness/runs/reviews/<run-id>/` in a workspace | `harness run change-review`, `harness run plan-review`, dry-run review commands | Workspace-local run state, either external target repo or harness checkout | Ignored; do not commit | Holds context, prompts, reviewer JSON, streams, events, `summary.md`, and `meta.json`. |
| `.agents/skills/` in a target repo | `harness skills install` | Target repo local skill installs | Target repo decides | Live installs copy packaged skills into the target repo. |
| `skills/sessions/node_modules/` | `skills/sessions/scripts/install.sh` or skill-local pnpm install | Harness checkout or copied skill local dependency state | Do not commit generated dependency content | Local generated dependency tree may exist after installing the sessions CLI. |
| `~/.sessions/index` | `sessions cursor reindex`, `sessions codex reindex` | User-level sessions cache | Do not commit | Current sessions index cache. |
| `~/.harness/session-index` | Older sessions CLI versions | User-level legacy cache | Do not commit | Older machines may retain this until first sessions CLI use migrates to `~/.sessions/index`. |
| `~/.codex/state_5.sqlite` | Codex CLI | User-level Codex state | Do not commit | Source of truth for Codex session indexing. |
| `~/.codex/sqlite/state_5.sqlite` | Older or alternate Codex CLI state layout | User-level Codex state | Do not commit | Missing-root fallback for Codex session indexing. |

Review artifacts are workspace-relative ignored local state: they live under an
external target repo when reviewing another repo, and under this harness checkout
when dogfooding reviews against harness itself.

## Provider auth assumptions

Cursor SDK review provider runs require `CURSOR_API_KEY` in the environment.

Codex SDK provider follows local Codex CLI auth via `codex login`, or
`CODEX_API_KEY` in the environment.

Do not write secrets into docs, plans, generated artifacts, committed
`harness.json`, or checked-in config.

## Harness repo vs target repo

| Owner | Owns | Does not own |
|-------|------|--------------|
| Harness repo | Source under `bin/`, `lib/`, `providers/`, and `workflows/`; packaged skills under `skills/`; the `install` script; build artifacts; contributor docs; workspace-local review artifacts when dogfooding this repo | Target repo product docs, source, tests, gates, and local policy choices |
| Target repo | `harness.json`, `.harness/bin/harness`, optional installed workflow skills under `.agents/skills/`, and workspace-local review artifacts when reviewing that repo | Harness provider internals, packaged fallback skills, or harness release behavior |

Use `/path/to/repo` in durable examples for external target repositories. Keep
private local paths out of committed docs.
