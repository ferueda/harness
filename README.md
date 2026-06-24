# Harness

A personal agent harness for coding workflows. It keeps reusable agent instructions, callable workflows, and runner code in one repo.

## Repo Shape

```text
harness.json  Repo-local harness defaults
skills/       Agent Skill instructions
.agents/     Repo-local development skills; not installed into target repos
providers/    Runtime adapters for external agent providers
workflows/    Callable workflows, starting with dual-review
lib/          Runner, artifact, and workflow helpers
automations/  Background task definitions
dev/plans/    Plans and handoffs for this repo
```

## First Workflow

```bash
node bin/harness.mjs init
node bin/harness.mjs run dual-review
```

The first workflow calls `review-implementation`, then `code-quality-review`, then writes structured artifacts under the target repo's `.harness/runs/reviews/<run-id>/`.

`harness.json` lives at the target repo root and keeps repo-local defaults:

```json
{
  "base": "main"
}
```

When `--workspace` is omitted, the CLI uses the nearest `harness.json` directory as the workspace. If none is found, it falls back to the current Git root. Workflow selection stays explicit: `harness run dual-review`.

`harness init` creates `harness.json` when missing and ensures `.gitignore` contains `.harness/`.

For external target repos, pass the repo path explicitly:

```bash
node bin/harness.mjs init --workspace /path/to/repo
```

Skills follow the [Agent Skills](https://agentskills.io/) format. Top-level `skills/` contains harness skills. `.agents/skills/` contains repo-local development skills for working on this project and should not be copied into repos that install the harness.

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

## Installation

Install using the [skills CLI](https://skills.sh):

```bash
npx skills add ferueda/harness
```

The skills CLI works with: Amp, Antigravity, Claude Code, Clawdbot, Codex, Cursor, Droid, Gemini, Gemini CLI, GitHub Copilot, Goose, Kilo, Kiro CLI, OpenCode, Roo, Trae, and Windsurf.

## Usage

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
