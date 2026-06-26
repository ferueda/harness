# AGENTS.md

Work style: telegraph; noun-phrases ok; drop grammar; min tokens.

## Agent Protocol

- Bugs: add regression test when it fits.
- Aim to keep files under ~700 LOC; guideline only (not a hard guardrail). Split/refactor when it improves clarity or testability.
- Style: telegraph. Drop filler/grammar. Min tokens.
- Add brief code comments for tricky or non-obvious logic.
- Keep files concise; extract helpers instead of “V2” copies. Use existing patterns preferentially unless you have a better approach.
- When answering questions, respond with high-confidence answers only: verify in code; do not guess.

## Commit Guidelines

- Use `git diff` to preview changes before committing.
- Commit messages: short imperative clauses (e.g., “Improve usage probe”, “Fix icon dimming”).
- Review all staged and unstaged changes and make atomic commits per file. Keep commits scoped.
- Each commit should have a clear, descriptive message that explains what was changed.
- Group related changes; avoid bundling unrelated refactors.
- Conventional Commits (feat|fix|refactor|build|ci|chore|docs|style|perf|test).

## Critical Thinking

- Fix root cause (not band-aid).
- Unsure: read more code; if still stuck, ask w/ short options.
- Conflicts: call out; pick safer path.
- Unrecognized changes: assume other agent; keep going; focus your changes. If it causes issues, stop + ask user.

## Repository Overview

`harness` is Felipe's personal agent workflow repo. It contains reusable skills, callable workflows, runner code, automations, and plans.

Keep this repo standalone. Do not include references, examples, paths, fixtures, or docs tied to private downstream repositories; use generic target-repo examples instead.

Core layout:

```
harness.json  Repo-local harness defaults
skills/       Agent Skill instructions
.agents/     Repo-local development skills; not installed into target repos
providers/    Runtime adapters for external agent providers
workflows/    Callable workflows, starting with change-review
lib/          Runner, artifact, and workflow helpers
automations/  Background task definitions
dev/plans/    Plans and handoffs for this repo
```

## Planning workflow

Coordinator: **`planning-workflow`**. Plans live in **`dev/plans/`** with **`dev/plans/README.md`** (execution order, dependencies, status).

| Skill | Role | Artifact |
|-------|------|----------|
| `planning-workflow` | Route intake → shape/validate → handoff → implement → close | — |
| `shape-requirements` | Gate or interview → confirmed interpretation or brief | `dev/briefs/YYMMDD-short-slug.md` (interview) |
| `diagnose-issue` | Evidence-backed problem definition before planning | inline or `dev/issues/YYMMDD-short-slug.md` |
| `audit` | Codebase survey → prioritized handoff plans | `dev/plans/YYMMDD-short-slug.md` |
| `create-plan` | Scoped plan from todo/spec/issue | `dev/plans/YYMMDD-short-slug.md` |
| `review-spec` | Validate plan/spec against codebase; proportionality check; Simplicity as a finding category | advisory findings |
| `implement-plan` | Execute approved plan phase-by-phase | reads from `dev/plans/` |
| `handoff-work` | Transfer context between agents or sessions | inline handoff |

**Shape vs diagnose:** `shape-requirements` when the question is what the user wants. `diagnose-issue` when the question is what is true in the repo. Too vague to investigate → gate only, then diagnose.

**Typical chain** (skip steps per `planning-workflow` routing): `shape-requirements` → `diagnose-issue` → `review-spec` → `create-plan` → `handoff-work` → `implement-plan` → `change-review-workflow`.

**Routing reference:** `planning-workflow/references/routing.md` — intake, skip rules, scenario fixtures, pass criteria.

`audit` is read-only on source; only `dev/plans/` files may be created or updated. Reconcile with `dev/plans/README.md` before adding plans.

**Plan skill discovery (required for `audit` and `create-plan`):** Before writing a plan, check the host available-skills list (if injected), repo skill dirs (`skills/`, `.agents/skills/`, `.cursor/skills/`, `.claude/skills/`), and `AGENTS.md` / `README` for named tools. Read each candidate `SKILL.md`; embed only verified skills in the plan's **Skills for the executor** table, each tied to a specific step. Never invent skill names.

## Review workflow

Coordinator: **`change-review-workflow`**. Triage (Implement / Adapt / Decline) and fixes happen in the coordinator — no separate triage skill.

| Skill | Role | Posture |
|-------|------|---------|
| `change-review-workflow` | Run harness reviewers, triage findings, apply fixes, re-review | Coordinator |
| `review-spec` | Validate plan/spec before implementation | Advisory |
| `review-implementation` | Adversarial review of implementation vs plan/spec | Skeptical; read-only |
| `code-quality-review` | Clarity, conventions, maintainability | Read-only |
| `simplify-review` | Behavior-preserving simplification (`change-review` step `simplify`) | Read-only |

`review-implementation`, `code-quality-review`, and `simplify-review` are read-only. Use `review-implementation` for correctness; `code-quality-review` for conventions; `simplify-review` for simplification suggestions.

**Skill discovery (for `implement-plan`, `review-implementation`, `code-quality-review`, `simplify-review`):** Discover available skills in the host and target repo. Read relevant `SKILL.md` files for languages, frameworks, or patterns touched by the work. Use them as guidelines — no fixed checklist. For `implement-plan`, start with the plan's **Skills for the executor** section when present.

## Handoff workflow

| Skill | Role |
|-------|------|
| `handoff-work` | Transfer context to another agent for continuation or review |

Use `handoff-work` when ending a session (done or not) so the next agent can continue without replaying prior context. In the planning chain, hand off after `create-plan` or partial `implement-plan`, and before `change-review-workflow` when implementer ≠ reviewer.

Typical close: `planning-workflow` → `implement-plan` → `handoff-work` (if needed) → `change-review-workflow`.

## Session evidence

| Skill | Role |
|-------|------|
| `session-evidence` | Extract snippets, artifacts, and session ids via `sessions analyze` |

Facts first; label interpretation separately. Do not treat `patterns` as recommendations.

**Audits:** `skills/session-evidence/references/audit-examples.md` (extract commands, scorecards, weekly/monthly loop). Routing fixtures: coordinator skills (e.g. `planning-workflow/references/routing.md`).

## Learning

| Skill | Role | Artifact |
|-------|------|----------|
| `learning-coach` | Topic learning over repeated sessions; one question at a time | `MISSION.md`, `LEARNER.md`, `PLAN.md`, `LOG.md`, `RESOURCES.md` |

Standalone — not part of planning or review coordinators. One topic per workspace directory.

## Directory Structure

```
skills/
  {skill-name}/           # kebab-case directory name
    SKILL.md              # Required: skill instructions and usage
    agents/openai.yaml    # Recommended: UI metadata and default prompt
    references/           # Optional: templates, playbooks (progressive disclosure)
    scripts/              # Optional: helper scripts and utilities
    examples/             # Optional: reference implementations
    resources/            # Optional: templates, assets, or data files
dev/plans/                # In target repos: implementation plans + README index
automations/              # Continuous background execution automations
  {automation-name}.md    # Markdown file describing the automation
```

## Automations

Automations are independent, background tasks designed to enforce project standards and prevent regressions.

### Creating a New Automation

- **Location**: Place in the `automations/` folder.
- **Naming**: Use `kebab-case.md` (e.g., `find-bugs.md`).
- **Format**: Include the goal, strategy, rules, and output expectations.

## Creating a New Skill

### Skill Directory Naming

- **Skill directory**: `kebab-case` (e.g., `audit`, `create-plan`, `review-implementation`)
- **SKILL.md**: Always uppercase, always this exact filename
- **Scripts**: `kebab-case.sh` or `kebab-case.py` (e.g., `deploy.sh`, `validate.py`)

### SKILL.md Format

```markdown
---
name: {skill-name}
description: {One sentence describing when to use this skill. Include trigger phrases like "Create a plan", "Browse the web", etc.}
---

# {Skill Title}

{Brief description of what the skill does.}

## When to Use

{Describe the scenarios where this skill should be activated}

## How It Works

{Numbered list explaining the skill's workflow}

## Skills and Guidelines

{Optional. Advise discovering available skills in host + repo; read relevant SKILL.md files; no fixed checklist.}

## Usage

{Show how to invoke the skill or use its scripts}

**Examples:**
{Show 2-3 common usage patterns}

## Output

{Describe what the skill produces or what the agent should do after}
```

### agents/openai.yaml Format

Recommended for new skills. Keep this metadata aligned with `SKILL.md`.

```yaml
interface:
  display_name: "Create Plan"
  short_description: "Turn instructions into implementation plans"
  default_prompt: "Use $create-plan to turn these requirements into a scoped, code-backed implementation plan."
```

## Best Practices for Context Efficiency

Skills are loaded on-demand—only the skill name and description are loaded at startup. The full `SKILL.md` loads into context only when the agent decides the skill is relevant. To minimize context usage:

- **Keep SKILL.md under 500 lines** — put detailed reference material in separate files
- **Write specific descriptions** — helps the agent know exactly when to activate the skill
- **Use progressive disclosure** — reference supporting files that get read only when needed
- **Prefer scripts over inline instructions** — script execution doesn't consume context (only output does)
- **One skill, one purpose** — keep skills focused on a single capability
- **Self-contained examples** — include complete, runnable examples

## Naming Conventions

| Item | Convention | Example |
|------|------------|---------|
| Skill directory | `kebab-case` | `review-implementation` |
| Script files | `kebab-case.{ext}` | `validate.sh` |
| SKILL.md | Exact name, uppercase | `SKILL.md` |
| UI metadata | `agents/openai.yaml` | `agents/openai.yaml` |

## Contributing

When adding new skills:

1. Follow the naming conventions above
2. Include clear trigger phrases in descriptions
3. Add `agents/openai.yaml` unless there is a specific reason to omit UI metadata
4. Test with at least one AI agent before committing
5. Update this file if introducing new patterns or conventions
