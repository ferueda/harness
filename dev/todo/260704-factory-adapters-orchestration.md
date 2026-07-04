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
  "stage": "ready-to-plan",
  "route": "ready-to-plan",
  "lastRunId": "20260704-...",
  "nextAction": "create-plan",
  "updatedAt": "..."
}
```

Possible local path:

```text
.harness/factory/items.jsonl
```

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
    teamKey: issue.team.key,
    issueId: issue.id,
    status: issue.state.name,
    assignee: issue.assignee?.name,
    priority: issue.priority,
  },
};
```

Example route mapping:

```text
ready-to-implement -> Linear status/label: Ready to Implement
ready-to-plan      -> Linear status/label: Needs Plan
needs-info         -> Linear status/label: Needs Info + comment with questions
wait-to-implement  -> Linear status/label: Backlog/Parked + comment with reconsiderWhen
```

Recommended Linear sequence:

1. Read-only import:

   ```bash
   harness factory linear fetch TEAM-123
   ```

   Outputs a `FactoryWorkItem`.

2. Linear-backed triage dry-run:

   ```bash
   harness run factory-triage --linear-issue TEAM-123 --dry-run
   ```

   Shows intended Linear updates; applies nothing.

3. Linear write mode:

   ```bash
   harness run factory-triage --linear-issue TEAM-123 --apply
   ```

   Applies deterministic status/label/comment updates.

4. Linear inbox:

   Query issues in a status such as `Factory Inbox`, then triage them.

Hard part is policy, not API calls:

- Which Linear statuses map to factory stages?
- Labels vs workflow states vs projects vs custom fields?
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

GitHub is a good first tracker adapter because this repo already centers PRs,
labels, Actions, and review flows.

## What Inngest replaces

Inngest replaces local/manual orchestration, not factory logic.

It can replace:

```text
harness factory dispatch
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

    await step.run("apply-route", () => linearAdapter.applyRoute(item, result.routePlan));
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
1. Linear issue created or moved to "Factory Inbox"
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
Linear status: Factory Inbox
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
  -> Linear attachment/comment with plan path or PR
```

## Boundary rule

Inngest should call harness code as a library. It should not reimplement routing
logic inside functions.

Good:

```ts
const routePlan = await runFactoryTriage({ workItem });
await linear.applyRoute(routePlan);
```

Bad:

```ts
if (issue.labels.includes("bug")) {
  // custom Inngest-only routing
}
```

Inngest is the conveyor belt. Linear/GitHub are the work boards. Harness is the
machinery.
