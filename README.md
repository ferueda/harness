# Harness

Personal agent workflow harness for coding workflows. It keeps reusable agent
skills, callable review/planning workflows, provider adapters, runner code, and
artifact conventions in one repo.

## Install

Prerequisites: Node 24 or newer, `pnpm` on `PATH`, and a POSIX shell with
`bash`.

```bash
git clone git@github.com:ferueda/harness.git ~/.harness
~/.harness/install
```

The checkout can live anywhere:

```bash
git clone git@github.com:ferueda/harness.git /path/to/harness
/path/to/harness/install
```

The installer runs `pnpm install --frozen-lockfile`, writes the user-level
`harness` command to `~/.local/bin` by default, and verifies `harness --help`.
If `~/.local/bin` is not on `PATH`, the installer prints the `export PATH=...`
line to add.

Next, initialize a target repo and run reviews.

To update:

```bash
cd /path/to/harness
git pull
./install
```

## Run Reviews

Initialize each target repo once:

```bash
cd /path/to/repo
harness init
```

`harness init` creates `harness.json` when missing, ensures `.harness/` is
ignored, and writes an ignored target-repo shim at `.harness/bin/harness`. When
`PATH` is not reliable, use the pinned shim:

```bash
.harness/bin/harness run change-review
```

Run the default implementation/quality/simplify review:

```bash
harness run change-review --verbose
```

Generated handoffs can be piped directly:

```bash
printf '%s\n' "$HANDOFF" | harness run change-review --handoff-stdin --verbose
```

Review an implementation plan before execution:

```bash
harness run plan-review --plan path/to/implementation-plan.md --verbose
```

Review artifacts are written under
`<workspace>/.harness/runs/reviews/<run-id>/`. Use `--verbose` for live
progress; the durable event timeline is written to `events.jsonl`. Use generated
help for full flag details:

```bash
harness run change-review --help
harness run plan-review --help
```

## Run Factory Intake

Route one local work item into the next factory station:

```bash
harness run factory-triage --item-file path/to/work-item.json --verbose
```

The item file is JSON with `id`, `source`, `title`, and `body`. PR 1 supports
file-backed intake only; GitHub, Linear, Jira, and Inngest adapters are future
layers over the same work-item contract.

Factory artifacts are written under
`<workspace>/.harness/runs/factory/<run-id>/`, including
`factory-triage.json`, `factory-route.json`, `factory-route.md`, `summary.md`,
and `meta.json`. The route is one of `ready-to-implement`, `ready-to-plan`,
`needs-info`, or `wait-to-implement`.

For review handoff, step-selection, and failure-triage workflow guidance,
read [skills/change-review-workflow/SKILL.md](skills/change-review-workflow/SKILL.md).
For artifact cleanup, use `harness runs prune --help`. For command ownership
and mutability, read
[docs/contributing/script-command-surface.md](docs/contributing/script-command-surface.md).

## Configure Providers

`harness.json` lives at the target repo root and stores repo-local defaults:

```json
{
  "base": "main",
  "defaultAgent": "cursor",
  "agents": {
    "cursor": {
      "model": "composer-2.5"
    },
    "codex": {
      "model": "gpt-5.5",
      "sandboxMode": "read-only",
      "approvalPolicy": "never",
      "modelReasoningEffort": "high"
    }
  }
}
```

Cursor SDK reviews require `CURSOR_API_KEY`. Codex SDK reviews follow local
Codex CLI auth (`codex login`) or `CODEX_API_KEY`.

List supported harness model modes with:

```bash
harness models
```

Setup and generated-artifact details live in
[docs/contributing/setup-manifest.md](docs/contributing/setup-manifest.md).

## Develop Harness

Harness source is TypeScript under `bin/`, `lib/`, `providers/`, and
`workflows/`. Repo-local development skills live under `.agents/skills/`.

Run the default gate:

```bash
pnpm check
```

For verbose gate output:

```bash
pnpm check:v
```

For fast CLI iteration from this checkout:

```bash
node bin/harness.ts init
node bin/harness.ts run change-review --verbose
```

Contributor docs:

- [docs/project-intent.md](docs/project-intent.md)
- [docs/contributing/index.md](docs/contributing/index.md)

## Packaged Skills

Packaged skills live under `skills/`; each `skills/*/SKILL.md` is the source of
truth for that skill's behavior. Install all packaged skills into a supported
agent host with:

```bash
npx skills add ferueda/harness
```

Copy selected workflow helper skills into a target repo with:

```bash
harness skills install change-review-workflow --workspace /path/to/repo
harness skills install planning-workflow --workspace /path/to/repo
```

Skill lookup order is target repo `.agents/skills/`, then user
`~/.agents/skills/`, then packaged harness `skills/`.

The `sessions` skill owns local transcript extraction. See
[skills/sessions/SKILL.md](skills/sessions/SKILL.md) and
`skills/sessions/scripts/install.sh`.

Background task definitions live under `automations/`, including
`automations/find-bugs.md` and `automations/test-coverage.md`.

## License

MIT
