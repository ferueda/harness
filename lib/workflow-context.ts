import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregateVerdict,
  renderFailedSummary,
  renderSummary,
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
  AgentRunInput,
  AgentRunResult,
  AgentSandboxMode,
} from "./agents.ts";
import { DEFAULT_AGENT_MODELS, DEFAULT_CODEX_REASONING_EFFORT } from "./agents.ts";
import type { AgentStreamFormat, AgentStreamLogSummary } from "./agent-stream-log.ts";
import {
  WORKFLOW_EVENTS_FILE,
  createCompositeEventSink,
  createFileEventSink,
  noopEventSink,
  type WorkflowEventSink,
} from "./workflow-events.ts";
import {
  buildDiffRef,
  buildInlinedHandoffSection,
  buildPlanRef,
  buildRunId,
  fillTemplate,
  prepareGitScope,
  writeRunContext,
} from "./context.ts";
import {
  IMPLEMENTATION_REVIEW_PROMPT,
  QUALITY_REVIEW_PROMPT,
  SPEC_REVIEW_PROMPT,
} from "./prompts/index.ts";
import type { ContextArtifact } from "./context.ts";
import { ReviewOutputSchema, formatZodError, type ReviewOutput } from "./schemas.ts";

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

type Scope = ReturnType<typeof prepareGitScope> & {
  baseRef: string;
  headRef: string;
};

type ScopeMeta = ReturnType<typeof buildScopeMeta>;
type ReviewSummary = ReturnType<typeof summarizeReview>;
type ReviewSummaries = Record<string, ReviewSummary>;

export type ReviewAgentName = keyof typeof REVIEWER_CONFIGS;

type ReviewStage = (typeof REVIEWER_CONFIGS)[ReviewAgentName]["stage"];
type PromptArtifacts = Partial<Record<ReviewStage, string>>;
type StreamArtifact = {
  path: string;
  status: AgentStreamLogSummary["status"];
  provider: AgentProviderName;
  format: AgentStreamFormat;
  bytes?: number;
  error?: string;
  agentMessageCount?: number;
  finalAgentMessageId?: string;
};
type StreamArtifacts = Partial<Record<ReviewStage, StreamArtifact>>;

type PromptContextArtifacts = {
  plan: ContextArtifact;
  handoff: ContextArtifact;
};

const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IS_BUILT_OUTPUT = basename(MODULE_ROOT) === "dist";
const HARNESS_ROOT = IS_BUILT_OUTPUT ? resolve(MODULE_ROOT, "..") : MODULE_ROOT;
const SCHEMA_PATH = join(HARNESS_ROOT, "schemas/review-output.schema.json");
const REVIEW_SANDBOX_MODE = "read-only" satisfies AgentSandboxMode;
const REVIEW_APPROVAL_POLICY = "never" satisfies AgentApprovalPolicy;
const DRY_RUN_REVIEW = {
  verdict: "pass",
  summary: "(dry-run placeholder)",
  findings: [],
} satisfies ReviewOutput;

const REVIEWER_CONFIGS = {
  "review-implementation": {
    title: "Implementation review",
    summaryKey: "implementation",
    promptTemplate: IMPLEMENTATION_REVIEW_PROMPT,
    promptFile: "implementation-review.prompt.md",
    reviewFile: "implementation-review.json",
    rawFile: "implementation-review.raw.json",
    dryRunReview: DRY_RUN_REVIEW,
    stage: "implementation",
  },
  "code-quality-review": {
    title: "Code quality review",
    summaryKey: "codeQuality",
    promptTemplate: QUALITY_REVIEW_PROMPT,
    promptFile: "quality-review.prompt.md",
    reviewFile: "quality-review.json",
    rawFile: "quality-review.raw.json",
    dryRunReview: DRY_RUN_REVIEW,
    stage: "quality",
  },
  "review-spec": {
    title: "Spec review",
    summaryKey: "spec",
    promptTemplate: SPEC_REVIEW_PROMPT,
    promptFile: "spec-review.prompt.md",
    reviewFile: "spec-review.json",
    rawFile: "spec-review.raw.json",
    dryRunReview: DRY_RUN_REVIEW,
    stage: "spec",
  },
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
  if (!existsSync(workspace)) {
    throw new Error(`Workspace does not exist: ${workspace}`);
  }

  const startedAt = new Date();
  const runId = buildRunId(startedAt);
  const runDir = join(resolve(options.runsDir ?? join(workspace, ".harness/runs/reviews")), runId);
  const includeGitScope = options.includeGitScope ?? true;

  let reviewProvider: Agent;
  let contextArtifacts: PromptContextArtifacts;
  let scope: Scope | undefined;
  let scopeMeta: ScopeMeta | undefined;
  let diffRef: string | undefined;
  try {
    mkdirSync(runDir, { recursive: true });

    const agentProviderFactory = options.agentProviderFactory;
    if (!agentProviderFactory) {
      throw new Error("agentProviderFactory is required");
    }
    reviewProvider = agentProviderFactory({
      provider: options.agentProvider ?? "cursor",
      codexPathOverride: options.codexPathOverride,
    });
    if (includeGitScope) {
      const baseRef = options.baseRef ?? "main";
      const headRef = options.headRef ?? "HEAD";
      scope = {
        ...prepareGitScope(workspace, {
          baseRef,
          headRef,
        }),
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
  const agentPolicyMeta = reviewPolicyOptions(reviewProvider.name, options);
  const agentMeta = {
    name: reviewProvider.name,
    model: resolvedAgentModel(reviewProvider.name, options),
    ...agentPolicyMeta,
  };
  const writeDryRunMeta = (steps?: WorkflowStepMetadata) => {
    const meta = {
      runId,
      status: "dry_run",
      workspace,
      runDir,
      agent: agentMeta,
      ...(scopeMeta ? { scope: scopeMeta } : {}),
      ...steps,
      prompts: promptPaths,
    };
    writeJson(join(runDir, "meta.json"), meta);
    return meta;
  };
  const finalizeRun = (
    input:
      | {
          status: "completed";
          title: string;
          reviews: ReviewSection[];
          verdict: ReviewVerdict;
          steps?: WorkflowStepMetadata;
        }
      | {
          status: "failed";
          title: string;
          reviews: ReviewSection[];
          failedReviews: FailedReview[];
          steps?: WorkflowStepMetadata;
        },
  ) => {
    const durationMs = Date.now() - startedAt.getTime();
    const startedAtIso = startedAt.toISOString();

    const summary =
      input.status === "completed"
        ? renderSummary({
            title: input.title,
            runId,
            workspace,
            scope,
            reviews: input.reviews,
            verdict: input.verdict,
            startedAt: startedAtIso,
            durationMs,
            steps: input.steps,
          })
        : renderFailedSummary({
            title: input.title,
            runId,
            workspace,
            scope,
            reviews: input.reviews,
            failedReviews: input.failedReviews,
            startedAt: startedAtIso,
            durationMs,
            steps: input.steps,
          });
    writeFileSync(join(runDir, "summary.md"), summary, "utf8");

    const reviewSummaries = buildReviewSummaries(input.reviews);
    const baseMeta = {
      runId,
      workspace,
      agent: agentMeta,
      ...(scopeMeta ? { scope: scopeMeta } : {}),
      startedAt: startedAtIso,
      durationMs,
      ...input.steps,
      ...buildTopLevelReviewFields(reviewSummaries),
      reviews: reviewSummaries,
      ...buildStreamArtifactsMeta(streamArtifacts),
      eventsFile: WORKFLOW_EVENTS_FILE,
    };
    const meta =
      input.status === "completed"
        ? { ...baseMeta, status: "completed", verdict: input.verdict }
        : { ...baseMeta, status: "failed", failedReviews: input.failedReviews };
    writeJson(join(runDir, "meta.json"), meta);
    return meta;
  };

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
    reviewConcurrency: resolvedReviewConcurrency(reviewProvider.name, options),
    aggregate: aggregateVerdict,
    reviewInfo: getReviewInfo,
    async agent(name: ReviewAgentName): Promise<ReviewOutput> {
      const config = REVIEWER_CONFIGS[name];

      const promptPath = join(runDir, config.promptFile);
      const streamPath = join(runDir, `${config.stage}-review.stream.jsonl`);
      const prompt = fillTemplate(
        config.promptTemplate,
        buildPromptValues({
          scope,
          diffRef,
          workspace,
          contextArtifacts,
          agentName: name,
        }),
      );
      writeFileSync(promptPath, prompt, "utf8");
      promptPaths[config.stage] = promptPath;

      if (options.dryRun) {
        writeJson(join(runDir, config.reviewFile), config.dryRunReview);
        return config.dryRunReview;
      }

      let result: AgentRunResult | undefined;
      try {
        result = await reviewProvider.run({
          workspace,
          prompt,
          schemaPath: SCHEMA_PATH,
          model: resolvedAgentModel(reviewProvider.name, options),
          ...agentPolicyMeta,
          maxRuntimeMs: options.maxRuntimeMs,
          logPath: streamPath,
          signal: options.signal,
        });
      } finally {
        recordStreamArtifact(
          streamArtifacts,
          config.stage,
          streamPath,
          reviewProvider.name,
          result,
        );
      }
      if (!result) {
        throw new Error(`${config.stage} reviewer failed without a result`);
      }

      writeJson(join(runDir, config.rawFile), rawAgentArtifact(result));

      if (!result.ok) {
        if (result.aborted) {
          throw new Error(`Agent was aborted: ${config.stage} reviewer`);
        }
        throw new Error(`${config.stage} reviewer failed: ${result.error}`);
      }

      const review = parseReviewerOutput(config.stage, result.structuredOutput);
      writeJson(join(runDir, config.reviewFile), review);
      return review;
    },
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
      if (options.dryRun) {
        return writeDryRunMeta(steps);
      }

      return finalizeRun({ status: "completed", title, reviews, verdict, steps });
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
      return finalizeRun({ status: "failed", title, reviews, failedReviews, steps });
    },
  };
}

function getReviewInfo(name: ReviewAgentName): { key: string; title: string; stage: string } {
  const config = REVIEWER_CONFIGS[name];
  return { key: config.summaryKey, title: config.title, stage: config.stage };
}

function reviewPolicyOptions(
  providerName: AgentProviderName,
  options: WorkflowRunOptions,
): Pick<AgentRunInput, "sandboxMode" | "approvalPolicy" | "modelReasoningEffort"> {
  if (providerName !== "codex") return {};
  return {
    sandboxMode: options.sandboxMode ?? REVIEW_SANDBOX_MODE,
    approvalPolicy: options.approvalPolicy ?? REVIEW_APPROVAL_POLICY,
    modelReasoningEffort: options.modelReasoningEffort ?? DEFAULT_CODEX_REASONING_EFFORT,
  };
}

function resolvedAgentModel(providerName: AgentProviderName, options: WorkflowRunOptions): string {
  return options.model ?? DEFAULT_AGENT_MODELS[providerName];
}

function resolvedReviewConcurrency(
  _providerName: AgentProviderName,
  _options: WorkflowRunOptions,
): "parallel" | "serial" {
  return "parallel";
}

function buildScopeMeta(scope: Scope) {
  return {
    baseRef: scope.baseRef,
    headRef: scope.headRef,
    mergeBase: scope.mergeBase,
    headSha: scope.headSha,
    headBranch: scope.headBranch,
    diffChars: scope.diff.length,
    diffLines: scope.diff ? scope.diff.split("\n").length : 0,
  };
}

function buildPromptValues({
  scope,
  diffRef,
  workspace,
  contextArtifacts,
  agentName,
}: {
  scope?: Scope;
  diffRef?: string;
  workspace: string;
  contextArtifacts: PromptContextArtifacts;
  agentName: ReviewAgentName;
}): Record<string, string> {
  return {
    BASE_REF: scope?.baseRef ?? "",
    HEAD_REF: scope?.headRef ?? "",
    DIFF_RANGE: scope ? `${scope.mergeBase}..${scope.headSha}` : "",
    PLAN_REF:
      agentName === "review-implementation" || agentName === "review-spec"
        ? buildPlanRef(contextArtifacts.plan, workspace)
        : "",
    HANDOFF_SECTION: buildInlinedHandoffSection(contextArtifacts.handoff),
    DIFF_REF: diffRef ?? "",
  };
}

function parseReviewerOutput(stage: string, structuredOutput: unknown): ReviewOutput {
  const review = ReviewOutputSchema.safeParse(structuredOutput);
  if (!review.success) {
    throw new Error(
      `${stage} reviewer failed: Invalid reviewer structured output: ${formatZodError(
        review.error,
      )}`,
    );
  }
  assertReviewerVerdictContract(stage, review.data);
  return review.data;
}

function assertReviewerVerdictContract(stage: string, review: ReviewOutput): void {
  if (review.verdict === "blocked") return;

  const hasMustFix = review.findings.some((finding) => finding.must_fix);
  if (review.verdict === "needs_changes" && !hasMustFix) {
    throw new Error(
      `${stage} reviewer failed: needs_changes requires at least one must_fix finding`,
    );
  }
  if (review.verdict === "pass" && hasMustFix) {
    throw new Error(`${stage} reviewer failed: pass cannot include must_fix findings`);
  }
}

function rawAgentArtifact(result: AgentRunResult): unknown {
  if (result.ok || result.raw !== undefined) return result.raw;
  return { error: result.error };
}

function summarizeReview(review: ReviewSection["review"]): {
  verdict: ReviewSection["review"]["verdict"];
  findingCount: number;
} {
  return {
    verdict: review?.verdict,
    findingCount: review?.findings?.length ?? 0,
  };
}

function buildReviewSummaries(reviews: ReviewSection[]): ReviewSummaries {
  return Object.fromEntries(reviews.map(({ key, review }) => [key, summarizeReview(review)]));
}

function buildTopLevelReviewFields(reviewSummaries: ReviewSummaries): {
  implementationReview?: ReviewSummary;
  qualityReview?: ReviewSummary;
  specReview?: ReviewSummary;
} {
  const fields: {
    implementationReview?: ReviewSummary;
    qualityReview?: ReviewSummary;
    specReview?: ReviewSummary;
  } = {};
  const fieldNames = {
    implementation: "implementationReview",
    codeQuality: "qualityReview",
    spec: "specReview",
  } as const;

  for (const [key, fieldName] of Object.entries(fieldNames)) {
    const summary = reviewSummaries[key];
    if (summary) fields[fieldName] = summary;
  }
  return fields;
}

function recordStreamArtifact(
  artifacts: StreamArtifacts,
  stage: ReviewStage,
  path: string,
  provider: AgentProviderName,
  result: AgentRunResult | undefined,
): void {
  const streamLog = extractStreamLog(result?.raw);
  const stat = fileStat(path);
  const bytes = stat?.size;
  const status = streamLog?.status ?? (bytes && bytes > 0 ? "written" : "missing");

  artifacts[stage] = {
    path,
    status,
    provider: streamLog?.provider ?? provider,
    format: streamLog?.format ?? streamFormatForProvider(provider),
    ...(bytes !== undefined ? { bytes } : {}),
    ...(streamLog?.error ? { error: streamLog.error } : {}),
    ...(streamLog?.agentMessageCount !== undefined
      ? { agentMessageCount: streamLog.agentMessageCount }
      : {}),
    ...(streamLog?.finalAgentMessageId
      ? { finalAgentMessageId: streamLog.finalAgentMessageId }
      : {}),
  };
}

function extractStreamLog(raw: unknown): AgentStreamLogSummary | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const streamLog = (raw as { streamLog?: unknown }).streamLog;
  if (!streamLog || typeof streamLog !== "object" || Array.isArray(streamLog)) return undefined;

  const candidate = streamLog as Partial<AgentStreamLogSummary>;
  if (
    typeof candidate.path !== "string" ||
    !isStreamStatus(candidate.status) ||
    (candidate.provider !== "cursor" && candidate.provider !== "codex") ||
    (candidate.format !== "cursor-sdk-message" && candidate.format !== "codex-thread-event")
  ) {
    return undefined;
  }
  return candidate as AgentStreamLogSummary;
}

function isStreamStatus(status: unknown): status is AgentStreamLogSummary["status"] {
  return (
    status === "written" || status === "missing" || status === "unsupported" || status === "error"
  );
}

function streamFormatForProvider(provider: AgentProviderName): AgentStreamFormat {
  return provider === "codex" ? "codex-thread-event" : "cursor-sdk-message";
}

function fileStat(path: string): { size: number } | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

function buildStreamArtifactsMeta(artifacts: StreamArtifacts): {
  streamArtifacts?: StreamArtifacts;
} {
  return Object.keys(artifacts).length > 0 ? { streamArtifacts: artifacts } : {};
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

export function cleanupOrphanedRunDir(runDir: string): boolean {
  if (existsSync(join(runDir, "meta.json"))) {
    return false;
  }

  rmSync(runDir, { recursive: true, force: true });
  return true;
}
