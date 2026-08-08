# Gate

**Completion criterion:** Confirmed interpretation approved. No commands, edits, or plans that depend on unknowns before approval.

## Underspecified

After a low-risk context read, treat work as **underspecified** only when the
remaining ambiguity materially changes the requested outcome, acceptance
boundary, safety, authority, or project direction. Do not gate on details that
repository evidence, established defaults, or normal implementation discovery
can settle safely.

## Ask

**1–5 questions**, first pass. Eliminate whole branches.

- Numbered; multiple-choice when possible; **bold recommended**
- Fast path: `defaults`
- Escape: "Not sure — use default"
- Reply format: `1b 2a`; restate choices in plain language

```text
1) Scope?
a) Minimal change **(recommended)**
b) Refactor while touching the area
c) Not sure — use default
2) Compatibility?
a) Current project defaults **(recommended)**
b) Also support: <specify>
c) Not sure — use default

Reply: defaults (or 1a 2a)
```

## Pause

Until answers: no commands, edits, or unknown-dependent plans. Discovery only — label it.

User wants to proceed without answers → numbered assumptions → confirm → continue.

## Confirm

Restate per [Confirmed interpretation](brief-template.md#confirmed-interpretation-gate-mode). One to three sentences OK when the block is redundant. Wait for approval.

## Anti-patterns

Multiple-choice beats open-ended when it removes ambiguity faster.
