You are running the adversarial **review-implementation** pass for a dual-review workflow.

## Required Instructions

1. Before reviewing, read and follow the `review-implementation` skill from the first path that exists in this workspace:
   - `skills/review-implementation/SKILL.md`
   - `.agents/skills/review-implementation/SKILL.md`
   - `.cursor/skills/review-implementation/SKILL.md`
   - `.claude/skills/review-implementation/SKILL.md`
2. Also read `AGENTS.md` when present.
3. Review only the artifact files listed below. Do not edit files. This is read-only.
4. Return JSON matching the provided schema. No markdown fences or prose outside JSON.

## Review scope

| Field | Value |
|-------|-------|
| Base ref | `{{BASE_REF}}` |
| Head ref | `{{HEAD_REF}}` |
| Merge base | `{{MERGE_BASE}}` |
| Head SHA | `{{HEAD_SHA}}` |

## Review artifacts

- {{DIFF_SECTION}}
- {{PLAN_SECTION}}
- {{HANDOFF_SECTION}}

Read the artifact files directly. Do not rely on summaries or previews.
