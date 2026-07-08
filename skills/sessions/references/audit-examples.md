# Audit examples

Worked examples for evaluating workflows and skills with the sessions skill. Extract facts first; label interpretation separately.

See also coordinator fixtures: `planning-workflow/references/routing.md`.

## Principles

1. **Extract first** — narrow `sessions analyze` filters; open `sessions show` for 1–2 sessions only.
2. **Facts vs interpretation** — match counts and artifacts are facts; "misfire" and "healthy" are interpretation.
3. **Recurrence before edits** — change a skill doc when the same gap appears **twice**.
4. **Coordinator vs leaf** — low `planning-workflow` hits may be fine if `create-plan` / `review-spec` fire correctly.
5. **Harness noise** — `review-implementation`, `handoff`, and `meta.json` inflate counts; prefer `isFirstUserTurn` and explicit `$skill` invokes.

## Weekly loop (~20 min)

1. Run **Planning** extract below (14 days).
2. Run **Review** extract below (14 days).
3. Score 2–3 sessions against coordinator fixtures + scorecards in this file.
4. Artifact spot-check (`dev/plans/`, `.harness/runs/reviews/`).
5. One doc edit max if a misfire repeated.

**Monthly:** run **Portfolio** example (90 days).

## Report template

```markdown
## Sessions audit

**Date:**
**Workspace:**
**Provider(s):** cursor | codex | both
**Window:** N days

### Commands run

-

### Facts

| Skill / term | Matches | First-turn | Notes |
| ------------ | ------- | ---------- | ----- |

### Artifacts

-

### Session ids reviewed

-

### Interpretation

- Healthy:
- Investigate:

### Action

- [ ] No change | Edit skill: … | Add fixture
```

## When to improve what

| Symptom                            | Likely fix                                                   |
| ---------------------------------- | ------------------------------------------------------------ |
| Skill never invoked; routing clear | Description triggers; invoke coordinator explicitly          |
| Same wrong first skill             | `planning-workflow/references/routing.md` intake or fixtures |
| Skill invoked, wrong behavior      | Leaf skill doc                                               |
| Zero hits weeks                    | Remove, merge, or promote                                    |
| Review findings not closed         | `change-review-workflow` After Results                       |

---

## Example: planning workflow

**Goal:** Did routing match `planning-workflow`? Compare to fixtures in `planning-workflow/references/routing.md`.

### Extract

```bash
# Per-skill counts
for term in planning-workflow shape-requirements diagnose-issue architect \
  create-plan review-spec implement-plan handoff-work audit; do
  echo -n "$term: "
  sessions analyze --provider codex --include-turns --extract-only \
    --workspace /path/to/repo --days 14 \
    --turn-query "$term" --format json 2>/dev/null \
    | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
      try{console.log(JSON.parse(d).evidence?.matches?.length??0)}catch{console.log(0)}})"
done
```

Combined JSON:

```bash
sessions analyze --provider codex --include-turns --extract-only \
  --workspace /path/to/repo --days 14 \
  --turn-query "planning-workflow" \
  --turn-query "shape-requirements" \
  --turn-query "diagnose-issue" \
  --turn-query "create-plan" \
  --turn-query "review-spec" \
  --turn-query "implement-plan" \
  --format json
```

Inspect: `isFirstUserTurn`, `artifacts` plan-file / `dev/briefs/`.

### Signals

| Healthy                                                         | Investigate                            |
| --------------------------------------------------------------- | -------------------------------------- |
| `shape-requirements` or `planning-workflow` first on vague work | `create-plan` / `implement-plan` first |
| `review-spec` on plan path before build                         | Plan in artifacts, no spec review      |
| `diagnose-issue` early on tickets                               | Interview on clear repro               |
| `handoff-work` across agents                                    | Next session replays chat              |

### Scorecard

```markdown
## Planning routing scorecard

**Session id:**
**User intent:**

**Expected first skill:** (from routing fixture #)
**Actual first skill:** **Match:** yes | no
**Path taken:**
**Skipped steps + reason:**
**Misfire:** yes | no → skill doc to fix:
```

### Misfires → doc

| Misfire                              | Edit                                                 |
| ------------------------------------ | ---------------------------------------------------- |
| Implement on "add logging", no scope | `shape-requirements` gate-mode or routing fixture #8 |
| Interview on JIRA ticket             | `planning-workflow/references/routing.md` intake     |
| Skipped review-spec on big plan      | `planning-workflow` step 2 or routing skip table     |

### Artifact check

```bash
ls dev/briefs/ dev/plans/ 2>/dev/null
```

New `dev/plans/*.md` → look for `review-spec` turn on same path.

---

## Example: review workflow

**Goal:** Did `change-review-workflow` run and close the loop?

### Extract

```bash
for term in change-review-workflow change-review "harness run" \
  review-spec review-implementation code-quality simplify-review; do
  echo -n "$term: "
  sessions analyze --provider codex --include-turns --extract-only \
    --workspace /path/to/repo --days 14 \
    --turn-query "$term" --format json 2>/dev/null \
    | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
      try{console.log(JSON.parse(d).evidence?.matches?.length??0)}catch{console.log(0)}})"
done
```

`handoff` / `review-implementation` hits often = harness prompts, not user invokes.

Look for: first-turn coordinator, `harness run change-review`, `.harness/runs/reviews/`.

### Signals

| Healthy                                                 | Investigate                        |
| ------------------------------------------------------- | ---------------------------------- |
| `change-review-workflow` or harness run after implement | Merge with no review               |
| `review-spec` for plan-only                             | change-review on plan with no diff |
| Re-run after fixes                                      | Findings never triaged             |

### Scorecard

```markdown
## Review routing scorecard

**Session id:**
**Trigger:** post-implement | plan validation | re-review
**Harness run:** yes | no
**Triage visible:** yes | no
**Re-review after fixes:** yes | no | n/a
**Misfire:** yes | no → skill doc to fix:
```

### Artifact check

```bash
ls .harness/runs/reviews/ 2>/dev/null | tail -5
```

---

## Example: skill portfolio

**Goal:** Monthly keep / merge / delete decisions.

### Extract

```bash
REPO=/path/to/repo
for term in $(ls skills/*/SKILL.md 2>/dev/null | xargs -I{} basename $(dirname {})); do
  c=$(sessions analyze --provider codex --include-turns --extract-only \
    --workspace "$REPO" --days 90 --turn-query "$term" --format json 2>/dev/null \
    | node -e "let d='';process.stdin.on('data',x=>d+=x);process.stdin.on('end',()=>{
      try{console.log(JSON.parse(d).evidence?.matches?.length??0)}catch{console.log(0)}})")
  printf '%3s  %s\n' "$c" "$term"
done | sort -rn
```

Repeat `--provider cursor`. Zero hits on `*-review` may be OK (CLI invokes them).

### Decisions template

```markdown
## Skill portfolio review

| Skill | Cursor | Codex | Verdict |
| ----- | ------ | ----- | ------- |
```

| Verdict             | When                     |
| ------------------- | ------------------------ |
| keep                | Used correctly           |
| improve description | Zero hits, still wanted  |
| merge               | Overlapping skills       |
| delete              | Zero hits 90d, redundant |

Cross-repo: `audit` may be hot in one repo only — judge per workspace.
