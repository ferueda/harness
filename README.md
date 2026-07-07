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

Route one local work item through factory triage or planning:

```bash
harness factory status --workspace /path/to/repo
harness factory linear fetch TEAM-123 --workspace /path/to/repo
harness factory triage --workspace /path/to/repo --item-file .harness/inbox/factory/item.json --dry-run
harness factory triage --workspace /path/to/repo --linear-issue TEAM-123 --dry-run
harness factory planning run --workspace /path/to/repo --item-file .harness/inbox/factory/item.json --dry-run
harness factory planning publish --run-dir .harness/runs/factory/<run-id> --pr-url https://github.com/owner/repo/pull/123
harness factory planning mark-plan-merged --run-dir .harness/runs/factory/<run-id> --commit abc1234
```

The item file is JSON with `id`, `source`, `title`, and `body`. `status` is
read-only. Station commands process one explicit item and do not move inbox
files.

Factory artifacts are written under
`<workspace>/.harness/runs/factory/<run-id>/`. Triage routes are
`ready-to-implement`, `ready-to-plan`, `needs-info`, or `wait-to-implement`.
Planning writes reviewed plans into the target repo only after approval. For
tracker-backed work, publish the plan file through a plan PR, then register the
PR URL and merge commit with the planning publication commands before treating
the tracker item as ready to implement.

Use low-level workflow primitives when you need direct workflow execution:

```bash
harness run factory-triage --item-file path/to/work-item.json --verbose
harness run plan-review --plan path/to/implementation-plan.md --verbose
```

Factory station agent and model selection comes from `harness.json` role config
under `factory.<station>.roles`. Linear fetch uses `LINEAR_API_KEY` and
`factory.linear` config to produce the same work-item contract. Factory triage
and planning can use `--linear-issue` as a read-only Linear input source.
Triage `--apply` moves Linear status and writes marker comments; planning apply
remains future work. GitHub, Jira, and Inngest remain future layers. For the
full operator model, read
[docs/contributing/factory.md](docs/contributing/factory.md).

For review handoff, step-selection, and failure-triage workflow guidance,
read [skills/change-review-workflow/SKILL.md](skills/change-review-workflow/SKILL.md).
For review artifact cleanup, use `harness runs prune --help`. The prune default
targets `.harness/runs/reviews`; factory run cleanup currently needs
`--runs-dir <workspace>/.harness/runs/factory` or manual deletion. For command
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
      "model": "composer-2.5"
    },
    "codex": {
      "model": "gpt-5.5",
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
          "model": "composer-2.5"
        }
      }
    },
    "planning": {
      "maxReviewIterations": 3,
      "roles": {
        "planner": { "agent": "cursor", "model": "composer-2.5" },
        "reviewer": {
          "agent": "codex",
          "model": "gpt-5.5",
          "modelReasoningEffort": "high"
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

The `sessions` skill owns local transcript extraction. See
[skills/sessions/SKILL.md](skills/sessions/SKILL.md) and
`skills/sessions/scripts/install.sh`.

Background task definitions live under `automations/`, including
`automations/find-bugs.md` and `automations/test-coverage.md`.

## License

MIT
