# AGENTS.md

Work style: telegraph; noun-phrases ok; drop grammar; min tokens.

## Agent Protocol

- Bugs: add regression test when it fits.
- Factory lifecycle, continuation, publication, provider-protocol, or system-smoke changes: run `make smoke-factory` in addition to the normal handoff gate. Live protocol checks require explicit authority. Details: `docs/contributing/testing.md`.
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

## Repository

Felipe's personal agent workflow repo: packaged skills, workflows, runner, automations, plans.

Keep this repo standalone. No references, examples, paths, fixtures, or docs tied to private downstream repos — use generic target-repo examples. Layout and usage: `README.md`.

## Contributor docs

- project intent -> `docs/project-intent.md`
- contributor index -> `docs/contributing/index.md`
- harness-engineering guide -> `docs/contributing/harness-engineering.md`
- architecture map -> `docs/contributing/architecture.md`
- testing guide -> `docs/contributing/testing.md`

## Planning workflow

Coordinator: **`planning-workflow`**. Plans: **`dev/plans/`** + **`dev/plans/README.md`**.

| Skill | Role | Artifact |
|-------|------|----------|
| `planning-workflow` | Route intake → shape/validate → handoff → implement → close | — |
| `shape-requirements` | Gate or interview → confirmed interpretation or brief | `dev/briefs/YYMMDD-short-slug.md` (interview) |
| `diagnose-issue` | Evidence-backed problem definition before planning | inline or `dev/issues/YYMMDD-short-slug.md` |
| `architect` | Manual-only repo-grounded design/architecture memo before planning | inline |
| `audit` | Codebase survey → prioritized handoff plans | `dev/plans/YYMMDD-short-slug.md` |
| `create-plan` | Scoped plan from todo/spec/issue | `dev/plans/YYMMDD-short-slug.md` |
| `review-spec` | Validate plan/spec against codebase; proportionality check; Simplicity as a finding category | advisory findings |
| `plan-review` | Executable one-pass `review-spec` for non-trivial implementation plans | `.harness/runs/reviews/<run-id>/` |
| `handoff-work` | Transfer context between agents or sessions | inline handoff |

**Shape vs diagnose:** `shape-requirements` when the question is what the user wants. `diagnose-issue` when the question is what is true in the repo. Too vague to investigate → gate only, then diagnose.

**Typical chain** (skip steps per `planning-workflow` routing): `shape-requirements` → `diagnose-issue` → `review-spec` → `create-plan` → `plan-review` → implementation → `handoff-work` → `change-review-workflow`.
Use `architect` only when explicitly invoked for ideation/research/solution design; it writes no artifacts and hands back an inline memo.

**Routing reference:** `planning-workflow/references/routing.md` — intake, skip rules, scenario fixtures, pass criteria.

`audit` is read-only on source; only `dev/plans/` files may be created or updated. Reconcile with `dev/plans/README.md` before adding plans.

**Plan skill discovery (`audit` and `create-plan`):** Check injected and repo-local skill descriptions, then read only candidates that match a concrete change. Mention a verified skill beside that change only when it adds non-obvious executor guidance; no skills table by default. Never invent skill names.

## Review workflow

Coordinator: **`change-review-workflow`**. Triage (Implement / Adapt / Decline) and fixes happen in the coordinator — no separate triage skill.

| Skill | Role | Posture |
|-------|------|---------|
| `change-review-workflow` | Run harness reviewers, triage findings, apply fixes, re-review | Coordinator |
| `review-spec` | Validate plan/spec before implementation | Advisory |
| `review-implementation` | Adversarial review of implementation vs plan/spec | Skeptical; read-only |
| `code-quality-review` | Behavior-preserving clarity, simplicity, conventions, maintainability | Read-only |

`review-implementation` and `code-quality-review` are read-only. Use `review-implementation` for correctness and `code-quality-review` for conventions, maintainability, and simplification suggestions.

**Skill discovery (for implementation, `review-implementation`, `code-quality-review`):** Discover available skills in the host and target repo. Read relevant `SKILL.md` files for languages, frameworks, or patterns touched by the work. Use them as guidelines — no fixed checklist. For plan-driven work, use any executor aids named beside the relevant changes.

## Handoff workflow

| Skill | Role |
|-------|------|
| `handoff-work` | Transfer context to another agent for continuation or review |

Use `handoff-work` when ending a session (done or not) so the next agent can continue without replaying prior context. In the planning chain, hand off after `plan-review` (or after `create-plan` when plan-review is skipped per routing) or partial implementation, and before `change-review-workflow` when implementer ≠ reviewer.

Typical close: `planning-workflow` → implementation → `handoff-work` (if needed) → `change-review-workflow`.

## Sessions

| Skill | Role |
|-------|------|
| `sessions` | Browse and extract snippets, artifacts, and session ids via `sessions analyze` |

CLI: `skills/sessions/scripts/sessions.ts` (install via `skills/sessions/scripts/install.sh`). Cache: `~/.sessions/index`.

Facts first; label interpretation separately. Do not treat `patterns` as recommendations.

**Coordinator audits (retrospective):** Use `sessions` to score real transcripts against routing fixtures — e.g. `planning-workflow/references/routing.md`. Coordinators like `planning-workflow` do not invoke `sessions`; when an agent runs planning, it is executing work, not auditing past sessions.

## Learning

| Skill | Role | Artifact |
|-------|------|----------|
| `learning-coach` | Topic learning over repeated sessions; one question at a time | `MISSION.md`, `LEARNER.md`, `PLAN.md`, `LOG.md`, `RESOURCES.md` |

Standalone — not part of planning or review coordinators. One topic per workspace directory.

## New packaged skills

- Directory: `skills/{kebab-case}/` with required `SKILL.md`; optional `agents/openai.yaml`, `references/`, `scripts/`.
- Match layout of nearby skills in `skills/`; see `README.md` for install and discovery.
- Automations: `automations/{kebab-case}.md` — goal, strategy, rules, output expectations.
