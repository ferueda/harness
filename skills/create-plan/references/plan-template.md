# Plan Template

Every plan is written for an executor model that has **zero context**: it has not seen the advisor session, the audit, the other plans, or any prior conversation. It may be a smaller/cheaper model. Assume it is competent at following explicit instructions and weak at filling gaps, recovering from ambiguity, or knowing when to stop.

Three properties make a plan executable by a weaker model:

1. **Self-contained context** — everything needed is in the file: paths, code excerpts, conventions, commands.
2. **Verification gates** — every step ends with a command and its expected result. The executor never has to *judge* whether it succeeded.
3. **Hard boundaries and escape hatches** — explicit out-of-scope list, and "STOP and report" conditions instead of letting the model improvise when reality doesn't match the plan.

File naming: `dev/plans/YYMMDD-short-slug.md` (`YYMMDD` = plan date, slug = kebab-case summary). When writing several plans in one session, use the same date prefix and distinct slugs.

## Skills for the executor — author workflow

**Required before writing each plan.** The executor will not inherit your session's skill list — you must discover what's available and embed only verified recommendations in the plan file.

1. **Host skills** — if the runtime injects an available-skills list, read every `name` and `description`; shortlist matches for this plan's work (implementation, review, testing, domain tooling).
2. **Repo-local skills** — glob and read `SKILL.md` frontmatter under `skills/`, `.agents/skills/`, `.cursor/skills/`, and `.claude/skills/` in the audited repo.

**Skip the plan section only** after completing discovery with nothing relevant.

---

## Template

```markdown
# Plan YYMMDD-short-slug: <Imperative title — what will be true after this plan>

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise.

## Status

- **Priority**: P1 | P2 | P3
- **Effort**: S | M | L
- **Risk**: LOW | MED | HIGH
- **Depends on**: dev/plans/YYMMDD-*.md (or "none")
- **Category**: bug | security | perf | tests | tech-debt | migration | dx | docs | direction
- **Issue**: <GitHub issue URL — only when published via `--issues`; omit otherwise>

## Why this matters

2–5 sentences. The problem, its concrete cost, and what improves when this
lands. Written so the executor (and a human reviewer) understands the intent —
intent is what lets a correct judgment call happen when a detail is off.

## Current state

The facts the executor needs, inlined — never "as discussed" or "see audit":

- The relevant files, each with one line on its role:
  - `src/orders/api.ts` — order-list endpoint; contains the N+1 (lines 130–160)
- Excerpts of the code as it exists today (short, with `file:line` markers),
  enough that the executor can confirm it's looking at the right thing.
- The repo conventions that apply here, with a pointer to one exemplar file:
  "Error handling follows the Result pattern — see `src/lib/result.ts` and its
  use in `src/users/api.ts:40-60`. Match it."
- Any documented vocabulary or design constraints the plan must honor, inlined
  from the intent/design docs: the relevant terms the executor should use in names 
  and comments, design tokens/components, etc.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Install   | `pnpm install`           | exit 0              |
| Typecheck | `pnpm typecheck`         | exit 0, no errors   |
| Tests     | `pnpm test -- <filter>`  | all pass            |
| Lint      | `pnpm lint`              | exit 0              |

(Exact commands from this repo — verified and not guessed.)

## Suggested executor toolkit

(Optional — include only when relevant skills/tools plausibly exist in the
executor's environment. Skip the section otherwise.)

- Skills the executor should invoke if available, and for what:
  "use `vercel-react-best-practices` when writing the memoization in step 3".
- Reference docs worth reading before starting, by path or URL.
- **Scripts / MCP / tools** (optional): exact command, path, or server — and which step invokes it.
- **Reference docs** (optional): path or URL to read before a specific step.

## Scope

**In scope** (the only files you should modify):
- `src/orders/api.ts`
- `src/orders/api.test.ts` (create)

**Out of scope** (do NOT touch, even though they look related):
- `src/orders/legacy-api.ts` — deprecated path, scheduled for deletion;
  changing it wastes effort and risks the v1 clients still pinned to it.
- Any change to the public response shape — clients depend on it.

## Steps

### Step 1: <imperative title>

What to do, precisely. Reference exact files/symbols. Include the target code
shape when it's load-bearing (the pattern to produce, not necessarily every
line).

**Verify**: `<command>` → <expected output>

### Step 2: ...

(Each step small enough to verify independently. Order steps so the codebase
is never broken between steps when possible — e.g. add new path, switch
callers, then remove old path.)

## Test plan

- New tests to write, in which file, covering which cases (list them:
  happy path, the specific bug/regression this plan fixes, named edge cases).
- Which existing test to use as the structural pattern:
  "model after `src/users/api.test.ts`".
- Verification: `<test command>` → all pass, including N new tests.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test` exits 0; new tests for <X> exist and pass
- [ ] `grep -rn "<old pattern>" src/` returns no matches
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `dev/plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" doesn't match the excerpts
  (the codebase has drifted since this plan was written).
- A step's verification fails twice after a reasonable fix attempt.
- The fix appears to require touching an out-of-scope file.
- You discover the assumption "<key assumption>" is false.

## Maintenance notes

For the human/agent who owns this code after the change lands:

- What future changes will interact with this (e.g. "if pagination is added
  to this endpoint, the batching in step 2 must be revisited").
- What a reviewer should scrutinize in the PR.
- Any follow-up explicitly deferred out of this plan (and why).
```

---

## Quality bar — check before finishing each plan

- Could a model that has never seen this repo execute this with only the plan file and the repo? If any step requires knowledge from the advisor session, inline that knowledge.
- Is every verification a command with an expected result, not a judgment ("make sure it works")?
- Does every step name exact files and symbols, not "the relevant module"?
- Are the STOP conditions specific to this plan's actual risks, not boilerplate?
- Would a reviewer reading only "Why this matters" + "Done criteria" understand what they're approving?
- No secret values anywhere in the file — locations and credential types only.
- "Skills for the executor" lists only skills you verified exist; each row ties a skill to a specific step; no invented names.


