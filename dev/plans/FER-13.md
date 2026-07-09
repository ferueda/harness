# Plan 260709-linear-pr-linking: Link factory PRs to Linear issues via naming conventions

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the next
> step. If any STOP condition occurs, stop and report. Do not improvise a GitHub
> adapter or PR-body mutation path.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Issue**: FER-13, https://linear.app/ferueda/issue/FER-13/link-prs-to-linear-issues

## Why this matters

Linear Reviews/Diffs show GitHub PRs on an issue when Linear's native GitHub
integration can link them. Linear links PRs when **any** of these hold:

1. The issue id appears in the branch name (e.g. `plan/FER-13-link-prs`).
2. The issue id appears in the PR title.
3. A magic word plus issue id appears in the PR title or body.

Magic words mainly control status automation (closing vs non-closing on merge).
Linking does **not** require harness to PATCH GitHub PR bodies or add a GitHub
token. Today harness records plan PR URLs and updates Linear comments, but
operators may open PRs without the issue id in branch or title, so Linear never
attaches the PR. This plan documents operator conventions so factory and
chief-created PRs link through native Linear behavior. No new harness GitHub
commands.

## Requirements

- Document the branch and title conventions operators must follow when opening
  plan and implementation PRs for tracker-backed factory work.
- State the prerequisite: Linear↔GitHub integration enabled for the target repo
  (document only; do not implement or configure).
- State how to repair already-open PRs that are not linked: operator renames
  branch/title or runs `gh pr edit` — not a harness command.
- Prefer non-closing magic words on plan PRs; use closing magic words on
  implementation PRs only when merge should complete the Linear issue.
- Keep harness station boundaries unchanged: stations and publication commands do
  not open PRs or mutate GitHub.
- Update `docs/contributing/factory.md` and `skills/factory-operator/SKILL.md`.
  Touch other docs only when needed for consistency with the new convention
  section.
- Do not add `GITHUB_TOKEN`, Octokit, `fetch` PR-body mutation, HTML markers,
  `attachmentCreate`, repo-wide PR scanning, or implementation-station PR
  creation.

## Current state

- Verified branch: `plan/FER-13-link-prs`; clean before this rewrite.
- `package.json` has no Octokit dependency and no GitHub client code.
- `rg -n "Octokit|GITHUB_TOKEN|GH_TOKEN|link-linear|factory-github" bin lib test docs package.json`
  finds no GitHub API client or PR-body link command in this tree.
- `rg -n "pr create|createPull|pulls\\.create|openPr" bin lib` finds no harness
  code that opens GitHub PRs. PR creation is operator/chief responsibility via
  `gh pr create` or equivalent.
- `docs/contributing/factory.md:445-466` documents `harness factory planning
  publish` and `mark-plan-merged` as local metadata/lifecycle writers that do
  not open PRs or inspect GitHub merge state.
- `docs/contributing/factory.md:540` states implementation non-goals include no
  PR creation.
- `docs/contributing/architecture.md:159`, `:215`, and `:353` state factory
  stations / publication do not open PRs.
- `skills/factory-operator/SKILL.md:323-335` tells operators to record plan PR
  URLs with `planning publish`; it does not prescribe branch/title naming for
  Linear linking.
- `bin/factory-commands.ts:372-391` registers `harness factory planning publish`
  with `--run-dir`, `--pr-url`, `--linear-issue`, and `--apply` only. No
  `--link-linear-pr`.
- `lib/factory-linear-planning-handoff.ts:141-152` posts a Linear comment with
  the plan PR URL. That comment does not cause GitHub PR linking by itself.
- Prior iter-5 plan (`20260709-063641-a741bf/iterations/5/plan.md`) proposed
  `harness factory github link-linear-pr`, `--link-linear-pr` on publish,
  `GITHUB_TOKEN`, and PR body upsert. Plan review `20260709-070039-a291b3`
  returned `needs_changes`. That approach is **superseded** by this docs-only
  convention plan.
- Read `docs/project-intent.md` before editing durable docs: keep examples
  generic (`owner/repo`, `ENG-123` / `TEAM-123`); separate current operator
  practice from planned harness adapters; do not describe GitHub mutation as
  current harness station behavior.

### External behavior verified

- Linear GitHub docs: PRs link by branch name, PR title, or magic words in
  title/description. Non-closing words include `related to`; closing words
  include `fixes` and `closes`. Existing open PRs can be linked by editing title
  or description: https://linear.app/docs/github

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Confirm no PR opener | `rg -n "pr create\|createPull\|pulls\\.create\|openPr" bin lib` | no matches |
| Confirm no GitHub client | `rg -n "Octokit\|GITHUB_TOKEN\|link-linear\|factory-github" bin lib test package.json` | no matches |
| Format check | `make check-format` | exit 0 |
| Docs contracts | `pnpm test -- test/docs-contracts.test.ts` | exit 0 |
| Full gate | `make check` | exit 0 |

## Skills for the executor

| Skill/tool | Verified source | Use for |
| --- | --- | --- |
| `implement-plan` | `skills/implement-plan/SKILL.md` | Execute this plan phase by phase; stop on drift. |
| `factory-operator` | `skills/factory-operator/SKILL.md` | Match factory operator vocabulary and STOP boundaries. |

## Scope

**In scope**:

- `docs/contributing/factory.md`
- `skills/factory-operator/SKILL.md`
- `dev/plans/FER-13.md` (this file; commit on the plan PR branch)
- Optional consistency edits only when a nearby doc directly contradicts the new
  convention: `README.md` factory examples, `docs/contributing/architecture.md`
  factory handoff paragraph

**Out of scope** (reject explicitly):

- `harness factory github link-linear-pr` or any `factory github` command group
- `harness factory planning publish --link-linear-pr`
- `GITHUB_TOKEN` / `GH_TOKEN` / Octokit / native `fetch` PR GET/PATCH
- HTML markers (`<!-- harness-factory:linear-pr-link:... -->`) or
  `upsertLinearPrLinkBody`
- Linear `attachmentCreate` or generic attachment APIs as a link path
- Repo-wide open-PR scanning or guessed issue matches from branch names alone
- Changing Linear workspace GitHub automation settings
- Implementation station opening PRs, branches, or worktrees
- New unit tests for GitHub API behavior (no code to test)
- Updating `dev/plans/README.md` active queue unless plan publication process
  explicitly asks for it

## Design

Rely on Linear's native GitHub integration. Linear links a PR when **any** of
branch name, PR title, or magic-word + issue id is present. This plan's house
rule is stricter for reliability: operators should put the normalized issue id
(e.g. `FER-13`) in **both** branch and PR title before or when opening the PR.
Title-only repair via `gh pr edit` is still enough for Linear to link.

### Plan PR convention

- **Branch**: `plan/<ISSUE>-<short-slug>` — example: `plan/FER-13-link-prs`.
- **Title**: include `<ISSUE>` — example: `plan: FER-13 link PRs via native Linear naming`.
- **Body**: optional. Prefer **no** closing magic words (`Fixes`, `Closes`,
  `Implements`, etc.) on plan PRs. A bare issue id in title or branch is enough
  for linking.
- **Handoff**: after the PR exists, run `harness factory planning publish
  --run-dir ... --pr-url ...` as today. `--linear-issue ... --apply` remains
  Linear-only.

### Implementation PR convention

- **Branch**: `feat/<ISSUE>-<short-slug>` or `fix/<ISSUE>-<short-slug>`.
- **Title**: include `<ISSUE>`.
- **Closing words**: use `Fixes <ISSUE>.` (or another Linear closing phrase) in
  title or body **only** when merge should complete the Linear issue.

### Prerequisite

- Target repo must have Linear's GitHub integration enabled and the repo
  connected in Linear settings. Harness does not verify or configure this.

### Repair for unlinked open PRs

Operator manual steps only:

```bash
gh pr edit <number> --title "feat: FER-13 short description"
# or rename branch and push, if policy allows
```

Do not add a harness repair command.

### Example operator flow (plan PR)

```bash
git checkout -b plan/FER-13-link-prs
# ... commit plan ...
git push -u origin plan/FER-13-link-prs
gh pr create --title "plan: FER-13 link PRs via native Linear naming" --body "..."
LINEAR_API_KEY=... harness factory planning publish \
  --run-dir .harness/runs/factory/<run-id> \
  --pr-url https://github.com/owner/repo/pull/123 \
  --linear-issue FER-13 --apply
```

## Steps

### Step 1: Confirm docs-only scope

Run:

```bash
rg -n "pr create|createPull|pulls\\.create|openPr" bin lib
rg -n "Octokit|GITHUB_TOKEN|GH_TOKEN|link-linear|factory-github" bin lib test package.json
```

Expected: no matches for PR creation; no matches for GitHub client/link command.

If harness code auto-opens PRs without issue ids, STOP and report. Add only the
smallest code fix in a follow-up only if that search proves it necessary. This
plan assumes docs-only.

**Verify**: both commands produce no matches.

### Step 2: Add Linear PR linking section to factory docs

In `docs/contributing/factory.md`, add a **Linear PR linking** subsection
immediately adjacent to the **Manual publication commands** block (around
`planning publish` / `mark-plan-merged` examples near lines 445–466). Cover:

- Native linking via branch name and/or PR title (cite Linear docs URL).
- Plan PR branch/title convention (`plan/<ISSUE>-...`, title contains issue id).
- Implementation PR branch/title convention (`feat/<ISSUE>-...`, etc.).
- Plan PRs: avoid closing magic words; implementation PRs: closing words only
  when merge should complete the issue.
- Prerequisite: Linear↔GitHub integration enabled for the repo.
- Repair: operator `gh pr edit` or branch rename — not harness.
- Explicit boundary: `planning publish` records URL and may apply Linear; it does
  not edit GitHub PRs or verify linking.

Update existing `publish` examples if they use generic `ENG-123` without showing
branch/title convention; keep generic owner/repo URLs.

**Verify**: `rg -n "Linear PR linking|plan/<ISSUE>" docs/contributing/factory.md`
-> section present.

### Step 3: Update factory-operator skill

In `skills/factory-operator/SKILL.md`:

- Add a short **Linear PR linking** subsection under Artifacts or Command Model.
- Repeat branch/title conventions and the plan vs implementation magic-word rule.
- Add `gh pr create` example with issue id in `--title` and `plan/<ISSUE>-...`
  branch context.
- State repair via `gh pr edit` for already-open unlinked PRs.
- Preserve STOP conditions: still no GitHub mutation from harness commands.
  Linking is operator responsibility at PR creation time.

Do not add `GITHUB_TOKEN` to setup examples.

**Verify**: `rg -n "Linear PR linking|gh pr edit|plan/<ISSUE>" skills/factory-operator/SKILL.md`
-> hits present.

### Step 4: Optional consistency pass

Search for factory handoff docs that imply harness links PRs to Linear:

```bash
rg -n "link.*PR|GitHub.*Linear|PR.*attach" docs README.md skills/factory-operator
```

If `README.md` or `docs/contributing/architecture.md` factory paragraphs
contradict native linking (e.g. imply a future GitHub adapter is required for
linking), add at most one sentence each pointing to the new factory.md section.
If touching README's "GitHub, Jira, and Inngest remain future layers" wording,
clarify that means **harness adapters**, while Linear-native PR linking via
branch/title is current operator practice. Do not expand scope into
`script-command-surface.md` or `setup-manifest.md` unless a direct contradiction
exists.

**Verify**: no doc claims harness PATCHes PR bodies or requires `GITHUB_TOKEN`
for factory PR linking.

### Step 5: Run gates

```bash
make check-format
pnpm test -- test/docs-contracts.test.ts
make check
git status --short
```

Expected: all gates exit 0; only in-scope files modified.

## Test plan

- Step 1 search commands prove no harness PR opener or GitHub client exists.
- `test/docs-contracts.test.ts` stays green after doc edits.
- Manual read: factory.md and factory-operator skill agree on conventions.

No new unit tests — no production code changes.

## Done criteria

- [x] `docs/contributing/factory.md` documents native Linear PR linking,
      branch/title conventions, prerequisite, repair path, and harness boundary.
- [x] `skills/factory-operator/SKILL.md` documents the same conventions for
      operators opening plan and implementation PRs.
- [x] No `harness factory github` command, `--link-linear-pr`, `GITHUB_TOKEN`
      requirement, or PR-body mutation is introduced.
- [x] Docs state plan PRs prefer no closing magic words; implementation PRs use
      closing words only when merge should complete the issue.
- [x] `make check` exits 0.
- [x] `git status --short` shows only in-scope doc/plan files.

## STOP conditions

Stop and report if:

- Step 1 finds harness code that opens PRs without embedding the issue id in
  branch or title — propose a minimal code fix in a separate follow-up instead
  of expanding this plan.
- A reviewer or chief asks for `link-linear-pr`, GitHub token support, PR body
  upsert, or repo-wide PR backfill in harness.
- Implementing the docs would require changing station commands to mutate GitHub.
- `make check` or `test/docs-contracts.test.ts` fails twice after a focused fix.
- Live Linear or GitHub credentials would need to be committed in docs or tests.

## Maintenance notes

- If Linear changes GitHub linking rules, update factory.md and factory-operator
  together.
- Future PR-creation automation (if ever added) should embed issue ids in branch
  and title at creation time; that is a separate plan because it changes factory
  ownership boundaries.
- Iter-5's `factory github link-linear-pr` design is intentionally discarded;
  do not resurrect it without a new approved plan.
