# Agent Harness — Work Handoff

**Status:** `in_progress`  
**Created:** 2026-06-21  
**Repo:** `agent-skills` today; migrate into new single repo `harness`  
**Owner:** Felipe

---

## Executive summary

We are building **`harness`** — a single repo for agent instructions, custom workflows, and the runner that orchestrates multi-agent coding workflows (review, implement, verify) across **many target repos**, with **durable execution** as the long-term goal.

**Phase 0 is done** in this repo: a sequential dual-review pipeline (`review-implementation` → `code-quality-review`) invoked via `run-dual-review.mjs`, writing artifacts to `<target-repo>/.agent-runs/reviews/`.

**Next agent should:** create the new `harness` repo, migrate this repo's skills and Phase 0 review pipeline into it, then build the simplest live `dual-review.workflow.js` before adding broader primitives.

---

## Context

### Goal

Build production-grade **agent loop architecture** for Felipe's personal coding workflow:

1. Run agents against **external repos** (`--workspace /path/to/app`)
2. Keep **one `harness` repo** to maintain; target repos stay clean
3. Persist **audit artifacts** in each target repo (`.agent-runs/`)
4. Compose existing **skills** (`implement-plan`, `handoff-work`, `review-implementation`, `code-quality-review`, `react-to-review`) into automated pipelines
5. Evolve toward **durable orchestration** (checkpointed steps, retries, triggers, hill-climbing meta-loops)

### What “done” looks like (north star)

| Layer | Primitive | End state |
|-------|-----------|-----------|
| **Instructions** | `skills/*/SKILL.md` in `harness` | Model-agnostic playbooks; globally installed to `~/.agents/skills/` |
| **Workflows** | `workflows/*.workflow.js` in `harness` | Multi-step pipelines: verify → review → export |
| **Orchestrator** | Inngest (planned Phase 2) | `step.run()` checkpointing, cron/webhooks, `onFailure`, concurrency |
| **Artifacts** | `.agent-runs/` in target repos | Step traces, JSON reviews, `summary.md`, resumable `steps.json` |
| **Triggers** | GH Actions → inbox → Inngest | Loop 3: event-driven, not manual-only |

### Starting point (before this work)

- `agent-skills` repo: collection of static skills for planning, implementing, reviewing
- `cursor-cli` skill: headless Cursor Agent wrapper (`cursor-agent.mjs`) with `--schema`, `--mode ask`, session resume
- `AGENTS.md` workflow: `implement-plan` → `handoff-work` → review → `react-to-review`
- No automated multi-reviewer pipeline; no durable orchestration

### Constraints (locked decisions)

1. **Single repo:** `harness` owns instructions, workflows, runner, and future orchestrator code
2. **Invocation:** harness always takes `--workspace <target-repo>`; never copy harness into each app
3. **Artifacts:** live in **target repo** at `.agent-runs/` (gitignored); not in harness repo
4. **Review order:** `review-implementation` first (adversarial/correctness), then `code-quality-review` (maintainability; sees reviewer 1 output)
5. **Export rule:** LLM produces structured JSON; **code** produces human reports (`summary.md`) — never ask an LLM to write final artifacts
6. **Human gates:** `react-to-review` and merge remain human/agent decisions; harness does not auto-merge or auto-fix without explicit future phase
7. **Terminology:** use **skills** only for `SKILL.md` instructions; use **workflows** or **pipelines** for runnable orchestration

### Out of scope (for now)

- Self-authoring loops (Inngest utah sidecar pattern)
- Auto-mutating skill prompts without human PR (Loop 4 hill-climbing is Phase 3+)
- Full Inngest deployment (Phase 2)
- Moving `cursor-cli` outside `skills/`

---

## Reference material

### Articles (frameworks to design against)

**1. Agent Loop Architecture (Inngest)**  
Three layers:

- **Loop** — cron/trigger + LLM decision-maker
- **Skill** (their term) — durable multi-step workflow with checkpointing
- **Orchestrator** — retries, concurrency, run history, `onFailure`

Key requirements durability enables: independent step retry, sub-agent lifecycle, guaranteed delivery, post-hoc observability, hot-deploy, concurrency control. Step-level checkpointing saves tokens on retry.

**2. The Art of Loop Engineering (LangChain / loopcraft)**  
Four stacked loops:

| Loop | Purpose | Our mapping |
|------|---------|-------------|
| 1 Agent | model + tools until done | `implement-plan`, `cursor-cli` |
| 2 Verification | grader + retry with feedback | dual-review (+ future deterministic graders) |
| 3 Event-driven | triggers at scale | GH Action / inbox / Inngest (not built) |
| 4 Hill climbing | traces → improve harness | meta-review over `.agent-runs/` (not built) |

**3. TradingFlow (Claude Code Dynamic Workflow)**  
https://github.com/lxcong/TradingFlow/blob/main/tradingflow.workflow.js

Reference implementation for **workflow composition** (not durability). Study for DSL shape, not execution engine.

---

## Architecture vision

```
┌─────────────────────────────────────────────────────────────────┐
│  harness (NEW REPO)                                              │
│  skills/                                                         │
│    review-implementation, code-quality-review, implement-plan,   │
│    react-to-review, handoff-work, ...                            │
│  workflows/dual-review.workflow.js                               │
│  lib/workflow-context.js                                         │
│  orchestrator/ (Phase 2: Inngest)                                │
└────────────────────────────┬────────────────────────────────────┘
                             │ CLI runs with --workspace
┌────────────────────────────▼────────────────────────────────────┐
│  target-repo (any app)                                           │
│  src/...                                                         │
│  dev/plans/ (optional)                                           │
│  .agent-runs/reviews/<run-id>/  ← artifacts                      │
└─────────────────────────────────────────────────────────────────┘
```

### End-to-end workflow (target)

```
implement-plan → handoff-work → [harness: verify → dual-review → export]
  → react-to-review (human/agent triage) → human merge
```

---

## What was worked on (Phase 0 — complete in this repo)

### Deliverable

`skills/review-pipeline/` — sequential dual-review via headless Cursor agents.

**Flow:**

1. `prepareGitScope` — merge-base diff (`base..head`)
2. Write `context/diff.patch`, optional plan/handoff copies
3. Invoke `cursor-agent.mjs` with `--mode ask` + JSON schema — **review-implementation**
4. Invoke again with prior review JSON inlined — **code-quality-review**
5. `aggregateVerdict()` → `summary.md` + `meta.json`
6. Exit `0` pass, `1` needs_changes/blocked/failure, `2` usage error

### Key files (Phase 0)

| Path | Role |
|------|------|
| `skills/review-pipeline/scripts/run-dual-review.mjs` | Main orchestrator (imperative; to be replaced by workflow DSL) |
| `skills/review-pipeline/scripts/lib/context.mjs` | Git scope, prompt templates, diff handling |
| `skills/review-pipeline/scripts/lib/aggregate.mjs` | Verdict rollup + `renderSummary()` |
| `skills/review-pipeline/schemas/review-output.schema.json` | Shared schema for both reviewers |
| `skills/review-pipeline/prompts/implementation-review.md` | Reviewer 1 prompt template |
| `skills/review-pipeline/prompts/quality-review.md` | Reviewer 2 prompt template |
| `skills/review-pipeline/SKILL.md` | Usage docs |
| `skills/review-pipeline/scripts/run-dual-review.test.mjs` | 9 unit tests (all passing) |

### Artifact layout (contract v0)

`<workspace>/.agent-runs/reviews/<run-id>/`:

```
meta.json                      # run metadata, verdict, session IDs, scope stats (no full diff)
summary.md                     # human rollup (deterministic renderSummary)
implementation-review.json     # structured reviewer 1 output
quality-review.json            # structured reviewer 2 output
implementation-review.prompt.md
quality-review.prompt.md
context/diff.patch
context/plan.md                # if --plan provided
context/handoff.md             # if --handoff provided
```

### Usage

```bash
# Dry-run (no LLM)
node skills/review-pipeline/scripts/run-dual-review.mjs \
  --workspace /path/to/target-repo --dry-run

# Full run
node skills/review-pipeline/scripts/run-dual-review.mjs \
  --workspace /path/to/target-repo \
  --base main --head HEAD \
  --plan dev/plans/foo.md \
  --handoff .agent-runs/handoff.md

# Tests
node --test skills/review-pipeline/scripts/run-dual-review.test.mjs
```

### Prerequisites

- `agent` on PATH (`agent login` or `CURSOR_API_KEY`)
- `skills/cursor-cli` at `skills/cursor-cli/` or `~/.agents/skills/cursor-cli/`

### Known Phase 0 limitations

- **Not durable:** process death after reviewer 1 → full re-run, duplicate tokens
- **No resumability:** no `steps.json` yet
- **LLM-only verification:** no deterministic pre-checks (tests/lint)
- **No triggers:** manual CLI only
- **Full JSON passed to reviewer 2:** token-heavy; needs digest
- **Same schema for both reviewers:** works but TradingFlow uses role-specific schemas
- **Lives in old repo:** should migrate to `harness`

---

## Design lessons (conversation synthesis)

### From articles — gaps to close

| Gap | Fix | Phase |
|-----|-----|-------|
| LLM-only verification | Add deterministic `test` + `lint` steps before reviewers | 1 |
| No retry-with-feedback | Optional fix-and-re-review loop (max 2 rounds) | 2.5 |
| No checkpointing | `steps.json` resumability, then Inngest `step.run()` | 0.5 → 2 |
| Artifact leakage risk | Gitignore `.agent-runs/`; keep artifacts local by default | 0.5 |
| Triggers deferred too far | GH Action + `.agent-runs/inbox/` event file | 1.5 |
| No hill climbing | Weekly meta-review of `.agent-runs/` → prompt PRs | 3 |
| No concurrency guard | Lock per branch SHA | 2 |
| No `onFailure` notify | Pluggable notifier (file → slack) | 2 |

### From TradingFlow — adopt (especially 1–4)

**1. Workflow-as-code, but start tiny**  
First harness workflow should be a custom, concrete `dual-review.workflow.js` that proves the live agent loop. Do not build a general workflow framework before one real workflow works end-to-end.

```javascript
export const meta = { name: "dual-review" }

export async function run(ctx) {
  const implementation = await ctx.agent("review-implementation")
  const quality = await ctx.agent("code-quality-review", {
    prior: implementation,
  })

  return ctx.export({
    implementation,
    quality,
    verdict: ctx.aggregate([implementation, quality]),
  })
}
```

Initial harness only needs `ctx.agent`, `ctx.aggregate`, and `ctx.export`. Add `phase`, `step`, `parallel`, and an interpreter after the simple workflow has been run live against a real branch.

**2. `meta` block for workflow discovery**  
Each workflow exports `meta`. Start with `name`; add `description`, `whenToUse`, `phases[]`, and `inputs[]` only when CLI help or a runs dashboard needs them. Separate from `SKILL.md` instructions.

**3. Parallel vs sequential discipline**

- **Parallel:** independent deterministic graders (test, lint, typecheck)
- **Sequential:** impl review → quality review (quality needs impl output)

**4. Digest layer between phases**  
Do not pass full `implementation-review.json` to reviewer 2. Add `digestReview(review)` — verdict, summary, findings by severity (~500 tokens). Full JSON stays on disk for `react-to-review`.

### Also adopt (lower priority)

- **`REVIEW_RULES`** shared constant injected into all reviewer prompts (like TradingFlow `DATA_RULES`)
- **Per-step labels** in `meta.json` / `steps.json`: `{ id, label, status, sessionId, durationMs }`
- **Role-specific schemas** instead of one shared `review-output.schema.json`
- **Optional Review Manager** synthesis agent after both reviewers (TradingFlow PM pattern)
- **Flexible inputs:** CLI flags + JSON inbox event file

### What we already do better than TradingFlow

- **Deterministic file writes in Node** — no LLM used as a dumb file writer
- **Structured artifact contract** in target repo

---

## Revised phased roadmap

| Phase | Deliverable | Status |
|-------|-------------|--------|
| **0** | Dual LLM review + artifacts in `agent-skills` | ✅ Done |
| **0.5** | Create new `harness` repo; migrate `skills/`, Phase 0 review pipeline, plans, and docs | **Next** |
| **0.6** | `steps.json` resumability; artifact schema v1; `.agent-runs/` gitignore guidance | Pending |
| **1a** | Implement simple `dual-review.workflow.js`; live LLM smoke test | Pending |
| **1b** | Generalize only proven pieces into small primitives (`agent`, `aggregate`, `export`, then maybe `step`) | Pending |
| **1c** | Deterministic grader; `REVIEW_RULES`; `digestReview()`; split schemas if useful | Pending |
| **1.5** | Triggers: GH Action, `.agent-runs/inbox/review.json` | Pending |
| **2** | Inngest orchestrator; `onFailure`; concurrency per SHA | Pending |
| **2.5** | Capped fix-and-re-review loop | Pending |
| **3** | Hill-climbing meta-review → skill prompt PRs (human-gated) | Pending |

---

## Proposed `harness` repo structure

```
harness/
├── README.md
├── skills/                         # migrated from agent-skills
├── workflows/
│   └── dual-review.workflow.js      # first concrete live workflow
├── lib/
│   ├── workflow-context.js          # ctx.agent, ctx.aggregate, ctx.export
│   ├── cursor-agent.js              # wrapper around cursor-agent.mjs
│   ├── artifacts.js                 # .agent-runs/ writer (shared contract)
│   ├── digest.js                    # digestReview()
│   ├── aggregate.js                 # port from review-pipeline
│   ├── context.js                   # git scope, prompt fill
│   └── graders/
│       ├── test.js
│       └── lint.js
├── schemas/
│   ├── implementation-review.json
│   └── quality-review.json
├── prompts/
│   ├── implementation-review.md
│   ├── quality-review.md
│   └── REVIEW_RULES.md              # shared grounding block
├── orchestrator/                    # Phase 2
│   └── (Inngest functions)
└── package.json                     # optional; Node 18+, no heavy deps initially
```

**Install pattern (target):**

```bash
# harness
git clone harness ~/.harness
ln -sf ~/.harness/bin/harness ~/.local/bin/harness

# skills
ln -sf ~/.harness/skills/* ~/.agents/skills/
```

**Invoke:**

```bash
harness run dual-review --workspace /path/to/app --base main
```

---

## Artifact schema v1 (target — extend Phase 0)

Add `steps.json` alongside `meta.json`:

```json
{
  "runId": "20260621-143022-abc123",
  "schemaVersion": 1,
  "workspace": "/path/to/app",
  "scope": {
    "baseRef": "main",
    "headRef": "HEAD",
    "mergeBase": "abc...",
    "headSha": "def...",
    "diffChars": 4200,
    "diffLines": 180
  },
  "steps": [
    {
      "id": "prepare-context",
      "label": "step:prepare",
      "status": "completed",
      "startedAt": "...",
      "durationMs": 120,
      "outputs": ["context/diff.patch"]
    },
    {
      "id": "verify-tests",
      "label": "grader:test",
      "status": "pending"
    },
    {
      "id": "review-implementation",
      "label": "reviewer:impl",
      "status": "completed",
      "sessionId": "uuid",
      "durationMs": 45000,
      "outputs": ["implementation-review.json"]
    },
    {
      "id": "code-quality-review",
      "label": "reviewer:quality",
      "status": "pending"
    }
  ],
  "verdict": null
}
```

**Keep v1 simple:**

- Statuses: `pending`, `running`, `completed`, `failed`, `skipped`
- Write step outputs to temp files, then rename into place
- On restart, skip only `completed` steps whose listed outputs exist
- Treat `running` from a previous process as retryable
- Any file referenced from prompts, metadata, or `steps.json` must exist
- Keep failure detail in the failed step: `{ error, exitCode, stderrPath? }`

Document this contract in `harness` (versioned).

### Artifact hygiene

- Target repos should gitignore `.agent-runs/`
- Do not upload or publish artifacts by default
- Keep full diffs in `context/diff.patch`, not in `meta.json`
- Prefer relative paths inside artifact JSON when possible; absolute paths are okay for local debugging only
- Store full diffs and rendered prompts locally for debugging; add redaction when a target repo needs it

### Artifact storage

Start with plain files as the source of truth: `meta.json`, `steps.json`, review JSON, prompts, summaries, logs, and context files. This keeps runs inspectable, easy to archive, and easy to debug with normal shell tools.

Do not introduce SQLite in Phase 1. Add it later only as an index over file artifacts when we need cross-run queries, dashboards, retention cleanup, or fast lookup by repo/branch/SHA/verdict. If SQLite is added, files remain canonical; the database is rebuildable.

### Deterministic grader contract

Start with one grader, probably tests. Keep it configurable:

- CLI accepts `--test-command`; otherwise auto-detect common package scripts
- Output shape: `{ id, status, command, exitCode, durationMs, stdoutPath, stderrPath }`
- Large stdout/stderr goes to files, not `steps.json`
- Missing command is `skipped`, failing command is `failed`

---

## Aggregate verdict logic (implemented)

```javascript
// skills/review-pipeline/scripts/lib/aggregate.mjs
// blocked if either reviewer blocked
// needs_changes if either needs_changes OR any finding.must_fix
// pass only if both pass
```

Port verbatim to `harness/lib/aggregate.js`.

---

## Skills for the executor

| Step | Skill / resource | Notes |
|------|------------------|-------|
| Create `harness` repo | — | New single repo for skills, workflows, and runner |
| Migrate skills | Existing `skills/` | Preserve skill directory names and metadata |
| Workflow DSL | TradingFlow `tradingflow.workflow.js` | Reference only; implement own primitives |
| Headless agents | `cursor-cli` / `cursor-agent.mjs` | Migrates into `harness/skills/cursor-cli` |
| Review instructions | `review-implementation`, `code-quality-review` | Migrates into `harness/skills`; workflows reference paths |
| Handoff format | `handoff-work` | Future: standardize handoff → harness input |
| Post-review triage | `react-to-review` | Phase 1: bundle aggregated JSON as input |
| Plan index | `dev/plans/README.md` in target repos | Optional per app |

---

## Verification (Phase 0)

```bash
node --test skills/review-pipeline/scripts/run-dual-review.test.mjs
# 9 tests, all pass

node skills/review-pipeline/scripts/run-dual-review.mjs \
  --workspace /Users/frueda/dev/agent-skills --base main --head HEAD --dry-run
# exit 0; artifacts under .agent-runs/reviews/<run-id>/
```

Full LLM run not verified in this session (requires `agent` auth).

---

## Next steps (ordered)

1. **Create `harness` repo** with approved shape: `skills/`, `workflows/`, `lib/`, `automations/`, `dev/plans/`
2. **Migrate existing skills and docs** from `agent-skills`; preserve paths under `skills/`
3. **Migrate Phase 0 review pipeline** into the new repo as source material, not final architecture
4. **Build the simplest live workflow**: `dual-review.workflow.js` calls `review-implementation`, then `code-quality-review`, then exports structured findings
5. **Keep the first runner small**: load that workflow, pass `--workspace`, write the same artifacts Phase 0 writes
6. **Run a full LLM smoke test** against a real branch before adding generic primitives
7. **Add `steps.json` v1** using the simple status/output rules above
8. **Add `.agent-runs/` gitignore guidance** to harness docs and target repo templates
9. **Extract tiny primitives only after they repeat**: `agent`, `aggregate`, `export`; add `step` when adding graders
10. **Add `digestReview()`** before changing reviewer prompts
11. **Add one deterministic grader** (`step('test', ...)`) with `--test-command`
12. **Add `REVIEW_RULES`** only if the prompts start drifting
13. **Split schemas** only if the shared schema becomes awkward
14. **Archive or redirect `agent-skills`** after migration so there is one source of truth

---

## Open items

| Item | Notes |
|------|-------|
| `harness` repo location | New repo is approved; confirm GitHub org/user before creation |
| `agent-skills` retirement | Decide whether to archive, rename, or leave a README redirect after migration |
| `cursor-cli` ownership | Migrate with the rest of `skills/`; harness depends on it |
| Inngest vs alternatives | Inngest is article's choice; GH Actions acceptable for Phase 1.5 triggers only |
| Review Manager agent | Optional synthesis step; defer unless needed for `react-to-review` input |
| Full LLM smoke test | Run dual-review against a real branch with `agent` auth |
| `.agent-runs/` committed in `agent-skills` | Dry-run created artifacts; add `.gitignore` entry or delete |
| SQLite artifact index | Defer until file artifacts become hard to query across many runs |

---

## Assumptions (do not re-litigate)

1. Harness runs **against** target repos, not just itself
2. Artifacts belong in **target repo** `.agent-runs/`
3. Reviewer order: **implementation → quality** (sequential)
4. New repo is **`harness`**, a single source of truth for skills and workflows
5. Phase 0 code in `agent-skills` is **throwaway scaffold** — port useful pieces into `harness`
6. TradingFlow patterns 1–4 are **approved direction** for harness v1
7. Durability (Inngest) is **Phase 2**, not a blocker for DSL migration

---

## Related paths in this repo

```
dev/plans/260621-agent-harness-handoff.md     ← this file
dev/plans/README.md

skills/review-pipeline/                        ← Phase 0 (migrate out)
skills/cursor-cli/                             ← migrate into harness; runner dependency
skills/review-implementation/SKILL.md          ← instructions only
skills/code-quality-review/SKILL.md
skills/handoff-work/SKILL.md
skills/react-to-review/SKILL.md
skills/implement-plan/SKILL.md
AGENTS.md                                      ← workflow overview
```

---

## Work Handoff (summary block)

**Status:** `in_progress`

### Context
Build a multi-repo agent harness with durable orchestration as the north star. New single repo is `harness`, containing both `skills/` and runnable workflows. Phase 0 dual-review prototype exists in `agent-skills`.

### What was worked on
Phase 0 `review-pipeline` implemented and tested. Architecture, repo split, article analysis, TradingFlow lessons, and revised roadmap documented in conversation and this file.

### How it was done
Node script spawning `cursor-agent.mjs` twice with JSON schemas; file-based artifacts in target repo `.agent-runs/reviews/`.

### Why it was done
Prove Loop 2 (verification) before Loop 3 (triggers) and orchestrator investment. TradingFlow informs workflow DSL shape for harness v1.

### Files referenced
See [Key files (Phase 0)](#key-files-phase-0) and [Related paths](#related-paths-in-this-repo).

### Verification
9 unit tests pass; dry-run succeeds.

### Next steps
Create `harness`; migrate `skills/` and Phase 0 review pipeline; build and live-test the simplest `dual-review.workflow.js`; then add `steps.json`, tiny primitives, `digestReview()`, and one configurable test grader.

### Open items
See [Open items](#open-items) table.
