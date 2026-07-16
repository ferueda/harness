# Script and Command Surface

Contributor and agent reference for command ownership, mutability, and where to
inspect generated help. Use this page to understand who owns each command
surface; use generated help for exact flags and target text.

Use [Architecture](./architecture.md) for runtime flow and artifacts and the
[Factory contributor guide](./factory.md) for Factory ownership and invariants.
Use [Harness engineering](./harness-engineering.md) for the workflow-quality
loop and [Setup Manifest](./setup-manifest.md) for generated artifacts and auth.

## Command ownership

| Surface                     | Owner file                                                   | Public commands                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Use when                                                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Make targets                | `Makefile`                                                   | `make help`, `make setup-worktree`, `make check`, `make check-v`, `make check-ci`, `make check-plan`, `make format`, `make fix`, `make fix-plan`, `make lint`, `make typecheck`, `make test`, `make smoke-dist`, `make smoke-factory`, `make build`, `make ensure-node`                                                                                                                                                                                                                                                                                                                                                                                   | Local worktree setup, development gates, and wrappers around package scripts. Wrapped gate targets use `scripts/run-gate-step.ts` for quiet success and bounded failure output. |
| pnpm scripts                | `package.json`                                               | `pnpm check`, `pnpm check:v`, `pnpm check:ci`, `pnpm check:plan`, `pnpm format`, `pnpm fix`, `pnpm fix:plan`, `pnpm format:check`, `pnpm lint`, `pnpm lint:fix`, `pnpm typecheck`, `pnpm test`, `pnpm test:watch`, `pnpm build`, `pnpm smoke:dist`, `pnpm smoke:factory`, `pnpm codex:proxy`                                                                                                                                                                                                                                                                                                                                                              | Direct package-level commands under Make targets plus local inspection utilities.                                                                                               |
| Source CLI                  | `bin/harness.ts`                                             | `harness init`, `harness factory status`, `harness factory inspect`, `harness factory linear list`, `harness factory linear fetch`, `harness factory linear create`, `harness factory triage`, `harness factory planning run`, `harness factory planning continue`, `harness factory planning publish`, `harness factory planning mark-plan-merged`, `harness factory implementation run`, `harness factory implementation continue`, `harness factory implementation publish`, `harness factory implementation mark-pr-merged`, `harness run change-review`, `harness run plan-review`, `harness runs prune`, `harness models`, `harness skills install` | User-facing workflows, tracker adapters, inbox management, read-only durable Factory inspection, and manually stepped Factory actions.                                          |
| Dist smoke test             | `scripts/smoke-dist.ts`                                      | `pnpm smoke:dist`, `make smoke-dist`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Verify built CLI behavior, factory command help, init shim creation, skills install, dry-run review metadata, and handoff artifacts.                                            |
| Factory system smoke        | `scripts/smoke-factory.ts`, `scripts/smoke-factory-grove.ts` | `pnpm smoke:factory`, `make smoke-factory`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Verify offline Factory execution, Inngest delivery, and Grove release/recovery.                                                                                                 |
| Codex request proxy         | `scripts/codex-proxy.mjs`                                    | `pnpm codex:proxy`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Inspect local Codex Responses API requests, request byte contributors, tool definition size, and reported input-token usage.                                                    |
| Sessions skill CLI          | `skills/sessions/scripts/`                                   | `sessions ...` after `skills/sessions/scripts/install.sh`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Browse and index local Cursor or Codex session history.                                                                                                                         |
| Cursor delegation skill CLI | `skills/cursor-cli/scripts/`                                 | `cursor-cli ...` after `skills/cursor-cli/scripts/install.sh`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Run ad-hoc Cursor delegation outside harness review workflows.                                                                                                                  |
| User install shim           | `install`                                                    | `harness ...` from the installed user-level shim                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Install or refresh the user command, usually under `~/.local/bin/harness`.                                                                                                      |
| Target-repo shim            | `harness init`                                               | `.harness/bin/harness ...` inside the target repo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Pin a target repo to the harness checkout that initialized it.                                                                                                                  |

## Read-only vs mutating commands

| Class                                   | Commands                                                                                                                                                                                                                                                                                                                      | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read-only/checking                      | `make help`, `make ensure-node`, `make check-format`, `make check-plan`, `make lint`, `make typecheck`, `make test`, `harness models`, `harness factory status`, `harness factory inspect`, `harness factory linear list`, `harness factory linear fetch`, `harness runs prune --dry-run`, `harness skills install --dry-run` | These inspect or verify current state without changing tracked source, moving inbox items, or deleting local state. `harness factory inspect` reads durable lifecycle JSONL without a lock, marker, projection, tracker request, provider call, or evidence crawl. `harness factory linear list` and `harness factory linear fetch` require `LINEAR_API_KEY`, call the live Linear API, and validate configured team/status/project scope. Fetch returns tracker metadata and never derives or merges Factory machine state. Neither command mutates repo files, lifecycle files, or Linear state. |
| Constrained external tracker mutation   | `harness factory linear create`                                                                                                                                                                                                                                                                                               | Creates one Linear intake issue using configured `factory.linear` team, project, and intake status. Requires `LINEAR_API_KEY`, non-empty title, and body from exactly one of `--body`, `--body-file`, or stdin. Prints compact JSON only. Not a station: no `--dry-run`/`--apply`, no lifecycle events, and no factory run artifacts.                                                                                                                                                                                                                                                              |
| Checking with ignored artifacts         | `make build`, `pnpm build`, `make smoke-dist`, `pnpm smoke:dist`, `make check`, `make check-v`, `make check-ci`, `pnpm check`, `pnpm check:v`, `pnpm check:ci`, `harness factory triage --dry-run`                                                                                                                            | Build and gate paths may refresh ignored `dist/`. Distribution smoke and ordinary checks may also run dry-run standalone reviews under workspace-local `.harness/runs/reviews/<run-id>/`. Factory triage dry-run writes run artifacts without invoking a provider, initializing the store marker, or mutating lifecycle state. Linear-backed dry-run still performs the required live Linear read without mutating Linear.                                                                                                                                                                         |
| Ephemeral system mutation               | `make smoke-factory`, `pnpm smoke:factory`                                                                                                                                                                                                                                                                                    | Creates temporary repositories, isolated Grove and Factory state, and a local Inngest process. Success cleans them; failure retains bounded diagnostics. It does not touch user state or external services.                                                                                                                                                                                                                                                                                                                                                                                        |
| Local inspection with ignored artifacts | `pnpm codex:proxy`                                                                                                                                                                                                                                                                                                            | Starts a local HTTP proxy, forwards matching Codex requests to the configured upstream, and writes ignored request audits under `logs/codex-proxy/`. It does not mutate tracked source, but captured logs may contain private prompt or tool context.                                                                                                                                                                                                                                                                                                                                              |
| Mutating/preparing                      | `make setup-worktree`, `make format`, `make fix`, `make fix-plan`, `./install`, `harness init`, `harness skills install`, `harness runs prune` without `--dry-run`                                                                                                                                                            | These install ignored dependencies, write files or shims, copy skills, delete run artifacts, or rewrite formatted source. `make setup-worktree` uses the ordinary shared pnpm store offline and skips shared Git-hook mutation. Live `harness skills install` writes into the target repo `.agents/skills/` tree.                                                                                                                                                                                                                                                                                  |
| Review artifact writing                 | `harness run change-review`, `harness run plan-review`                                                                                                                                                                                                                                                                        | Live and dry-run review commands write ignored run artifacts under `.harness/runs/reviews/<run-id>/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Factory artifact writing                | `harness factory triage`, `harness factory planning run`, `harness factory planning continue`, `harness factory planning publish`, `harness factory planning mark-plan-merged`, `harness factory implementation run`, `harness factory implementation continue`                                                               | Writes action lifecycle state and recovery evidence under `${XDG_DATA_HOME:-~/.local/share}/harness/store/projects/<repo-id>/` by default. Phase runs execute at most one handler, persist its terminal result, print the next reaction, and exit. Continuation commands copy one bounded response and append one candidate-bound decision without invoking a handler or tracker. `revise` resumes the saved producer session; `re-review` preserves the candidate. Only a passing reviewed commit is promoted.                                                                                    |
| Factory PR publication                  | `harness factory planning publish`, `harness factory implementation publish`                                                                                                                                                                                                                                                  | Materializes or verifies the exact reviewed head, pushes an absent deterministic branch, finds or creates one matching GitHub PR, appends an opened event, and optionally projects Linear. Retry rejects divergence and never merges.                                                                                                                                                                                                                                                                                                                                                              |
| Factory merge acknowledgement           | `harness factory planning mark-plan-merged`, `harness factory implementation mark-pr-merged`                                                                                                                                                                                                                                  | Verifies a human-supplied local merge commit contains the recorded head, appends one merged event, and optionally projects Linear. Performs no GitHub query or merge.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Skill-owned CLIs                        | `sessions ...`, `cursor-cli ...`                                                                                                                                                                                                                                                                                              | Mutability depends on the skill command. For example, `sessions <provider> reindex` writes user-level caches documented in [Setup Manifest](./setup-manifest.md).                                                                                                                                                                                                                                                                                                                                                                                                                                  |

`harness run ... --dry-run` is lower risk than a live review because it does not
invoke reviewers, but it is not as side-effect-free as
`harness runs prune --dry-run`.

## Factory durable-store behavior

`harness factory status` inspects the durable factory store without acquiring
lifecycle locks or rebuilding state. Linear fetch is tracker-only and does not
read or derive Factory state. Triage dry-run performs a read-only store-format
compatibility check; it neither creates a marker nor mutates an empty store.

`harness factory inspect` is the per-work-item durable read surface. It accepts
one item file or canonical Linear issue identifier, prints stable JSON with
artifact roots and verbatim refs, and returns null state/event/reaction when
history is absent. Its Linear selector is store-only and never requires
`LINEAR_API_KEY`. Exact next station commands appear only for mechanically
selectable reactions; human, merge, terminal, stale, and null waits have no
command. Resolve a candidate wait with the explicit planning or implementation
`continue` command, then invoke the normal printed `run` command later.

Live `harness factory triage` writes Factory action lifecycle and run evidence under
`${XDG_DATA_HOME:-~/.local/share}/harness/store/projects/<repo-id>/` by
default. Live readiness paths rebuild lifecycle state under a per-work-item
lock when needed. Standalone review commands keep their workspace-local
defaults.

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
visual checks. Run `pnpm check` before handoff. CI runs `pnpm check:ci` for
pushes and pull requests outside the approved `dev/plans/**/*.md`-only class.
Plan-only pull requests run plan formatting and docs contracts instead. CI does
not depend on local Git hooks. The ordinary local `pnpm check` excludes the
Factory system smoke; full `pnpm check:ci` runs it after ordinary checks, while
the plan-only CI path bypasses both the full gate and that smoke.

Use [Setup Manifest](./setup-manifest.md) for hook activation and generated
artifact ownership.

## Do not duplicate generated help

Docs explain command ownership, intent, and mutability. Generated help owns exact
flags and target text:

- `harness --help`
- `harness factory linear --help`
- `harness factory linear list --help`
- `harness factory linear fetch --help`
- `harness factory linear create --help`
- `harness factory triage --help`
- `harness factory status --help`
- `harness factory inspect --help`
- `harness run --help`
- `harness run plan-review --help`
- `make help`

When generated help changes, update this page only if the command ownership or
mutability model changes.

## Inventory rules

- Treat `install`, `bin/harness.ts`, `scripts/*`, `workflows/*.ts`,
  and `skills/*/scripts/*` as executable command surfaces.
  Current concrete root script entries include `scripts/smoke-dist.ts` for dist
  smoke coverage, `scripts/smoke-factory.ts` for the offline Factory system
  journey, `scripts/run-gate-step.ts` for wrapped Make gate output, and
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
