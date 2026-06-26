# Plan 260626-session-turn-search-extraction: Make session evidence a simple turn extractor

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: dev/plans/260626-session-evidence-extraction.md
- **Category**: dx
- **Status**: Done

## Why this matters

The merged session evidence layer is useful, but it still feels too much like
an analyzer: it groups transcript fragments into buckets and prints "patterns".
The next pass should make the tool feel like structured grep for agent
sessions. Agents should be able to ask for user turns containing a phrase such
as `verify`, `how to`, `review`, or `test`, then receive snippets, artifacts,
and provenance without the CLI implying what action to take.

## Current state

- `bin/sessions.ts` exposes `sessions analyze --include-turns` with
  `--days`, `--workspace`, `--query`, `--include-automation`,
  `--evidence-limit`, `--pattern-limit`, and `--min-support`.
- `--query` does **not** search all transcript text. In
  `lib/sessions/core/filters.ts`, it only matches session id, workspace key,
  workspace path, title, and `firstUserQuery`.
- `lib/sessions/core/evidence.ts` extracts bounded fragments, artifacts, and
  grouped `patterns`. It excludes fragments that do not match a lexical signal.
- `skills/session-evidence/SKILL.md` still talks about workflow, skill,
  indexer, classifier, follow-up plans, and recommendations. That wording no
  longer matches the desired simple extraction goal.
- `test/sessions/cli.test.ts` already covers `--include-turns` JSON/table
  output, filtering, warnings, and invalid option combinations.
- `test/sessions/core/evidence.test.ts` already covers buckets, artifacts,
  one-off hiding, truncation, and deterministic sorting.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Format | `pnpm run format` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0, no errors |
| Evidence tests | `pnpm exec vitest run test/sessions/core/evidence.test.ts` | all tests pass |
| CLI tests | `pnpm exec vitest run test/sessions/cli.test.ts` | all tests pass |
| Skill tests | `pnpm exec vitest run test/skills.test.ts` | all tests pass |
| Build | `pnpm run build` | exit 0 |

## Suggested executor toolkit

| Step | Skill / resource | Notes |
| --- | --- | --- |
| Implementation | `implement-plan` | Execute this plan phase by phase and update status when verified. |
| TypeScript changes | `.agents/skills/typescript-refactor` | Keep types explicit, provider-neutral, and Node type-strip compatible. |
| CLI changes | `.agents/skills/node` | Preserve Node 24 ESM style and existing Commander exit-code behavior. |
| Tests | `.agents/skills/vitest` | Add focused fixture tests with temp dirs and no live `~/.cursor` reads. |
| Skill update | `skill-creator` and `writing-great-skills` | Keep `skills/session-evidence` concise, procedural, and extraction-focused. |

## Scope

**In scope**:

- `bin/sessions.ts`
- `lib/sessions/core/evidence.ts`
- `lib/sessions/core/types.ts` only if extra provenance requires a narrow type
  addition.
- `test/sessions/cli.test.ts`
- `test/sessions/core/evidence.test.ts`
- `test/fixtures/sessions/**` only for small transcript fixtures needed by
  tests.
- `skills/session-evidence/SKILL.md`
- `skills/session-evidence/agents/openai.yaml`
- `dev/plans/README.md`

**Out of scope**:

- No semantic search, embeddings, LLM summarization, or topic modeling.
- No workflow, skill, indexer, classifier, or self-improvement
  recommendations.
- No Codex provider.
- No change to existing `--query` semantics.
- No broad rename of existing JSON fields such as `patterns`, `examples`, or
  `artifacts`.
- No default transcript scan without `--include-turns`.

## Design

Add a dedicated transcript-text search flag:

```bash
sessions analyze --provider cursor --include-turns --turn-query "verify"
sessions analyze --provider cursor --include-turns --turn-query "how to" --days 30
```

Rules:

- `--turn-query` searches actual user-turn text, not indexed metadata.
- `--turn-query` requires `--include-turns`.
- `--turn-query` counts as a narrowing filter for the broad-scan warning.
- Do not silently change `--query`; keep it as metadata/session filtering.
- When `--turn-query` is present, include flat matching turn evidence in JSON
  and table output. Keep existing grouped `patterns` stable for compatibility,
  but do not make users rely on patterns to inspect exact matches.
- Turn-query matches should be visible even when normal grouped patterns would
  be hidden by `--min-support 2`.

Add simple extraction signal words for broad scans and examples:

- Intent/check words: `verify`, `validate`, `check`, `confirm`.
- How-to/question words: `how to`, `what should`, `should we`, `explain`.
- Existing useful task words stay useful: `review`, `test`, `debug`, `plan`,
  `implement`, `fix`, `run`.

These words are only deterministic extraction aids. Do not turn them into a
score, recommendation, or candidate detector.

Add a small extraction-only refinement after the first live smoke:

```bash
sessions analyze --provider cursor --include-turns --extract-only --turn-query "review"
sessions analyze --provider cursor --include-turns --extract-only --turn-query "verify" --turn-query "validate" --turn-query "check"
```

Rules:

- `--extract-only` requires `--include-turns`.
- `--extract-only` skips index-analysis output.
- Repeatable `--turn-query` uses OR semantics.
- A turn that matches multiple terms appears once with `matchedQueries`.
- When `--extract-only` and at least one `--turn-query` are present, skip
  pattern grouping and return `patterns: []`.
- Keep full artifact arrays in JSON; compact artifact display only in tables.

## Data shape

Extend the evidence report with a flat match list:

```ts
export type EvidenceMatch = {
  sessionId: string;
  workspacePath: string;
  workspacePathConfidence: WorkspacePathConfidence;
  workspacePathSource?: WorkspacePathSource;
  turnIndex: number;
  isFirstUserTurn: boolean;
  updatedAtMs?: number;
  text: string;
  query?: string;
  matchedQueries: string[];
  artifacts: EvidenceArtifact[];
};

export type SessionEvidenceReport = {
  schemaVersion: 1;
  provider: SessionProviderId;
  scannedSessions: number;
  scannedUserTurns: number;
  skippedUserTurns: number;
  excludedFragments: number;
  matches: EvidenceMatch[];
  patterns: EvidencePattern[];
  artifacts: Record<EvidenceArtifactType, EvidenceArtifact[]>;
};
```

If `--turn-query` is absent, `matches` may be an empty array. Keep
`schemaVersion: 1` unless the executor decides the additive field requires
`schemaVersion: 2`; if so, update all tests and explain the compatibility
reason in the PR.

## Steps

### Step 1: Add transcript turn-query matching

In `bin/sessions.ts`, add `--turn-query <text>` to `sessions analyze`.

- Add `turnQuery?: string` to `AnalyzeOptions`.
- Reject `--turn-query` without `--include-turns` with the same Commander error
  style as other transcript-evidence options.
- Include `turnQuery` in the broad-scan warning narrowing check.
- Pass `turnQuery` to `extractSessionEvidence`.

In `lib/sessions/core/evidence.ts`, add `turnQuery?: string` to
`ExtractSessionEvidenceOptions`.

- Match case-insensitively against full `turn.text`.
- Prefer reusing `phraseMatches`/`normalizeSnippet` where that keeps behavior
  consistent.
- When a turn matches, add an `EvidenceMatch` entry with bounded text centered
  around the match.
- Extract artifacts from the matched turn and include them on the match.
- Do not require the matched turn to hit a bucket signal or `minSupport`.

**Verify**:

```bash
pnpm exec vitest run test/sessions/core/evidence.test.ts
```

Expected: all tests pass, including new match tests.

### Step 2: Render flat matches in CLI output

In `bin/sessions.ts`, render `evidence.matches` when present.

- JSON output should include `evidence.matches`.
- Table output should include a small "Transcript matches" section before or
  after grouped evidence.
- Show columns like `session`, `turn`, `workspace`, `snippet`, and maybe
  `artifacts`; keep rows bounded by `--evidence-limit` or a small explicit
  match limit if adding one is cleaner.
- Keep existing "Transcript evidence patterns" behavior stable for broad scans.

**Verify**:

```bash
pnpm exec vitest run test/sessions/cli.test.ts
```

Expected: all CLI tests pass, including new `--turn-query` cases.

### Step 3: Add curated extraction signals

In `lib/sessions/core/evidence.ts`, add the following words to the existing
deterministic signal lists where they fit naturally:

- `verify`, `validate`, `check`, `confirm`
- `how to`, `what should`, `should we`, `explain`

Keep this conservative:

- Do not add a new bucket unless a current bucket is clearly wrong.
- Do not add scoring, weights, or ranking.
- Do not suppress generic terms globally if they are useful as explicit
  `--turn-query` terms.

**Verify**:

```bash
pnpm exec vitest run test/sessions/core/evidence.test.ts
```

Expected: all tests pass; add one test showing `verify` or `how to` is retained
as evidence in a broad scan.

### Step 4: Simplify the session-evidence skill

Rewrite `skills/session-evidence/SKILL.md` as an operator guide for extraction.

Required changes:

- Frontmatter description should trigger on extracting session evidence,
  searching transcript turns, inspecting snippets/artifacts, and using
  `sessions analyze --include-turns`.
- Remove user-facing references to workflow proposals, skill candidates,
  indexer/classifier plans, self-improvement, "Possible follow-ups", and
  "Recommended next plan".
- Include command examples for:
  - workspace/date scan
  - `--turn-query "verify"`
  - `--turn-query "how to"`
  - JSON handoff
- Teach agents to report:
  - commands run
  - filters used
  - matching snippets
  - artifacts found
  - session ids / turn indexes
  - missing context that requires `sessions cursor show`
- Keep interpretation separate from extraction.

Update `skills/session-evidence/agents/openai.yaml` so the metadata matches the
new extraction-focused skill.

**Verify**:

```bash
pnpm exec vitest run test/skills.test.ts
```

Expected: all skill tests pass.

### Step 4.5: Add extract-only and multi-term query refinements

In `bin/sessions.ts`:

- Add `--extract-only`.
- Keep the command under `sessions analyze`; do not add a new subcommand.
- Make `--turn-query` repeatable and pass all values to the extractor.
- Render slim output for extract-only mode: scan summary, transcript matches,
  and evidence JSON only. Do not render index-quality sections.
- Compact table artifact display as counts plus a few examples.

In `lib/sessions/core/evidence.ts`:

- Add `matchedQueries: string[]` to `EvidenceMatch`.
- Add repeatable query support with OR semantics.
- Return one match per turn, even when multiple terms match.
- Support skipping pattern extraction when extract-only query mode is active.

In `skills/session-evidence/SKILL.md`:

- Document `--extract-only` as the preferred investigation mode.
- Document repeatable `--turn-query`.

**Verify**:

```bash
pnpm exec vitest run test/sessions/core/evidence.test.ts test/sessions/cli.test.ts test/skills.test.ts
```

Expected: all tests pass.

### Step 5: Final verification

Run:

```bash
pnpm run format
pnpm typecheck
pnpm exec vitest run test/sessions/core/evidence.test.ts test/sessions/cli.test.ts test/skills.test.ts
pnpm run build
```

Expected: every command exits 0.

## Test plan

- `test/sessions/core/evidence.test.ts`
  - `turnQuery` finds a matching non-first user turn.
  - matching snippets center around the query term.
  - one-off `turnQuery` matches appear even when `minSupport` is `2`.
  - `verify` or `how to` survives broad evidence extraction as a useful signal.
- `test/sessions/cli.test.ts`
  - `--turn-query` requires `--include-turns`.
  - `--turn-query` searches transcript text that `--query` does not find.
  - `--turn-query` counts as a narrowing filter and suppresses broad-scan
    warning.
  - table output includes a "Transcript matches" section.
  - JSON output includes `evidence.matches`.
- `test/skills.test.ts`
  - existing skill validation remains green after updating
    `skills/session-evidence`.

## Done criteria

- [x] `sessions analyze --include-turns --turn-query <text>` searches user-turn
      transcript text.
- [x] `--query` remains metadata/session filtering only.
- [x] JSON output includes flat match evidence with provenance and artifacts.
- [x] Table output shows flat transcript matches.
- [x] Broad evidence scans recognize `verify` / `how to` style terms without
      adding recommendations.
- [x] `skills/session-evidence` explains the extraction workflow and no longer
      frames the tool around workflow/skill/indexer/classifier follow-up plans.
- [x] `--extract-only` renders transcript extraction without index-analysis
      sections.
- [x] Repeatable `--turn-query` supports OR matching and records
      `matchedQueries`.
- [x] Extract-only query mode skips pattern grouping and returns `patterns: []`.
- [x] Table artifact display is compact while JSON keeps full artifact arrays.
- [x] Verification commands in Step 5 all exit 0.
- [x] `dev/plans/README.md` status row is updated.

## STOP conditions

Stop and report back if:

- Implementing `--turn-query` requires changing Cursor transcript parsing or
  cache file format beyond a narrow additive field.
- Keeping `schemaVersion: 1` conflicts with existing tests or downstream JSON
  expectations.
- The implementation starts requiring semantic search, embeddings, LLM calls,
  or scoring.
- The skill update cannot stay concise without adding references or scripts.
- A verification command fails twice after a reasonable fix attempt.

## Maintenance notes

- This is an extraction pass, not an analysis-product pass. Reviewers should
  reject recommendation-shaped fields or language.
- Future consumers can interpret `matches`, `patterns`, and `artifacts`, but
  this CLI should keep returning evidence rather than deciding what it means.
- If later work adds Codex sessions, implement it as a separate provider plan.
