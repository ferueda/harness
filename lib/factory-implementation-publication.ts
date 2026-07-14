import { join } from "node:path";
import { readFileSync } from "node:fs";
import { appendFactoryActionEvent, readFactoryActionEvents } from "./factory-lifecycle-kernel.ts";
import type { FactoryLifecycleEvent } from "./factory-lifecycle-events.ts";
import { deriveFactoryWorkItemKey } from "./factory-lifecycle.ts";
import { readFactoryPhaseRunIdentity } from "./factory-phase-run.ts";
import { prepareImplementationPublication } from "./factory-implementation-publication-preparation.ts";
import { assertCommitAncestor, resolveLocalCommit } from "./factory-publication-git.ts";
import {
  publishFactoryPullRequest,
  type FactoryCommandRunner,
} from "./factory-pull-request-publisher.ts";
import type { LinearFactoryAdapter } from "./factory-linear-adapter.ts";
import { parseFactoryWorkItem, type FactoryWorkItem } from "./factory-schemas.ts";
import {
  reduceFactoryLifecycleEvents,
  type FactoryLifecycleState,
} from "./factory-state-machine.ts";
import type { FactoryStoreMeta } from "./factory-store.ts";

export async function publishImplementationPullRequest(input: {
  workspace: string;
  factoryStateRoot: string;
  factoryStore: FactoryStoreMeta;
  workItem: FactoryWorkItem;
  issueRef?: string;
  applyAdapter?: LinearFactoryAdapter;
  commandRunner?: FactoryCommandRunner;
}) {
  const key = deriveFactoryWorkItemKey(input.workItem);
  const events = readFactoryActionEvents(input.factoryStateRoot, key);
  const state = reduceFactoryLifecycleEvents(events);
  if (!state || state.phase !== "implementation") throw new Error("No active implementation phase");
  const runDir = join(input.factoryStore.projectRoot, "runs/factory", state.phaseRunId);
  const identity = readFactoryPhaseRunIdentity(runDir);
  if (identity.phase !== "implementation") throw new Error("Invalid implementation identity");
  const phaseWorkItem = parseFactoryWorkItem(
    JSON.parse(readFileSync(join(runDir, "context/work-item.json"), "utf8")),
  );
  if (deriveFactoryWorkItemKey(phaseWorkItem) !== key)
    throw new Error("Implementation publication work item conflicts with phase identity");
  const recorded = events.findLast(
    (event) => event.type === "implementation_pr.opened" && event.phaseRunId === state.phaseRunId,
  );
  let opened: Extract<FactoryLifecycleEvent, { type: "implementation_pr.opened" }>;
  let nextState: FactoryLifecycleState = state;
  if (recorded?.type === "implementation_pr.opened") {
    opened = recorded;
  } else {
    if (state.status !== "awaiting-pr-publication" || !state.reviewedHead)
      throw new Error("Implementation publication requires a final passing review");
    const prepared = prepareImplementationPublication({
      workspace: input.workspace,
      branchRef: identity.branchRef,
      baseRef: identity.baseRef,
      reviewedHead: state.reviewedHead,
      title: phaseWorkItem.title,
      workItemKey: key,
    });
    const pr = input.commandRunner
      ? publishFactoryPullRequest({ ...prepared, workspace: input.workspace }, input.commandRunner)
      : publishFactoryPullRequest({ ...prepared, workspace: input.workspace });
    opened = {
      version: 1,
      id: `implementation_pr.opened:${state.phaseRunId}`,
      type: "implementation_pr.opened",
      workItemKey: key,
      occurredAt: new Date().toISOString(),
      phaseRunId: state.phaseRunId,
      data: { url: pr.url, head: prepared.headSha },
    };
    nextState = appendFactoryActionEvent({
      factoryStateRoot: input.factoryStateRoot,
      event: opened,
      expectedLastEventId: state.lastEventId,
    }).state;
  }
  let linearApplied = false;
  if (input.applyAdapter) {
    if (!input.issueRef) throw new Error("Linear implementation publication requires an issue");
    await input.applyAdapter.applyImplementationPublished({
      issueRef: input.issueRef,
      runId: state.phaseRunId,
      runDir,
      prUrl: opened.data.url,
      reviewedHead: opened.data.head,
    });
    linearApplied = true;
  }
  return { phaseRunId: state.phaseRunId, event: opened, state: nextState, linearApplied };
}

export async function markImplementationPullRequestMerged(input: {
  workspace: string;
  factoryStateRoot: string;
  factoryStore: FactoryStoreMeta;
  workItem: FactoryWorkItem;
  url: string;
  commit: string;
  issueRef?: string;
  applyAdapter?: LinearFactoryAdapter;
}) {
  const key = deriveFactoryWorkItemKey(input.workItem);
  const events = readFactoryActionEvents(input.factoryStateRoot, key);
  const state = reduceFactoryLifecycleEvents(events);
  if (!state || state.phase !== "implementation") throw new Error("No active implementation phase");
  const opened = events.findLast(
    (event) => event.type === "implementation_pr.opened" && event.phaseRunId === state.phaseRunId,
  );
  if (!opened || opened.type !== "implementation_pr.opened")
    throw new Error("Implementation merge has no publication");
  if (opened.data.url !== input.url)
    throw new Error("Implementation merge URL does not match publication");
  const resolved = resolveLocalCommit(input.workspace, input.commit);
  assertCommitAncestor(input.workspace, opened.data.head, resolved);
  const existing = events.findLast(
    (event) => event.type === "implementation_pr.merged" && event.phaseRunId === state.phaseRunId,
  );
  if (
    existing?.type === "implementation_pr.merged" &&
    (existing.data.url !== input.url || existing.data.commit !== resolved)
  )
    throw new Error("Implementation merge retry conflicts with durable lifecycle truth");
  const merged: Extract<FactoryLifecycleEvent, { type: "implementation_pr.merged" }> =
    existing?.type === "implementation_pr.merged"
      ? existing
      : {
          version: 1,
          id: `implementation_pr.merged:${state.phaseRunId}`,
          type: "implementation_pr.merged",
          workItemKey: key,
          occurredAt: new Date().toISOString(),
          phaseRunId: state.phaseRunId,
          data: { url: input.url, commit: resolved },
        };
  const appended = existing
    ? { event: merged, state }
    : appendFactoryActionEvent({
        factoryStateRoot: input.factoryStateRoot,
        event: merged,
        expectedLastEventId: state.lastEventId,
      });
  let linearApplied = false;
  if (input.applyAdapter) {
    if (!input.issueRef) throw new Error("Linear implementation merge requires an issue");
    const projection = {
      issueRef: input.issueRef,
      runId: state.phaseRunId,
      runDir: join(input.factoryStore.projectRoot, "runs/factory", state.phaseRunId),
      prUrl: opened.data.url,
      reviewedHead: opened.data.head,
    };
    // Repair a publication projection that failed after its durable event before moving to Done.
    await input.applyAdapter.applyImplementationPublished(projection);
    await input.applyAdapter.applyImplementationMerged({ ...projection, mergeCommit: resolved });
    linearApplied = true;
  }
  return { phaseRunId: state.phaseRunId, event: merged, state: appended.state, linearApplied };
}
