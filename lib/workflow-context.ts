import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
import { createAgentProvider } from "./agent-provider.ts";
import type { AgentProviderOptions } from "./agent-provider.ts";
import type {
  Agent,
  AgentApprovalPolicy,
  AgentProviderName,
  AgentReasoningEffort,
  AgentRunInput,
  AgentRunResult,
  AgentSandboxMode,
  CursorRuntime,
} from "./agents.ts";
import {
  DEFAULT_AGENT_MODELS,
  DEFAULT_CODEX_REASONING_EFFORT,
  effectiveCursorRuntime,
} from "./agents.ts";
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
  SIMPLIFY_REVIEW_PROMPT,
} from "./prompts/index.ts";
import type { ContextArtifact } from "./context.ts";
import { ReviewOutputSchema, formatZodError, type ReviewOutput } from "./schemas.ts";

type WorkflowOptions = {
  workspace: string;
  baseRef: string;
  headRef: string;
  runsDir?: string;
  agentProvider?: AgentProviderName;
  cursorRuntime?: CursorRuntime;
  cursorAgentPath?: string;
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
};

type WorkflowContextFactoryOptions = WorkflowOptions & {
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

type PromptArtifacts = Partial<Record<(typeof REVIEWER_CONFIGS)[ReviewAgentName]["stage"], string>>;

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
  simplify: {
    title: "Simplify review",
    summaryKey: "simplify",
    promptTemplate: SIMPLIFY_REVIEW_PROMPT,
    promptFile: "simplify-review.prompt.md",
    reviewFile: "simplify-review.json",
    rawFile: "simplify-review.raw.json",
    dryRunReview: DRY_RUN_REVIEW,
    stage: "simplify",
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

  let reviewProvider: Agent;
  let contextArtifacts: PromptContextArtifacts;
  let scope: Scope;
  let scopeMeta: ScopeMeta;
  let diffRef: string;
  try {
    mkdirSync(runDir, { recursive: true });

    const agentProviderFactory = options.agentProviderFactory ?? createAgentProvider;
    reviewProvider = agentProviderFactory({
      provider: options.agentProvider ?? "cursor",
      cursorRuntime: options.cursorRuntime,
      cursorAgentPath: options.cursorAgentPath,
      codexPathOverride: options.codexPathOverride,
    });
    scope = {
      ...prepareGitScope(workspace, {
        baseRef: options.baseRef,
        headRef: options.headRef,
      }),
      baseRef: options.baseRef,
      headRef: options.headRef,
    };
    scopeMeta = buildScopeMeta(scope);

    contextArtifacts = writeRunContext({
      workspace,
      runDir,
      scope,
      planPath: options.planPath,
      handoffPath: options.handoffPath,
      handoffText: options.handoffText,
    });

    diffRef = buildDiffRef(scope.diff, runDir, workspace);
  } catch (error) {
    cleanupOrphanedRunDir(runDir);
    throw error;
  }

  const promptPaths: PromptArtifacts = {};
  const agentPolicyMeta = reviewPolicyOptions(reviewProvider.name, options);
  const agentMeta = {
    name: reviewProvider.name,
    model: resolvedAgentModel(reviewProvider.name, options),
    ...resolvedCursorRuntimeMeta(reviewProvider.name, options),
    ...agentPolicyMeta,
  };
  const writeDryRunMeta = (steps?: WorkflowStepMetadata) => {
    const meta = {
      runId,
      status: "dry_run",
      workspace,
      scope: scopeMeta,
      runDir,
      agent: agentMeta,
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
      scope: scopeMeta,
      startedAt: startedAtIso,
      durationMs,
      ...input.steps,
      ...buildTopLevelReviewFields(reviewSummaries),
      reviews: reviewSummaries,
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
    reviewConcurrency: resolvedReviewConcurrency(reviewProvider.name, options),
    aggregate: aggregateVerdict,
    reviewInfo: getReviewInfo,
    async agent(name: ReviewAgentName): Promise<ReviewOutput> {
      const config = REVIEWER_CONFIGS[name];

      const promptPath = join(runDir, config.promptFile);
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

      const result = await reviewProvider.run({
        workspace,
        prompt,
        schemaPath: SCHEMA_PATH,
        model: resolvedAgentModel(reviewProvider.name, options),
        ...agentPolicyMeta,
        maxRuntimeMs: options.maxRuntimeMs,
      });

      writeJson(join(runDir, config.rawFile), rawAgentArtifact(result));

      if (!result.ok) {
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
  options: WorkflowOptions,
): Pick<AgentRunInput, "sandboxMode" | "approvalPolicy" | "modelReasoningEffort"> {
  if (providerName !== "codex") return {};
  return {
    sandboxMode: options.sandboxMode ?? REVIEW_SANDBOX_MODE,
    approvalPolicy: options.approvalPolicy ?? REVIEW_APPROVAL_POLICY,
    modelReasoningEffort: options.modelReasoningEffort ?? DEFAULT_CODEX_REASONING_EFFORT,
  };
}

function resolvedAgentModel(providerName: AgentProviderName, options: WorkflowOptions): string {
  return options.model ?? DEFAULT_AGENT_MODELS[providerName];
}

function resolvedCursorRuntimeMeta(providerName: AgentProviderName, options: WorkflowOptions) {
  if (providerName !== "cursor") return {};
  return { runtime: effectiveCursorRuntime(options.cursorRuntime) };
}

function resolvedReviewConcurrency(
  _providerName: AgentProviderName,
  _options: WorkflowOptions,
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
  scope: Scope;
  diffRef: string;
  workspace: string;
  contextArtifacts: PromptContextArtifacts;
  agentName: ReviewAgentName;
}): Record<string, string> {
  return {
    BASE_REF: scope.baseRef,
    HEAD_REF: scope.headRef,
    DIFF_RANGE: `${scope.mergeBase}..${scope.headSha}`,
    PLAN_REF:
      agentName === "review-implementation"
        ? buildPlanRef(contextArtifacts.plan, workspace)
        : "",
    HANDOFF_SECTION: buildInlinedHandoffSection(contextArtifacts.handoff),
    DIFF_REF: diffRef,
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
  return review.data;
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
  simplifyReview?: ReviewSummary;
} {
  const fields: {
    implementationReview?: ReviewSummary;
    qualityReview?: ReviewSummary;
    simplifyReview?: ReviewSummary;
  } = {};
  const fieldNames = {
    implementation: "implementationReview",
    codeQuality: "qualityReview",
    simplify: "simplifyReview",
  } as const;

  for (const [key, fieldName] of Object.entries(fieldNames)) {
    const summary = reviewSummaries[key];
    if (summary) fields[fieldName] = summary;
  }
  return fields;
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
