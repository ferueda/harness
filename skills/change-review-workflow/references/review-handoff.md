# Review Handoff

Write this handoff before running `harness run change-review`.

The handoff is reviewer input, not a work log. Include only facts and decisions needed to review the current change. Completion criterion: a reviewer can verify scope, changed behavior, risks, and test coverage without chat history.

## Template

```markdown
## Review Handoff

**Status:** complete | in_progress | blocked

### Goal
[What problem this change is meant to solve. Include the original request, issue, plan, or spec path when available.]

### Scope
[What is in scope, what is explicitly out of scope, and any intentional deferrals.]

### Files changed
- `path/to/file` - [What changed and why it matters]

### Implementation notes
[Key decisions, patterns followed, compatibility choices, migrations, or behavior changes reviewers should understand.]

### Verification
[Commands run and result. If not run, say why.]

### Risks to scrutinize
- [Correctness, edge case, test, migration, compatibility, or maintainability concern]

### Open items
- [Blockers, unanswered questions, or follow-ups. Use "none" when empty.]
```

## Rules

- Cite file paths and commands; avoid vague summaries.
- Separate verified facts from assumptions.
- Call out skipped verification and why it was skipped.
- Do not paste full diffs or long logs. Point reviewers to files and artifacts.
- Keep risks reviewable: name the behavior, boundary, or invariant that needs scrutiny.
