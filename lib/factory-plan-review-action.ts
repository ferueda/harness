import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Agent, AgentProviderOptions } from "./agents.ts";
import { createFactoryArtifactRef, verifyFactoryArtifactRef } from "./factory-artifact-ref.ts";
import { factoryActionKey } from "./factory-action-contract.ts";
import {
  factoryActionResultPath,
  readFactoryActionResult,
  writeFactoryActionResult,
} from "./factory-action-result.ts";
import { appendFactoryActionEvent, readFactoryActionEvents } from "./factory-lifecycle-kernel.ts";
import type { FactoryActionEvent, FactoryLifecycleEvent } from "./factory-lifecycle-events.ts";
import { deriveFactoryWorkItemKey } from "./factory-lifecycle.ts";
import type { openFactoryPlanningRunContext } from "./factory-planning-run-context.ts";
import { ReviewOutputSchema } from "./schemas.ts";
import { createWorkflowContext } from "./workflow-context.ts";
import {
  decideNextFactoryAction,
  reduceFactoryLifecycleEvents,
  type FactoryLifecycleState,
  type FactoryReaction,
} from "./factory-state-machine.ts";
import { run as runPlanReview } from "../workflows/plan-review.workflow.ts";
import { writeDurableFactoryFile } from "./factory-durable-file.ts";
import { startFactoryActionTelemetry } from "./factory-action-telemetry.ts";
import { z } from "zod";

type PlanningContext = ReturnType<typeof openFactoryPlanningRunContext>;

export async function reviewPlanCandidate(input: {
  ctx: PlanningContext;
  factoryStateRoot: string;
  reaction: Extract<FactoryReaction, { kind: "invoke" }>;
  maxRuntimeMs: number;
  signal?: AbortSignal;
  agentProviderFactory: (options: AgentProviderOptions) => Agent;
  reviewRunner?: typeof runPlanReview;
}): Promise<{ event: FactoryLifecycleEvent; state: FactoryLifecycleState }> {
  const { ctx, reaction } = input;
  const events = readFactoryActionEvents(
    input.factoryStateRoot,
    deriveFactoryWorkItemKey(ctx.workItem),
  );
  const state = reduceFactoryLifecycleEvents(events);
  const latest = events.at(-1);
  if (
    !state ||
    !latest ||
    reaction.handler !== "reviewPlanCandidate" ||
    JSON.stringify(decideNextFactoryAction(state, latest)) !== JSON.stringify(reaction) ||
    latest.type !== "planning.candidate.produced"
  )
    throw new Error("reviewPlanCandidate reaction conflicts with durable Factory state");
  const actionDir = join(
    ctx.runDir,
    "actions",
    String(reaction.attempt),
    reaction.handler,
    factoryActionKey({ ...reaction, phaseRunId: ctx.runId }),
  );
  if (!existsSync(factoryActionResultPath(actionDir))) {
    mkdirSync(actionDir, { recursive: true });
    const candidatePath = verifyFactoryArtifactRef(latest.data.candidate, {
      "factory-store": ctx.factoryStore.projectRoot,
      repository: ctx.workspace,
    });
    const reviewPath = join(actionDir, "spec-review.json");
    const resultPath = join(actionDir, "review-result.json");
    let meta: { status?: unknown };
    if (existsSync(resultPath)) {
      const staged = StagedReviewOutcomeSchema.parse(JSON.parse(readFileSync(resultPath, "utf8")));
      if (
        staged.version !== 1 ||
        staged.action?.phaseRunId !== ctx.runId ||
        staged.action?.handler !== reaction.handler ||
        staged.action?.attempt !== reaction.attempt ||
        staged.action?.causationEventId !== reaction.causationEventId ||
        !staged.meta
      )
        throw new Error("Staged review outcome conflicts with action identity");
      meta = staged.meta;
      writeDurableFactoryFile(reviewPath, `${JSON.stringify(staged.review, null, 2)}\n`, true);
    } else {
      const profile = ctx.identity.actions.reviewPlanCandidate;
      const reviewCtx = createWorkflowContext({
        workspace: ctx.workspace,
        planPath: candidatePath,
        runsDir: join(actionDir, "review-runs"),
        includeGitScope: false,
        agentProvider: profile.provider,
        ...(profile.provider === "codex" && profile.executable
          ? { codexPathOverride: profile.executable }
          : {}),
        model: profile.model,
        ...(profile.provider === "codex"
          ? {
              sandboxMode: profile.sandbox,
              approvalPolicy: profile.approvalPolicy,
              modelReasoningEffort: profile.reasoningEffort,
            }
          : {}),
        maxRuntimeMs: input.maxRuntimeMs,
        signal: input.signal,
        agentProviderFactory: input.agentProviderFactory,
      });
      const finishTelemetry = startFactoryActionTelemetry({
        eventSink: ctx.eventSink,
        runId: ctx.runId,
        runDir: actionDir,
        workspace: ctx.workspace,
        stepId: reaction.handler,
      });
      try {
        meta = await (input.reviewRunner ?? runPlanReview)(reviewCtx);
        if (!existsSync(join(reviewCtx.runDir, "spec-review.json")))
          throw new Error("Plan reviewer did not produce spec-review.json");
        finishTelemetry(meta.status === "completed" ? "completed" : "failed");
      } catch (error) {
        finishTelemetry("failed", errorMessage(error));
        const terminal = buildFailure(ctx, reaction, actionDir, errorMessage(error), "retryable");
        writeFactoryActionResult(actionDir, terminal);
        return appendRecovered(input.factoryStateRoot, ctx, reaction, actionDir);
      }
      const review = JSON.parse(readFileSync(join(reviewCtx.runDir, "spec-review.json"), "utf8"));
      writeDurableFactoryFile(
        resultPath,
        `${JSON.stringify({ version: 1, action: { phaseRunId: ctx.runId, handler: reaction.handler, attempt: reaction.attempt, causationEventId: reaction.causationEventId }, meta, review }, null, 2)}\n`,
        true,
      );
      writeDurableFactoryFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, true);
    }
    let review: z.infer<typeof ReviewOutputSchema>;
    try {
      review = ReviewOutputSchema.parse(JSON.parse(readFileSync(reviewPath, "utf8")));
    } catch (error) {
      const terminal = buildFailure(ctx, reaction, actionDir, errorMessage(error), "terminal");
      writeFactoryActionResult(actionDir, terminal);
      return appendRecovered(input.factoryStateRoot, ctx, reaction, actionDir);
    }
    const reviewRef = ref(ctx, reviewPath);
    const verdict = meta.status === "completed" ? review.verdict : "blocked";
    let blockingRef;
    if (verdict === "needs_changes") {
      const findings = review.findings
        .filter((finding) => finding.must_fix)
        .map((finding, index) => ({
          id: `spec-${String(index + 1).padStart(3, "0")}`,
          ...finding,
        }));
      if (findings.length === 0) {
        const terminal = buildFailure(
          ctx,
          reaction,
          actionDir,
          "plan-review needs_changes without a must_fix finding",
          "terminal",
        );
        writeFactoryActionResult(actionDir, terminal);
        return appendRecovered(input.factoryStateRoot, ctx, reaction, actionDir);
      }
      const path = join(actionDir, "blocking-findings.json");
      writeFileSync(path, `${JSON.stringify(findings, null, 2)}\n`);
      blockingRef = ref(ctx, path);
    }
    if (verdict === "pass" && ctx.identity.publicationMode === "local") {
      try {
        materialize(candidatePath, resolve(ctx.workspace, ctx.identity.outputPlan));
      } catch (error) {
        const terminal = buildFailure(ctx, reaction, actionDir, errorMessage(error), "terminal");
        writeFactoryActionResult(actionDir, terminal);
        return appendRecovered(input.factoryStateRoot, ctx, reaction, actionDir);
      }
    }
    const event: FactoryLifecycleEvent = {
      version: 1,
      id: `planning.review.completed:${factoryActionKey({ ...reaction, phaseRunId: ctx.runId })}`,
      type: "planning.review.completed",
      workItemKey: deriveFactoryWorkItemKey(ctx.workItem),
      occurredAt: new Date().toISOString(),
      phaseRunId: ctx.runId,
      data: {
        handler: "reviewPlanCandidate",
        handlerVersion: 1,
        attempt: reaction.attempt,
        causationEventId: reaction.causationEventId,
        execution: { workspaceRef: ctx.factoryStore.repo.id, runRef: reviewRef },
        evidence: blockingRef ? [reviewRef, blockingRef] : [reviewRef],
        verdict,
        review: reviewRef,
        ...(blockingRef ? { blockingFindings: blockingRef } : {}),
        reviewCeiling: ctx.identity.reviewCeiling,
      },
    };
    writeFactoryActionResult(actionDir, event);
  }
  const recovered = readFactoryActionResult(actionDir);
  assertRecoveredResult(ctx, reaction, recovered);
  if (
    recovered.type === "planning.review.completed" &&
    recovered.data.verdict === "pass" &&
    ctx.identity.publicationMode === "local"
  ) {
    const candidatePath = verifyFactoryArtifactRef(latest.data.candidate, {
      "factory-store": ctx.factoryStore.projectRoot,
      repository: ctx.workspace,
    });
    materialize(candidatePath, resolve(ctx.workspace, ctx.identity.outputPlan));
  }
  return appendFactoryActionEvent({
    factoryStateRoot: input.factoryStateRoot,
    event: recovered,
    expectedLastEventId: reaction.causationEventId,
  });
}

const StagedReviewOutcomeSchema = z.object({
  version: z.literal(1),
  action: z.object({
    phaseRunId: z.string(),
    handler: z.literal("reviewPlanCandidate"),
    attempt: z.number().int().positive(),
    causationEventId: z.string(),
  }),
  meta: z.object({ status: z.unknown().optional() }).passthrough(),
  review: ReviewOutputSchema,
});

function buildFailure(
  ctx: PlanningContext,
  reaction: Extract<FactoryReaction, { kind: "invoke" }>,
  actionDir: string,
  message: string,
  failureKind: "retryable" | "human-required" | "terminal",
): FactoryActionEvent {
  const failurePath = join(actionDir, "failure.json");
  writeDurableFactoryFile(
    failurePath,
    `${JSON.stringify({ message, failureKind }, null, 2)}\n`,
    true,
  );
  const failure = ref(ctx, failurePath);
  return {
    version: 1,
    id: `factory.action.failed:${factoryActionKey({ ...reaction, phaseRunId: ctx.runId })}`,
    type: "factory.action.failed",
    workItemKey: deriveFactoryWorkItemKey(ctx.workItem),
    occurredAt: new Date().toISOString(),
    phaseRunId: ctx.runId,
    data: {
      handler: "reviewPlanCandidate",
      handlerVersion: 1,
      attempt: reaction.attempt,
      causationEventId: reaction.causationEventId,
      execution: { workspaceRef: ctx.factoryStore.repo.id, runRef: failure },
      evidence: [failure],
      phase: "planning",
      failureKind,
      message,
    },
  };
}

function appendRecovered(
  factoryStateRoot: string,
  ctx: PlanningContext,
  reaction: Extract<FactoryReaction, { kind: "invoke" }>,
  actionDir: string,
) {
  const recovered = readFactoryActionResult(actionDir);
  assertRecoveredResult(ctx, reaction, recovered);
  return appendFactoryActionEvent({
    factoryStateRoot,
    event: recovered,
    expectedLastEventId: reaction.causationEventId,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertRecoveredResult(
  ctx: PlanningContext,
  reaction: Extract<FactoryReaction, { kind: "invoke" }>,
  event: FactoryLifecycleEvent,
): void {
  if (
    (event.type !== "planning.review.completed" && event.type !== "factory.action.failed") ||
    event.workItemKey !== deriveFactoryWorkItemKey(ctx.workItem) ||
    event.phaseRunId !== ctx.runId ||
    event.data.handler !== "reviewPlanCandidate" ||
    event.data.attempt !== reaction.attempt ||
    event.data.causationEventId !== reaction.causationEventId ||
    event.data.execution.workspaceRef !== ctx.factoryStore.repo.id
  )
    throw new Error("Recovered planning review result conflicts with phase identity");
  const roots = { "factory-store": ctx.factoryStore.projectRoot, repository: ctx.workspace };
  verifyFactoryArtifactRef(event.data.execution.runRef, roots);
  for (const evidence of event.data.evidence) verifyFactoryArtifactRef(evidence, roots);
}

function ref(ctx: PlanningContext, path: string) {
  return createFactoryArtifactRef({
    base: "factory-store",
    root: ctx.factoryStore.projectRoot,
    path: relative(ctx.factoryStore.projectRoot, path),
  });
}

function materialize(source: string, target: string) {
  mkdirSync(dirname(target), { recursive: true });
  const bytes = readFileSync(source);
  if (existsSync(target)) {
    if (!readFileSync(target).equals(bytes))
      throw new Error(`Output plan conflicts with reviewed candidate: ${target}`);
    return;
  }
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, bytes, { flag: "wx" });
  renameSync(temp, target);
}
