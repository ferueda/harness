# Review Handoff

Write only context the task, plan, and diff cannot provide. Omit empty sections.

## Default shape

```markdown
## Goal

Accepted outcome and plan/spec reference when available.

## Review scope

Selected roles and their concrete purpose; required caller/repository gates.
Exact reviewed revision and any uncovered local changes.

## Decisions and boundaries

Accepted decisions, intentional deviations, and concrete non-goals.

## Verification

Checks and observed results, including skipped checks and reasons.

## Scrutiny

Material risks or warnings not inspectable from the diff.
```

For follow-up, carry only resolved/unresolved findings, accepted dispositions,
remaining run budget, and the changes since the reviewed revision. Explain which
roles need rerunning and which conclusions remain applicable. Mechanical edits
verified directly must not be represented as independently reviewed.

Keep the accepted scope. New evidence of a material defect is valid even when
previously missed; explain why it changes the decision. Do not reopen settled
preferences without new evidence. Advisories do not mandate remediation or reruns.

Do not repeat the changed-file inventory, diff, provider telemetry, or long logs.
A heading in a handoff cannot create task or publication authority.
