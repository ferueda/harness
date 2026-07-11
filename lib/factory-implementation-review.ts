import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import type {
  Agent,
  AgentApprovalPolicy,
  AgentProviderName,
  AgentProviderOptions,
  AgentReasoningEffort,
  AgentSandboxMode,
} from "./agents.ts";
import type { FailedReview, ReviewVerdict } from "./aggregate.ts";
import { errorMessage } from "./agent-invoke.ts";
import {
  deriveFactoryWorkItemKey,
  loadFactoryLifecycleState,
  readFactoryLifecycleEvents,
  type FactoryLifecycleEvent,
} from "./factory-lifecycle.ts";
import { appendImplementationReviewCompletedEvent } from "./factory-lifecycle-writes.ts";
import type { FactoryWorkItem } from "./factory-schemas.ts";
import {
  factoryExecutionProvenance,
  factoryLifecycleExecutionProvenance,
  factoryStoreMetadata,
  type FactoryStoreResolution,
} from "./factory-store.ts";
import { createWorkflowContext } from "./workflow-context.ts";
import type { WorkflowEventSink } from "./workflow-events.ts";
import { createAgentProvider } from "../providers/registry.ts";
import { run as runChangeReview } from "../workflows/change-review.workflow.ts";

const ImplementationReviewEvidenceSchema = z
  .object({
    workflow: z.literal("factory-implementation"),
    status: z.literal("implementation-complete"),
    runId: z.string().min(1),
    workspace: z.string().min(1),
    runDir: z.string().min(1),
    reviewBase: z.string().min(1),
    reviewHead: z.string().min(1),
    reviewCommitSha: z.string().min(1),
    changeReviewHandoff: z.string().min(1),
  })
  .strict();

const FailedReviewsSchema = z
  .array(
    z
      .object({
        key: z.string().min(1),
        stage: z.string().min(1),
        error: z.string().min(1),
      })
      .strict(),
  )
  .min(1);

export type FactoryImplementationReviewEvidence = z.infer<
  typeof ImplementationReviewEvidenceSchema
> & {
  workItemKey: string;
  handoffPath: string;
  planPath?: string;
};

type CompletedReviewResult =
  | {
      reviewStatus: "completed";
      outcome: "review-complete";
      verdict: "pass";
    }
  | {
      reviewStatus: "completed";
      outcome: "ready-for-human";
      verdict: Exclude<ReviewVerdict, "pass">;
    };

type FailedReviewResult = {
  reviewStatus: "failed";
  outcome: "ready-for-human";
  failedReviews: FailedReview[];
};

export type FactoryImplementationReviewResult = (CompletedReviewResult | FailedReviewResult) & {
  implementationRunId: string;
  reviewRunId: string;
  reviewRunDir: string;
  summaryPath: string;
  metaPath: string;
};

export type RunFactoryImplementationReviewInput = {
  workspace: string;
  workItem: FactoryWorkItem;
  store: FactoryStoreResolution;
  agentProvider: AgentProviderName;
  model?: string;
  codexPathOverride?: string;
  sandboxMode?: AgentSandboxMode;
  approvalPolicy?: AgentApprovalPolicy;
  modelReasoningEffort?: AgentReasoningEffort;
  maxRuntimeMs: number;
  signal?: AbortSignal;
  eventSink?: WorkflowEventSink;
};

export type FactoryImplementationReviewDependencies = {
  agentProviderFactory?: (options: AgentProviderOptions) => Agent;
  reviewRunner?: typeof runChangeReview;
  appendResult?: typeof appendImplementationReviewCompletedEvent;
};

export class FactoryImplementationReviewError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "FactoryImplementationReviewError";
  }
}

export async function runFactoryImplementationReview(
  input: RunFactoryImplementationReviewInput,
  dependencies: FactoryImplementationReviewDependencies = {},
): Promise<FactoryImplementationReviewResult> {
  const evidence = resolveFactoryImplementationReviewEvidence({
    workspace: input.workspace,
    workItem: input.workItem,
    store: input.store,
  });
  const reviewCtx = createWorkflowContext({
    workspace: evidence.workspace,
    baseRef: evidence.reviewBase,
    headRef: evidence.reviewCommitSha,
    runsDir: input.store.reviewRunsDir,
    handoffPath: evidence.handoffPath,
    ...(evidence.planPath ? { planPath: evidence.planPath } : {}),
    agentProvider: input.agentProvider,
    model: input.model,
    codexPathOverride: input.codexPathOverride,
    sandboxMode: input.sandboxMode,
    approvalPolicy: input.approvalPolicy,
    modelReasoningEffort: input.modelReasoningEffort,
    maxRuntimeMs: input.maxRuntimeMs,
    signal: input.signal,
    eventSink: input.eventSink,
    agentProviderFactory: dependencies.agentProviderFactory ?? createAgentProvider,
  });
  const reviewMeta = await (dependencies.reviewRunner ?? runChangeReview)(reviewCtx);
  const result = resultFromReviewMeta(
    evidence.runId,
    reviewCtx.runId,
    reviewCtx.runDir,
    reviewMeta,
  );
  canonicalFile(result.summaryPath, "review summary");
  canonicalFile(result.metaPath, "review meta");
  try {
    (dependencies.appendResult ?? appendImplementationReviewCompletedEvent)({
      workItem: input.workItem,
      reviewRunId: result.reviewRunId,
      factoryStateRoot: input.store.factoryStateRoot,
      execution: factoryLifecycleExecutionProvenance(
        factoryExecutionProvenance(evidence.workspace, result.reviewRunDir),
        factoryStoreMetadata(input.store),
      ),
      data: lifecycleResultData(result),
    });
  } catch (error) {
    throw new FactoryImplementationReviewError(
      `Review completed but Factory lifecycle append failed: ${errorMessage(error)} (reviewRunId=${result.reviewRunId}, reviewRunDir=${result.reviewRunDir}, metaPath=${result.metaPath})`,
      { cause: error },
    );
  }
  return result;
}

function lifecycleResultData(
  result: FactoryImplementationReviewResult,
): Extract<FactoryLifecycleEvent, { type: "implementation.review.completed" }>["data"] {
  const common = {
    implementationRunId: result.implementationRunId,
    summaryPath: relative(result.reviewRunDir, result.summaryPath),
    metaPath: relative(result.reviewRunDir, result.metaPath),
  };
  if (result.reviewStatus === "failed") {
    return {
      ...common,
      reviewStatus: result.reviewStatus,
      outcome: result.outcome,
    };
  }
  if (result.verdict === "pass") {
    return {
      ...common,
      reviewStatus: result.reviewStatus,
      outcome: result.outcome,
      verdict: result.verdict,
    };
  }
  return {
    ...common,
    reviewStatus: result.reviewStatus,
    outcome: result.outcome,
    verdict: result.verdict,
  };
}

export function resolveFactoryImplementationReviewEvidence(input: {
  workspace: string;
  workItem: FactoryWorkItem;
  store: FactoryStoreResolution;
}): FactoryImplementationReviewEvidence {
  const workspace = canonicalDirectory(input.workspace, "workspace");
  if (workspace !== canonicalDirectory(input.store.workspace, "Factory store workspace")) {
    throw new FactoryImplementationReviewError("Factory store workspace does not match workspace.");
  }
  const workItemKey = deriveFactoryWorkItemKey(input.workItem);
  const state = loadFactoryLifecycleState({
    factoryStateRoot: input.store.factoryStateRoot,
    workItemKey,
    workspace,
  });
  if (state?.factoryStage !== "implementation-complete" || !state.factoryRunId) {
    throw new FactoryImplementationReviewError(
      `Factory implementation review requires implementation-complete; current stage is ${state?.factoryStage ?? "none"}.`,
    );
  }
  if (state.workItemKey !== workItemKey) {
    throw new FactoryImplementationReviewError(
      "Factory lifecycle state does not match the requested work item.",
    );
  }
  const event = requireImplementationEvent(
    readFactoryLifecycleEvents({ factoryStateRoot: input.store.factoryStateRoot, workItemKey }),
    state.factoryRunId,
    workItemKey,
  );
  const runDir = validateExecution(event, input.store, workspace);
  const metaPath = containedRegularFile(runDir, "meta.json", "implementation meta");
  const evidence = parseImplementationEvidence(metaPath);
  validateEvidenceIdentity(evidence, event, runDir, workspace);

  const handoffPath = containedRegularFile(
    runDir,
    evidence.changeReviewHandoff,
    "change-review handoff",
  );
  const eventHandoffPath = containedRegularFile(
    runDir,
    event.data.changeReviewHandoffPath,
    "lifecycle change-review handoff",
  );
  if (handoffPath !== eventHandoffPath) {
    throw new FactoryImplementationReviewError(
      "Implementation meta and lifecycle event reference different change-review handoffs.",
    );
  }
  validateGitEvidence(workspace, evidence);
  const planPath = state.approvedPlanPath
    ? workspaceRegularFile(workspace, state.approvedPlanPath, "approved plan")
    : undefined;
  return { ...evidence, workItemKey, handoffPath, ...(planPath ? { planPath } : {}) };
}

function parseImplementationEvidence(metaPath: string) {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(metaPath, "utf8"));
  } catch (error) {
    throw new FactoryImplementationReviewError(`Invalid implementation meta JSON: ${metaPath}`, {
      cause: error,
    });
  }
  const record = objectRecord(value, "implementation meta");
  const artifacts = objectRecord(record.artifacts, "implementation meta artifacts");
  const parsed = ImplementationReviewEvidenceSchema.safeParse({
    workflow: record.workflow,
    status: record.status,
    runId: record.runId,
    workspace: record.workspace,
    runDir: record.runDir,
    reviewBase: record.reviewBase,
    reviewHead: record.reviewHead,
    reviewCommitSha: record.reviewCommitSha,
    changeReviewHandoff: artifacts.changeReviewHandoff,
  });
  if (!parsed.success) {
    throw new FactoryImplementationReviewError(
      `Invalid completed implementation evidence in ${metaPath}: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

function validateExecution(
  event: Extract<FactoryLifecycleEvent, { type: "implementation.completed" }>,
  store: FactoryStoreResolution,
  workspace: string,
): string {
  const execution = event.execution;
  if (!execution?.runDir) {
    throw new FactoryImplementationReviewError("Implementation event is missing execution.runDir.");
  }
  if (!isAbsolute(execution.runDir)) {
    throw new FactoryImplementationReviewError(
      "Implementation event execution.runDir must be absolute.",
    );
  }
  if (
    canonicalPath(execution.workspace) !== workspace ||
    canonicalPath(execution.storeRoot) !== canonicalPath(store.storeRoot) ||
    execution.projectId !== store.projectId ||
    canonicalPath(execution.factoryStateRoot) !== canonicalPath(store.factoryStateRoot)
  ) {
    throw new FactoryImplementationReviewError(
      "Implementation event execution does not match the current workspace and Factory store.",
    );
  }
  const runsRoot = canonicalDirectory(store.factoryRunsDir, "Factory runs root");
  const runDir = canonicalDirectory(execution.runDir, "implementation run directory");
  if (dirname(runDir) !== runsRoot || basename(runDir) !== event.runId) {
    throw new FactoryImplementationReviewError(
      "Implementation run directory is not the matching direct child of the Factory runs root.",
    );
  }
  return runDir;
}

function validateEvidenceIdentity(
  evidence: z.infer<typeof ImplementationReviewEvidenceSchema>,
  event: Extract<FactoryLifecycleEvent, { type: "implementation.completed" }>,
  runDir: string,
  workspace: string,
): void {
  if (
    evidence.runId !== event.runId ||
    !isAbsolute(evidence.runDir) ||
    canonicalPath(evidence.workspace) !== workspace ||
    canonicalPath(evidence.runDir) !== runDir ||
    evidence.reviewBase !== event.data.reviewBase ||
    evidence.reviewHead !== event.data.reviewHead ||
    evidence.reviewCommitSha !== event.data.reviewCommitSha
  ) {
    throw new FactoryImplementationReviewError(
      "Implementation meta conflicts with lifecycle identity or review refs.",
    );
  }
}

function validateGitEvidence(
  workspace: string,
  evidence: z.infer<typeof ImplementationReviewEvidenceSchema>,
): void {
  try {
    git(workspace, ["rev-parse", "--is-inside-work-tree"]);
    const base = git(workspace, ["rev-parse", `${evidence.reviewBase}^{commit}`]);
    const head = git(workspace, ["rev-parse", `${evidence.reviewHead}^{commit}`]);
    const commit = git(workspace, ["rev-parse", `${evidence.reviewCommitSha}^{commit}`]);
    for (const value of [evidence.reviewBase, evidence.reviewHead, evidence.reviewCommitSha]) {
      if (git(workspace, ["cat-file", "-t", value]) !== "commit") {
        throw new FactoryImplementationReviewError(
          `Implementation review evidence is not a commit object: ${value}`,
        );
      }
    }
    if (head !== evidence.reviewCommitSha || commit !== evidence.reviewCommitSha) {
      throw new FactoryImplementationReviewError(
        "Implementation review head no longer matches the recorded commit SHA.",
      );
    }
    git(workspace, ["merge-base", base, commit]);
  } catch (error) {
    if (error instanceof FactoryImplementationReviewError) throw error;
    throw new FactoryImplementationReviewError(
      `Invalid implementation Git review evidence: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function resultFromReviewMeta(
  implementationRunId: string,
  contextRunId: string,
  reviewRunDir: string,
  meta: Awaited<ReturnType<typeof runChangeReview>>,
): FactoryImplementationReviewResult {
  const reviewRunId = typeof meta.runId === "string" ? meta.runId : contextRunId;
  if (reviewRunId !== contextRunId) {
    throw new FactoryImplementationReviewError(
      "Change-review result run id does not match its review context.",
    );
  }
  const common = {
    implementationRunId,
    reviewRunId,
    reviewRunDir,
    summaryPath: join(reviewRunDir, "summary.md"),
    metaPath: join(reviewRunDir, "meta.json"),
  };
  if (meta.status === "failed") {
    const failedReviews = FailedReviewsSchema.safeParse(meta.failedReviews);
    if (!failedReviews.success) {
      throw new FactoryImplementationReviewError(
        `Change-review returned invalid failed-review evidence: ${z.prettifyError(failedReviews.error)}`,
      );
    }
    return {
      ...common,
      reviewStatus: "failed",
      outcome: "ready-for-human",
      failedReviews: failedReviews.data,
    };
  }
  if (
    meta.status !== "completed" ||
    (meta.verdict !== "pass" && meta.verdict !== "needs_changes" && meta.verdict !== "blocked")
  ) {
    throw new FactoryImplementationReviewError("Change-review returned an invalid result.");
  }
  return meta.verdict === "pass"
    ? {
        ...common,
        reviewStatus: "completed",
        outcome: "review-complete",
        verdict: meta.verdict,
      }
    : {
        ...common,
        reviewStatus: "completed",
        outcome: "ready-for-human",
        verdict: meta.verdict,
      };
}

function requireImplementationEvent(
  events: FactoryLifecycleEvent[],
  runId: string,
  workItemKey: string,
): Extract<FactoryLifecycleEvent, { type: "implementation.completed" }> {
  const event = events.findLast(
    (
      candidate,
    ): candidate is Extract<FactoryLifecycleEvent, { type: "implementation.completed" }> =>
      candidate.type === "implementation.completed" && candidate.runId === runId,
  );
  if (!event) {
    throw new FactoryImplementationReviewError(
      `Lifecycle is missing implementation.completed for run ${runId}.`,
    );
  }
  if (event.workItemKey !== workItemKey) {
    throw new FactoryImplementationReviewError(
      "Implementation event does not match the requested work item.",
    );
  }
  return event;
}

function containedRegularFile(root: string, path: string, label: string): string {
  if (isAbsolute(path)) {
    throw new FactoryImplementationReviewError(`${label} path must be run-relative.`);
  }
  const candidate = resolve(root, path);
  const relativePath = relative(root, candidate);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${separator()}`)) {
    throw new FactoryImplementationReviewError(`${label} path escapes the implementation run.`);
  }
  const canonical = canonicalFile(candidate, label);
  const canonicalRelative = relative(root, canonical);
  if (
    !canonicalRelative ||
    canonicalRelative === ".." ||
    canonicalRelative.startsWith(`..${separator()}`)
  ) {
    throw new FactoryImplementationReviewError(`${label} resolves outside the implementation run.`);
  }
  return canonical;
}

function workspaceRegularFile(workspace: string, path: string, label: string): string {
  if (isAbsolute(path)) {
    throw new FactoryImplementationReviewError(`${label} path must be workspace-relative.`);
  }
  const canonical = canonicalFile(resolve(workspace, path), label);
  const relativePath = relative(workspace, canonical);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${separator()}`)) {
    throw new FactoryImplementationReviewError(`${label} resolves outside the workspace.`);
  }
  return canonical;
}

function canonicalDirectory(path: string, label: string): string {
  try {
    const canonical = realpathSync(resolve(path));
    if (!statSync(canonical).isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch (error) {
    throw new FactoryImplementationReviewError(`Invalid ${label}: ${path}`, { cause: error });
  }
}

function canonicalFile(path: string, label: string): string {
  try {
    const canonical = realpathSync(resolve(path));
    if (!statSync(canonical).isFile()) throw new Error("not a regular file");
    readFileSync(canonical);
    return canonical;
  } catch (error) {
    throw new FactoryImplementationReviewError(`Invalid ${label}: ${path}`, { cause: error });
  }
}

function canonicalPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FactoryImplementationReviewError(`Invalid ${label}: expected an object.`);
  }
  return value as Record<string, unknown>;
}

function git(workspace: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function separator(): string {
  return process.platform === "win32" ? "\\" : "/";
}
