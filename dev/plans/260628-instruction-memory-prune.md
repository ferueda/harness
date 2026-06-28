# Plan 260628-instruction-memory-prune: Prune always-loaded instructions and stale memory records

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: docs
- **Written against**: `1a4205d`

## Why this matters

The repo's always-loaded instruction surface has started to behave like push
memory: useful directions, repo docs, finished-work records, and skill
catalogs are mixed together. The attached memory article's bar is the right one
for this repo: keep only decision-changing, cross-cutting instructions in
always-loaded files; move or delete finished work records; put skill-specific
lessons in the owning skill, not global memory. This plan reduces token drag
without changing either packaged installable skills under `skills/` or
repo-local development skills under `.agents/skills/`.

## Current state

- `AGENTS.md` is the repo-level always-loaded instruction file. It is 231 lines,
  over the 200-line threshold from the audit.
- `dev/plans/260621-agent-harness-handoff.md` is the active roadmap/handoff. It
  is 722 lines and mixes live roadmap, architecture notes, completed PR history,
  and a duplicated summary block.
- `.harness/runs/reviews/**/context/handoff.md` contains ignored generated
  reviewer handoffs. The audit found 223 files and 3,757 total lines at the
  time it ran. A clean checkout may have zero `.harness/` artifacts; that is a
  no-op, not a failure.
- `ARCHITECTURE.md`, `VISION.md`, `CLAUDE.md`, `LEARNINGS*`, and tracked memory
  files do not exist in this repo.
- `.agents/skills/typescript-refactor/AGENTS.md`,
  `.agents/skills/vitest/AGENTS.md`, and `.agents/skills/zod/AGENTS.md` duplicate
  skill summaries in repo-local development skill directories. Do not edit them
  in this plan; this cleanup is about loaded memory/instruction files, not skill
  content.

Current excerpts to confirm before editing:

```markdown
AGENTS.md:30
## Repository Overview

AGENTS.md:49
## Planning workflow

AGENTS.md:122
## Directory Structure

AGENTS.md:203
## Best Practices for Context Efficiency
```

```markdown
dev/plans/260621-agent-harness-handoff.md:15
**Done today:** TypeScript CLI (`harness run change-review`), ...

dev/plans/260621-agent-harness-handoff.md:252
### Completed since original plan (2026-06-21)

dev/plans/260621-agent-harness-handoff.md:545
## Revised phased roadmap

dev/plans/260621-agent-harness-handoff.md:702
## Work Handoff (summary block)
```

Repo conventions to preserve:

- Work style in `AGENTS.md`: telegraph, minimal filler, concrete paths.
- Plans live in `dev/plans/` and are indexed in `dev/plans/README.md`.
- Shipped/superseded plans live under `dev/plans/archive/`.
- Generated review run artifacts live under `.harness/`, which is ignored.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Check status | `git status --short` | Shows only intentional plan/cleanup changes |
| Count instruction lines | `wc -l AGENTS.md dev/plans/260621-agent-harness-handoff.md` | `AGENTS.md` under 200 after cleanup |
| Find instruction files | `find . -path './.git' -prune -o -path './node_modules' -prune -o -type f \( -iname 'AGENTS.md' -o -iname 'ARCHITECTURE.md' -o -iname 'VISION.md' -o -iname 'CLAUDE.md' -o -iname 'LEARNINGS*' \) -print \| sort` | Root `AGENTS.md` plus three repo-local development `.agents/skills/*/AGENTS.md` files; no `ARCHITECTURE.md`, `VISION.md`, `CLAUDE.md`, or `LEARNINGS*` |
| Dry-run artifact prune | `harness runs prune --older-than 7d --dry-run` | JSON reports matched runs without deletion, or zero matches |
| Doc regression | `pnpm exec vitest run test/skills.test.ts` | exit 0 |
| Sanity gate | `pnpm check` | exit 0 |

## Suggested executor toolkit

| Step | Skill / resource | Use |
|------|------------------|-----|
| Whole plan | `implement-plan` | Execute the plan phase-by-phase and update checkboxes/status. |
| Handoff if stopping early | `handoff-work` | Produce a continuation handoff if only part of the cleanup is complete. |

`change-review-workflow` is optional after implementation and should be used
only if the user asks for a review pass. Do not invoke `skill-creator`; no skill
is being created or edited.

## Scope

**In scope**:

- `AGENTS.md`
- `dev/plans/260621-agent-harness-handoff.md`
- `dev/plans/README.md`
- `dev/plans/archive/` only if archiving the stale handoff is cleaner than
  shrinking it in place
- ignored `.harness/runs/reviews/` artifacts via `harness runs prune`

**Out of scope**:

- `.agents/skills/**` — repo-local development skills for working on this repo;
  not part of this instruction-memory cleanup.
- `skills/**` — packaged installable skills used by target repos; not part of
  this instruction-memory cleanup.
- `README.md` — keep repo documentation there; do not solve `AGENTS.md` bloat by
  moving text into another always-loaded file.
- Code under `bin/`, `lib/`, `providers/`, `workflows/`, `test/`, or `schemas/`.
- Any Git commit, branch, push, or PR unless the user asks after implementation.

## Steps

### Step 1: Recreate the backup before modifying instructions

Create a fresh reversible backup outside the loaded repo surface:

```bash
mkdir -p "$HOME/.codex/backups"
backup_path="$HOME/.codex/backups/harness-instruction-prune-$(date +%Y%m%d-%H%M%S).tar.gz"
paths=(AGENTS.md dev/plans)
if [ -d .harness/runs ]; then
  paths+=(.harness/runs)
fi
tar -czf "$backup_path" \
  --exclude='./node_modules' \
  --exclude='./.git' \
  "${paths[@]}"
```

Do not put the backup under this repo.

**Verify**: `ls -t "$HOME"/.codex/backups/harness-instruction-prune-*.tar.gz | head -1` → prints the new archive path.

### Step 2: Shrink `AGENTS.md` to cross-cutting steering

Rewrite `AGENTS.md` so it is under 200 lines and only keeps lines that change
agent decisions in this repo.

Keep:

- Work style and agent protocol.
- Commit guidelines that are repo-specific.
- The standalone/private-downstream boundary.
- Planning/review routing rules only where they prevent recurring mistakes:
  shape vs diagnose, audit/create-plan skill discovery, read-only review roles.
- Sessions warning: facts first, label interpretation, do not treat `patterns`
  as recommendations.
- A minimal repo-local skill creation rule only if needed: new skills live under
  `skills/{kebab-case}/SKILL.md` and should match nearby skill layout.

Delete or compress:

- The full repo layout table. The model can infer it from files and `README.md`.
- Long workflow skill catalogs that duplicate `SKILL.md` descriptions.
- Directory-structure examples that duplicate actual directories.
- Long SKILL.md and `agents/openai.yaml` templates. Keep at most a short
  pointer to existing in-repo examples; do not reference a host-only skill that
  may not exist for the executor.
- Generic statements such as "write clear code" when a more specific local rule
  already exists.

Do not add imports to skill-local `AGENTS.md` files in either skill tree.

**Verify**:

```bash
wc -l AGENTS.md
rg -n "TypeScript runner|Available Skills|SKILL.md Format|agents/openai.yaml Format|Core layout" AGENTS.md
```

Expected: `AGENTS.md` line count is below 200; `rg` returns no matches for the
deleted bulk sections.

### Step 3: Convert the 722-line handoff into a current active roadmap

Handle `dev/plans/260621-agent-harness-handoff.md` as stale memory mixed with a
live roadmap.

Required outcome: there must still be an active roadmap after this step. Use one
of these two shapes:

1. **Preferred:** shrink `dev/plans/260621-agent-harness-handoff.md` in place to
   a current roadmap under 250 lines.
2. **Alternative:** archive the full file and create a new short active roadmap
   file, then update `dev/plans/README.md` to point at the new file.

The active roadmap must carry forward:

- Current goal and scope for the harness roadmap.
- Pending phases: `steps.json`, `digestReview()`, deterministic grader, inbox
  trigger, per-step runner extraction, and Inngest orchestrator.
- Artifact schema v1 essentials, especially `steps.json` statuses and retry
  semantics.
- Open items and assumptions needed for the next executor.

Remove duplicated summary blocks and completed PR history from the active file.
`dev/plans/README.md` already records shipped PRs, so preserving the full history
is optional.

Preserve these active decisions somewhere if they remain true:

- Harness runs against target repos.
- Artifacts belong under target repo `.harness/`.
- Durability/Inngest is Phase 2, not a blocker for local `steps.json`, graders,
  or inbox work.
- Human gates remain for review reaction and merge until explicitly changed.

**Verify**:

```bash
wc -l dev/plans/260621-agent-harness-handoff.md 2>/dev/null || true
rg -n "Completed since original plan|Done today|Work Handoff \\(summary block\\)" dev/plans/*.md
```

Expected: active handoff is gone or substantially shorter; stale completion
phrases do not appear in active plan files. If the active roadmap remains at
`dev/plans/260621-agent-harness-handoff.md`, it is under 250 lines. Historical
phrases may appear only under `dev/plans/archive/`.

### Step 4: Prune ignored generated review handoffs

Use the repo's existing run-prune command for ignored `.harness/runs/reviews`
artifacts. Start with a dry run.

```bash
harness runs prune --older-than 7d --dry-run
```

If the dry run reports only old local run artifacts and the matched count is
acceptable, run:

```bash
harness runs prune --older-than 7d
```

If the command is unavailable, use `node bin/harness.ts runs prune --older-than
7d --dry-run` and then the non-dry-run equivalent. If `.harness/runs/reviews`
does not exist or the dry run reports zero matches, record the no-op and
continue.

**Verify**:

```bash
find .harness/runs/reviews -path '*/context/handoff.md' -type f 2>/dev/null | wc -l
git status --short
```

Expected: handoff count is lower; `git status --short` does not show `.harness/`
because it is ignored.

### Step 5: Document skill-local duplicate summaries as deferred, not edited

Do not modify `.agents/skills/typescript-refactor/AGENTS.md`,
`.agents/skills/vitest/AGENTS.md`, or `.agents/skills/zod/AGENTS.md`.

Add one note to `dev/plans/README.md` or this plan's completion notes:

- These files duplicate repo-local development skill summaries.
- They are intentionally untouched because this plan does not edit skill content.
- If the duplication should be fixed, do it as a separate skill-structure change
  with explicit scope for `.agents/skills/**` and/or `skills/**`.

**Verify**:

```bash
git diff -- .agents/skills skills
```

Expected: no diff.

### Step 6: Run final verification

Run documentation/instruction checks and the repo gate:

```bash
wc -l AGENTS.md
wc -l dev/plans/260621-agent-harness-handoff.md 2>/dev/null || true
find . -path './.git' -prune -o -path './node_modules' -prune -o -type f \( -iname 'AGENTS.md' -o -iname 'ARCHITECTURE.md' -o -iname 'VISION.md' -o -iname 'CLAUDE.md' -o -iname 'LEARNINGS*' \) -print | sort
rg -n "TypeScript runner|Available Skills|SKILL.md Format|agents/openai.yaml Format|Core layout" AGENTS.md
rg -n "Completed since original plan|Done today|Work Handoff \\(summary block\\)" dev/plans/*.md
git diff --stat
pnpm exec vitest run test/skills.test.ts
pnpm check
```

Expected:

- `AGENTS.md` is under 200 lines.
- If `dev/plans/260621-agent-harness-handoff.md` remains active, it is under 250
  lines.
- Instruction file inventory is exactly root `AGENTS.md` plus the three
  repo-local development `.agents/skills/*/AGENTS.md` files; no
  `ARCHITECTURE.md`, `VISION.md`, `CLAUDE.md`, or `LEARNINGS*`.
- Negative `rg` checks return no matches in active files.
- Diff is limited to in-scope files.
- `pnpm exec vitest run test/skills.test.ts` exits 0.
- `pnpm check` exits 0. Treat it as a sanity gate for unchanged code, not proof
  that markdown cleanup is correct.

## Test plan

No runtime tests are required for docs-only instruction cleanup. Use command
verification instead:

- `wc -l AGENTS.md` enforces the always-loaded budget; `wc -l` on the active
  handoff enforces the roadmap budget if it remains.
- `rg` checks ensure stale completed-work phrases are gone from active files.
- `git diff -- .agents/skills skills` proves both skill trees were not edited.
- `pnpm exec vitest run test/skills.test.ts` runs the existing `AGENTS.md`
  regression test.
- `pnpm check` is a code sanity gate, not markdown validation.

## Done criteria

All must hold:

- [ ] A fresh backup exists under `$HOME/.codex/backups/`.
- [ ] `AGENTS.md` is under 200 lines.
- [ ] `AGENTS.md` no longer duplicates the repo layout, full skill catalog, or
      skill-file templates.
- [ ] An active roadmap still exists; if
      `dev/plans/260621-agent-harness-handoff.md` remains active, it is under 250
      lines.
- [ ] Ignored `.harness/runs/reviews` handoffs are pruned or a reason is recorded
      for leaving them.
- [ ] `.agents/skills/**` and `skills/**` have no diff.
- [ ] `dev/plans/README.md` reflects the active queue after cleanup.
- [ ] Final verification commands are run and results recorded.

## STOP conditions

Stop and report back if:

- `git status --short` shows unrelated user changes in `AGENTS.md` or
  `dev/plans/260621-agent-harness-handoff.md`; do not overwrite them.
- Shrinking `AGENTS.md` below 200 lines would require deleting a repo-specific
  safety rule with no obvious better home.
- Step 3 cannot preserve the pending `steps.json` / grader / inbox / Inngest
  roadmap in under 250 lines without losing needed implementation detail.
- Cleanup appears to require editing `.agents/skills/**` or `skills/**`.
- `harness runs prune --older-than 7d --dry-run` reports paths outside
  `.harness/runs/reviews`.
- `pnpm check` fails for a reason unrelated to docs/instruction changes.

## Maintenance notes

Reviewers should focus on whether each remaining always-loaded instruction
changes a real decision. Finished-work records belong in Git history, archived
plans, or ignored run artifacts; they do not belong in active plans or
`AGENTS.md`. If a future run finds a lesson tied to one skill, update the owning
skill deliberately: `skills/**` for packaged installable skills, `.agents/skills/**`
for repo-local harness development skills.
