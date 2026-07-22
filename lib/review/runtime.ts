import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  aggregateVerdict,
  type FailedReview,
  type ReviewSection,
  type ReviewVerdict,
  type WorkflowStepMetadata,
} from "./aggregate.ts";
import type {
  Agent,
  AgentApprovalPolicy,
  AgentProviderName,
  AgentProviderOptions,
  AgentReasoningEffort,
  AgentSandboxMode,
} from "../agent/contract.ts";
import {
  createCompositeEventSink,
  createFileEventSink,
  noopEventSink,
  type WorkflowEventSink,
} from "./events.ts";
import {
  buildDiffRef,
  buildRunId,
  prepareGitScope,
  writeRunContext,
  type ContextArtifact,
} from "./run-context.ts";
import {
  getReviewInfo,
  resolveReviewAgent,
  runReviewer,
  type ReviewAgentName,
} from "./reviewer.ts";
import {
  buildScopeMeta,
  cleanupOrphanedRunDir,
  createRunReportWriter,
  type PromptArtifacts,
  type ReviewRunScope,
  type StreamArtifacts,
} from "./run-report.ts";

export type { ReviewAgentName } from "./reviewer.ts";
export { cleanupOrphanedRunDir } from "./run-report.ts";

type WorkflowRunOptions = {
  workspace: string;
  baseRef?: string;
  headRef?: string;
  runsDir?: string;
  agentProvider?: AgentProviderName;
  codexPathOverride?: string;
  planPath?: string;
  handoffPath?: string;
  handoffText?: string;
  model?: string;
  sandboxMode?: AgentSandboxMode;
  approvalPolicy?: AgentApprovalPolicy;
  modelReasoningEffort?: AgentReasoningEffort;
  maxRuntimeMs: number;
  dryRun?: boolean;
  includeGitScope?: boolean;
  eventSink?: WorkflowEventSink;
  heartbeatMs?: number;
  signal?: AbortSignal;
};

type WorkflowOptions = WorkflowRunOptions & {
  agentProviderFactory: (options: AgentProviderOptions) => Agent;
};

type WorkflowContextFactoryOptions = WorkflowRunOptions & {
  agentProviderFactory?: (options: AgentProviderOptions) => Agent;
};

type PromptContextArtifacts = {
  plan: ContextArtifact;
  handoff: ContextArtifact;
};

export function createWorkflowContext(options: WorkflowOptions) {
  return createWorkflowContextInternal(options);
}

// Test-only seam for provider injection; production callers should use createWorkflowContext.
export function createWorkflowContextForTest(options: WorkflowContextFactoryOptions) {
  return createWorkflowContextInternal(options);
}

function createWorkflowContextInternal(options: WorkflowContextFactoryOptions) {
  const workspace = resolve(options.workspace);
  if (!existsSync(workspace)) throw new Error(`Workspace does not exist: ${workspace}`);

  const startedAt = new Date();
  const runId = buildRunId(startedAt);
  const runDir = join(resolve(options.runsDir ?? join(workspace, ".harness/runs/reviews")), runId);
  const includeGitScope = options.includeGitScope ?? true;

  let reviewProvider: Agent;
  let contextArtifacts: PromptContextArtifacts;
  let scope: ReviewRunScope | undefined;
  let scopeMeta: ReturnType<typeof buildScopeMeta> | undefined;
  let diffRef: string | undefined;
  try {
    mkdirSync(runDir, { recursive: true });

    const agentProviderFactory = options.agentProviderFactory;
    if (!agentProviderFactory) throw new Error("agentProviderFactory is required");
    reviewProvider = agentProviderFactory({
      provider: options.agentProvider ?? "cursor",
      codexPathOverride: options.codexPathOverride,
    });
    if (includeGitScope) {
      const baseRef = options.baseRef ?? "main";
      const headRef = options.headRef ?? "HEAD";
      scope = {
        ...prepareGitScope(workspace, { baseRef, headRef }),
        baseRef,
        headRef,
      };
      scopeMeta = buildScopeMeta(scope);
      diffRef = buildDiffRef(scope.diff, runDir, workspace);
    }

    contextArtifacts = writeRunContext({
      workspace,
      runDir,
      scope,
      planPath: options.planPath,
      handoffPath: options.handoffPath,
      handoffText: options.handoffText,
    });
  } catch (error) {
    cleanupOrphanedRunDir(runDir);
    throw error;
  }

  const promptPaths: PromptArtifacts = {};
  const streamArtifacts: StreamArtifacts = {};
  const eventSink = options.dryRun
    ? noopEventSink
    : options.eventSink
      ? createCompositeEventSink(createFileEventSink(runDir), options.eventSink)
      : createFileEventSink(runDir);
  const resolvedAgent = resolveReviewAgent(reviewProvider.name, options);
  const agentMeta = {
    name: reviewProvider.name,
    model: resolvedAgent.model,
    ...resolvedAgent.policy,
  };
  const report = createRunReportWriter({
    runId,
    runDir,
    workspace,
    startedAt,
    agentMeta,
    scope,
    scopeMeta,
    promptPaths,
    streamArtifacts,
  });

  return {
    runId,
    runDir,
    workspace,
    scope,
    scopeMeta,
    startedAt,
    dryRun: options.dryRun,
    eventSink,
    heartbeatMs: options.heartbeatMs,
    reviewConcurrency: "parallel",
    aggregate: aggregateVerdict,
    reviewInfo: getReviewInfo,
    agent: (name: ReviewAgentName) =>
      runReviewer({
        name,
        provider: reviewProvider,
        resolvedAgent,
        workspace,
        runDir,
        scope,
        diffRef,
        contextArtifacts,
        promptPaths,
        streamArtifacts,
        maxRuntimeMs: options.maxRuntimeMs,
        dryRun: options.dryRun,
        signal: options.signal,
      }),
    export({
      title,
      reviews,
      verdict,
      steps,
    }: {
      title: string;
      reviews: ReviewSection[];
      verdict: ReviewVerdict;
      steps?: WorkflowStepMetadata;
    }) {
      if (options.dryRun) return report.writeDryRun(steps);
      return report.finalize({ status: "completed", title, reviews, verdict, steps });
    },
    exportFailed({
      title,
      reviews,
      failedReviews,
      steps,
    }: {
      title: string;
      reviews: ReviewSection[];
      failedReviews: FailedReview[];
      steps?: WorkflowStepMetadata;
    }) {
      return report.finalize({ status: "failed", title, reviews, failedReviews, steps });
    },
  };
}
