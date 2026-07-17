import { execFileSync } from "node:child_process";
import { join, relative } from "node:path";
import { readFileSync } from "node:fs";
import {
  createFactoryArtifactRef,
  verifyFactoryArtifactRef,
  type FactoryArtifactRef,
} from "./factory-artifact-ref.ts";
import { writeDurableFactoryFile } from "./factory-durable-file.ts";
import { appendFactoryActionEvent, readFactoryActionEvents } from "./factory-lifecycle-kernel.ts";
import type { FactoryLifecycleEvent } from "./factory-lifecycle-events.ts";
import { deriveFactoryWorkItemKey } from "./factory-lifecycle.ts";
import { readFactoryPhaseRunIdentity } from "./factory-phase-run.ts";
import { preparePlanPublication } from "./factory-plan-publication-preparation.ts";
import { assertCommitAncestor, resolveLocalCommit } from "./factory-publication-git.ts";
import { factoryPhaseBaseSha, factoryPhaseBranchRef } from "./factory-phase-git.ts";
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
      baseSha: factoryPhaseBaseSha(identity),
      branchRef: factoryPhaseBranchRef(identity),
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
  const runDir = join(input.factoryStore.projectRoot, "runs/factory", state.phaseRunId);
  const identity = readFactoryPhaseRunIdentity(runDir);
  if (identity.phase !== "planning") throw new Error("Invalid planning phase identity");
  let approvedPlan: FactoryArtifactRef | undefined;
  if (existing?.type !== "plan_pr.merged" || existing.data.approvedPlan) {
    const mergedPlanBytes = readMergedPlan(input.workspace, resolved, identity.outputPlan);
    approvedPlan =
      existing?.type === "plan_pr.merged"
        ? authenticateRecordedApprovedPlan(existing.data.approvedPlan!, input, mergedPlanBytes)
        : persistApprovedPlan(input.factoryStore, runDir, mergedPlanBytes);
  }
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
          data: { url: input.url, commit: resolved, approvedPlan: approvedPlan! },
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
    await input.applyAdapter.applyPlanningMerged({
      issueRef: input.issueRef,
      runId: state.phaseRunId,
      runDir,
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

function readMergedPlan(workspace: string, commit: string, outputPlan: string): Buffer {
  try {
    return execFileSync("git", ["show", `${commit}:${outputPlan}`], {
      cwd: workspace,
      encoding: "buffer",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(`Merged plan is missing at ${outputPlan} in commit ${commit}`, {
      cause: error,
    });
  }
}

function persistApprovedPlan(
  store: FactoryStoreMeta,
  runDir: string,
  bytes: Buffer,
): FactoryArtifactRef {
  const path = join(runDir, "artifacts/approved-plan.md");
  writeDurableFactoryFile(path, bytes, true);
  return createFactoryArtifactRef({
    base: "factory-store",
    root: store.projectRoot,
    path: relative(store.projectRoot, path),
  });
}

function authenticateRecordedApprovedPlan(
  approvedPlan: FactoryArtifactRef,
  input: Pick<Parameters<typeof markPlanPullRequestMerged>[0], "factoryStore" | "workspace">,
  mergedPlanBytes: Buffer,
): FactoryArtifactRef {
  const path = verifyFactoryArtifactRef(approvedPlan, {
    "factory-store": input.factoryStore.projectRoot,
    repository: input.workspace,
  });
  if (!readFileSync(path).equals(mergedPlanBytes))
    throw new Error("Approved plan artifact does not match the recorded merge commit");
  return approvedPlan;
}
