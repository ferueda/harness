# Packaged skills

Install only the roles a target repository needs. `SKILL.md` descriptions are
selection hints; bodies load on activation, and references load when relevant.
This catalogue is for selection and maintenance, not mandatory task context.

## Choose by deliverable

For a clear build or fix, implement directly using target-repository guidance.
Use `planning-workflow` only when the next action is unclear or coordination is
requested. Investigation does not make a plan inevitable.

- Clarify blocking intent or conduct an explicit interview: `shape-requirements`.
- Establish uncertain code behavior and cause: `diagnose-issue`.
- Design a solution when explicitly invoked: `architect`.
- Challenge a proposed design before planning: `adversarial-review`.
- Write a durable implementation plan: `create-plan`.
- Review an implementation plan: `review-spec` or `harness run plan-review`.
- Review a diff read-only for correctness: `review-implementation`.
- Review substantive structural risks read-only: `code-quality-review`.
- Select proportionate review and authorized remediation: `change-review-workflow`.
- Explain behavior and tradeoffs without reviewing merge safety: `explain-change`.
- Transfer context to another agent/session: `handoff-work`.

At a coherent completion point, assess the complete change. Skip routine,
low-risk work; use implementation for material behavioral risk, quality for
substantial structural risk, or both when they answer distinct questions. A test
edit or new commit alone does not trigger review. Explicit review requests and
mandatory caller gates still apply; required checks remain separate. Pass
`--steps` deliberately when invoking change-review. Report a justified skip as
not independently reviewed, never as a pass.

A review-only request does not grant fix or publication authority. An explicit
full workflow continues through its authorized checks and fixes within the
review budget. No new catch-all skill is needed for ordinary repository surveys
or documentation corrections; answer those tasks directly with scoped evidence.

## Installation and resolution

Use `npx skills add ferueda/harness` to select skills for a supported host, or:

```bash
harness skills install change-review-workflow --workspace /path/to/repo
```

The Harness command copies exactly the named skill and its bundled references
into target `.agents/skills/`. It does not install sibling skills, fetch updates,
or resolve workflow dependencies. Repeat it for explicitly chosen additional
roles. Existing copies are skipped unless replacement is explicitly requested;
inspect generated help and local changes before using `--force`.

Use the host's discovered skill paths. Neither sibling paths nor a user-level
fallback are guaranteed. When a workflow requires a missing child, report the
missing dependency; do not claim to run it or install more without permission.
Optional specialist guidance may be omitted while completing the bounded task.

Updating Harness does not remove previously copied skills from target repos.
The retired `audit` and `docs-drift-review` packages and doc-drift automation are
no longer distributed. Remove their old target/user copies and scheduled
invocations only with the owner's authority; this change does not edit installed
skills in any repository.

## Maintenance

Each directory has one short task-specific description and a self-contained
`SKILL.md`; keep required local references inside that package. Optional
`agents/openai.yaml` controls host presentation and invocation policy.
`architect` remains explicit-only. Do not add hidden global reading dependencies.

Portable skills and Harness runtime prompts are separate entrypoints. Changes
to shared authority, proof, or review semantics must be checked in both; the
runner does not load the corresponding packaged reviewer as its policy.
See `docs/contributing/agent-guidance.md` in the Harness checkout for maintenance
and opt-in evaluation guidance, not an execution prerequisite in target repos.
