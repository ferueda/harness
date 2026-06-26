# Plan 260626-session-evidence-extraction: Extract richer neutral evidence from sessions

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: dev/plans/260626-session-index-analysis.md
- **Category**: dx

## Why this matters

The current session analyzer is useful, but it mostly works from indexed
metadata and each session's first user query. That is enough to spot broad
signals, but not enough for agents to reliably reason about repeated work,
recurring artifacts, durable preferences, or workflow/skill opportunities.
This plan improves `sessions analyze` as a neutral evidence extractor: it
should surface richer transcript-derived patterns without deciding what to do
with them. Humans and agents can then use the evidence for different follow-up
decisions: new workflows, new skills, indexer improvements, classifier changes,
or process cleanup.

## Current state

- `bin/sessions.ts` exposes:
  - `sessions cursor reindex|list|show|export|stats`
  - `sessions analyze --provider cursor --format table|json`
- `lib/sessions/core/analyze.ts` computes provider-neutral metadata signals:
  missing fields, automation/subagent counts, workspace path quality, repeated
  first-query prefixes/words, marker counts, and class-scoped marker counts.
- `lib/sessions/cursor/analyze.ts` adds Cursor-specific sample sets and index
  improvement candidates.
- `lib/sessions/cursor/provider.ts` exposes `iterUserTurns(filters)` and parses
  transcript files on demand. This is the right entry point for bounded
  transcript-level evidence.
- `lib/sessions/core/types.ts` defines `UserTurn`, including `sessionId`,
  workspace data, `text`, `rawText`, and the source `session`.
- `bin/sessions.ts` still renders legacy wording:
  `Self-improve marker candidates` and `Index improvement candidates`. These
  are metadata frequency signals, not recommendations. This plan should
  neutralize the user-facing labels without broad type renames.
- `test/sessions/helpers.ts` provides temp session environments, transcript
  fixtures, and cache helpers. Tests must not read the developer's live
  `~/.cursor`.
- `dev/plans/260626-session-index-analysis.md` intentionally stopped before
  self-improve or proposal generation. It preserved the bridge to later
  evidence-based decisions.

Current analyzer gaps:

- It does not extract sentence/fragment-level evidence.
- It does not inspect transcript user turns beyond indexed `firstUserQuery`.
- It does not identify recurring artifact types such as plan files, PR URLs,
  branches, commands, or paths.
- It does not group similar task requests beyond exact prefix/word counts.
- Its current table labels still sound like recommendations rather than
  neutral metadata observations.
- It cannot yet produce a compact evidence report that another agent can use
  to reason about workflow ideas, skill improvements, or process patterns.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Format | `pnpm run format` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0, no errors |
| Focused sessions tests | `pnpm exec vitest run test/sessions/**/*.test.ts` | all sessions tests pass |
| CLI tests | `pnpm exec vitest run test/cli.test.ts test/sessions/**/*.test.ts` | all listed tests pass |
| Skill file check | `test -f skills/session-evidence/SKILL.md && test -f skills/session-evidence/agents/openai.yaml` | exit 0 |
| Build | `pnpm run build` | exit 0 |
| Full gate | `make check` | exit 0 |

## Suggested executor toolkit

| Step | Skill / resource | Notes |
| --- | --- | --- |
| All implementation | `implement-plan` | Execute this plan phase by phase and update checkboxes only when verified. |
| Type/result design | `.agents/skills/typescript-refactor` | Keep result types explicit, deterministic, and provider-neutral. |
| CLI and transcript IO | `.agents/skills/node` | Preserve Node 24 ESM/type-stripping-compatible style and bounded filesystem reads. |
| Tests | `.agents/skills/vitest` | Add focused fixture tests with temp dirs and no shared mutable state. |
| Usage skill | `skill-creator` | Create a concise packaged skill with `SKILL.md` and `agents/openai.yaml`. |
| Skill wording | `writing-great-skills` | Keep the skill procedural, short, and non-prescriptive. |

## Scope

**In scope**:

- `lib/sessions/core/evidence.ts` — new provider-neutral transcript evidence
  extractor over `UserTurn`s.
- `lib/sessions/core/analyze.ts` — integrate evidence result types only if that
  keeps `sessions analyze` cohesive; otherwise import evidence separately from
  the CLI.
- `bin/sessions.ts` — add a neutral way to request richer evidence from
  `sessions analyze`, and rename existing user-facing analyze labels so they
  describe metadata signals rather than self-improvement recommendations.
- `test/sessions/**` — pure evidence extraction tests and CLI behavior tests.
- `test/fixtures/sessions/**` — add small fixtures only when existing fixtures
  cannot express needed cases.
- `skills/session-evidence/SKILL.md` — short packaged skill for agents learning
  how to operate the analyzer, extract useful evidence, and ask interpretation
  questions from the output.
- `skills/session-evidence/agents/openai.yaml` — UI metadata aligned with the
  new skill.
- `dev/plans/README.md` — keep this plan indexed as pending until
  implementation completes.

**Out of scope**:

- No workflow proposal generation.
- No skill proposal generation.
- No edits to existing skills, `.agents/`, `AGENTS.md`, Cursor rules, or
  user-level dotfiles. The only allowed skill change is the new
  `skills/session-evidence/` usage skill.
- No LLM calls, embeddings, semantic search, vector stores, or cloud APIs.
- No Codex session adapter.
- No scheduled automation or background daemon.
- No changes to `harness run change-review` workflows.
- No broad type or data-contract rename for existing
  `indexImprovementCandidates`; relabel rendering only unless a narrow alias is
  needed for clarity.

## Command shape

Keep the analyzer neutral. Prefer extending `sessions analyze` instead of
adding a purpose-specific command:

```bash
sessions analyze --provider cursor --format table
sessions analyze --provider cursor --format json
sessions analyze --provider cursor --include-turns
sessions analyze --provider cursor --include-turns --days 30 --workspace /path/to/repo --query review
```

Rules:

- `--include-turns` enables bounded transcript-level evidence extraction.
- Without `--include-turns`, keep current behavior and avoid reading transcript
  files.
- `--days`, `--workspace`, `--query`, and `--include-automation` should use the
  same filtering semantics as `sessions cursor list`.
- Add `--evidence-limit <n>` to bound examples per pattern, default `3`.
- Add `--pattern-limit <n>` to bound displayed pattern rows, default `10`.
- Add `--min-support <n>` to hide one-off patterns by default, default `2`.
- Read cache and transcript files only; do not reindex automatically.
- Default filters should exclude automation/subagent sessions when extracting
  turn evidence. Automation can be included explicitly for diagnostics.
- `--days`, `--workspace`, `--query`, and `--include-automation` apply only to
  transcript evidence when `--include-turns` is present. Reject these flags
  with a clear Commander error when `--include-turns` is absent.
- Existing `--limit` continues to bound cache-metadata sections. It must not
  silently control transcript evidence rows; use `--pattern-limit` and
  `--evidence-limit` for that.

## Evidence model

Add provider-neutral types similar to:

```ts
export type EvidenceBucket =
  | "review"
  | "planning"
  | "implementation"
  | "testing"
  | "debugging"
  | "git-pr"
  | "research"
  | "preference"
  | "noise"
  | "other";

export type EvidenceArtifact = {
  type: "path" | "plan-file" | "pull-request" | "branch" | "command" | "url";
  value: string;
  sessionId: string;
};

export type EvidenceExample = {
  sessionId: string;
  workspacePath: string;
  workspacePathConfidence: WorkspacePathConfidence;
  workspacePathSource?: WorkspacePathSource;
  turnIndex: number;
  isFirstUserTurn: boolean;
  text: string;
};

export type EvidencePattern = {
  id: string;
  bucket: EvidenceBucket;
  groupKey: string;
  label: string;
  support: number;
  signals: string[];
  artifacts: EvidenceArtifact[];
  examples: EvidenceExample[];
};

export type SessionEvidenceReport = {
  schemaVersion: 1;
  provider: SessionProviderId;
  scannedSessions: number;
  scannedUserTurns: number;
  skippedUserTurns: number;
  excludedFragments: number;
  patterns: EvidencePattern[];
  artifacts: Record<EvidenceArtifact["type"], EvidenceArtifact[]>;
};
```

Keep this output descriptive, not prescriptive. Do not include fields named
`workflowCandidate`, `skillCandidate`, `recommendation`, or `action`.
Cap `EvidenceExample.text` to a small snippet, default 180 characters. The
top-level `artifacts` record is the global rollup by type; per-pattern
`artifacts` are bounded cross-references that explain why that pattern grouped.

## Usage skill shape

Create a short packaged skill after the CLI behavior exists:
`skills/session-evidence/SKILL.md`.

The skill is an operator guide for agents using the analyzer itself. Its job is
to teach the typical flow, useful filters, what data to inspect, and what
questions to ask of the evidence. It is not a workflow-mining skill, a
skill-creation skill, or an automation.

Frontmatter:

```yaml
---
name: session-evidence
description: Use when analyzing local agent session history with `sessions analyze --include-turns`, extracting neutral transcript evidence, interpreting patterns, or deciding whether evidence should lead to a workflow, skill, indexer, classifier, or process-improvement plan.
---
```

Body requirements:

- Keep the body under 500 lines. Do not add `references/`, scripts, examples,
  or assets unless the skill becomes too long to stay readable.
- Explain that `sessions analyze --include-turns` produces evidence, not
  recommendations. The skill should teach agents how to use that analyzer
  output as input for judgment.
- Give a compact workflow:
  1. Start narrow: choose `--days`, `--workspace`, `--query`, and
     `--min-support` before reading evidence.
  2. Run table output first for scanning, then JSON output for handoff or
     deeper analysis.
  3. Inspect `patterns`, `artifacts`, `support`, `examples`, `sessionId`, and
     `turnIndex`.
  4. Drill into source sessions with `sessions cursor show <sessionId>` only
     when snippets are not enough.
  5. Ask interpretation questions over the extracted data before deciding what
     it means.
  6. Separate observation from interpretation: evidence can suggest a future
     workflow, skill, indexer, classifier, or process plan, but the skill must
     not create one automatically.
- Include recommended command patterns:
  - recent workspace scan:
    `sessions analyze --provider cursor --include-turns --days 30 --workspace /path/to/repo`
  - topic scan:
    `sessions analyze --provider cursor --include-turns --query review --min-support 2`
  - JSON handoff:
    `sessions analyze --provider cursor --include-turns --format json --pattern-limit 20 --evidence-limit 3`
- Include interpretation rules:
  - Treat support as recurrence, not importance.
  - Prefer patterns backed by multiple sessions plus artifacts.
  - Treat one-off patterns as leads only when `--min-support 1` is used.
  - Check examples before naming a follow-up plan.
  - Keep privacy boundaries: summarize sensitive snippets; do not quote
    secrets, tokens, or private transcript text.
- Include useful question patterns agents should ask while analyzing evidence:
  - What do we repeatedly ask agents to do manually?
  - Which review, test, or debug loops keep showing up?
  - Which user preferences appear often enough to become repo guidance or a
    skill?
  - Which artifacts recur: plans, PRs, branches, commands, or paths?
  - Is the index missing useful fields because analysts keep needing transcript
    context?
  - Which patterns are real recurring work, and which are noise from
    automation, handoffs, or review workers?
  - What evidence would justify a separate follow-up plan, and what should stay
    a no-op?
- Include an output shape agents should use when reporting results:
  `Commands run`, `Strong patterns`, `Evidence`, `Possible follow-ups`,
  `Noise/rejected leads`, `Recommended next plan or no-op`.
- Add `skills/session-evidence/agents/openai.yaml` with:

```yaml
interface:
  display_name: "Session Evidence"
  short_description: "Analyze transcript evidence from local agent sessions"
  default_prompt: "Use $session-evidence to run sessions analyze with transcript evidence, inspect recurring patterns, and separate observations from possible follow-up plans."
```

## Extraction rules

Start deterministic and local:

1. Iterate `UserTurn`s from `SessionProvider.iterUserTurns()` with filters.
2. Use `turn.text`, not `turn.rawText`, for evidence extraction. Cursor
   transcript parsing already strips injected blocks and extracts user query
   text when present.
3. Split text into bounded fragments on blank lines, newlines, `!`, and `?`.
   Avoid splitting on `.` by default because paths, versions, filenames, and
   code snippets commonly contain periods.
   - Normalize and keep fragments between 12 and 240 characters.
   - For longer fragments, keep a signal-centered window when possible.
   - Process at most 20 fragments per user turn.
4. Extract artifact values:
   - plan files: `dev/plans/*.md`, `plans/*.md`, or paths ending in
     `-plan.md`
   - PR URLs: GitHub pull request URLs
   - commands: backticked shell commands or lines beginning with common tools
     such as `pnpm`, `npm`, `node`, `git`, `make`, `harness`, `sessions`
   - URLs: `http://` and `https://`
   - paths: absolute paths and repo-relative paths with known extensions
   - branches: backticked branch-looking tokens, or values paired with explicit
     words such as `branch` or `checkout`
   Do not treat every plain token containing `/` as a branch; that is too noisy
   for v1.
5. Assign neutral buckets from lexical signals:
   - `noise`: automated worker, final answer, handoff-only boilerplate
   - `review`: review, code-quality, implementation review, review-spec,
     audit, validate
   - `planning`: plan, spec, phases, roadmap, next, scope
   - `implementation`: implement, build, add, refactor, fix, patch
   - `testing`: test, vitest, baseline, coverage, flaky, check
   - `debugging`: debug, failure, failed, error, broken, investigate
   - `git-pr`: pr, pull request, branch, commit, merge
   - `research`: read article, investigate, compare, understand
   - `preference`: prefer, always, never, make sure, do not, don't
6. Apply bucket precedence before grouping:
   `noise` -> `preference` -> `git-pr` -> `debugging` -> `testing` ->
   `review` -> `planning` -> `implementation` -> `research` -> `other`.
   If a fragment is assigned `noise` or matches `NOISE_MARKERS`, exclude it
   from `patterns`, and increment `excludedFragments`; do not also bucket it as
   `review`.
7. Group similar fragments with explainable deterministic keys, not embeddings:
   `groupKey = bucket + ":" + dominantSignal + ":" + normalizeSnippet(fragment).slice(0, 80)`.
   `dominantSignal` is the longest matching signal in the winning bucket's
   signal list; break ties lexicographically for stable tests.
   `label` should be a readable truncation of the normalized fragment, not a
   recommendation.
8. Only emit patterns whose support is at least `--min-support`. Default `2`;
   allow `--min-support 1` for exploratory runs.
9. Only emit patterns with at least one lexical signal. Artifacts alone can
   appear in the global artifact rollup, but should not create patterns.
10. Support counts distinct sessions, not duplicate fragments from the same
   session.
11. Bound examples, per-pattern artifact samples, and each top-level artifact
    type rollup by `--evidence-limit`.
12. Sort patterns by support descending, then bucket, then label.

## Steps

### Step 1: Add provider-neutral evidence extraction

Create `lib/sessions/core/evidence.ts`.

Implement:

- exported result types from **Evidence model**
- `extractSessionEvidence(turns, options)`
- fragment extraction helpers
- artifact extraction helpers
- bucket/signal assignment helpers
- grouping/support counting helpers

Reuse existing helpers from `lib/sessions/core/analyze.ts` where useful:
`normalizeSnippet`, `phraseMatches`, `PREFERENCE_MARKERS`, and
`NOISE_MARKERS`.

Do not add methods to `SessionProvider`; compose the provider iterator in the
CLI.

**Verify**: `pnpm typecheck` -> exit 0.

### Step 2: Add focused evidence tests

Create `test/sessions/core/evidence.test.ts`.

Cover:

- fragments are extracted without splitting paths on `.`
- repeated requests across sessions become one pattern with support counted by
  distinct session id
- duplicate fragments in one session do not inflate support
- review/planning/testing/git-pr/debugging/preference buckets are assigned from
  lexical signals
- noise fragments are excluded before review/testing signals can create
  patterns
- plan files, PR URLs, branch names, commands, and paths are extracted as
  artifacts
- examples and artifacts are bounded by `evidenceLimit`
- top-level artifact rollups are bounded by `evidenceLimit` per artifact type
- one-off fragments are hidden by default via `minSupport`, and included when
  `minSupport` is `1`
- example text is truncated to the configured snippet length
- output ordering is deterministic

Model test style after `test/sessions/core/analyze.test.ts`: direct imports,
plain fixture objects, no filesystem unless required.

**Verify**:

```bash
pnpm exec vitest run test/sessions/core/evidence.test.ts
```

Expected: new test file passes.

### Step 3: Extend `sessions analyze`

In `bin/sessions.ts`, extend the existing top-level `analyze` command:

- add `--include-turns`
- add `--days`, `--workspace`, `--query`, and `--include-automation` filters
  for turn evidence only
- add `--evidence-limit`
- add `--pattern-limit`
- add `--min-support`
- relabel current table output:
  - `Self-improve marker candidates` -> `Lexical marker counts (metadata only)`
  - `Index improvement candidates` -> `Index quality signals`
- table output should append a clearly labeled section:
  `Transcript evidence patterns`
- JSON output should include the evidence report under an `evidence` field only
  when `--include-turns` is set

Do not change default `sessions analyze` performance. It must still use the
cache-only path unless `--include-turns` is present.

**Verify**:

```bash
pnpm run build
node dist/bin/sessions.js analyze --provider cursor --include-turns --format json
```

Expected: exits 0 when a Cursor cache exists and prints parseable JSON with an
`evidence.patterns` array.

### Step 4: Add CLI integration tests

Extend `test/sessions/cli.test.ts` or create
`test/sessions/evidence-cli.test.ts` if the file becomes too large.

Cover:

- default `sessions analyze` does not include evidence and does not need
  transcript files
- `--include-turns --format json` includes `evidence.patterns`
- `--include-turns` table output includes `Transcript evidence patterns`
- `--days`, `--workspace`, and `--query` narrow scanned sessions
- `--include-automation` changes the scan set
- turn-only filters such as `--days` are rejected when `--include-turns` is not
  set
- `--min-support` hides one-off patterns by default
- table output uses neutral metadata labels and does not render
  `Self-improve marker candidates`
- missing/unreadable transcript errors are clear and suggest reindexing,
  matching existing provider behavior

Use temp `HOME` and real transcript fixtures through `writeTranscript` +
`buildCursorIndex`, not cache-only rows. Do not read live `~/.cursor`.

**Verify**:

```bash
pnpm exec vitest run test/sessions/core/evidence.test.ts test/sessions/cli.test.ts
```

Expected: all listed tests pass. If you split evidence CLI coverage into
`test/sessions/evidence-cli.test.ts`, include that file in the command too.

### Step 5: Add the session evidence usage skill

Create:

- `skills/session-evidence/SKILL.md`
- `skills/session-evidence/agents/openai.yaml`

Follow **Usage skill shape** exactly unless implementation reveals a concrete
reason to adjust wording. Keep the skill procedural and neutral: it teaches
agents how to extract and interpret evidence, not how to automatically create
workflows or skills.

Do not create `references/`, scripts, examples, or assets for this skill unless
the `SKILL.md` would otherwise exceed 500 lines. If extra files seem necessary,
stop and report; do not expand the skill silently.

**Verify**:

```bash
test -f skills/session-evidence/SKILL.md && test -f skills/session-evidence/agents/openai.yaml
pnpm exec vitest run test/skills.test.ts
```

Expected: both commands exit 0.

### Step 6: Full validation and docs

Run:

```bash
pnpm run format
pnpm typecheck
pnpm exec vitest run test/skills.test.ts
pnpm exec vitest run test/sessions/**/*.test.ts
pnpm exec vitest run test/cli.test.ts test/sessions/**/*.test.ts
pnpm run build
make check
```

Expected: every command exits 0.

Only after implementation is complete, update `dev/plans/README.md` to mark
this plan `done`.

## Test plan

- Pure evidence tests in `test/sessions/core/evidence.test.ts` for fragment
  extraction, artifact extraction, grouping, support counts, limits, and
  deterministic ordering.
- Unit tests for noise precedence, `minSupport`, snippet truncation, and
  duplicate fragments from the same session.
- CLI tests with real transcript fixtures for `sessions analyze --include-turns`.
- Regression test that default `sessions analyze` stays cache-only.
- Regression test that automation/review-worker text does not dominate default
  turn evidence.
- Regression test that metadata analyze labels are neutral and do not contain
  `Self-improve marker candidates`.
- Skill file smoke check for `skills/session-evidence/SKILL.md` and
  `skills/session-evidence/agents/openai.yaml`.
- Build test through `pnpm run build` so the new analyzer options compile into
  `dist/bin/sessions.js`.

## Done criteria

- [x] `lib/sessions/core/evidence.ts` exists with exported evidence report
      types and deterministic extraction.
- [x] `sessions analyze --provider cursor --include-turns` exists.
- [x] Default `sessions analyze` remains cache-only.
- [x] JSON output includes neutral evidence under `evidence` only when
      requested.
- [x] Table output includes `Transcript evidence patterns` only when requested.
- [x] Table output uses neutral metadata labels for marker counts and index
      quality signals.
- [x] Artifact extraction covers plan files, PR URLs, branches, commands, URLs,
      and paths.
- [x] Example snippets are bounded and include session/turn provenance.
- [x] One-off patterns are hidden by default unless `--min-support 1` is used.
- [x] Pattern support counts distinct sessions.
- [x] The analyzer command does not modify or propose workflows, skills,
      AGENTS files, Cursor rules, or repo instruction changes.
- [x] `skills/session-evidence/SKILL.md` exists and explains how to run,
      inspect, and interpret transcript evidence without automating follow-up
      decisions.
- [x] `skills/session-evidence/agents/openai.yaml` exists and matches the
      skill.
- [x] Focused evidence tests pass.
- [x] `pnpm exec vitest run test/skills.test.ts` exits 0.
- [x] `pnpm typecheck` exits 0.
- [x] `pnpm exec vitest run test/sessions/**/*.test.ts` exits 0.
- [x] `pnpm run build` exits 0.
- [x] `make check` exits 0.
- [x] `dev/plans/README.md` status row is updated to `done` only after
      implementation lands.

## STOP conditions

Stop and report back if:

- Useful grouping requires semantic similarity, embeddings, or LLM judgment.
- Evidence extraction needs to dump private full transcript text instead of
  bounded snippets.
- The first evidence report is dominated by review-worker/handoff noise after
  default filters.
- Scanning a typical local cache with `--include-turns` and no narrowing takes
  more than 30 seconds; tighten defaults or add an explicit bound before
  continuing.
- Evidence JSON exceeds 1 MB with default limits; tighten snippet, pattern, or
  artifact caps before continuing.
- Supporting `codex` requires building a Codex session provider.
- The command needs to change `harness run change-review` or workflow code.
- `sessions analyze` becomes slow by default without `--include-turns`.
- The usage skill starts prescribing concrete workflow/skill creation instead
  of teaching evidence interpretation.
- The usage skill needs references, scripts, examples, or assets to stay
  understandable; report before expanding it beyond a short skill.
- A verification command fails twice after a reasonable fix attempt.

## Maintenance notes

- This is an evidence layer. Keep it neutral and reusable.
- Do not turn extracted evidence into workflow proposals or skill proposals in
  this plan.
- If later work adds workflow-opportunity reports, skill-improvement reports,
  or semantic clustering, put each behind a separate plan and consume this
  evidence output as input.
- Plausible follow-up consumers are separate plans such as
  `session-workflow-opportunities`, `session-skill-signals`, and
  `session-indexer-signals`. They should read `evidence.patterns` and
  `evidence.artifacts` rather than changing this extractor into a recommender.
- The `session-evidence` skill is the bridge for agents: it should teach how to
  use the neutral evidence output and how to report possible follow-ups, while
  still requiring separate plans for workflow, skill, indexer, or process
  changes.
- Keep privacy review explicit. If examples start exposing credentials, tokens,
  or private transcript text, add redaction before expanding output volume.
- Reviewers should scrutinize privacy, deterministic grouping, transcript scan
  cost, and whether labels remain descriptive rather than prescriptive.
