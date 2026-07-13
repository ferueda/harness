# Setup Manifest

Contributor reference for local requirements, install behavior, generated
artifacts, provider auth, and harness-repo vs target-repo ownership.

See [Script and Command Surface](./script-command-surface.md) for command
mutability, and [Architecture](./architecture.md) for runtime flow, review
artifact lifecycle, and directory ownership.

## Local requirements

| Requirement                            | Needed for                                            | Notes                                                                         |
| -------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| Node 24 or newer                       | Source CLI, tests, build, skill CLIs                  | The source checkout runs TypeScript directly through Node type stripping.     |
| `pnpm` on `PATH`                       | Install, package scripts, gates, skill-local installs | The harness installer and sessions skill installer both use pnpm.             |
| POSIX shell with `bash`                | `install`, generated shims, target-repo shim          | Shims use `#!/usr/bin/env bash` and `set -euo pipefail`.                      |
| Git checkout of this harness repo      | Source install and development                        | The checkout can live anywhere; use generic paths such as `/path/to/harness`. |
| Optional PATH entry for installed shim | Interactive `harness ...` command                     | See Install and update for the default shim path.                             |

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

## Hook activation

Fresh checkout installs run `pnpm install --frozen-lockfile`, which runs the
package `prepare` script and installs the local `.git/hooks/pre-commit` hook via
`simple-git-hooks`. The hook is local commit hygiene: it runs staged
format/lint fixes through `lint-staged`, then runs `pnpm typecheck`.

`pnpm-workspace.yaml` scopes the workspace to the root package and approves the
`simple-git-hooks` install script so noninteractive pnpm installs can activate
the hook. The standalone sessions skill installer uses `--ignore-workspace` so
`skills/sessions/` keeps its own lockfile and dependency install. If hooks need
to be refreshed without reinstalling dependencies, run `pnpm exec
simple-git-hooks`.

Hooks do not replace `pnpm check` before handoff, and CI uses `pnpm check:ci`
instead of local Git hooks.

## Generated artifacts and ownership

| Path                                                                                       | Created by                                                                                                                                                     | Repo boundary                                                              | Commit policy                              | Notes                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.git/hooks/pre-commit` in the harness checkout                                            | `pnpm install --frozen-lockfile`, `pnpm exec simple-git-hooks`                                                                                                 | Harness repo local Git metadata                                            | Do not commit                              | Runs staged format/lint fixes and `pnpm typecheck` before local commits.                                                                                                                                    |
| `dist/` in the harness checkout                                                            | `pnpm build`, `make build`, `pnpm smoke:dist`, `make smoke-dist`, `make check`, `make check-v`, `make check-ci`, `pnpm check`, `pnpm check:v`, `pnpm check:ci` | Harness repo local build output                                            | Ignored; do not commit                     | Built JavaScript used by smoke tests and future package paths.                                                                                                                                              |
| OS temp `harness-gate-*` dirs or `GATE_LOG_DIR`                                            | Wrapped Make targets via `scripts/run-gate-step.ts`                                                                                                            | Harness repo local gate diagnostics                                        | Do not commit; review before sharing       | Failed gate logs are kept for diagnosis. Successful logs are deleted unless `KEEP_GATE_LOGS=1`.                                                                                                             |
| `logs/codex-proxy/` in the harness checkout                                                | `pnpm codex:proxy` / `scripts/codex-proxy.mjs`                                                                                                                 | Local Codex Responses API request audits                                   | Ignored; do not commit                     | Contains Markdown request audits and, when `CODEX_PROXY_WRITE_RAW=1`, parsed request JSON. Treat as sensitive because captured prompts, tool definitions, and request metadata may include private context. |
| `.harness/` in the harness checkout                                                        | Dogfooded `harness run ...`, `make smoke-dist`, `pnpm smoke:dist`, `make check`, `pnpm check`                                                                  | Harness repo local run state                                               | Ignored; do not commit                     | Contains local workflow artifacts when running against this repo. Smoke and full check paths use dry-run `change-review` and leave ignored run directories.                                                 |
| `harness.json` in a target repo                                                            | `harness init`                                                                                                                                                 | Target repo config                                                         | Target repo decides                        | Stores repo-local defaults such as base branch and default agent.                                                                                                                                           |
| `.harness/bin/harness` in a target repo                                                    | `harness init`                                                                                                                                                 | Target repo local shim                                                     | Ignored; do not commit                     | Points back to the harness checkout that initialized the repo.                                                                                                                                              |
| `.harness/inbox/factory/*.json` in a workspace                                             | User-created files, future tracker adapters                                                                                                                    | Workspace-local factory intake queue                                       | Ignored; do not commit                     | Pending local factory work items. `harness factory status` reads these files. `harness factory triage --item-file ...` can run one item without moving it.                                                  |
| `.harness/inbox/factory/processed/*.json`                                                  | Historical experimental batch runs                                                                                                                             | Workspace-local factory intake history                                     | Ignored; do not commit                     | Historical processed inbox items. Current factory station commands do not write this path.                                                                                                                  |
| `.harness/inbox/factory/failed/*`                                                          | Historical experimental batch runs                                                                                                                             | Workspace-local factory intake failure state                               | Ignored; do not commit                     | Historical failed inbox items and sibling `.error.json` summaries. Current factory station commands do not write this path.                                                                                 |
| `${XDG_DATA_HOME:-~/.local/share}/harness/store/projects/<repo-id>/factory/events/*.jsonl` | Live `harness factory` station commands                                                                                                                        | Durable factory lifecycle state                                            | User data; do not commit                   | Canonical lifecycle event log keyed by work item. Linear status/comments are human projections; run `meta.json` is execution evidence. Legacy workspace-local `.harness/factory` is detected and ignored.   |
| `${XDG_DATA_HOME:-~/.local/share}/harness/store/projects/<repo-id>/factory/state/*.json`   | Lifecycle store helper after appending or loading lifecycle events                                                                                             | Durable factory lifecycle read model                                       | User data; do not commit                   | Rebuildable cache derived from durable JSONL and atomically published under a per-work-item lock.                                                                                                           |
| `.harness/runs/reviews/<run-id>/` in a workspace                                           | `harness run change-review`, `harness run plan-review`, dry-run review commands                                                                                | Workspace-local run state, either external target repo or harness checkout | Ignored; do not commit                     | Holds context, prompts, reviewer JSON, streams, events, `summary.md`, and `meta.json`.                                                                                                                      |
| `${XDG_DATA_HOME:-~/.local/share}/harness/store/projects/<repo-id>/runs/factory/<run-id>/` | `harness factory triage`                                                                                                                                       | Durable factory run evidence                                               | User data; do not commit                   | Holds triage action artifacts, telemetry, immutable recovery evidence, and `meta.json` with store provenance. Prune remains explicit-path based; pass this durable root with `--runs-dir`.                  |
| `.agents/skills/` in a target repo                                                         | `harness skills install`                                                                                                                                       | Target repo local skill installs                                           | Target repo decides                        | Live installs copy packaged skills into the target repo.                                                                                                                                                    |
| `skills/sessions/node_modules/`                                                            | `skills/sessions/scripts/install.sh` or skill-local `pnpm install --ignore-workspace --prod --frozen-lockfile`                                                 | Harness checkout or copied skill local dependency state                    | Do not commit generated dependency content | Local generated dependency tree may exist after installing the sessions CLI.                                                                                                                                |
| `~/.sessions/index`                                                                        | `sessions cursor reindex`, `sessions codex reindex`                                                                                                            | User-level sessions cache                                                  | Do not commit                              | Current sessions index cache.                                                                                                                                                                               |
| `~/.harness/session-index`                                                                 | Older sessions CLI versions                                                                                                                                    | User-level legacy cache                                                    | Do not commit                              | Older machines may retain this until first sessions CLI use migrates to `~/.sessions/index`.                                                                                                                |
| `~/.codex/state_5.sqlite`                                                                  | Codex CLI                                                                                                                                                      | User-level Codex state                                                     | Do not commit                              | Source of truth for Codex session indexing.                                                                                                                                                                 |
| `~/.codex/sqlite/state_5.sqlite`                                                           | Older or alternate Codex CLI state layout                                                                                                                      | User-level Codex state                                                     | Do not commit                              | Missing-root fallback for Codex session indexing.                                                                                                                                                           |

Review artifacts are workspace-relative ignored local state: they live under an
external target repo when reviewing another repo, and under this harness checkout
when dogfooding reviews against harness itself.

Factory station lifecycle and run artifacts live under the durable store,
`${XDG_DATA_HOME:-~/.local/share}/harness/store/projects/<repo-id>/`; target
repositories keep workspace-local inbox files and committed material.
Harness-owned schemas resolve from the harness checkout `schemas/` directory.
Manual planning candidate, review, and publication actions are shipped;
implementation actions remain unavailable. Default
`harness runs prune` targets review runs; factory
run cleanup currently needs
`--runs-dir <store>/projects/<repo-id>/runs/factory` or manual deletion until prune
grows a factory-aware default.

Factory inbox files are separate from future review-trigger inbox files.
`harness factory status` is read-only. `harness factory triage --item-file ...`
creates factory run artifacts for one work item and does not move pending inbox
files. Current factory station
commands do not batch-process every inbox file. `processed/` and `failed/` are
historical local paths from earlier batch experiments; current station commands
may report them in status output but do not mutate them.
Triage first checks durable lifecycle history: a prior
`triage.work_item.completed`
exits before run creation and leaves the inbox item untouched unless the
operator supplies `--rerun`.

## Provider auth assumptions

Cursor SDK review provider runs require `CURSOR_API_KEY` in the environment.

Codex SDK provider follows local Codex CLI auth via `codex login`, or
`CODEX_API_KEY` in the environment.

Linear list, fetch, create, and Linear-backed station input use
`LINEAR_API_KEY` for `harness factory linear list`,
`harness factory linear fetch`, `harness factory linear create`,
`harness factory triage --linear-issue TEAM-123`. Create is a constrained
intake write (no `--apply`); adding `--apply` to Linear triage projects its
guarded start and terminal status/comment updates. Linear-backed planning also
requires live status validation; each mutation needs that invocation's
`--apply`. Implementation commands are unavailable.

Do not write secrets into docs, plans, generated artifacts, committed
`harness.json`, or checked-in config.

## Harness repo vs target repo

| Owner        | Owns                                                                                                                                                                                                              | Does not own                                                                      |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Harness repo | Source under `bin/`, `lib/`, `providers/`, and `workflows/`; packaged skills under `skills/`; the `install` script; build artifacts; contributor docs; workspace-local review artifacts when dogfooding this repo | Target repo product docs, source, tests, gates, and local policy choices          |
| Target repo  | `harness.json`, `.harness/bin/harness`, optional installed workflow skills under `.agents/skills/`, and workspace-local review artifacts when reviewing that repo                                                 | Harness provider internals, packaged fallback skills, or harness release behavior |

Use `/path/to/repo` in durable examples for external target repositories. Keep
private local paths out of committed docs.
