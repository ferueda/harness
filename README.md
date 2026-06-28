# Harness

A personal agent harness for coding workflows. It keeps reusable agent instructions, callable workflows, and runner code in one repo.

## Repo Shape

```text
harness.json  Repo-local harness defaults
skills/       Agent Skill instructions (+ skill-owned CLIs: `sessions`, `cursor-cli`)
.agents/     Repo-local development skills; not installed into target repos
providers/    Runtime adapters for external agent providers
workflows/    Callable review workflows
lib/          Runner, artifact, and workflow helpers
automations/  Background task definitions
dev/plans/    Plans and handoffs for this repo
```

## Install Harness

Prerequisites: Node 24 or newer, `pnpm` on `PATH`, and a POSIX shell with `bash`.
The installer runs `pnpm install --frozen-lockfile` in the checkout before it
writes the user-level `harness` command.

```bash
git clone git@github.com:ferueda/harness.git ~/.harness
~/.harness/install
harness init
harness run change-review
```

The checkout can live anywhere. If you prefer a development directory, install from that path instead:

```bash
git clone git@github.com:ferueda/harness.git ~/dev/harness
~/dev/harness/install
```

The installer writes a user-level `harness` command into `~/.local/bin` by default. If the checkout moves, rerun `install` from the new location.
If `~/.local/bin` is not on `PATH`, the installer prints the exact `export PATH=...` line to add before running `harness init`.

To update:

```bash
cd /path/to/harness-checkout
git pull
./install
```

## First Workflow

The default change-review workflow starts `implementation`, `quality`, and `simplify` in parallel. Reviewers read the same base artifacts, then harness aggregates their results in workflow order and writes structured artifacts under the target repo's `.harness/runs/reviews/<run-id>/`.

Callers can choose a subset explicitly for follow-up cycles:

```bash
harness run change-review --steps implementation
harness run change-review --steps implementation,quality
```

Migration from old command names: `harness run review` is now
`harness run change-review --steps implementation,quality`; `harness run
review-full` is now `harness run change-review`.

Generated review handoffs can be piped directly; harness writes the shared reviewer copy under the ignored run artifact directory:

```bash
printf '%s\n' "$HANDOFF" | harness run change-review --handoff-stdin
```

If a reviewer provider fails, the workflow still prints JSON to stdout and exits `1`. Failed runs use `status: "failed"`, include `failedReviews`, preserve any successful peer review summaries, and write `summary.md` plus `meta.json`.

Prune old local run artifacts explicitly when they are no longer useful:

```bash
harness runs prune --older-than 30d --dry-run
harness runs prune --older-than 30d
```

The command targets `<workspace>/.harness/runs/reviews` by default and prints JSON with matched/deleted counts.

`harness.json` lives at the target repo root and keeps repo-local defaults:

```json
{
  "base": "main",
  "defaultAgent": "cursor"
}
```

When `--workspace` is omitted, the CLI uses the nearest `harness.json` directory as the workspace. If none is found, it falls back to the current Git root. Workflow selection stays explicit: `harness run change-review`.

Reviewer agents are selected with `--agent cursor|codex` or `defaultAgent` in `harness.json`:

```json
{
  "base": "main",
  "defaultAgent": "codex",
  "agents": {
    "cursor": {
      "model": "composer-2.5"
    },
    "codex": {
      "model": "gpt-5.5",
      "executable": "/opt/codex",
      "sandboxMode": "read-only",
      "approvalPolicy": "never",
      "modelReasoningEffort": "high"
    }
  }
}
```

`cursor` remains the default provider. Config is provider-scoped under `agents`, so Cursor and Codex settings do not mix. Default review models are `composer-2.5` for Cursor and `gpt-5.5` for Codex. Reviews always use the Cursor SDK or Codex SDK provider. Codex defaults to `modelReasoningEffort: "high"`, `sandboxMode: "read-only"`, and `approvalPolicy: "never"`. Other Codex modes are exposed for future workflows and explicit overrides.

For Codex, harness uses the TypeScript SDK without passing a custom environment, so auth follows the local Codex CLI: run `codex login` once or provide `CODEX_API_KEY` in the environment. Use `harness models` for the harness model catalog.

```bash
harness run change-review --agent codex --model gpt-5.5 --reasoning-effort high --sandbox read-only --approval-policy never --verbose
```

Cursor reviews use the SDK provider:

```json
{
  "agents": {
    "cursor": {
      "model": "composer-2.5"
    }
  }
}
```

Cursor SDK review model selection is intentionally constrained to three modes.

| `--model` | SDK selection |
|-----------|---------------|
| `composer-2.5` | Composer 2.5 with `fast=false` |
| `claude-opus-4-8` | Opus 4.8 with `thinking=true`, `effort=high`, `fast=false` |
| `gpt-5.5` | GPT-5.5 with `context=272k`, `reasoning=high`, `fast=false` |

```bash
CURSOR_API_KEY=... harness run change-review --agent cursor --verbose
```

The SDK provider uses Cursor local agent mode, requires `CURSOR_API_KEY`, runs change-review steps in parallel, and rejects review runs that modify tracked workspace status outside `.harness/`. The git status comparison is the review safety backstop; it detects final tracked-status changes but cannot prove that a file was not edited and reverted during the run. Cursor SDK local sandboxing is environment-dependent and is not required by harness. It is not equivalent to the CLI `ask` path and cannot rely on `agent login` auth.

For ad-hoc Cursor delegation outside harness reviews, use the **`cursor-cli`** skill (`skills/cursor-cli/`) and its `cursor-cli` launcher — not `harness run`.

For live caller feedback, run change-review with `--verbose`. Stdout remains the final metadata JSON. Stderr emits workflow event JSONL while reviewers run, and the durable timeline is always written to `<runDir>/events.jsonl` for non-dry-run reviews.

`harness init` creates `harness.json` when missing, ensures `.gitignore` contains `.harness/`, and writes an ignored repo-local shim at `.harness/bin/harness`. The shim points back to the harness installation that ran `init`, so future agents can use a stable command without relying on `PATH`. The shim is a bash script; target machines need a POSIX shell with `bash` available.

For external target repos, pass the repo path explicitly:

```bash
harness init --workspace /path/to/repo
```

`harness init` also writes a target-repo fallback shim:

```bash
/path/to/repo/.harness/bin/harness run change-review
```

The init JSON returns `recommendedCommand: ".harness/bin/harness run change-review"`, which assumes the shell is already at the workspace root. Treat that as a pinned command for agents and automation when PATH is unreliable. For normal interactive use after installing harness, prefer `harness run change-review`.

Install optional local workflow helper skills explicitly:

```bash
harness skills install change-review-workflow --workspace /path/to/repo
harness skills install planning-workflow --workspace /path/to/repo
```

Skills follow the [Agent Skills](https://agentskills.io/) format. Target repos usually keep local skills in `.agents/skills/`. Workflow skill lookup stops at the first match:

1. target repo `.agents/skills/{skill}/SKILL.md`
2. user `~/.agents/skills/{skill}/SKILL.md`
3. packaged harness `skills/{skill}/SKILL.md`

In this repo, top-level `skills/` contains packaged fallback skills. `.agents/skills/` dogfoods selected packaged skills (e.g. `change-review-workflow`) for harness development and must stay in sync; other entries are repo-local only (e.g. `node`, `vitest`).

## Development

Harness source is TypeScript under `bin/`, `lib/`, `providers/`, and `workflows/`.
The source-checkout install path above runs `bin/harness.ts` directly with Node
24 type stripping. Runtime packaging still builds JavaScript into `dist/` for
CI smoke tests and any future npm-style package path.

Use the quiet gate while developing:

```bash
pnpm check
```

For full command output:

```bash
pnpm check:v
```

The gate runs Oxfmt, Oxlint, strict TypeScript checks, Vitest, and the build. CI runs the same `pnpm check:ci` gate.

For fast CLI iteration from source:

```bash
node bin/harness.ts init
node bin/harness.ts run change-review --verbose
```

## Session Extraction

Install the skill-owned `sessions` CLI from the harness checkout:

```bash
skills/sessions/scripts/install.sh
sessions cursor reindex
sessions analyze --provider cursor --include-turns --extract-only --days 30 --workspace /path/to/repo
```

Without install: `node skills/sessions/scripts/sessions.ts <command>`. Index cache
lives at `~/.sessions/index` (auto-migrated from `~/.harness/session-index`).

Codex uses a separate provider and cache:

```bash
sessions codex reindex
sessions codex stats --format json
sessions analyze --provider codex --include-turns --extract-only --turn-query "verify"
sessions codex show <sessionId>
```

Codex indexing reads `~/.codex/state_5.sqlite` as the source of truth, with
`~/.codex/sqlite/state_5.sqlite` only as a missing-root fallback. Codex
metadata/evidence may clean a leading injected first-turn preamble; `codex
show` and `codex export` preserve raw rollout transcript text.

For targeted investigation, prefer exact transcript turn searches:

```bash
sessions analyze --provider cursor --include-turns --extract-only --turn-query "review"
sessions analyze --provider cursor --include-turns --extract-only --turn-query "verify" --turn-query "validate" --turn-query "check"
```

`--turn-query` searches user-turn transcript text and can be repeated for OR
matching. `--query` filters indexed session metadata only: title, id,
workspace, or first user query. Use `--evidence-limit` to cap table match rows;
JSON output keeps full `matches` and artifact arrays for agent handoff.

Open the source session when snippets are not enough:

```bash
sessions cursor show <sessionId>
```

For agent-oriented extraction and workflow audits, use the **`sessions`** skill. Turn-query starters: `skills/sessions/references/turn-queries.md`. Audits: `skills/sessions/references/audit-examples.md`.

## Available Skills

Packaged skills in `skills/` (15). Coordinators route leaf skills; invoke a coordinator when unsure where to start.

### planning-workflow

Coordinate planning from intent to implementation. Routes through shape, diagnose, review-spec, create-plan, implement-plan, and handoff.

**Use when:**
- Starting feature work or a non-trivial fix
- Running the full plan-build cycle
- Unsure which planning skill to invoke first

**Coordinates:** `shape-requirements`, `diagnose-issue`, `review-spec`, `create-plan`, `implement-plan`, `handoff-work`, then `change-review-workflow`

**References:** `references/routing.md` (rules, fixtures, pass criteria)

---

### shape-requirements

Shape requirements before planning or implementing. **Gate** when a build/fix/plan task is underspecified. **Interview** when the user wants a brief from a vague idea.

**Use when:**
- Build/fix/plan task lacks scope, done-ness, or constraints
- User wants to think through an idea and produce a written brief

**Output:** Confirmed interpretation (gate) or requirements brief in `dev/briefs/` (interview). Chains to `diagnose-issue`, `create-plan`, `review-spec`, or direct implementation.

---

### diagnose-issue

Research and define codebase issues before implementation planning. Validates whether a reported problem exists, diagnoses mechanism, compares solution directions — read-only unless the user asks for edits.

**Use when:**
- Bug report, ticket, symptom, or design concern about current code
- User needs evidence-backed problem definition before a plan
- Proposed solution should be validated against the checkout

**Do not use when:** user wants a step-by-step plan, direct implementation, or diff review.

**Output:** Problem definition (status, evidence, mechanism, solution directions). Chains to `shape-requirements` **gate**, `create-plan`, or `review-spec`.

---

### audit

Survey a codebase as a senior advisor and produce prioritized, self-contained implementation plans for other agents to execute. Strictly read-only on source code — never implements or refactors itself.

**Use when:**
- "Audit this codebase..."
- Finding improvement opportunities (bugs, security, performance, tests, tech debt, migrations, DX)
- Suggesting features, roadmap direction, or handoff plans for another agent

**Output:** Plans in `dev/plans/` (`YYMMDD-short-slug.md`) plus `dev/plans/README.md` (execution order, dependencies, status). Each plan includes a **Skills for the executor** section — verified skills from the host and repo, mapped to specific steps. Composes with `create-plan` and `implement-plan` in the same folder.

**Variants:** `quick` / `deep`, focused audits (`security`, `perf`, `tests`), `branch`, `next`, `plan <description>`, `execute <plan>`, `reconcile`, `--issues`

---

### create-plan

Create a scoped, code-backed implementation plan from a todo, spec, issue, review notes, or raw user instructions.

**Output:** `dev/plans/YYMMDD-short-slug.md` with a **Skills for the executor** section (host + repo skills discovered and tied to plan steps)

**Use when:**
- "Create a plan..."
- "Turn this todo/spec into a plan..."
- Requirements need research, phases, tests, risks, and acceptance criteria before implementation

---

### review-spec

Review a spec document against codebase reality. Identifies gaps, risks, overengineering, and ensures sound implementations.

**Use when:**
- "Review this spec..."
- "Check this plan..."
- Validating a plan before implementation

**Evaluates:** Architecture, Feasibility, Simplicity, Reliability, Performance, Security, Edge Cases, Testing — includes proportionality check; Simplicity issues are standard findings (no separate summary block)

---

### implement-plan

Execute an approved plan or spec document phase-by-phase, writing robust idiomatic code that follows codebase patterns. Discovers relevant agent skills for implementation guidelines.

**Use when:**
- A plan/spec document exists and is approved
- Ready to start implementation
- "Implement this plan..."
- "Execute the spec..."
- Working through phases from `dev/plans/`

**Output:** Phase summaries, files touched, verification results, and updated plan checkboxes

---

### handoff-work

Hand off work in progress or finished to another agent for continuation or review. Self-contained summary with background context, what was worked on, how, why, files referenced, and what remains.

**Use when:**
- Ending a session (done or not) another agent will continue or review
- "Hand off this work..."
- "Prepare a handoff..."
- After `create-plan` or partial `implement-plan`; before `change-review-workflow` when implementer ≠ reviewer

**Output:** Handoff block with status, context, what/how/why, file references, next steps, verification, and open items

---

### change-review-workflow

Run and close the harness `change-review` workflow. Defaults to all steps unless `--steps` is explicit. Triage (Implement / Adapt / Decline) and fixes happen in the coordinator — no separate triage skill.

**Use when:**
- "Run a review..."
- "Run a full review..."
- "Run a review for these changes..."
- "Run the change review workflow..."
- "Run change-review..."
- "Run a harness review..."
- Running a multi-agent harness review
- Compiling reviewer results and deciding which findings to apply

**Coordinates:** review handoff input, CLI execution, optional selected steps, finding triage, accepted fixes, and re-review

---

### review-implementation

Review a given implementation critically and adversarially against its plan or spec. Looks for antipatterns, bugs, plan drift, unnecessary complexity, and missing tests. Default posture: assume every change adds unnecessary complexity until proven otherwise. Read-only — never edits files.

**Use when:**
- "Review this implementation..."
- "Review these changes..."
- "Review this branch..."
- "Adversarial review..."
- "Challenge these changes..."
- Validating an executor's diff against a plan before merge

**Evaluates:** Correctness, plan adherence, complexity, architecture, reliability, policy, missing tests

**Output:** Findings with severity, location, recommendation, and rationale; verdict `pass` | `needs_changes` | `blocked`

---

### code-quality-review

Review recently modified code for clarity, consistency, and maintainability while preserving exact functionality. Audits adherence to project conventions and industry best practices. Read-only — never edits files.

**Use when:**
- "Code quality review..."
- "Readability audit..."
- "Maintainability review..."
- Behavior-preserving refinement suggestions on a diff or implementation

**Evaluates:** Conventions, clarity, complexity, policy compliance, architecture — without changing what the code does

**Output:** Findings with severity, location, recommendation, and rationale; verdict `pass` | `needs_changes` | `blocked`

---

### simplify-review

Read-only simplification reviewer for `harness run change-review` (CLI step `simplify`).

**Use when:**
- Running the `change-review` workflow
- Looking for clarity and maintainability improvements after implementation and quality review
- Checking whether code can be simpler without changing functionality

**Output:** Findings with severity, location, recommendation, and rationale; verdict `pass` | `needs_changes` | `blocked`

---

### sessions

Extract snippets, artifacts, session ids, and turn indexes from local Cursor or
Codex session history. Skill-owned CLI at `skills/sessions/scripts/sessions.ts`.
Uses `sessions analyze --provider cursor|codex --include-turns --extract-only`
and repeatable `--turn-query` for exact transcript searches.

**Use when:**
- Looking up prior session context
- Exploring transcripts by intent (see `references/turn-queries.md`)
- Collecting evidence for another agent without generating recommendations
- Auditing which skills and workflows you actually invoke across sessions
- Weekly/monthly workflow audits

**Install:** `skills/sessions/scripts/install.sh` from harness checkout.

**Audits:** `skills/sessions/references/audit-examples.md` (workflow/skill usage). **Exploration:** `skills/sessions/references/turn-queries.md` (starter `--turn-query` terms).

**Output:** Matching snippets, `matchedQueries`, artifacts, session ids, and
turn indexes. Use `sessions cursor show <sessionId>` or
`sessions codex show <sessionId>` for full context. Codex indexing reads
`~/.codex/state_5.sqlite` as the source of truth, with
`~/.codex/sqlite/state_5.sqlite` only as a missing-root fallback. Codex
metadata uses the DB first user message when available and strips a leading
injected preamble; transcript evidence may apply the same first-turn
cleanup, while `show` and `export` preserve the raw rollout transcript.

---

### cursor-cli

Run Cursor Agent headlessly for ad-hoc delegation outside harness reviews. Install via `skills/cursor-cli/scripts/install.sh` or run `node skills/cursor-cli/scripts/cursor-cli.ts` from this repo.

**Use when:**
- "Call Cursor..."
- "Ask Cursor..."
- "Invoke Cursor Agent..."
- Automating `agent -p` from scripts or agent-to-agent flows

---

### learning-coach

Guide a lightweight topic learning workspace over repeated sessions. Markdown files only — one question at a time, active recall over lectures.

**Use when:**
- Learning a new topic across multiple sessions
- "Help me learn…", "Coach me on…", "Teach me…"
- Building a durable learning trail in the workspace

**Workspace files:** `MISSION.md`, `LEARNER.md`, `PLAN.md`, `LOG.md`, `RESOURCES.md` (one topic per directory)

**Output:** Updated workspace state and exactly one focused question per turn

---

## Automations

In addition to skills, this repository includes automations designed for continuous background execution to ensure codebase quality and reliability:

### find-bugs

A deep bug-finding automation focused on high-severity issues. It inspects recent commits to identify critical correctness bugs (data loss, crashes, security holes) that escaped review.

**Use when:**
- Running continuous background checks on newly merged code
- Looking for high-impact issues rather than stylistic nits

---

### test-coverage

A test coverage automation focused on preventing regressions. It inspects recently merged code and adds missing tests where coverage is weak and business risk is meaningful.

**Use when:**
- Automatically patching coverage gaps on new code paths
- Enforcing test requirements on critical core flows

## Agent Skill Installation

This section is only for installing the packaged skills into an agent host. It is not the harness CLI install path above.

Install skills using the [skills CLI](https://skills.sh):

```bash
npx skills add ferueda/harness
```

The skills CLI works with: Amp, Antigravity, Claude Code, Clawdbot, Codex, Cursor, Droid, Gemini, Gemini CLI, GitHub Copilot, Goose, Kilo, Kiro CLI, OpenCode, Roo, Trae, and Windsurf.

## Skill Usage

Skills are automatically available once installed. The agent will use them when relevant tasks are detected or when explicitly invoked.

**Examples:**
```
Use planning-workflow to add retry logic to the API client
```
```
Diagnose JIRA-442: login 500 when email is empty
```
```
Review this implementation adversarially
```
```
Audit this codebase for security issues
```
```
Create a plan for this feature request
```
```
Interview me about this new feature
```
```
Help me learn Rust ownership in this folder
```

## Skill Structure

Each skill contains:

- `SKILL.md` - Instructions for the agent (required)
- `agents/openai.yaml` - UI metadata such as display name, short description, and default prompt (recommended)
- `references/` - Templates, playbooks, and progressive-disclosure docs (optional)
- `scripts/` - Helper scripts (optional)
- `examples/` - Reference implementations (optional)
- `resources/` - Templates and assets (optional)

## License

MIT
