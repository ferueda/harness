import { writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Agent,
  AgentApprovalPolicy,
  AgentProviderName,
  AgentReasoningEffort,
  AgentRunInput,
  AgentRunResult,
  AgentSandboxMode,
} from "../agent/contract.ts";
import { DEFAULT_AGENT_MODELS, DEFAULT_CODEX_REASONING_EFFORT } from "../agent/contract.ts";
import {
  buildInlinedHandoffSection,
  buildPlanRef,
  fillTemplate,
  type ContextArtifact,
} from "./run-context.ts";
import {
  IMPLEMENTATION_REVIEW_PROMPT,
  QUALITY_REVIEW_PROMPT,
  SPEC_REVIEW_PROMPT,
} from "./prompts/index.ts";
import {
  recordStreamArtifact,
  type PromptArtifacts,
  type ReviewRunScope,
  type StreamArtifacts,
} from "./run-report.ts";
import { ReviewOutputSchema, formatZodError, type ReviewOutput } from "./schema.ts";

const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
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

export type ReviewAgentName = keyof typeof REVIEWER_CONFIGS;

export type ReviewAgentOptions = {
  model?: string;
  sandboxMode?: AgentSandboxMode;
  approvalPolicy?: AgentApprovalPolicy;
  modelReasoningEffort?: AgentReasoningEffort;
};

export type ResolvedReviewAgent = {
  model: string;
  policy: Pick<AgentRunInput, "sandboxMode" | "approvalPolicy" | "modelReasoningEffort">;
};

type PromptContextArtifacts = {
  plan: ContextArtifact;
  handoff: ContextArtifact;
};

export function getReviewInfo(name: ReviewAgentName): {
  key: string;
  title: string;
  stage: string;
} {
  const config = REVIEWER_CONFIGS[name];
  return { key: config.summaryKey, title: config.title, stage: config.stage };
}

export function resolveReviewAgent(
  providerName: AgentProviderName,
  options: ReviewAgentOptions,
): ResolvedReviewAgent {
  const policy =
    providerName === "codex"
      ? {
          sandboxMode: options.sandboxMode ?? REVIEW_SANDBOX_MODE,
          approvalPolicy: options.approvalPolicy ?? REVIEW_APPROVAL_POLICY,
          modelReasoningEffort: options.modelReasoningEffort ?? DEFAULT_CODEX_REASONING_EFFORT,
        }
      : {};
  return {
    model: options.model ?? DEFAULT_AGENT_MODELS[providerName],
    policy,
  };
}

export async function runReviewer(input: {
  name: ReviewAgentName;
  provider: Agent;
  resolvedAgent: ResolvedReviewAgent;
  workspace: string;
  runDir: string;
  scope?: ReviewRunScope;
  diffRef?: string;
  contextArtifacts: PromptContextArtifacts;
  promptPaths: PromptArtifacts;
  streamArtifacts: StreamArtifacts;
  maxRuntimeMs: number;
  dryRun?: boolean;
  signal?: AbortSignal;
}): Promise<ReviewOutput> {
  const config = REVIEWER_CONFIGS[input.name];
  const promptPath = join(input.runDir, config.promptFile);
  const streamPath = join(input.runDir, `${config.stage}-review.stream.jsonl`);
  const prompt = fillTemplate(
    config.promptTemplate,
    buildPromptValues({
      scope: input.scope,
      diffRef: input.diffRef,
      workspace: input.workspace,
      contextArtifacts: input.contextArtifacts,
      agentName: input.name,
    }),
  );
  writeFileSync(promptPath, prompt, "utf8");
  input.promptPaths[config.stage] = promptPath;

  if (input.dryRun) {
    writeJson(join(input.runDir, config.reviewFile), config.dryRunReview);
    return config.dryRunReview;
  }

  let result: AgentRunResult | undefined;
  try {
    result = await input.provider.run({
      workspace: input.workspace,
      prompt,
      schemaPath: SCHEMA_PATH,
      model: input.resolvedAgent.model,
      ...input.resolvedAgent.policy,
      maxRuntimeMs: input.maxRuntimeMs,
      logPath: streamPath,
      signal: input.signal,
    });
  } finally {
    recordStreamArtifact(
      input.streamArtifacts,
      config.stage,
      streamPath,
      input.provider.name,
      result,
    );
  }
  if (!result) throw new Error(`${config.stage} reviewer failed without a result`);

  writeJson(join(input.runDir, config.rawFile), rawAgentArtifact(result));

  if (!result.ok) {
    if (result.aborted) throw new Error(`Agent was aborted: ${config.stage} reviewer`);
    throw new Error(`${config.stage} reviewer failed: ${result.error}`);
  }

  const review = parseReviewerOutput(config.stage, result.structuredOutput);
  writeJson(join(input.runDir, config.reviewFile), review);
  return review;
}

function buildPromptValues({
  scope,
  diffRef,
  workspace,
  contextArtifacts,
  agentName,
}: {
  scope?: ReviewRunScope;
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

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}
