---
name: shape-requirements
description: >
  Shape requirements before planning or implementing. Gate underspecified build,
  fix, or plan tasks. Interview when the user says "interview me about", "ask me
  questions about", "help me think through", "I need to spec out", "let's flesh
  out", or has a vague idea to turn into a brief.
---

# Shape Requirements

## 1. Pick a branch

| Signal | Branch | Load |
|--------|--------|------|
| Build, fix, or plan **now** — objective, scope, done-ness, or constraints unclear | **gate** | [references/gate-mode.md](references/gate-mode.md) |
| Written spec exists; only implementation choices unclear | **gate** | [references/gate-mode.md](references/gate-mode.md) |
| Think out loud, interview, flesh out an idea; **no artifact yet** | **interview** | [references/interview-mode.md](references/interview-mode.md) |

Explicit interview or doc request → **interview**. Otherwise → **gate**.

Low-risk discovery reads OK when they don't commit direction. Don't ask what a quick read answers.

**Done when:** branch chosen and its reference loaded.

## 2. Run the branch

Follow the loaded reference through its **completion criterion**.

**Done when:**
- **gate** — confirmed interpretation approved ([template](references/brief-template.md#confirmed-interpretation-gate-mode)); no edits, commands, or dependent plans before approval
- **interview** — user said write up; brief saved per [brief-template.md](references/brief-template.md); every TBD in **Open Questions**

## 3. Hand off

| Next | When |
|------|------|
| Implement | Gate cleared; small repo-local change |
| `diagnose-issue` | Brief or interpretation asserts current behavior, bug, or risk needing code evidence |
| `create-plan` | Multi-step, cross-area, or phased |
| `review-spec` | Brief or plan needs codebase validation |
| `planning-workflow` | Unsure which planning step comes next |
| Stop | User only wanted confirmation or brief |

After **gate** approval, continue with the user's original build, fix, or plan request. For **interview** mode or clarify-only requests, offer the natural next step and wait.

**Done when:** original requested work continues, or next step stated for interview/clarify-only.

## Cross-branch

Don't mix **gate** batching with **interview** one-at-a-time in one pass.
