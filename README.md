# Harness

Harness is a personal toolkit for agent-assisted software work. It provides:

- callable plan and implementation review workflows;
- independent Linear automation through a self-hosted Inngest worker;
- Cursor and Codex provider adapters;
- packaged agent skills and background-task definitions.

Harness runs against ordinary Git repositories. Target repositories keep their
own code, configuration, and local review artifacts. Linear remains the queue
for issue automation; Inngest owns delivery and retries.

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

## Run Linear Automation

`harness linear worker` connects one target repository to a self-hosted Inngest
server. A one-minute poll finds new Backlog revisions, reloads each issue from
Linear, and sends issues that need classification to the independent triage
operation. The triage result is written back through the standalone Linear
module.

The worker uses stable IDs and its triage profile from the target repository's
`linearAutomation` configuration. Secrets stay in the environment. See the
[Linear automation guide](docs/contributing/linear-automation.md) for the
Compose setup, health checks, and smoke tests.

## Configure Agents

`harness.json` stores target-repository defaults. `harness init` starts with the
base branch only; add provider choices as needed:

```json
{
  "base": "main",
  "defaultAgent": "codex"
}
```

Run `harness models` for the supported model catalog. The independent
`harness linear worker` reads its stable Linear IDs and triage profile from
`linearAutomation`.

Cursor SDK runs require `CURSOR_API_KEY`. Codex follows local `codex login`
authentication or `CODEX_API_KEY`. The Linear worker requires
`LINEAR_API_KEY`.

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
live under [`automations/`](automations/). Local agent-history analysis is
provided separately by [Sessions](https://github.com/ferueda/sessions).

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
