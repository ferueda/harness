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

Route one local work item through factory triage:

```bash
harness factory status --workspace /path/to/repo
harness factory linear list --status intake --workspace /path/to/repo
harness factory linear fetch TEAM-123 --workspace /path/to/repo
harness factory linear create --workspace /path/to/repo --title "Example intake" --body "Details"
harness factory triage --workspace /path/to/repo --item-file .harness/inbox/factory/item.json
harness factory triage --workspace /path/to/repo --linear-issue TEAM-123
```

The item file is JSON with `id`, `source`, `title`, and `body`. `status` is
read-only. Station commands process one explicit item and do not move inbox
files.

Factory station artifacts are written under
`${XDG_DATA_HOME:-~/.local/share}/harness/store/projects/<repo-id>/runs/factory/<run-id>/`
by default. Factory lifecycle JSONL and rebuildable state live under that
project's `factory/` directory. This default is intentionally outside the
documented harness checkout at `~/.harness`. Triage routes are
`ready-to-implement`, `ready-to-plan`, `needs-info`, or `wait-to-implement`.
Planning and implementation actions are not shipped yet. A terminal triage may
therefore return a wait reaction with no executable downstream command. The CLI
prints an exact next command only when the durable terminal evidence contains
one; it never synthesizes or automatically executes a follow-up action.

Use low-level workflow primitives when you need direct workflow execution:

```bash
harness run factory-triage --item-file path/to/work-item.json --verbose
harness run plan-review --plan path/to/implementation-plan.md --verbose
```

Factory station agent and model selection comes from `harness.json` role config
under `factory.<station>.roles`. Linear list and fetch use `LINEAR_API_KEY` and
`factory.linear` config and are read-only. Linear create is a constrained write
that creates one configured-project intake issue and prints compact JSON; it
does not use `--apply` and does not write factory lifecycle or run artifacts.
Factory triage can use `--linear-issue`; `--apply` is explicit and projects the
triage start and terminal result to Linear. Optional `--dry-run` prepares
triage artifacts without a provider and does not initialize Factory state.
Harness adapters for GitHub, Jira, and Inngest remain future layers. Linking
factory PRs to Linear issues via branch/title naming is current operator
practice (see Linear PR linking in
[docs/contributing/factory.md](docs/contributing/factory.md)). For the full
operator model, read that same doc.

For review handoff, step-selection, and failure-triage workflow guidance,
read [skills/change-review-workflow/SKILL.md](skills/change-review-workflow/SKILL.md).
Configure the durable store with `--factory-store-root`,
`--factory-store-project-id`, `HARNESS_FACTORY_STORE_ROOT`,
`HARNESS_FACTORY_STORE_PROJECT_ID`, or `factory.store.root` /
`factory.store.projectId` in `harness.json`. The workspace keeps its local
shim and `.harness/inbox/factory`; it remains the sandbox and Git
materialization point. Standalone reviews remain workspace-local under
`.harness/runs/reviews` unless their own `--runs-dir` is used.

For review artifact cleanup, use `harness runs prune --help`. The prune default
targets `.harness/runs/reviews`; factory run cleanup currently needs
`--runs-dir <store>/projects/<repo-id>/runs/factory` or manual deletion. For command
ownership and mutability, read
[docs/contributing/script-command-surface.md](docs/contributing/script-command-surface.md).

## Configure Providers

`harness.json` lives at the target repo root and stores repo-local defaults:

```json
{
  "base": "main",
  "defaultAgent": "cursor",
  "agents": {
    "cursor": {
      "model": "grok-4.5"
    },
    "codex": {
      "model": "gpt-5.6-sol",
      "sandboxMode": "read-only",
      "approvalPolicy": "never",
      "modelReasoningEffort": "high"
    }
  },
  "factory": {
    "triage": {
      "roles": {
        "triager": {
          "agent": "cursor",
          "model": "grok-4.5"
        }
      }
    },
    "planning": {
      "maxReviewIterations": 3,
      "roles": {
        "planner": { "agent": "cursor", "model": "grok-4.5" },
        "reviewer": {
          "agent": "codex",
          "model": "gpt-5.6-sol",
          "modelReasoningEffort": "high"
        }
      }
    },
    "implementation": {
      "roles": {
        "implementer": {
          "agent": "cursor",
          "model": "grok-4.5"
        }
      }
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

For Codex request-size inspection, run `pnpm codex:proxy`; details live in
[docs/contributing/script-command-surface.md](docs/contributing/script-command-surface.md).

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

Manual-only skills include `architect` for repo-grounded solution design and
`audit` for codebase surveys. `architect` returns an inline architecture memo
and does not write plan files or other artifacts.

The `sessions` skill owns local transcript extraction. See
[skills/sessions/SKILL.md](skills/sessions/SKILL.md) and
`skills/sessions/scripts/install.sh`.

Background task definitions live under `automations/`, including
`automations/find-bugs.md` and `automations/test-coverage.md`.

## License

MIT
