---
name: implement-plan
description: >
  Execute an approved plan or spec document phase-by-phase, writing robust idiomatic code that
  follows codebase patterns. Trigger when the user says "implement this plan", "execute the spec",
  "work through the phases", or a plan in `dev/plans/` is approved and ready for implementation.
---

# Implement Plan

Implement the given plan or spec document phase by phase. Write robust, idiomatic code that follows codebase patterns and industry best practices.

## When to Use

- An approved plan or spec exists and is ready for implementation
- Executing phases from `dev/plans/` or a similar handoff document
- The user says "implement this plan", "execute the spec", or "work through the phases"
- A create-plan artifact needs to be turned into working code

## Skills and Guidelines

Before implementing, discover what agent skills are available in the host environment and in the target codebase — for example `skills/`, `.agents/skills/`, `.cursor/skills/`, `.claude/skills/`, or any injected available-skills list.

Read the `SKILL.md` for skills that appear relevant to the languages, frameworks, libraries, or patterns required by the plan. Use those skills as guidelines and best practices during implementation. Do not assume a fixed checklist; pick what fits this task and codebase. If the plan includes a **Skills for the executor** section, start there — then supplement with any other relevant skills you discover.

## Process

1. **Read the spec** — Understand phases, success criteria, and scope boundaries.
2. **Explore the codebase** — Read files mentioned in the spec and related code.
3. **Analyze patterns** — Identify existing conventions, architecture, and idioms to follow.
4. **Implement phase by phase** — Complete one phase before moving to the next. Do not skip ahead.
5. **Verify your work** — Run codebase gates when available (for example `make check` or `make test`) after code changes. Skip for docs-only changes.

## Implementation Rules

- **Follow the plan** — The spec is your contract; implement what is specified.
- **Match codebase patterns** — Use existing conventions, not new ones.
- **Write robust code** — Handle errors, edge cases, and failure modes.
- **Be idiomatic** — Use language best practices and established patterns.
- **No shortcuts** — Implement fully; do not stub or leave placeholders.
- **Minimize scope** — Do not add unrelated refactors or features beyond the plan.

## Verification

- **Code changes**: Run `make check` or `make test` before proceeding to the next phase.
- **On failure**: Run `make fix` first, then re-run `make check`.
- **Documentation-only**: Skip verification.

## Communication

- If the plan does not match codebase reality, explain the discrepancy.
- If you need to deviate, explain why before making changes.
- Update checkboxes in the spec as you complete each section.

## Output

After each phase (or at completion):

- Summarize what was implemented and which files were touched.
- Report verification results (pass/fail, commands run).
- Note any deviations from the plan and why.
- Call out remaining phases or open items if work is incomplete.
