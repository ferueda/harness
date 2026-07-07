import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
import { readWorkspaceStatus } from "../lib/review-guard.ts";
import { ReviewOutputSchema, type ReviewOutput } from "../lib/schemas.ts";
import { createWorkflowContext } from "../lib/workflow-context.ts";
import { run as runPlanReview } from "./plan-review.workflow.ts";

export const meta = { name: "factory-planning" };

const FACTORY_PLANNING_APPROVAL_POLICY = "never" as const;

const DRY_RUN_PLANNING = {
  outcome: "draft-ready",
  summary: "(dry-run placeholder)",
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
    ctx.eventSink({
      type: "run:end",
      runId: ctx.runId,
      runDir: ctx.runDir,
      workspace: ctx.workspace,
      status: "failed",
      durationMs: Date.now() - startedAt.getTime(),
      error: errorMessage(error),
    });
    throw error;
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
  if (ctx.dryRun) return runDryRun(ctx);

  const handoffFailure = validateWorkItemHandoff(ctx);
  if (handoffFailure) {
    return ctx.export({
      status: "planning-failed",
      iterations: [],
      error: handoffFailure,
    });
  }

  const planner = ctx.plannerProvider();

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

      const trackedStatusBefore = readTrackedStatus(ctx.workspace);
      const plannerResult = await invokePlanner({
        ctx,
        planner,
        role: ctx.plannerRole,
        index,
        prompt,
        session: index === 1 ? undefined : plannerSession,
      });
      assertTrackedStatusUnchanged(ctx.workspace, trackedStatusBefore);
      if (index === 1) plannerSession = plannerResult.session;
      const output = parseFactoryPlanningOutput(plannerResult.structuredOutput);
      if (index > 1 && output.outcome === "draft-ready") {
        validateFindingDecisions(output, latestFindings ?? []);
      }

      const planPath = ctx.writePlannerArtifacts({
        index,
        prompt,
        raw: rawAgentArtifact(plannerResult),
        output,
      });

      if (output.outcome === "needs-human") {
        return ctx.export({
          status: "plan-needs-human",
          iterations: [...iterations, { index }],
          plannerSession,
          humanQuestions: output.humanQuestions,
        });
      }

      if (!planPath) {
        throw new FactoryPlanningError(
          "Planner draft-ready output did not produce a plan snapshot",
        );
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
          humanQuestions: blockedReviewQuestions(review.ref),
        });
      }
      if (review.meta.verdict !== "needs_changes") {
        return fail(ctx, iterations, plannerSession, "plan-review returned invalid verdict");
      }

      const specReview = readSpecReview(review.ref.specReviewPath);
      latestFindings = enrichFindings(specReview.findings);
      ctx.writeReviewFindings(index, latestFindings);
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
  const prompt = renderFactoryPlanningInitialPrompt(planningPromptContext(ctx));
  writeFileSync(ctx.draftPath, DRY_RUN_PLAN_MARKDOWN, "utf8");
  const planPath = ctx.writePlannerArtifacts({
    index: 1,
    prompt,
    raw: DRY_RUN_PLANNING,
    output: DRY_RUN_PLANNING,
  });
  return ctx.export({
    status: "dry_run",
    iterations: planPath ? [{ index: 1, planPath }] : [],
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
}): Promise<Extract<AgentRunResult, { ok: true }>> {
  const iterationDir = input.ctx.iterationDir(input.index);
  mkdirSync(iterationDir, { recursive: true });
  const result = await input.planner.run({
    workspace: input.ctx.workspace,
    prompt: input.prompt,
    schemaPath: FACTORY_PLANNING_SCHEMA_PATH,
    model: input.ctx.plannerAgent.model,
    ...plannerPolicyOptions(input.planner.name, input.role),
    maxRuntimeMs: input.ctx.maxRuntimeMs,
    logPath: join(iterationDir, "planner.stream.jsonl"),
    session: input.session,
    signal: input.ctx.signal,
  });
  if (!result.ok) {
    const error = result.aborted
      ? "Agent was aborted: factory-planning"
      : `factory-planning failed: ${result.error}`;
    throw new FactoryPlanningError(error);
  }
  return result;
}

async function runReview(
  ctx: FactoryPlanningRunContext,
  planPath: string,
): Promise<{ meta: ReviewMeta; ref: FactoryPlanningReviewRef }> {
  const reviewCtx = createWorkflowContext({
    workspace: ctx.workspace,
    planPath,
    runsDir: join(ctx.workspace, ".harness/runs/reviews"),
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
  return ctx.export({
    status: "planning-failed",
    iterations,
    plannerSession,
    error,
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

function assertTrackedStatusUnchanged(workspace: string, before: string | undefined): void {
  if (before === undefined) return;
  const after = readTrackedStatus(workspace);
  if (after === undefined || after === before) return;
  throw new FactoryPlanningError(`Planner modified tracked workspace files:\n${after}`);
}
