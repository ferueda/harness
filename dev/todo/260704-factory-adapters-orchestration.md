# Factory adapters and orchestration context

**Status:** open  
**Related plan:** [`dev/plans/260704-factory-intake-routing.md`](../plans/260704-factory-intake-routing.md)

## Purpose

Preserve the adapter/orchestrator design context for later factory work. PR 1
for factory intake should stay local and file-backed. Linear, GitHub, and
Inngest should attach later without replacing the core factory contracts.

## Core boundary

Harness owns the factory logic:

- `FactoryWorkItem`
- `FactoryTriageOutput`
- `FactoryRoutePlan`
- route validation
- prompts
- run artifacts
- deterministic state transitions

Trackers and orchestrators should feed or run this logic. They should not
reimplement route decisions.

Agents recommend. Harness moves.

```text
Agent JSON -> Zod parse -> route plan -> deterministic transition
```

## CLI namespace rule

Use `harness run <workflow>` for one named workflow execution. Use
`harness factory <command>` for factory management, adapters, tracker-backed
station commands, queue state, and future multi-item operations.

Examples:

```bash
harness run factory-triage --item-file item.json
harness factory linear fetch TEAM-123
harness factory github fetch 123
harness factory status
```

Keep the workflow name `factory-triage`, not `triage`. `triage` is too generic:
the repo can have issue triage, review finding triage, plan triage, bug triage,
or audit triage. `factory-triage` names the factory intake station.

## What the local inbox is

The inbox is a local file queue, not the factory itself:

```text
.harness/inbox/factory/
  001-fix-empty-state.json
  002-add-export-button.json
```

Each file is a `FactoryWorkItem`. It is the simplest adapter boundary: outside
systems can drop work into a shape harness already understands.

Initial folder meaning:

```text
.harness/inbox/factory/*.json              unprocessed
.harness/inbox/factory/processed/*.json    triaged
.harness/inbox/factory/failed/*.json       failed triage
```

Longer term, stage visibility should come from an explicit state index or a
tracker, not directory names alone:

```json
{
  "itemId": "github-123",
  "source": "github",
  "metadata": {
    "tracker": {
      "source": "github",
      "id": "owner/repo#123",
      "url": "https://github.com/owner/repo/issues/123"
    },
    "factoryStage": "ready-to-plan",
    "factoryRoute": "ready-to-plan",
    "factoryRunId": "20260704-...",
    "factoryNextAction": "create-plan"
  },
  "updatedAt": "..."
}
```

Possible local path:

```text
.harness/factory/items.jsonl
```

## Reserved metadata keys

Adapters should preserve `FactoryWorkItem` and attach tracker/station state
through reserved `metadata` keys. These keys are the future bridge between
file-backed local runs, GitHub/Linear, Inngest, and implementation:

```json
{
  "tracker": {
    "source": "linear",
    "id": "TEAM-123",
    "url": "https://linear.app/acme/issue/TEAM-123"
  },
  "factoryRoute": "ready-to-plan",
  "factoryNextAction": "create-plan",
  "factoryStage": "plan-pr-open",
  "factoryRunId": "20260707-120000",
  "approvedPlanPath": "dev/plans/TEAM-123.md",
  "approvedPlanPrUrl": "https://github.com/acme/repo/pull/123",
  "approvedPlanCommit": "abc1234"
}
```

Trackers should store board state, summaries, and links. The canonical approved
plan should be a repo file at `approvedPlanPath`, but tracker-backed planning
must publish that file through a plan PR before the tracker moves to
`Ready to Implement`. Tracker comments should link the plan path and plan PR;
they should not be the source of truth for the full plan.

Keep two related but distinct concepts:

- Harness `factoryStage` can be fine-grained internal state such as
  `plan-approved`, `plan-needs-human`, or `plan-review-unresolved`.
- Linear status is the coarse human board state such as `Ready to Implement`,
  `Needs Info`, or `Planning Failed`.

For example, an internally approved planning run may first keep
`factoryStage=plan-pr-open` in metadata while Linear remains in `Planning`.
After the plan PR merges, metadata moves to `factoryStage=plan-approved` and
Linear moves to `Ready to Implement`.

## Work item stages

Factory triage takes an incoming item and assigns one route:

```text
incoming
  -> ready-to-implement
  -> ready-to-plan
  -> needs-info
  -> wait-to-implement
```

Later stages continue from those routes:

```text
ready-to-plan
  -> plan-created
  -> plan-reviewed
  -> ready-to-implement

ready-to-implement
  -> implementation-started
  -> implementation-complete
  -> review-running
  -> review-complete
  -> ready-for-human
```

`wait-to-implement` means the work is valid enough to remember, but not worth
acting on now. It is not a trash bin. It needs a reconsideration condition:

```json
{
  "route": "wait-to-implement",
  "rationale": "This depends on the new plugin registry landing first.",
  "reconsiderWhen": "After the plugin registry plan is implemented and reviewed."
}
```

## What Linear replaces

Linear should replace the file-backed source/state surface, not the factory.

It can replace:

```text
manual/file work item input
.harness/inbox/factory/*.json as the main queue
local stage visibility
manual status updates
```

It should not replace:

```text
FactoryWorkItem
FactoryTriageOutput
FactoryRoutePlan
buildFactoryRoutePlan
factory-triage prompt/workflow
planning/review workflows
deterministic transition logic
```

Linear adapter flow:

```text
Linear issue
  -> Linear adapter
  -> FactoryWorkItem
  -> factory-triage workflow
  -> FactoryRoutePlan
  -> Linear adapter applies deterministic updates
```

Example conversion:

```ts
const item: FactoryWorkItem = {
  id: `linear:${issue.identifier}`,
  source: "linear",
  title: issue.title,
  body: issue.description ?? "",
  url: issue.url,
  labels: issue.labels,
  metadata: {
    tracker: {
      source: "linear",
      id: issue.identifier,
      url: issue.url,
    },
    factoryStage: linearStateToFactoryStage(issue.state.name),
    teamKey: issue.team.key,
    issueId: issue.id,
    status: issue.state.name,
    assignee: issue.assignee?.name,
    priority: issue.priority,
  },
};
```

Linear workflow statuses should be the canonical human board state. Labels
should be secondary filters only. The current preferred Linear team workflow is:

```text
Backlog
  Backlog              Waiting for triage
  Parked               Valid, but intentionally deferred

Unstarted
  Needs Info           Human must answer questions
  Needs Plan           Classified as needing planning
  Ready to Implement   Implementation can start
  Triage Failed        Triage run failed; human should inspect or rerun
  Planning Failed      Planning run failed; human should inspect or rerun

Started
  Triaging             Factory triage is running
  Planning             Planning/review loop is running

Completed
  Done                 Finished implementation/review work

Canceled
  Canceled

Duplicate
  Duplicate
```

Do not add `Plan Approved` as a Linear status. A successful planning station
writes the approved plan to `dev/plans/<tracker-key>.md`, opens or expects a
plan PR, and writes a concise comment with the plan path and PR link. The issue
should move to `Ready to Implement` only after the plan PR merges, so the board
answers what can actually be implemented from `main`.

Example route mapping:

```text
ready-to-implement -> Linear status: Ready to Implement
ready-to-plan      -> Linear status: Needs Plan
needs-info         -> Linear status: Needs Info + comment with questions
wait-to-implement  -> Linear status: Parked + comment with reconsiderWhen
triage failure     -> Linear status: Triage Failed + error comment
planning success   -> Linear status: Planning + plan path / plan PR comment
plan PR merged     -> Linear status: Ready to Implement + approved plan path comment
plan-needs-human   -> Linear status: Needs Info + questions/comment
review unresolved  -> Linear status: Planning Failed + unresolved review comment
planning failure   -> Linear status: Planning Failed + error comment
```

On `--apply`, use in-flight statuses:

```text
Backlog | Needs Info | Triage Failed -> Triaging -> terminal triage status
Needs Plan | Planning Failed         -> Planning -> terminal planning status
```

If the process crashes while the issue is in `Triaging` or `Planning`, the first
adapter version can rely on manual reset or rerun-from-failed policy. Inngest
later owns durable retry/lock behavior.

Entry guards:

- `harness factory triage --linear-issue ... --apply` should normally accept
  `Backlog`, `Needs Info`, or `Triage Failed`.
- Rerunning from `Parked` should require a human decision that the
  `reconsiderWhen` condition has been met.
- Triage should not run from `Needs Plan` or `Ready to Implement` unless a
  future explicit override exists.
- `harness factory planning --linear-issue ... --apply` should accept
  `Needs Plan` and maybe `Planning Failed` for retry.

Recommended Linear sequence:

1. Read-only import:

   ```bash
   harness factory linear fetch TEAM-123
   ```

   Outputs a `FactoryWorkItem`.

2. Linear-backed triage dry-run:

   ```bash
   harness factory triage --linear-issue TEAM-123 --dry-run
   ```

   Shows intended Linear updates; applies nothing.

3. Linear write mode:

   ```bash
   harness factory triage --linear-issue TEAM-123 --apply
   ```

   Applies deterministic status/comment updates. Labels are optional secondary
   filters and should not be the source of truth for factory stage.

4. Linear-backed planning dry-run:

   ```bash
   harness factory planning --linear-issue TEAM-123 --dry-run
   ```

   Fetches the issue, verifies it maps to `ready-to-plan`, runs the planning
   station without mutating Linear, and reports intended status/comment updates.

5. Linear planning write mode:

   ```bash
   harness factory planning --linear-issue TEAM-123 --apply
   ```

   When the internal planning outcome is approved, writes the approved plan to
   `dev/plans/<tracker-key>.md`, records `approvedPlanPath` and
   `approvedPlanPrUrl` in metadata, and adds a concise summary with the plan
   path and plan PR. Linear should move to `Ready to Implement` only after the
   plan PR merges and `approvedPlanCommit` is known. Linear comments should not
   contain the full plan.

6. Linear inbox:

   Query issues in the `Backlog` status, then triage them.

## Linear implementation split

Keep Linear implementation in scoped slices:

1. **Read-only adapter.** Add `@linear/sdk`, `factory.linear` config parsing,
   status map validation, issue identifier lookup, issue/comment conversion to
   `FactoryWorkItem`, and `harness factory linear fetch TEAM-123`. No Linear
   mutation.
2. **Triage input integration.** Add `--linear-issue` to
   `harness factory triage`, keep it mutually exclusive with `--item-file`, and
   run the existing triage station from a Linear-derived `FactoryWorkItem`. This
   slice is read-only toward Linear and does not add `--apply`.
3. **Triage apply integration.** Add `--apply` for Linear-backed triage. Move
   from an allowed entry status to `Triaging`, then to the terminal triage
   status with idempotent comments.
4. **Planning integration.** Add `--linear-issue` to `harness factory planning`,
   guard entry from `Needs Plan | Planning Failed`, support dry-run previews, and
   make `--apply` move through `Planning` to `Ready to Implement`, `Needs Info`,
   or `Planning Failed` with approved-plan comments when applicable.
5. **Backlog listing.** Later, add a read-only command that lists issues in the
   configured intake status and prints candidate station commands. Do not batch
   run work in the first Linear adapter pass.

Suggested `harness.json` mapping:

```json
{
  "factory": {
    "linear": {
      "teamKey": "TEAM",
      "statuses": {
        "intake": "Backlog",
        "parked": "Parked",
        "needsInfo": "Needs Info",
        "needsPlan": "Needs Plan",
        "readyToImplement": "Ready to Implement",
        "triaging": "Triaging",
        "planning": "Planning",
        "triageFailed": "Triage Failed",
        "planningFailed": "Planning Failed"
      }
    }
  }
}
```

Initial implementation slice should prefer Linear before the implementation
station if we want to validate the factory against real tracker state first:

```text
Linear issue -> triage -> ready-to-plan -> planning -> plan PR -> ready-to-implement
```

This gives the future implementation station a concrete input contract:
consume Linear issues in `Ready to Implement`. If `approvedPlanPath` exists,
the implementer must follow the plan at that path on `main`; if
`approvedPlanCommit` exists, the implementer should prefer that commit as the
pin. If no `approvedPlanPath` exists, it is a triage-direct item and the
implementation station should require an explicit direct-implementation route
marker.

## Linear SDK notes

Use `@linear/sdk` for the first adapter. Keep SDK calls behind a small harness
adapter so factory stations do not depend on Linear types.

Authentication:

```ts
import { LinearClient } from "@linear/sdk";

const client = new LinearClient({ apiKey: process.env.LINEAR_API_KEY });
```

The SDK also supports OAuth via `accessToken`, but the first CLI slice should
use a personal API key from `LINEAR_API_KEY`. Fail fast when the env var is
missing for non-dry-run Linear commands.

Useful SDK operations:

- `linearClient.issue(id)` or equivalent issue lookup for a known model UUID.
- issue identifier lookup may need a filtered `linearClient.issues(...)`
  query, because users will pass `TEAM-123`, not a model UUID.
- status names in config should be resolved to Linear workflow state IDs once
  before mutations; fail fast if a configured status is missing from the team.
- `issue.comments()` to include human answers when rebuilding a
  `FactoryWorkItem`.
- `linearClient.updateIssue(issue.id, input)` or `issue.update(input)` to move
  state, apply labels, or attach metadata-backed fields where Linear supports
  them.
- `linearClient.createComment({ issueId, body })` for concise route/planning
  summaries.
- connection pagination helpers such as `fetchNext()` for future inbox queries.

Adapter shape:

```ts
type LinearFactoryAdapter = {
  fetchWorkItem(identifier: string): Promise<FactoryWorkItem>;
  validateStatusMap(): Promise<void>;
  previewRouteUpdate(item: FactoryWorkItem, route: FactoryRoutePlan): LinearUpdatePlan;
  applyRouteUpdate(item: FactoryWorkItem, route: FactoryRoutePlan): Promise<void>;
  previewPlanningUpdate(meta: FactoryPlanningRunMeta): LinearUpdatePlan;
  applyPlanningUpdate(meta: FactoryPlanningRunMeta): Promise<void>;
};
```

Linear has no durable generic metadata field for the first slice. Use concise
harness-owned comments with stable hidden markers for round-trip state and
dedupe:

```text
<!-- harness-factory:triage:<run-id> -->
Factory triage complete.

Route: ready-to-plan
Run: .harness/runs/factory/<run-id>
Next: Needs Plan
```

For planning:

```text
<!-- harness-factory:planning:<run-id> -->
Factory plan ready.

Plan: dev/plans/TEAM-123.md
Plan PR: https://github.com/acme/repo/pull/123
Run: .harness/runs/factory/<run-id>
Next: merge plan PR, then Ready to Implement
```

The adapter should avoid duplicate comments for the same run id and skip writes
when Linear is already in the target status.

For webhooks later, `@linear/sdk/webhooks` provides `LinearWebhookClient` with
signature verification and typed event handlers. That belongs with Inngest or a
server adapter, not the first local CLI slice.

Hard part is policy, not API calls:

- Which Linear statuses map to factory stages?
- Which optional labels help filtering without becoming stage state?
- Who can apply changes?
- Should comments be automatic?
- How do we avoid noisy updates?

## What GitHub replaces

GitHub is the same class of adapter as Linear. It replaces file input and can
own visible state through issues, labels, comments, branches, and PRs.

Likely first GitHub flow:

```text
GitHub Issue
  -> GitHub adapter
  -> FactoryWorkItem
  -> factory-triage workflow
  -> FactoryRoutePlan
  -> GitHub adapter applies deterministic labels/comments
```

Example route mapping:

```text
ready-to-implement -> label: ready-to-implement
ready-to-plan      -> label: ready-to-plan
needs-info         -> label: needs-info + comment with questions
wait-to-implement  -> label: wait-to-implement + comment with reconsiderWhen
```

GitHub is a good tracker adapter for PR-centric repos because this repo already
centers PRs, labels, Actions, and review flows. Linear may be the better first
adapter when the goal is to validate the factory against a product/task work
board before implementation automation.

## What Inngest replaces

Inngest replaces local/manual orchestration, not factory logic.

It can replace:

```text
manual single-item station commands
manual polling loop
file inbox as the main queue
manual command chaining
```

It should not replace:

```text
schemas
route table
prompts
FactoryWorkItem
FactoryTriageOutput
buildFactoryRoutePlan
Linear/GitHub adapters
planning/review/implementation workflows
```

Without Inngest:

```text
Linear/GitHub/manual
  -> file inbox
  -> harness command
  -> factory-triage
  -> local artifacts
  -> maybe update tracker
```

With Inngest:

```text
Linear/GitHub webhook
  -> Inngest event
  -> Inngest function
  -> harness factory code
  -> factory-triage
  -> FactoryRoutePlan
  -> Linear/GitHub adapter applies deterministic update
  -> next event if needed
```

Example event:

```json
{
  "name": "factory/work_item.created",
  "data": {
    "source": "linear",
    "id": "TEAM-123"
  }
}
```

Example function shape:

```ts
inngest.createFunction(
  { id: "factory-triage" },
  { event: "factory/work_item.created" },
  async ({ event, step }) => {
    const item = await step.run("fetch-work-item", () =>
      linearAdapter.fetchWorkItem(event.data.id),
    );

    const result = await step.run("triage", () => runFactoryTriage({ workItem: item }));

    await step.run("apply-route", () => linearAdapter.applyRouteUpdate(item, result.routePlan));
  },
);
```

## How Linear, Inngest, and harness work together

Linear owns product/task state:

```text
issue title, description, comments, status, labels
```

Inngest owns orchestration state:

```text
which step is running, retrying, failed, completed
```

Harness owns factory logic:

```text
schemas, prompts, route decisions, artifacts, deterministic transitions
```

Combined flow:

```text
1. Linear issue created or moved to "Backlog"
2. Linear webhook sends event
3. Inngest receives event
4. Inngest calls Linear adapter to fetch issue
5. Adapter converts issue -> FactoryWorkItem
6. Inngest calls harness factory triage code
7. Agent returns FactoryTriageOutput
8. Harness validates and builds FactoryRoutePlan
9. Inngest calls Linear adapter to apply route
10. Linear status/comment updates
```

Example:

```text
Linear status: Backlog
  -> Inngest event: factory/work_item.created
  -> Harness route: ready-to-plan
  -> Linear status: Needs Plan
  -> Comment: route summary + next action
```

Later:

```text
Linear status: Needs Plan
  -> Inngest event: factory/work_item.ready_to_plan
  -> Harness planning workflow
  -> Linear status: Planning
  -> Linear comment with approved plan path + plan PR
  -> Work item metadata gets approvedPlanPath, approvedPlanPrUrl, factoryStage=plan-pr-open
  -> Plan PR merged event
  -> Linear status: Ready to Implement
  -> Work item metadata gets approvedPlanCommit and factoryStage=plan-approved
```

## Boundary rule

Inngest should call harness code as a library. It should not reimplement routing
logic inside functions.

Good:

```ts
const routePlan = await runFactoryTriage({ workItem });
await linear.applyRouteUpdate(workItem, routePlan);
```

Bad:

```ts
if (issue.labels.includes("bug")) {
  // custom Inngest-only routing
}
```

Inngest is the conveyor belt. Linear/GitHub are the work boards. Harness is the
machinery.
