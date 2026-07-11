import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Agent,
  DEFAULT_CODEX_REASONING_EFFORT,
  type AgentRunInput,
  type AgentRunResult,
  type AgentSessionRef,
} from "../lib/agents.ts";
import {
  FACTORY_PLANNING_SCHEMA_PATH,
  DraftValidationError,
  FactoryPlanningPublicationError,
  type DraftValidationReason,
  type PlannerFailureClassification,
  type PublicationStage,
  type FactoryPlanningAgentRole,
  type FactoryPlanningReviewRef,
  type FactoryPlanningReviewMeta,
  type FactoryPlanningRunContext,
  type FactoryPlanningRunMeta,
  readJsonFile,
} from "../lib/factory-planning-run-context.ts";
import {
  FactoryPlanningError,
  parseFactoryPlanningOutput,
  type FactoryPlanningOutput,
} from "../lib/factory-planning-schemas.ts";
import {
  renderFactoryPlanningInitialPrompt,
  renderFactoryPlanningRevisionPrompt,
} from "../lib/prompts/index.ts";
import { errorArtifact } from "../lib/agent-invoke.ts";
import { readWorkspaceStatus, withWorkspaceGuard } from "../lib/review-guard.ts";
import { ReviewOutputSchema, type ReviewOutput } from "../lib/schemas.ts";
import { createWorkflowContext } from "../lib/workflow-context.ts";
import { run as runPlanReview } from "./plan-review.workflow.ts";

export const meta = { name: "factory-planning" };

const FACTORY_PLANNING_APPROVAL_POLICY = "never" as const;

const DRY_RUN_PLANNING = {
  outcome: "draft-ready",
  summary: "(dry-run placeholder)",
  humanQuestions: [],
  findingDecisions: [],
} satisfies FactoryPlanningOutput;

const DRY_RUN_PLAN_MARKDOWN = "# Dry Run Plan\n\nProviders and reviewers were not called.\n";

type PlanningIteration = FactoryPlanningRunMeta["iterations"][number];
type ReviewMeta = FactoryPlanningReviewMeta;
type EnrichedFinding = ReviewOutput["findings"][number] & { id: string };

export async function run(ctx: FactoryPlanningRunContext): Promise<FactoryPlanningRunMeta> {
  const startedAt = new Date();
  if (!ctx.dryRun) {
    ctx.eventSink({
      type: "run:start",
      runId: ctx.runId,
      runDir: ctx.runDir,
      workspace: ctx.workspace,
      status: "running",
      startedAt: startedAt.toISOString(),
    });
  }

  let result: FactoryPlanningRunMeta | undefined;
  try {
    result = await runPlanningLoop(ctx);
  } catch (error) {
    const safeError = publicFailureMessage(ctx, errorMessage(error));
    ctx.eventSink({
      type: "run:end",
      runId: ctx.runId,
      runDir: ctx.runDir,
      workspace: ctx.workspace,
      status: "failed",
      durationMs: Date.now() - startedAt.getTime(),
      error: safeError,
    });
    throw new FactoryPlanningError(safeError, { cause: error });
  }

  if (!ctx.dryRun) {
    ctx.eventSink({
      type: "run:end",
      runId: ctx.runId,
      runDir: ctx.runDir,
      workspace: ctx.workspace,
      status: isFailedTerminalStatus(result.status) ? "failed" : "completed",
      durationMs: Date.now() - startedAt.getTime(),
      ...(result.error ? { error: result.error } : {}),
    });
  }
  return result;
}

async function runPlanningLoop(ctx: FactoryPlanningRunContext): Promise<FactoryPlanningRunMeta> {
  const handoffFailure = validateWorkItemHandoff(ctx);
  if (handoffFailure) {
    return ctx.export({
      status: "planning-failed",
      iterations: [],
      error: handoffFailure,
    });
  }
  if (ctx.dryRun) return runDryRun(ctx);

  const planner = ctx.plannerProvider();
  ctx.preparePlannerScratch();

  const iterations: PlanningIteration[] = [];
  let plannerSession: AgentSessionRef | undefined;
  let latestFindings: EnrichedFinding[] | undefined;
  let completedReviews = 0;

  for (let index = 1; ; index += 1) {
    try {
      const prompt =
        index === 1
          ? renderFactoryPlanningInitialPrompt(planningPromptContext(ctx))
          : renderFactoryPlanningRevisionPrompt({
              draftPath: ctx.draftPath,
              currentDate: ctx.startedAt.toISOString().slice(0, 10),
              reviewFindingsJson: JSON.stringify(latestFindings ?? [], null, 2),
            });

      const plannerAttempt = await invokePlanner({
        ctx,
        planner,
        role: ctx.plannerRole,
        index,
        prompt,
        session: index === 1 ? undefined : plannerSession,
      });
      const plannerResult = plannerAttempt.result;
      try {
        ctx.writePlannerEvidence({
          index,
          prompt,
          raw: rawAgentArtifact(plannerResult),
        });
      } catch (error) {
        return failPlannerTurn({
          ctx,
          iterations,
          index,
          plannerSession,
          classification: "publication-failed",
          message: `Failed to persist planner evidence: ${errorMessage(error)}`,
          raw: rawAgentArtifact(plannerResult),
          publicationStage: "stage",
        });
      }
      if (!plannerResult.ok) {
        const failure = classifyPlannerFailure(plannerResult, plannerAttempt.invocationThrew);
        return failPlannerTurn({
          ctx,
          iterations,
          index,
          plannerSession,
          classification: failure.classification,
          message: failure.message,
          raw: rawAgentArtifact(plannerResult),
          exitCode: plannerResult.exitCode,
          aborted: plannerResult.aborted,
        });
      }
      if (index === 1) plannerSession = plannerResult.session;

      let output: FactoryPlanningOutput;
      try {
        output = parseFactoryPlanningOutput(plannerResult.structuredOutput);
        assertPlannerOutputPathSafe(ctx, output);
      } catch (error) {
        return failPlannerTurn({
          ctx,
          iterations,
          index,
          plannerSession,
          classification: "structured-output-invalid",
          message: errorMessage(error),
          raw: rawAgentArtifact(plannerResult),
        });
      }
      try {
        ctx.writePlannerStructuredArtifact(index, output);
      } catch (error) {
        return failPlannerTurn({
          ctx,
          iterations,
          index,
          plannerSession,
          classification: "publication-failed",
          message: `Failed to persist planner output: ${errorMessage(error)}`,
          raw: rawAgentArtifact(plannerResult),
          publicationStage: "stage",
        });
      }
      if (index > 1 && output.outcome === "draft-ready") {
        try {
          validateFindingDecisions(output, latestFindings ?? []);
        } catch (error) {
          return failPlannerTurn({
            ctx,
            iterations,
            index,
            plannerSession,
            classification: "finding-decisions-invalid",
            message: errorMessage(error),
            raw: rawAgentArtifact(plannerResult),
          });
        }
      }

      if (output.outcome === "needs-human") {
        return ctx.export({
          status: "plan-needs-human",
          iterations: [...iterations, { index }],
          plannerSession,
          humanQuestions: output.humanQuestions,
        });
      }

      let planPath: string;
      try {
        planPath = ctx.publishPlannerDraft(index);
      } catch (error) {
        const failure = classifyPublicationFailure(error);
        return failPlannerTurn({
          ctx,
          iterations,
          index,
          plannerSession,
          classification: failure.classification,
          message: failure.message,
          raw: rawAgentArtifact(plannerResult),
          ...(failure.draftReason ? { draftReason: failure.draftReason } : {}),
          publicationStage: failure.publicationStage,
        });
      }

      const iteration: PlanningIteration = { index, planPath };
      iterations.push(iteration);

      const review = await runReview(ctx, planPath);
      iteration.review = review.ref;
      ctx.writeReviewRef(index, review.ref);

      if (review.meta.status === "failed") {
        return fail(ctx, iterations, plannerSession, planReviewFailureMessage(review.meta));
      }
      if (review.meta.status !== "completed") {
        return fail(ctx, iterations, plannerSession, "plan-review returned invalid status");
      }

      completedReviews += 1;
      if (review.meta.verdict === "pass") {
        let outputPlan: string | undefined;
        try {
          outputPlan = ctx.writeFinalPlan(planPath);
          return ctx.export({
            status: "plan-approved",
            iterations,
            outputPlan,
            plannerSession,
          });
        } catch (error) {
          if (outputPlan) ctx.removeFinalPlan(outputPlan);
          throw error;
        }
      }
      if (review.meta.verdict === "blocked") {
        return ctx.export({
          status: "plan-needs-human",
          iterations,
          plannerSession,
          humanQuestions: blockedReviewQuestions(review.ref).map((question) =>
            publicFailureMessage(ctx, question),
          ),
        });
      }
      if (review.meta.verdict !== "needs_changes") {
        return fail(ctx, iterations, plannerSession, "plan-review returned invalid verdict");
      }

      const specReview = readSpecReview(review.ref.specReviewPath);
      latestFindings = enrichFindings(specReview.findings);
      ctx.writeReviewFindings(index, sanitizePublicReviewerValue(ctx, latestFindings));
      if (completedReviews >= ctx.maxReviewIterations) {
        return ctx.export({
          status: "plan-review-unresolved",
          iterations,
          plannerSession,
          error: "Plan review still needs changes after max review iterations",
        });
      }
      if (!plannerSession) {
        return fail(ctx, iterations, plannerSession, "Planner session was not captured");
      }
    } catch (error) {
      return fail(ctx, iterations, plannerSession, errorMessage(error));
    }
  }
}

function runDryRun(ctx: FactoryPlanningRunContext): FactoryPlanningRunMeta {
  ctx.preparePlannerScratch();
  const prompt = renderFactoryPlanningInitialPrompt(planningPromptContext(ctx));
  writeFileSync(ctx.draftPath, DRY_RUN_PLAN_MARKDOWN, "utf8");
  ctx.writePlannerEvidence({ index: 1, prompt, raw: DRY_RUN_PLANNING });
  ctx.writePlannerStructuredArtifact(1, DRY_RUN_PLANNING);
  const planPath = ctx.publishPlannerDraft(1);
  return ctx.export({
    status: "dry_run",
    iterations: [{ index: 1, planPath }],
  });
}

function validateWorkItemHandoff(ctx: FactoryPlanningRunContext): string | undefined {
  const metadata = ctx.workItem.metadata;
  const route = metadata?.factoryRoute;
  if (route !== undefined && route !== "ready-to-plan") {
    return `factoryRoute must be ready-to-plan for planning station, got ${String(route)}`;
  }
  const nextAction = metadata?.factoryNextAction;
  if (nextAction !== undefined && nextAction !== "create-plan") {
    return `factoryNextAction must be create-plan for planning station, got ${String(nextAction)}`;
  }
  return undefined;
}

async function invokePlanner(input: {
  ctx: FactoryPlanningRunContext;
  planner: Agent;
  role: FactoryPlanningAgentRole;
  index: number;
  prompt: string;
  session?: AgentSessionRef;
}): Promise<{ result: AgentRunResult; invocationThrew: boolean }> {
  input.ctx.preparePlannerIteration(input.index);
  const iterationDir = input.ctx.iterationDir(input.index);
  const trackedStatusBefore = readTrackedStatus(input.ctx.workspace);
  let result: AgentRunResult;
  let invocationThrew = false;
  try {
    result = await input.planner.run({
      workspace: input.ctx.workspace,
      prompt: input.prompt,
      schemaPath: FACTORY_PLANNING_SCHEMA_PATH,
      model: input.ctx.plannerAgent.model,
      ...plannerPolicyOptions(input.planner.name, input.role),
      workspaceGuard: "record",
      maxRuntimeMs: input.ctx.maxRuntimeMs,
      logPath: join(iterationDir, "planner.stream.jsonl"),
      session: input.session,
      signal: input.ctx.signal,
    });
  } catch (error) {
    invocationThrew = true;
    result = {
      ok: false,
      error: `factory-planning invocation threw: ${errorMessage(error)}`,
      raw: errorArtifact(error),
      exitCode: 1,
    };
  }
  if (trackedStatusBefore === undefined) return { result, invocationThrew };
  return {
    result: withWorkspaceGuard(result, input.ctx.workspace, trackedStatusBefore, "enforce"),
    invocationThrew,
  };
}

async function runReview(
  ctx: FactoryPlanningRunContext,
  planPath: string,
): Promise<{ meta: ReviewMeta; ref: FactoryPlanningReviewRef }> {
  const reviewCtx = createWorkflowContext({
    workspace: ctx.workspace,
    planPath,
    runsDir: ctx.reviewRunsDir,
    includeGitScope: false,
    agentProvider: ctx.reviewerRole.agent,
    codexPathOverride: ctx.reviewerRole.codexPathOverride,
    model: ctx.reviewerAgent.model,
    sandboxMode: ctx.reviewerRole.sandboxMode,
    approvalPolicy: ctx.reviewerRole.approvalPolicy,
    modelReasoningEffort: ctx.reviewerRole.modelReasoningEffort,
    maxRuntimeMs: ctx.maxRuntimeMs,
    dryRun: false,
    signal: ctx.signal,
    eventSink: ctx.eventSink,
    agentProviderFactory: ctx.agentProviderFactory,
  });
  let reviewMeta: ReviewMeta;
  try {
    reviewMeta = ctx.planReviewRunner
      ? await ctx.planReviewRunner(reviewCtx)
      : await runPlanReview(reviewCtx);
  } catch (error) {
    return {
      meta: { status: "failed", runId: reviewCtx.runId, error: errorMessage(error) },
      ref: buildReviewRef(reviewCtx.runId, reviewCtx.runDir, "failed"),
    };
  }
  return {
    meta: reviewMeta,
    ref: buildReviewRef(
      typeof reviewMeta.runId === "string" ? reviewMeta.runId : reviewCtx.runId,
      reviewCtx.runDir,
      String(reviewMeta.status ?? "unknown"),
      reviewMeta.verdict,
    ),
  };
}

function planReviewFailureMessage(meta: ReviewMeta): string {
  return typeof meta.error === "string" && meta.error
    ? `plan-review failed: ${meta.error}`
    : "plan-review failed";
}

function isFailedTerminalStatus(status: FactoryPlanningRunMeta["status"]): boolean {
  return status === "planning-failed" || status === "plan-review-unresolved";
}

function planningPromptContext(ctx: FactoryPlanningRunContext): {
  workItemJson: string;
  draftPath: string;
  currentDate: string;
} {
  return {
    workItemJson: JSON.stringify(ctx.workItem, null, 2),
    draftPath: ctx.draftPath,
    currentDate: ctx.startedAt.toISOString().slice(0, 10),
  };
}

function buildReviewRef(
  runId: string,
  runDir: string,
  status: string,
  verdict?: unknown,
): FactoryPlanningReviewRef {
  return {
    runId,
    runDir,
    status,
    ...(isReviewVerdict(verdict) ? { verdict } : {}),
    specReviewPath: join(runDir, "spec-review.json"),
    ...(existsSync(join(runDir, "summary.md")) ? { summaryPath: join(runDir, "summary.md") } : {}),
  };
}

function readSpecReview(path: string): ReviewOutput {
  try {
    const parsed = ReviewOutputSchema.safeParse(readJsonFile(path));
    if (parsed.success) return parsed.data;
    throw new FactoryPlanningError("Invalid spec-review.json");
  } catch (error) {
    if (error instanceof FactoryPlanningError) throw error;
    throw new FactoryPlanningError(`Failed to read spec-review.json: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

function enrichFindings(findings: ReviewOutput["findings"]): EnrichedFinding[] {
  return findings.map((finding, index) => ({
    id: `spec-${String(index + 1).padStart(3, "0")}`,
    ...finding,
  }));
}

function validateFindingDecisions(
  output: FactoryPlanningOutput,
  findings: EnrichedFinding[],
): void {
  const expected = new Set(findings.map((finding) => finding.id));
  const seen = new Set<string>();
  for (const decision of output.findingDecisions) {
    if (!expected.has(decision.findingId)) {
      throw new FactoryPlanningError(`Unknown finding decision id: ${decision.findingId}`);
    }
    if (seen.has(decision.findingId)) {
      throw new FactoryPlanningError(`Duplicate finding decision id: ${decision.findingId}`);
    }
    seen.add(decision.findingId);
  }
  for (const id of expected) {
    if (!seen.has(id)) throw new FactoryPlanningError(`Missing finding decision id: ${id}`);
  }
}

function fail(
  ctx: FactoryPlanningRunContext,
  iterations: PlanningIteration[],
  plannerSession: AgentSessionRef | undefined,
  error: string,
): FactoryPlanningRunMeta {
  const safeError = publicFailureMessage(ctx, error);
  return ctx.export({
    status: "planning-failed",
    iterations,
    plannerSession,
    error: safeError,
  });
}

function plannerPolicyOptions(
  providerName: string,
  role: FactoryPlanningAgentRole,
): Pick<AgentRunInput, "sandboxMode" | "approvalPolicy" | "modelReasoningEffort"> {
  if (providerName !== "codex") return {};
  return {
    sandboxMode: role.sandboxMode,
    approvalPolicy: role.approvalPolicy ?? FACTORY_PLANNING_APPROVAL_POLICY,
    modelReasoningEffort: role.modelReasoningEffort ?? DEFAULT_CODEX_REASONING_EFFORT,
  };
}

function blockedReviewQuestions(review: FactoryPlanningReviewRef): string[] {
  const specReview = readSpecReview(review.specReviewPath);
  const questions = [
    `Plan review blocked: ${specReview.summary}`,
    ...specReview.findings
      .filter((finding) => finding.must_fix)
      .map((finding) => `${finding.title}: ${finding.recommendation}`),
  ].filter((question) => question.trim().length > 0);
  return questions.length ? questions : ["Plan review returned blocked."];
}

function rawAgentArtifact(result: AgentRunResult): unknown {
  if (result.ok || result.raw !== undefined) return result.raw;
  return { error: result.error };
}

function classifyPlannerFailure(
  result: Extract<AgentRunResult, { ok: false }>,
  invocationThrew: boolean,
): {
  classification: Extract<
    PlannerFailureClassification,
    | "provider-failed"
    | "provider-aborted"
    | "provider-timeout"
    | "invocation-threw"
    | "workspace-guard-failed"
  >;
  message: string;
} {
  if (result.failureKind === "workspace-guard") {
    return {
      classification: "workspace-guard-failed",
      message: `Planner modified tracked workspace files: ${result.error}`,
    };
  }
  if (invocationThrew) return { classification: "invocation-threw", message: result.error };
  if (result.exitCode === 124) return { classification: "provider-timeout", message: result.error };
  if (result.aborted) return { classification: "provider-aborted", message: result.error };
  return { classification: "provider-failed", message: result.error };
}

function classifyPublicationFailure(error: unknown): {
  classification: Extract<PlannerFailureClassification, "draft-invalid" | "publication-failed">;
  message: string;
  publicationStage?: PublicationStage;
  draftReason?: DraftValidationReason;
} {
  if (error instanceof DraftValidationError) {
    return { classification: "draft-invalid", message: error.message, draftReason: error.reason };
  }
  if (error instanceof FactoryPlanningPublicationError) {
    return {
      classification: "publication-failed",
      message: error.message,
      publicationStage: error.stage,
    };
  }
  return { classification: "publication-failed", message: errorMessage(error) };
}

function failPlannerTurn(input: {
  ctx: FactoryPlanningRunContext;
  iterations: PlanningIteration[];
  index: number;
  plannerSession?: AgentSessionRef;
  classification: PlannerFailureClassification;
  message: string;
  raw: unknown;
  exitCode?: number;
  aborted?: boolean;
  publicationStage?: PublicationStage;
  draftReason?: DraftValidationReason;
}): FactoryPlanningRunMeta {
  const safeMessage = publicFailureMessage(input.ctx, input.message);
  input.ctx.writePlannerFailureArtifacts({
    index: input.index,
    classification: input.classification,
    message: safeMessage,
    raw: input.raw,
    ...(input.draftReason ? { draftReason: input.draftReason } : {}),
    ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
    ...(input.aborted !== undefined ? { aborted: input.aborted } : {}),
    ...(input.publicationStage ? { publicationStage: input.publicationStage } : {}),
  });
  return fail(
    input.ctx,
    [...input.iterations, { index: input.index }],
    input.plannerSession,
    safeMessage,
  );
}

export function publicFailureMessage(ctx: FactoryPlanningRunContext, message: string): string {
  return message
    .replaceAll(ctx.draftPath, "[planner-scratch]/draft.md")
    .replaceAll(ctx.scratchRunDir, "[planner-scratch]")
    .replaceAll(join(ctx.workspace, ".harness/factory-drafts"), "[planner-scratch-root]")
    .replaceAll("factory-drafts", "[planner-scratch-root]");
}

function assertPlannerOutputPathSafe(
  ctx: FactoryPlanningRunContext,
  output: FactoryPlanningOutput,
): void {
  const serialized = JSON.stringify(output);
  if (
    serialized.includes(ctx.draftPath) ||
    serialized.includes(ctx.scratchRunDir) ||
    serialized.includes(join(ctx.workspace, ".harness/factory-drafts")) ||
    serialized.includes("factory-drafts")
  ) {
    throw new FactoryPlanningError("Planner structured output contains a forbidden scratch path");
  }
}

function sanitizePublicReviewerValue(ctx: FactoryPlanningRunContext, value: unknown): unknown {
  if (typeof value === "string") return publicFailureMessage(ctx, value);
  if (Array.isArray(value)) return value.map((item) => sanitizePublicReviewerValue(ctx, item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        publicFailureMessage(ctx, key),
        sanitizePublicReviewerValue(ctx, item),
      ]),
    );
  }
  return value;
}

function isReviewVerdict(value: unknown): value is FactoryPlanningReviewRef["verdict"] {
  return value === "pass" || value === "needs_changes" || value === "blocked";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readTrackedStatus(workspace: string): string | undefined {
  const status = readWorkspaceStatus(workspace);
  return status.ok ? status.value : undefined;
}
