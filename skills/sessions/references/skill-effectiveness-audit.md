# Skill effectiveness audit

Use this playbook for a bounded retrospective such as: “Find every Codex use
of this skill in the last 10 days. Was each result correct and valuable? Should
the skill change?”

## Contents

- [Audit contract](#audit-contract)
- [Workflow](#workflow)
- [Per-session scorecard](#per-session-scorecard)
- [Failure ownership](#failure-ownership)
- [Controlled probes](#controlled-probes)
- [Worked pattern: classifier skill](#worked-pattern-classifier-skill)
- [Report shape](#report-shape)
- [Common mistakes](#common-mistakes)

## Audit contract

Define before searching:

- provider, time window, timezone, workspace, and whether automation or
  subagent sessions are in scope
- what counts as a skill use: explicit invocation, implicit routing, workflow
  child invocation, or all three
- the skill's intended job, from its `SKILL.md`
- project intent and downstream contracts that define correctness
- separate criteria for **correctness** and **value**

If the request says “every use,” build a complete session inventory for the
scope. Top search matches are only candidates, not proof of completeness.

## Workflow

### 1. Establish expected behavior

Read the audited skill, project intent, relevant schemas, deterministic routing
code, and tests. Write a short rubric before reading outcomes. This limits
hindsight bias and makes disagreements inspectable.

### 2. Refresh and inventory

```bash
sessions codex reindex
sessions codex list --days 10 --workspace /path/to/repo --limit 500
```

Add `--include-automation` and `--include-subagents` only when the audit scope
includes them. Record exclusions. `--workspace` is a literal path prefix; omit
it or repeat the inventory for known worktree paths when the scope crosses
workspaces.

### 3. Discover candidates through multiple lanes

Search the skill name, explicit invocation syntax, and user-language synonyms:

```bash
sessions analyze --provider codex --include-turns --extract-only \
  --days 10 --workspace /path/to/repo \
  --turn-query "triage" --turn-query '$triage' \
  --turn-query "classify" --turn-query "is this ready" \
  --format json
```

`--turn-query` searches user turns, so it can miss an implicitly selected skill.
Reconcile these matches with the full session inventory. Use `sessions codex show`
to verify actual use; do not count a skill name in documentation, review output,
or quoted history as an invocation.

### 4. Reconstruct each use

Start with bounded context, then widen only when needed:

```bash
sessions codex show <session-id> --turn <turn-index> --context 3 \
  --max-tool-chars 2000
```

Capture:

- user intent and evidence available at execution time
- why the skill triggered
- files, tracker items, tools, and external sources inspected
- skill output and downstream action
- persisted canonical artifacts versus raw telemetry
- corrections, user objections, reruns, or later outcomes

### 5. Score facts before interpretation

Build the per-session table from transcript and artifacts. Then judge against
the prewritten rubric. A plausible answer is not necessarily supported; a
correct answer is not necessarily useful.

Use each source for the question it can answer:

| Source                       | Establishes                          |
| ---------------------------- | ------------------------------------ |
| Skill and project intent     | what should happen                   |
| Transcript and raw stream    | what the agent emitted and inspected |
| Validated canonical artifact | what the system accepted             |
| Downstream state and tests   | what the system acted on             |

### 6. Investigate anomalies at the owning layer

Read local provider/runner code when raw events disagree with persisted output.
Consult primary provider documentation or issue trackers for transport or model
behavior. Label inference explicitly.

### 7. Recommend the smallest owning-layer change

Prefer evidence-backed changes to the component that owns the failure. Repeated
instruction gaps usually justify skill edits. A single deterministic contract
violation or high-impact safety issue can justify immediate correction.

## Per-session scorecard

| Field                   | Question                                                              |
| ----------------------- | --------------------------------------------------------------------- |
| Intent                  | What outcome did the user need?                                       |
| Expected skill behavior | What did the skill contract require?                                  |
| Context quality         | Did the run inspect the necessary repo, tracker, and intent evidence? |
| Result                  | What did the skill decide or produce?                                 |
| Correctness             | Was it supported and contract-valid?                                  |
| Value                   | Did it reduce uncertainty or enable the right next action?            |
| Downstream effect       | What canonical artifact or state change followed?                     |
| Failure owner           | Skill, routing, provider, runner, validation, downstream, or none?    |
| Confidence              | High, medium, or low; what evidence is missing?                       |

Useful verdicts:

- **Correct and valuable** — supported decision; useful downstream effect.
- **Correct, low value** — technically sound but obvious, redundant, or not
  actionable.
- **Useful, partly incorrect** — moved work forward but relied on an unsupported
  claim or violated part of the contract.
- **Incorrect** — wrong decision, unsupported evidence, or harmful next action.
- **Unclear** — transcript or outcome evidence is insufficient.

Judge the run using facts available then, not knowledge learned later.

## Failure ownership

| Symptom                              | Likely owner                     | Check                                         |
| ------------------------------------ | -------------------------------- | --------------------------------------------- |
| Wrong skill selected                 | routing or skill description     | trigger text and neighboring skills           |
| Correct skill, weak investigation    | skill instructions               | required evidence and tool guidance           |
| Correct reasoning, invalid object    | prompt/schema/validation         | provider schema and runtime parser            |
| Correct final artifact, noisy stream | provider or runner               | event phases and final selection logic        |
| Correct classification, wrong action | deterministic downstream mapping | route mapper and projection tests             |
| Good result, impossible to audit     | observability                    | raw artifacts, canonical artifacts, telemetry |

Do not “fix” provider behavior with stronger prompt wording unless a controlled
probe shows wording owns the behavior. Do not filter raw diagnostics merely to
make them resemble the canonical result.

## Controlled probes

Use throwaway inputs when causality remains unclear. Change one factor per run:

| Probe             | Compare                                      |
| ----------------- | -------------------------------------------- |
| Structured schema | schema on versus off                         |
| Tool use          | tools available/used versus no tools         |
| Prompt wording    | original versus revised instruction          |
| Provider path     | streamed versus non-streamed, when supported |

For each probe, record event count, message phases when observable, final
response, validation result, and persisted artifact. Keep provider, model,
workspace, and input stable. Clean up temporary tracker issues, branches, and
other external fixtures afterward.

Probes explain mechanisms; they do not replace the real-session audit.

## Worked pattern: classifier skill

A recent classifier audit used this sequence:

1. Enumerate all Codex sessions in the requested window and identify five real
   classifier runs.
2. Compare each decision with the skill contract, project intent, repository
   evidence, runtime schema, and deterministic route mapping.
3. Score the decisions separately for correctness and usefulness.
4. Notice schema-shaped progress messages in every raw stream while the
   canonical persisted decisions remained final-only and correct.
5. Reproduce the anomaly with three probes: schema without tools, schema with
   tools, and tools without schema.
6. Inspect provider and SDK behavior, then confirm the limitation in the
   provider's primary issue tracker.
7. Assign fixes by ownership: improve the classifier contract where real
   decision gaps existed; document artifact authority and add runner telemetry
   for stream ambiguity; do not pretend prompt wording can suppress an upstream
   event behavior.
8. Smoke-test representative routes with temporary tracker items, validate
   canonical artifacts, and delete the fixtures.

The key lesson: evaluate the skill's decision quality independently from the
transport that carries its progress and final response.

## Report shape

```markdown
## Scope and method

- Provider / window / workspace:
- Invocation definition and exclusions:
- Commands and sources:

## Findings

| Session | Intent | Result | Correct? | Valuable? | Evidence | Owner |
| ------- | ------ | ------ | -------- | --------- | -------- | ----- |

## Cross-cutting patterns

- Healthy behavior:
- Repeated gaps:
- Isolated anomalies:

## Recommendations

1. Change, owning layer, evidence, expected effect.
2. No-change decisions and why.

## Confidence and missing evidence
```

Include session ids and turn indexes for traceability, but summarize sensitive
content. Distinguish observed facts, controlled-probe results, and inference.

## Common mistakes

- Treating fuzzy metadata search as transcript search.
- Claiming exhaustive coverage from the first few matches.
- Counting quoted skill names as invocations.
- Reading only the final answer and missing tool or downstream context.
- Treating raw progress as the authoritative artifact.
- Collapsing correctness and value into one score.
- Blaming the skill for provider, runner, or deterministic mapping defects.
- Editing instructions before reproducing a suspected mechanism.
- Leaving throwaway external fixtures behind.
- Reporting conclusions without session ids, turn indexes, or confidence.
