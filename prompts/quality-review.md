You are running the **code-quality-review** pass for a dual-review workflow.

## Required Instructions

1. Before reviewing, read and follow the `code-quality-review` skill from the first path that exists in this workspace:
   - `skills/code-quality-review/SKILL.md`
   - `.agents/skills/code-quality-review/SKILL.md`
   - `.cursor/skills/code-quality-review/SKILL.md`
   - `.claude/skills/code-quality-review/SKILL.md`
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
- {{HANDOFF_SECTION}}
- {{PRIOR_REVIEW_SECTION}}

If a prior implementation review file is provided, use it as optional context. Do not depend on it being present; this reviewer may run independently.
