# Harness

A personal agent harness for coding workflows. It keeps reusable agent instructions, callable workflows, and runner code in one repo.

## Repo Shape

```text
harness.json  Repo-local harness defaults
skills/       Agent Skill instructions
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
harness run review
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

The default review workflow (the change review workflow skill) starts `review-implementation` and `code-quality-review` in parallel. Reviewers read the same base artifacts, then harness aggregates their results in workflow order and writes structured artifacts under the target repo's `.harness/runs/reviews/<run-id>/`.

For the broader review cycle, run `review-full`. It adds a read-only `simplify` pass and starts all three reviewers in parallel.

Generated review handoffs can be piped directly; harness writes the shared reviewer copy under the ignored run artifact directory:

```bash
printf '%s\n' "$HANDOFF" | harness run review --handoff-stdin
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
  "base": "main"
}
```

When `--workspace` is omitted, the CLI uses the nearest `harness.json` directory as the workspace. If none is found, it falls back to the current Git root. Workflow selection stays explicit: `harness run review` or `harness run review-full`.

`harness init` creates `harness.json` when missing, ensures `.gitignore` contains `.harness/`, and writes an ignored repo-local shim at `.harness/bin/harness`. The shim points back to the harness installation that ran `init`, so future agents can use a stable command without relying on `PATH`. The shim is a bash script; target machines need a POSIX shell with `bash` available.

For external target repos, pass the repo path explicitly:

```bash
harness init --workspace /path/to/repo
```

`harness init` also writes a target-repo fallback shim:

```bash
/path/to/repo/.harness/bin/harness run review
```

The init JSON returns `recommendedCommand: ".harness/bin/harness run review"`, which assumes the shell is already at the workspace root. Treat that as a pinned command for agents and automation when PATH is unreliable. For normal interactive use after installing harness, prefer `harness run review`.

Install optional local workflow helper skills explicitly:

```bash
harness skills install change-review-workflow --workspace /path/to/repo
```

Skills follow the [Agent Skills](https://agentskills.io/) format. Target repos usually keep local skills in `.agents/skills/`. Workflow skill lookup stops at the first match:

1. target repo `.agents/skills/{skill}/SKILL.md`
2. user `~/.agents/skills/{skill}/SKILL.md`
3. packaged harness `skills/{skill}/SKILL.md`

In this repo, top-level `skills/` contains packaged fallback skills. `.agents/skills/` contains repo-local development skills for working on harness itself and should not be copied into repos that install harness.

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
node bin/harness.ts run review
```

## Available Skills

### ask-questions

Clarify requirements before implementing. Ensures agents ask the minimum set of must-have questions to avoid wrong work. Explicitly invoked only.

**Use when:**
- Request is underspecified or ambiguous
- Multiple plausible interpretations exist
- Key constraints or acceptance criteria are unclear

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

### cursor-cli

Run Cursor Agent headlessly and delegate work to another Cursor agent over the CLI.

**Use when:**
- "Call Cursor..."
- "Ask Cursor..."
- "Invoke Cursor Agent..."
- Automating `agent -p` from scripts or agent-to-agent flows

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

Review recently modified code for behavior-preserving simplification opportunities. Read-only — never edits files.

**Use when:**
- Running the `review-full` workflow
- Looking for clarity and maintainability improvements after implementation and quality review
- Checking whether code can be simpler without changing functionality

**Output:** Findings with severity, location, recommendation, and rationale; verdict `pass` | `needs_changes` | `blocked`

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

### interrogator

Interview the user to extract knowledge from their head and synthesize it into a structured document. Asks one question at a time, depth-first, to produce specs, design docs, briefs, or decision records.

**Use when:**
- "Interview me about..."
- "Help me think through..."
- "I need to spec out..."
- User has a vague concept and needs help turning it into a concrete artifact

---

### react-to-review

Evaluate, analyze, and systematically react to an adversarial code review report. Decide on the action for each finding, justify the decision, and plan implementation.

**Use when:**
- An adversarial review report has been provided
- "React to this review..."
- Evaluating review findings (Implement, Adapt, Decline) and planning fixes

---

### change-review-workflow

Run and close the harness `review` or `review-full` workflow. Defaults to `review` unless `review-full` is explicit.

**Use when:**
- "Run a review..."
- "Run a full review..."
- "Run a review for these changes..."
- "Run the change review workflow..."
- "Run review-full..."
- "Run a harness review..."
- Running a multi-agent harness review
- Compiling reviewer results and deciding which findings to apply

**Coordinates:** review handoff input, CLI execution, reviewer artifact triage, accepted fixes, and re-review

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

### review-spec

Review a spec document against codebase reality. Identifies gaps, risks, and ensures sound implementations.

**Use when:**
- "Review this spec..."
- "Check this plan..."
- Validating a plan before implementation

**Evaluates:** Architecture, Feasibility, Reliability, Performance, Security, Edge Cases, Testing

---

### handoff-work

Hand off work in progress or finished to another agent for continuation or review. Self-contained summary with background context, what was worked on, how, why, files referenced, and what remains.

**Use when:**
- Ending a session (done or not) another agent will continue or review
- "Hand off this work..."
- "Prepare a handoff..."
- Before review on recent changes

**Output:** Handoff block with status, context, what/how/why, file references, next steps, verification, and open items

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
Review this implementation adversarially
```
```
Research how the payment system works
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
