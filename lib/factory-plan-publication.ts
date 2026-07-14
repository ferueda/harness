import { join } from "node:path";
import { readFileSync } from "node:fs";
import { appendFactoryActionEvent, readFactoryActionEvents } from "./factory-lifecycle-kernel.ts";
import type { FactoryLifecycleEvent } from "./factory-lifecycle-events.ts";
import { deriveFactoryWorkItemKey } from "./factory-lifecycle.ts";
import { readFactoryPhaseRunIdentity } from "./factory-phase-run.ts";
import { preparePlanPublication } from "./factory-plan-publication-preparation.ts";
import { assertCommitAncestor, resolveLocalCommit } from "./factory-publication-git.ts";
import {
  publishFactoryPullRequest,
  type FactoryCommandRunner,
} from "./factory-pull-request-publisher.ts";
import type { LinearFactoryAdapter } from "./factory-linear-adapter.ts";
import { parseFactoryWorkItem, type FactoryWorkItem } from "./factory-schemas.ts";
import {
  decideNextFactoryAction,
  reduceFactoryLifecycleEvents,
  type FactoryLifecycleState,
} from "./factory-state-machine.ts";
import type { FactoryStoreMeta } from "./factory-store.ts";

export async function publishPlanPullRequest(input: {
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
  if (!state || state.phase !== "planning") throw new Error("No active planning phase");
  const runDir = join(input.factoryStore.projectRoot, "runs/factory", state.phaseRunId);
  const identity = readFactoryPhaseRunIdentity(runDir);
  if (identity.phase !== "planning" || identity.publicationMode !== "pull-request")
    throw new Error("Planning phase is not configured for pull-request publication");
  const phaseWorkItem = parseFactoryWorkItem(
    JSON.parse(readFileSync(join(runDir, "context/work-item.json"), "utf8")),
  );
  if (deriveFactoryWorkItemKey(phaseWorkItem) !== key)
    throw new Error("Planning publication work item conflicts with phase identity");
  const recorded = events.findLast(
    (event) => event.type === "plan_pr.opened" && event.phaseRunId === state.phaseRunId,
  );
  let opened: Extract<FactoryLifecycleEvent, { type: "plan_pr.opened" }>;
  let nextState: FactoryLifecycleState = state;
  if (recorded?.type === "plan_pr.opened") {
    opened = recorded;
  } else {
    if (state.status !== "awaiting-plan-publication")
      throw new Error("Planning publication requires a final passing review");
    const review = events.findLast(
      (event) =>
        event.type === "planning.review.completed" &&
        event.phaseRunId === state.phaseRunId &&
        event.data.verdict === "pass",
    );
    if (!review || review.type !== "planning.review.completed")
      throw new Error("Planning publication has no final passing review");
    const candidate = events.find((event) => event.id === review.data.candidateEventId);
    if (
      !candidate ||
      candidate.type !== "planning.candidate.produced" ||
      candidate.phaseRunId !== state.phaseRunId ||
      candidate.workItemKey !== key ||
      candidate.data.attempt !== review.data.candidateAttempt
    )
      throw new Error("Planning publication has no final reviewed candidate");
    const prepared = preparePlanPublication({
      workspace: input.workspace,
      factoryStoreProjectRoot: input.factoryStore.projectRoot,
      phaseRunId: state.phaseRunId,
      workItemKey: key,
      workItem: phaseWorkItem,
      baseRef: identity.baseRef!,
      baseSha: identity.baseSha!,
      branchRef: identity.branchRef!,
      outputPlan: identity.outputPlan,
      candidate: candidate.data.candidate,
    });
    const publication = { ...prepared, workspace: input.workspace };
    const pr = input.commandRunner
      ? publishFactoryPullRequest(publication, input.commandRunner)
      : publishFactoryPullRequest(publication);
    opened = {
      version: 1,
      id: `plan_pr.opened:${state.phaseRunId}`,
      type: "plan_pr.opened",
      workItemKey: key,
      occurredAt: new Date().toISOString(),
      phaseRunId: state.phaseRunId,
      data: { url: pr.url, head: prepared.headSha, plan: candidate.data.candidate },
    };
    nextState = appendFactoryActionEvent({
      factoryStateRoot: input.factoryStateRoot,
      event: opened,
      expectedLastEventId: state.lastEventId,
    }).state;
  }
  let linearApplied = false;
  if (input.applyAdapter) {
    if (!input.issueRef) throw new Error("Linear plan publication requires an issue reference");
    await input.applyAdapter.applyPlanningPublished({
      issueRef: input.issueRef,
      runId: state.phaseRunId,
      runDir,
      approvedPlanPath: identity.outputPlan,
      approvedPlanPrUrl: opened.data.url,
    });
    linearApplied = true;
  }
  return { phaseRunId: state.phaseRunId, event: opened, state: nextState, linearApplied };
}

export async function markPlanPullRequestMerged(input: {
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
  if (!state || state.phase !== "planning") throw new Error("No active planning phase");
  const opened = events.findLast(
    (event) => event.type === "plan_pr.opened" && event.phaseRunId === state.phaseRunId,
  );
  if (!opened || opened.type !== "plan_pr.opened") throw new Error("Plan merge has no publication");
  if (opened.data.url !== input.url) throw new Error("Plan merge URL does not match publication");
  const resolved = resolveLocalCommit(input.workspace, input.commit);
  assertCommitAncestor(input.workspace, opened.data.head, resolved);
  const existing = events.findLast(
    (event) => event.type === "plan_pr.merged" && event.phaseRunId === state.phaseRunId,
  );
  if (
    existing?.type === "plan_pr.merged" &&
    (existing.data.url !== input.url || existing.data.commit !== resolved)
  )
    throw new Error("Plan merge retry conflicts with durable lifecycle truth");
  const merged: Extract<FactoryLifecycleEvent, { type: "plan_pr.merged" }> =
    existing?.type === "plan_pr.merged"
      ? existing
      : {
          version: 1,
          id: `plan_pr.merged:${state.phaseRunId}`,
          type: "plan_pr.merged",
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
    if (!input.issueRef) throw new Error("Linear plan merge requires an issue reference");
    const identity = readFactoryPhaseRunIdentity(
      join(input.factoryStore.projectRoot, "runs/factory", state.phaseRunId),
    );
    if (identity.phase !== "planning") throw new Error("Invalid planning phase identity");
    await input.applyAdapter.applyPlanningMerged({
      issueRef: input.issueRef,
      runId: state.phaseRunId,
      runDir: join(input.factoryStore.projectRoot, "runs/factory", state.phaseRunId),
      approvedPlanPath: identity.outputPlan,
      approvedPlanPrUrl: opened.data.url,
      approvedPlanCommit: resolved,
    });
    linearApplied = true;
  }
  return {
    phaseRunId: state.phaseRunId,
    event: merged,
    state: appended.state,
    reaction: decideNextFactoryAction(appended.state, merged),
    linearApplied,
  };
}
