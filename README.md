# Harness

Harness is a personal toolkit for agent-assisted software work. It provides:

- callable plan and implementation review workflows;
- Cursor and Codex provider adapters;
- packaged agent skills and background-task definitions;
- local, inspectable review artifacts.

Harness runs against ordinary Git repositories. Target repositories keep their
own code, configuration, installed skills, and local review artifacts.

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

## Configure Agents

`harness.json` stores target-repository defaults. `harness init` starts with the
base branch only; add provider choices as needed:

```json
{
  "base": "main",
  "defaultAgent": "codex"
}
```

Run `harness models` for the supported model catalog. `defaultAgent` selects
Cursor or Codex; the `agents` map stores provider-specific model and Codex
execution defaults.

Cursor SDK runs require `CURSOR_API_KEY`. Codex follows local `codex login`
authentication or `CODEX_API_KEY`.

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

Install only the roles the target needs; use the [skill catalogue](skills/README.md)
to choose by deliverable. This includes a generic read-only `triage` skill for
classifying work before execution. The Harness installer copies exactly one
named package and its local references, not its sibling skills. Hosts own
discovery; use their verified paths rather than assuming a fallback order.
Updating Harness does not update or remove existing target copies.

Background task definitions live under [`automations/`](automations/). Local
agent-history analysis is provided separately by
[Sessions](https://github.com/ferueda/sessions).

## Engineering Principles

Reusable guidance for daily engineering work lives under
[`docs/principles/`](docs/principles/). These documents are references rather
than installable skills:

- [Make interfaces feel better](docs/principles/make-interfaces-feel-better.md)
- [Emil Kowalski's design engineering principles](docs/principles/emil-design-eng.md)

## Develop Harness

```bash
pnpm install --frozen-lockfile
make check
```

Use `make fix` for formatting or lint fixes, inspect the diff, then rerun
`make check`.

Contributor references:

- [Project intent](docs/project-intent.md)
- [Engineering principles](docs/principles/README.md)
- [Contributor index](docs/contributing/index.md)
- [Architecture](docs/contributing/architecture.md)
- [Script and command surface](docs/contributing/script-command-surface.md)
- [Testing](docs/contributing/testing.md)

## License

MIT
