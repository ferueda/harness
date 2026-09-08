# Setup Manifest

Contributor reference for local requirements, install behavior, generated
artifacts, provider authentication, and Harness-repo versus target-repo
ownership.

See [Script and command surface](./script-command-surface.md) for command
mutability and [Architecture](./architecture.md) for runtime flow and review
artifact lifecycle.

## Local requirements

| Requirement             | Needed for                                  | Notes                                                           |
| ----------------------- | ------------------------------------------- | --------------------------------------------------------------- |
| Node 24 or newer        | Source CLI, tests, build, and skill scripts | Source TypeScript runs through Node type stripping.             |
| `pnpm` on `PATH`        | Install, package scripts, and gates         | The installer and repository gates use pnpm.                    |
| POSIX shell with `bash` | Installer and generated shims               | Shims use `#!/usr/bin/env bash` and `set -euo pipefail`.        |
| Git checkout of Harness | Source install and development              | The checkout can live anywhere; use `/path/to/harness` in docs. |

## Install and update

Run `./install` from the Harness checkout, or run `/path/to/harness/install`
from elsewhere. The installer validates Node 24 or newer, runs
`pnpm install --frozen-lockfile`, writes the user-level `harness` shim, and
verifies `harness --help`.

Package scripts fail clearly when dependencies are missing. Install dependencies
before running parallel Make gates so pnpm does not race to update them. Set
`HARNESS_INSTALL_SKIP_PNPM=1` only in installer tests that intentionally skip
dependency installation.

The default user-level shim is `~/.local/bin/harness`. If the checkout moves,
rerun `./install` so the shim points at the current `bin/harness.ts`.

## Isolated worktree readiness

After verifying a fresh Harness worktree's Git baseline, run
`make setup-worktree` before source edits or provider work. It runs
`CI=1 SKIP_INSTALL_SIMPLE_GIT_HOOKS=1 pnpm install --frozen-lockfile --offline`
against the ordinary shared pnpm store. Repository-owned Make gates resolve that
store without ambient overrides and pass it to pnpm explicitly. A cache miss
fails immediately; warm the shared store from an accepted lockfile before
delegation.

The command creates only the ignored `node_modules/`, skips shared Git-hook
mutation, and does not create a worktree-local package store. `.pnpm-store/` is
ignored as defense in depth. This readiness step does not replace the final
`make check` gate.

## Hook activation

Fresh checkout installs run the package `prepare` script, which installs the
local `.git/hooks/pre-commit` hook through `simple-git-hooks`. The hook formats
and lints staged files with `lint-staged`, then runs `pnpm typecheck`.

`pnpm-workspace.yaml` scopes the workspace to the root package and approves the
`simple-git-hooks` install script. Refresh hooks without reinstalling by running
`pnpm exec simple-git-hooks`.

Hooks do not replace `pnpm check` before handoff. CI uses `make check` for
pushes and non-plan-only pull requests; pull requests that change only
`dev/plans/**/*.md` run `make check-plan`. CI does not depend on local Git hooks.

## Target configuration

Run `harness init` in a target repository to create a minimal `harness.json`,
ignore `.harness/`, and write the local command shim. Configuration supports the
base branch, a default `cursor` or `codex` provider, an optional Cursor model,
and Codex model, executable, sandbox, approval, and reasoning defaults.

Keep secrets out of `harness.json`. Cursor uses `CURSOR_API_KEY`. Codex uses
local `codex login` state or `CODEX_API_KEY`.

## Generated artifacts and ownership

| Path                                                          | Created by                                   | Commit policy                               | Notes                                                                                    |
| ------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `.git/hooks/pre-commit`                                       | `pnpm install`, `pnpm exec simple-git-hooks` | Do not commit                               | Local staged-file hygiene.                                                               |
| `node_modules/`                                               | `pnpm install`, `make setup-worktree`        | Ignored                                     | Repository dependencies from the ordinary shared pnpm store.                             |
| `dist/`                                                       | Build, distribution smoke, and full gates    | Ignored                                     | Built JavaScript used by packaging checks.                                               |
| OS temp `harness-gate-*` dirs or `GATE_LOG_DIR`               | `scripts/run-gate-step.ts`                   | Do not commit                               | Failed logs remain for diagnosis. Successful logs are removed unless `KEEP_GATE_LOGS=1`. |
| `logs/codex-proxy/`                                           | `pnpm codex:proxy`                           | Ignored; treat as sensitive                 | Request audits can include prompts, tools, and request metadata.                         |
| `.harness/` in this checkout                                  | Dogfooded review commands and full checks    | Ignored                                     | Local workflow artifacts.                                                                |
| `harness.json` in a target repo                               | `harness init`                               | Target decides                              | Review and provider defaults without secrets.                                            |
| `.harness/bin/harness` in a target repo                       | `harness init`                               | Ignored                                     | Points to the Harness checkout used for initialization.                                  |
| `.harness/runs/reviews/<run-id>/` or an explicit `--runs-dir` | Review workflows and dry runs                | Ignored by default; caller owns an override | Context, prompts, streams, events, validated results, summary, and metadata.             |
| `.agents/skills/` in a target repo                            | `harness skills install`                     | Target decides                              | Copies one named packaged skill and its local references.                                |

Review artifacts are workspace-relative. They live in an external target repo
when reviewing that repo and in this checkout when dogfooding Harness.
Harness-owned schemas resolve from the Harness checkout's `schemas/` directory.
`harness runs prune` removes workspace-local review runs.

## Provider authentication

Cursor SDK review runs require `CURSOR_API_KEY` in the environment. Codex SDK
review runs follow local Codex CLI authentication from `codex login`, or use
`CODEX_API_KEY`.

The optional Codex proxy listens only on loopback and records request audits in
`logs/codex-proxy/`. Configure its upstream URL and ports with the variables
documented by `scripts/codex-proxy.mjs`; captured request material is local and
potentially sensitive.

Do not write secrets into docs, plans, generated artifacts, committed
`harness.json`, or checked-in config.

## Harness repo and target repo

| Owner        | Owns                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Harness repo | `bin/`, `lib/`, `providers/`, `workflows/`, packaged `skills/`, the installer, contributor docs, checks, and local dogfood artifacts |
| Target repo  | Project docs, source, tests, gates, `harness.json`, optional installed skills, and workspace-local review artifacts                  |

Use `/path/to/repo` in durable examples. Keep private local paths out of
committed docs.
