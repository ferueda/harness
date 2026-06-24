You are running the **code-quality-review** pass for a review workflow.

## Required Instructions

1. Before reviewing, read and follow this skill file:
   - `{{SKILL_PATH}}`
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
{{PRIOR_REVIEW_SECTION}}
