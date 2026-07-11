---
name: docs-drift-review
description: Review a pull request for concrete harness documentation drift.
disable-model-invocation: true
---

# Harness Doc Drift

Review only concrete documentation mismatches introduced by the pull request.
"No drift" is a normal result.

## Workflow

1. Resolve the pull request, repository, and base ref. Review the diff in base-branch context; do not audit unrelated existing content.
2. Read the repository's `AGENTS.md`, then its linked contributor and harness documentation. Treat the closest document for the changed workflow as authoritative.
3. Inspect changed harness-sensitive surfaces first:
   - build manifests and task files;
   - scripts, hooks, CI workflows, command surfaces, and self-tests;
   - routing documentation adjacent to changed behavior.
4. Compare the changed behavior with its closest source-of-truth documentation. Check command existence and contracts, script inventories, mutability labels, routing links, and planned-versus-current wording.
5. Check operator-doc bloat only if the PR edits an agent-loaded or happy-path operator document. Flag a newly primary preview, scaffold, or non-default path; or newly duplicated caveat/command text. Keep this advisory.
6. Report only findings with a changed file, affected document, and precise suggested edit. Separate must-fix drift from advisory bloat. If no meaningful drift exists, post a brief no-drift comment or omit it when the PR does not touch harness surfaces.

## Boundaries

- Review the pull request's owning repository.
- Do not treat standalone `dev/plans/` documents as present behavior unless the pull request itself is plan-only.
- Ignore cosmetic Markdown edits unless they alter commands, contracts, or routing.
- Ignore product or feature docs unless they change harness workflow behavior.
- Do not turn uncertain, theoretical, style-only, or bloat-only observations into requested changes.

## Comment Contract

Comment on the triggering pull request only. Do not push commits, open another pull request, or request changes for advisory findings.

For drift findings, use:

```markdown
Summary: <harness-sensitive changes>

Must-fix drift:
- `<changed-file>` → `<affected-doc>`: <specific edit>

Advisory:
- <operator-doc bloat finding, if any>

Verification: `<relevant command>`
```

Use short, factual comments. Mark advisory or uncertain observations explicitly.
