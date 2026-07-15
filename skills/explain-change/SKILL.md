---
name: explain-change
description: Brief a code change, diff, branch, commit range, or pull request so the user can decide whether to approve, merge, revise, or build on it. Use when the user asks for a walkthrough of what changed or how it works, wants behavior or day-to-day impact, asks about API, contract, or boundary changes, questions diff size or complexity, or wants accepted tradeoffs.
---

# Explain Change

Produce an evidence-backed change briefing. Organize it around behavior,
decisions, and an acceptance-level mental model.

## Success Criteria

Finish when the user can explain the change and make the requested next
decision from supported facts, visible tradeoffs, and clearly named unknowns.

## Authority

Use this order:

1. Repository guidance and documented project intent.
2. The original request, accepted plan, issue, ADR, and settled decisions.
3. The actual diff, current code, directly affected consumers, and tests.
4. PR descriptions, commit messages, and handoffs as claims to verify.

Keep explanation-only work read-only. When the request also authorizes a change
or publication, complete that work first and brief the resulting scope.

## 1. Resolve the Change

Select the explicit PR, branch, commit range, or working-tree diff. When the
user implies the current change and only one credible scope exists, use it and
state the choice. Ask for the smallest missing scope only when multiple choices
would produce materially different briefings.

Resolve the real base and head. Refresh remote PR evidence when the request
names a PR. Include staged, unstaged, deleted, renamed, generated, and untracked
files that belong to a local change.

**Complete when:** the base, head, current state, and every file in scope are
known.

## 2. Build the Mental Model

Read the changed code and enough unchanged surrounding code to explain the old
path. Inspect entry points, callers, consumers, tests, and intent sources that
establish why the change exists.

Group files into conceptual parts. Trace each material path from its user,
operator, or system entry point through decisions and state changes to its
observable result. Use concrete examples when they make behavior clearer.

**Complete when:** the old behavior, new behavior, implementation shape, and
reason for the change can each be stated plainly.

## 3. Build the Surface Ledger

Assess each surface that the change could materially affect:

- user, developer, or operator behavior;
- CLI, HTTP, package, or internal API contracts;
- schemas, durable files, events, messages, and provider protocols;
- data ownership, module boundaries, trust boundaries, and side effects;
- failure, retry, recovery, and concurrency behavior;
- compatibility, migration, rollout, and reversibility;
- security, privacy, performance, cost, and operability; and
- tests and other proof for changed behavior.

For every material surface, establish **before**, **after**, **evidence**, and
**compatibility impact**. Name important preserved surfaces when that answers a
likely concern. Omit surfaces with no useful bearing on the decision.

**Complete when:** every material observable or durable effect is either
explained or identified as missing evidence.

## 4. Build the Tradeoff Ledger

For each accepted tradeoff, state:

- the benefit gained;
- the cost, limitation, risk, or behavior given up;
- the rejected alternative and rationale, when evidence exists; and
- reversibility or the condition that should reopen the decision.

Label a tradeoff **explicit** when an authoritative source records its
acceptance. Label it **inferred** when it follows from the implementation but
its acceptance is undocumented. State when available evidence shows no
material tradeoff; infer only from implementation evidence.

When the user questions diff size, complexity, or overengineering, quantify the
main sources of churn and map them to product behavior, safety, compatibility,
tests, documentation, or incidental complexity. Give a clear verdict:
**proportional**, **mixed**, or **disproportionate**.

Route requests for defect-finding, correctness, or merge safety through the
applicable review workflow when available, then use its result as evidence in
the briefing. Use this skill alone for explanation, impact, and proportionality.

**Complete when:** every material tradeoff is labeled explicit or inferred,
its cost and rationale are grounded, and any proportionality verdict is
supported by the diff.

## 5. Deliver the Briefing

Lead with the conclusion. Use inline Markdown unless the user requests another
format. Include only sections that help answer the request, usually drawn from:

- **What changes**
- **Before and after**
- **How it works**
- **Change surfaces**
- **Tradeoffs accepted**
- **Why the diff is this size**
- **Evidence and open questions**
- **Decision or next unlock**

Center day-to-day requests on the changed workflow. For “what happens after it
lands,” explain both immediate impact and newly available next work. Attach
file, test, plan, or PR evidence near the claim it supports. Use a small diagram
only when it makes a multi-step flow or boundary clearer than prose.

Prefer existing verification evidence. Run a narrow, non-destructive check only
when a material claim cannot be resolved from code and recorded results. Stop
once the success criteria are met; preserve facts, decisions, caveats, and next
steps before adding optional background.
