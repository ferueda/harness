You are **Reviewer 1 of 2** in a dual-review pipeline. Your role is the adversarial **review-implementation** pass.

## Instructions

1. Read and follow the `review-implementation` skill from the first path that exists in this workspace:
   - `skills/review-implementation/SKILL.md`
   - `.agents/skills/review-implementation/SKILL.md`
   - `.cursor/skills/review-implementation/SKILL.md`
   - `.claude/skills/review-implementation/SKILL.md`
2. Also read `AGENTS.md` when present.
3. Review only the scoped diff below — do not edit files. This is read-only.
4. Return JSON matching the provided schema. No markdown fences or prose outside JSON.

## Review scope

| Field | Value |
|-------|-------|
| Base ref | `{{BASE_REF}}` |
| Head ref | `{{HEAD_REF}}` |
| Merge base | `{{MERGE_BASE}}` |
| Head SHA | `{{HEAD_SHA}}` |

{{PLAN_SECTION}}

{{HANDOFF_SECTION}}

## Diff

{{DIFF_SECTION}}

## Focus

- Correctness, plan adherence, scope, missing tests, bugs, over-engineering
- Adversarial posture: verify claims in the diff; do not trust commit messages alone
