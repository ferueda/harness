import { buildFactoryRoutePlan } from "../lib/factory-intake.ts";
import {
  FACTORY_TRIAGE_EVENT_STEP,
  FACTORY_TRIAGE_STEP_OUTPUTS,
  type FactoryRunContext,
  type FactoryRunMeta,
} from "../lib/factory-run-context.ts";
import { FactoryTriageError } from "../lib/factory-schemas.ts";

export const meta = { name: "factory-triage" };

export async function triageWorkItem(
  ctx: FactoryRunContext,
  options: { nextLiveRunRequiresRerun?: boolean } = {},
): Promise<FactoryRunMeta> {
  const triage = await ctx.invokeTriageAgent();
  const routePlan = buildFactoryRoutePlan(ctx.workItem, triage, {
    ...options,
    isDryRun: ctx.dryRun,
  });
  return ctx.export({ triage, routePlan });
}

export async function run(
  ctx: FactoryRunContext,
  options: { nextLiveRunRequiresRerun?: boolean; heartbeatMs?: number } = {},
): Promise<FactoryRunMeta> {
  const runStartedAt = Date.now();
  const stepStartedAt = new Date();
  ctx.eventSink({
    type: "run:start",
    runId: ctx.runId,
    runDir: ctx.runDir,
    workspace: ctx.workspace,
    status: "running",
    startedAt: stepStartedAt.toISOString(),
  });
  ctx.eventSink({
    type: "step:start",
    runId: ctx.runId,
    runDir: ctx.runDir,
    workspace: ctx.workspace,
    stepId: FACTORY_TRIAGE_EVENT_STEP,
    cliStep: FACTORY_TRIAGE_EVENT_STEP,
    status: "running",
    startedAt: stepStartedAt.toISOString(),
  });

  const heartbeat = setInterval(() => {
    ctx.eventSink({
      type: "step:heartbeat",
      runId: ctx.runId,
      runDir: ctx.runDir,
      workspace: ctx.workspace,
      stepId: FACTORY_TRIAGE_EVENT_STEP,
      cliStep: FACTORY_TRIAGE_EVENT_STEP,
      status: "running",
      elapsedMs: Date.now() - stepStartedAt.getTime(),
    });
  }, options.heartbeatMs ?? 30_000);

  try {
    const result = await triageWorkItem(ctx, options);
    ctx.eventSink({
      type: "step:end",
      runId: ctx.runId,
      runDir: ctx.runDir,
      workspace: ctx.workspace,
      stepId: FACTORY_TRIAGE_EVENT_STEP,
      cliStep: FACTORY_TRIAGE_EVENT_STEP,
      status: "completed",
      durationMs: Date.now() - stepStartedAt.getTime(),
      outputs: [...FACTORY_TRIAGE_STEP_OUTPUTS],
    });
    ctx.eventSink({
      type: "run:end",
      runId: ctx.runId,
      runDir: ctx.runDir,
      workspace: ctx.workspace,
      status: "completed",
      durationMs: Date.now() - runStartedAt,
    });
    return result;
  } catch (error) {
    const factoryError =
      error instanceof FactoryTriageError
        ? error
        : new FactoryTriageError(error instanceof Error ? error.message : String(error), {
            cause: error,
          });
    const result = ctx.exportFailed(factoryError);
    ctx.eventSink({
      type: "step:end",
      runId: ctx.runId,
      runDir: ctx.runDir,
      workspace: ctx.workspace,
      stepId: FACTORY_TRIAGE_EVENT_STEP,
      cliStep: FACTORY_TRIAGE_EVENT_STEP,
      status: "failed",
      durationMs: Date.now() - stepStartedAt.getTime(),
      error: factoryError.message,
    });
    ctx.eventSink({
      type: "run:end",
      runId: ctx.runId,
      runDir: ctx.runDir,
      workspace: ctx.workspace,
      status: "failed",
      durationMs: Date.now() - runStartedAt,
      error: factoryError.message,
    });
    return result;
  } finally {
    clearInterval(heartbeat);
  }
}
