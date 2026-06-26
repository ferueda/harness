---
name: session-evidence
description: Use when analyzing local agent session history with `sessions analyze --include-turns`, extracting neutral transcript evidence, interpreting patterns, or deciding whether evidence should lead to a workflow, skill, indexer, classifier, or process-improvement plan.
---

# Session Evidence

Use `sessions analyze --include-turns` as an evidence extractor. The analyzer
does not make recommendations; it surfaces bounded transcript patterns,
artifacts, examples, and provenance for you to interpret.

## Workflow

1. Start narrow. Choose `--days`, `--workspace`, `--query`, and `--min-support`
   before reading evidence.
2. Scan table output first. Use JSON when handing evidence to another agent or
   doing deeper analysis.
3. Inspect `patterns`, `artifacts`, `support`, `examples`, `sessionId`, and
   `turnIndex`.
4. Drill into source sessions with `sessions cursor show <sessionId>` only when
   snippets are not enough.
5. Ask interpretation questions over the extracted data before deciding what it
   means.
6. Separate observation from interpretation. Evidence can suggest a future
   workflow, skill, indexer, classifier, or process plan, but this skill should
   not create one automatically.

## Command Patterns

Recent workspace scan:

```bash
sessions analyze --provider cursor --include-turns --days 30 --workspace /path/to/repo
```

Topic scan:

```bash
sessions analyze --provider cursor --include-turns --query review --min-support 2
```

JSON handoff:

```bash
sessions analyze --provider cursor --include-turns --format json --pattern-limit 20 --evidence-limit 3
```

## Questions To Ask

- What do we repeatedly ask agents to do manually?
- Which review, test, or debug loops keep showing up?
- Which user preferences appear often enough to become repo guidance or a skill?
- Which artifacts recur: plans, PRs, branches, commands, or paths?
- Is the index missing useful fields because analysts keep needing transcript
  context?
- Which patterns are real recurring work, and which are noise from automation,
  handoffs, or review workers?
- What evidence would justify a separate follow-up plan, and what should stay a
  no-op?

## Interpretation Rules

- Treat support as recurrence, not importance.
- Prefer patterns backed by multiple sessions plus artifacts.
- Treat one-off patterns as leads only when `--min-support 1` is used.
- Check examples before naming a follow-up plan.
- Keep privacy boundaries: summarize sensitive snippets; do not quote secrets,
  tokens, or private transcript text.

## Output

Report:

- `Commands run`
- `Strong patterns`
- `Evidence`
- `Possible follow-ups`
- `Noise/rejected leads`
- `Recommended next plan or no-op`
