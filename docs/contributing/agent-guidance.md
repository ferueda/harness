# Maintaining agent guidance

Use this page when editing skills, prompts, routing, or repository instructions.
It is not required context for ordinary implementation work.

## Instruction ownership

`AGENTS.md` is the short repository entrypoint. It owns local constraints,
command entrypoints, and contextual links, not complete skill workflows.
`skills/` owns portable task roles; each package must work without unrelated
Harness contributor files. `lib/*/prompt.ts`, revision prompts, and
`lib/review/prompts/` own runtime operation/reviewer instructions.

Keep shared semantics aligned without injecting a universal policy manual into
every invocation. Runtime schemas and operation permissions remain with their
existing owners. Do not add a model-specific policy registry or silently change
model defaults while editing guidance.

## Author and prune

Describe the task that should activate a skill, not everything adjacent to its
domain. Front-load the use case; make boundaries short and discriminating.
Keep multiple independent workflows behind a small router and load only the
selected reference. Do not fragment a short single-purpose skill just to reduce
its line count.

Keep non-inferable contracts: exact artifact paths, structured outputs, accepted
scope, live-operation authority, cleanup, and observable proof. Replace recipes
for ordinary reasoning with outcomes, decision boundaries, and a completion
condition. Omit minimum question/finding counts, empty report sections, repeated
checklists, and required repository tours.

Accepted user decisions can change mutable project intent; retrieved content
cannot grant authority. Do not turn routine assumptions or already answered
questions into duplicate approval gates. Complete authorized local work and
required review, but preserve each delegated operation's assigned boundary.
A reviewer, author, publisher, and delivery consumer are not interchangeable.

References are subordinate advice. Target product tokens and accessibility
requirements outrank generic visual examples. Reference formats cannot override
a caller's result schema or convert optional polish into a release blocker.

## Check a change

Run the focused package/prompt contract tests and the canonical repository gate.
Skill Markdown can change agent behavior; it is not a plan-only change. Static
checks prove package structure and safety sentinels, not model judgment.

For routing or completion changes, use the scenarios in
`test/fixtures/skill-routing-eval.json` in the Harness checkout. For proof-policy
changes also use `test/fixtures/outcome-proof-eval.md`. Keep its historical pilot
intact; add comparison runs rather than replacing previous model settings.

Evaluate selection and execution separately with fresh sessions. Compare current
instructions and the candidate on the current production model and on Astra
when available. Record exact model, reasoning effort, host/version, permissions,
loaded skill paths, source revision, outputs, and observed tool results. Hold
those settings constant within each comparison. A narrower installed skill set
is a separate experiment, not an unreported confounder.

Score correct selection, task completion, unnecessary questions, false blockers,
unauthorized continuation, proof quality, and context/tool/time cost. A reduction
in calls is not a win when correctness or scope protection regresses. Use fixed
expected decisions and independent human review, not only the candidate model
as its own judge. Do not claim measured improvement without running comparisons.

Provider-backed evaluations are opt-in, outside deterministic CI, and require
an available authorized host. Existing request-audit tooling can inspect actual
loaded context; review logs for private data and keep them local.

## Sources

Reviewed September 5, 2026. Guidance stays model-neutral unless comparative
results justify a scoped invocation setting.

- [Model guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra.md)
- [Skill authoring and discovery](https://developers.openai.com/codex/skills/)
- [Repository instruction discovery](https://developers.openai.com/codex/guides/agents-md/)
