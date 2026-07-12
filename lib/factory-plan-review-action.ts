import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Agent, AgentProviderOptions } from "./agents.ts";
import { createFactoryArtifactRef } from "./factory-artifact-ref.ts";
import { factoryActionKey } from "./factory-action-contract.ts";
import {
  factoryActionResultPath,
  readFactoryActionResult,
  writeFactoryActionResult,
} from "./factory-action-result.ts";
import { appendFactoryActionEvent, readFactoryActionEvents } from "./factory-lifecycle-kernel.ts";
import type { FactoryLifecycleEvent } from "./factory-lifecycle-events.ts";
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
    const candidatePath = join(ctx.factoryStore.projectRoot, latest.data.candidate.path);
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
    const meta = await (input.reviewRunner ?? runPlanReview)(reviewCtx);
    const reviewSource = join(reviewCtx.runDir, "spec-review.json");
    const review = ReviewOutputSchema.parse(JSON.parse(readFileSync(reviewSource, "utf8")));
    const reviewPath = join(actionDir, "spec-review.json");
    copyFileSync(reviewSource, reviewPath);
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
      if (findings.length === 0)
        throw new Error("plan-review needs_changes without a must_fix finding");
      const path = join(actionDir, "blocking-findings.json");
      writeFileSync(path, `${JSON.stringify(findings, null, 2)}\n`);
      blockingRef = ref(ctx, path);
    }
    if (verdict === "pass" && ctx.identity.publicationMode === "local")
      materialize(candidatePath, resolve(ctx.workspace, ctx.identity.outputPlan));
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
  return appendFactoryActionEvent({
    factoryStateRoot: input.factoryStateRoot,
    event: readFactoryActionResult(actionDir),
    expectedLastEventId: reaction.causationEventId,
  });
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
