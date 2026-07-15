# Harness

Harness is a personal toolkit for agent-assisted software work. It provides:

- callable plan and implementation review workflows;
- a durable, manually stepped Factory for triage, planning, implementation,
  review, and pull-request handoff;
- Cursor and Codex provider adapters;
- packaged agent skills and background-task definitions.

Harness runs against ordinary Git repositories. Target repositories keep their
own code, configuration, and local review artifacts; Factory lifecycle state and
evidence live in a separate durable store.

## Install

Requirements: Node.js 24 or newer, `pnpm`, and a POSIX shell with `bash`.

```bash
git clone git@github.com:ferueda/harness.git ~/.harness
~/.harness/install
```

The checkout may live elsewhere. The installer installs locked dependencies,
writes `harness` to `~/.local/bin` by default, and verifies the command. If that
directory is not on `PATH`, it prints the required export.

Update an existing installation with:

```bash
cd ~/.harness
git pull
./install
```

## Review a Repository

Initialize each target repository once:

```bash
cd /path/to/repo
harness init
```

This creates a minimal `harness.json` when needed, ignores generated
`.harness/` state, and writes an ignored local shim at
`.harness/bin/harness`.

Run the default implementation and code-quality review:

```bash
harness run change-review --verbose
```

Review an implementation plan:

```bash
harness run plan-review --plan path/to/implementation-plan.md --verbose
```

Standalone review artifacts are written to
`.harness/runs/reviews/<run-id>/` in the target repository. Generated help owns
the complete command surface:

```bash
harness run change-review --help
harness run plan-review --help
```

See the
[change-review workflow skill](skills/change-review-workflow/SKILL.md) for
review handoff, finding triage, and rerun guidance.

## Run Factory

Factory is a durable state machine operated one command at a time. Each
invocation reads current state, executes at most one pending action, persists
the result, and exits. The caller decides when to run the next printed command.

Start from a Linear issue:

```bash
harness factory triage \
  --workspace /path/to/repo \
  --linear-issue TEAM-123 \
  --apply
```

Or use a local work-item JSON file containing `id`, `source`, `title`, and
`body`:

```bash
harness factory triage \
  --workspace /path/to/repo \
  --item-file .harness/inbox/factory/item.json
```

Inspect state without advancing it:

```bash
harness factory status --workspace /path/to/repo
harness factory inspect --workspace /path/to/repo --linear-issue TEAM-123
```

Factory can route work through planning or directly to implementation. Planning
and implementation preserve immutable candidates, run reviews, pause for
explicit `revise` or `re-review` decisions when needed, publish reviewed pull
requests, and wait for merge acknowledgement. Factory never merges a pull
request. Linear and GitHub updates are explicit projections; `--apply` is
required where shown by command help.

Factory state and run evidence default to
`${XDG_DATA_HOME:-~/.local/share}/harness/store/projects/<repo-id>/`. The target
workspace remains the Git materialization and execution sandbox.

Operators should follow the
[Factory operator skill](skills/factory-operator/SKILL.md). Contributors should
use the [Factory contributor guide](docs/contributing/factory.md). Generated
help owns exact flags and recovery commands.

## Configure Agents

`harness.json` stores target-repository defaults. `harness init` starts with the
base branch only; add provider choices as needed:

```json
{
  "base": "main",
  "defaultAgent": "codex"
}
```

Factory roles may override the provider and model under
`factory.<station>.roles`. Run `harness models` for the supported model catalog.

Cursor SDK runs require `CURSOR_API_KEY`. Codex follows local `codex login`
authentication or `CODEX_API_KEY`. Linear commands require `LINEAR_API_KEY`;
pull-request publication uses the authenticated `gh` CLI.

See the [setup manifest](docs/contributing/setup-manifest.md) for configuration,
generated paths, and provider details.

## Packaged Skills

Packaged skills live under [`skills/`](skills/). Install them into a supported
agent host with:

```bash
npx skills add ferueda/harness
```

Install one packaged skill into a target repository with:

```bash
harness skills install change-review-workflow --workspace /path/to/repo
```

Skill resolution prefers target-repository `.agents/skills/`, then user
`~/.agents/skills/`, then packaged Harness skills. Background task definitions
live under [`automations/`](automations/). The
[sessions skill](skills/sessions/SKILL.md) owns local Cursor and Codex transcript
inspection.

## Develop Harness

```bash
pnpm install --frozen-lockfile
make check
```

Use `make fix` for formatting or lint fixes, inspect the diff, then rerun
`make check`.

Contributor references:

- [Project intent](docs/project-intent.md)
- [Contributor index](docs/contributing/index.md)
- [Architecture](docs/contributing/architecture.md)
- [Script and command surface](docs/contributing/script-command-surface.md)
- [Testing](docs/contributing/testing.md)

## License

MIT
