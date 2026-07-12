import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  assertFactoryPathContained,
  createFactoryArtifactRef,
  isFactoryRelativePathContained,
} from "../lib/factory-artifact-ref.ts";
import {
  factoryActionResultPath,
  readFactoryActionResult,
  writeFactoryActionResult,
} from "../lib/factory-action-result.ts";
import { factoryActionKey } from "../lib/factory-action-contract.ts";
import {
  appendFactoryActionEvent,
  readFactoryActionEvents,
} from "../lib/factory-lifecycle-kernel.ts";
import type { FactoryLifecycleEvent } from "../lib/factory-lifecycle-events.ts";
import { buildFactoryRoutePlan } from "../lib/factory-intake.ts";
import { deriveFactoryWorkItemKey } from "../lib/factory-lifecycle.ts";
import {
  FACTORY_TRIAGE_EVENT_STEP,
  FACTORY_TRIAGE_STEP_OUTPUTS,
  type FactoryRunContext,
  type FactoryRunMeta,
} from "../lib/factory-run-context.ts";
import {
  FactoryTriageError,
  parseFactoryTriageOutput,
  type FactoryTriageOutput,
} from "../lib/factory-schemas.ts";
import {
  decideNextFactoryAction,
  reduceFactoryLifecycleEvents,
  type FactoryLifecycleState,
  type FactoryReaction,
} from "../lib/factory-state-machine.ts";

export const meta = { name: "factory-triage" };

async function executeTriageProvider(
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

export async function triageWorkItem(input: {
  ctx: FactoryRunContext;
  factoryStateRoot: string;
  reaction: Extract<FactoryReaction, { kind: "invoke" }>;
  nextLiveRunRequiresRerun: boolean;
  runProvider?: (
    ctx: FactoryRunContext,
    options: { nextLiveRunRequiresRerun: boolean },
  ) => Promise<FactoryRunMeta>;
  onMeta?: (meta: FactoryRunMeta) => void;
}): Promise<{ event: FactoryLifecycleEvent; state: FactoryLifecycleState }> {
  const { ctx, reaction } = input;
  const events = readFactoryActionEvents(
    input.factoryStateRoot,
    deriveFactoryWorkItemKey(ctx.workItem),
  );
  const latest = events.at(-1);
  const state = reduceFactoryLifecycleEvents(events);
  if (!latest || !state || reaction.phase !== "triage" || reaction.handler !== "triageWorkItem") {
    throw new Error("triageWorkItem requires an active triage reaction");
  }
  const expected = decideNextFactoryAction(state, latest);
  if (
    expected.kind !== "invoke" ||
    expected.handler !== reaction.handler ||
    expected.attempt !== reaction.attempt ||
    expected.causationEventId !== reaction.causationEventId ||
    latest.id !== reaction.causationEventId ||
    latest.phaseRunId !== ctx.runId
  ) {
    throw new Error("triageWorkItem reaction conflicts with durable Factory state");
  }

  const actionDir = join(
    ctx.runDir,
    "actions",
    String(reaction.attempt),
    reaction.handler,
    factoryActionKey({ ...reaction, phaseRunId: ctx.runId }),
  );
  let terminal: FactoryLifecycleEvent;
  if (existsSync(factoryActionResultPath(actionDir))) {
    terminal = readFactoryActionResult(actionDir);
  } else {
    let meta = readCompletedMeta(ctx);
    if (!meta) {
      try {
        meta = await (input.runProvider ?? run)(ctx, {
          nextLiveRunRequiresRerun: input.nextLiveRunRequiresRerun,
        });
      } catch (error) {
        meta = ctx.exportFailed(error);
      }
    }
    input.onMeta?.(meta);
    let triage: FactoryTriageOutput | undefined;
    if (meta.status === "completed") {
      try {
        triage = readTriageArtifact(meta);
      } catch (error) {
        meta = ctx.exportFailed(error);
      }
    }
    terminal = buildTriageActionEvent(ctx, meta, triage, reaction);
    writeFactoryActionResult(actionDir, terminal);
  }
  if (
    terminal.workItemKey !== deriveFactoryWorkItemKey(ctx.workItem) ||
    terminal.phaseRunId !== ctx.runId ||
    terminal.data.handler !== "triageWorkItem" ||
    terminal.data.attempt !== reaction.attempt ||
    terminal.data.causationEventId !== reaction.causationEventId ||
    (terminal.type !== "triage.work_item.completed" && terminal.type !== "factory.action.failed")
  ) {
    throw new Error("Recovered triage action result conflicts with durable Factory state");
  }
  return appendFactoryActionEvent({
    factoryStateRoot: input.factoryStateRoot,
    event: terminal,
    expectedLastEventId: reaction.causationEventId,
  });
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
    const result = await executeTriageProvider(ctx, options);
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

function readCompletedMeta(ctx: FactoryRunContext): FactoryRunMeta | undefined {
  const path = join(ctx.runDir, "meta.json");
  if (!existsSync(path)) return undefined;
  const value = JSON.parse(readFileSync(path, "utf8")) as FactoryRunMeta;
  if (value.status !== "completed") return undefined;
  if (
    value.runId !== ctx.runId ||
    resolve(value.runDir) !== resolve(ctx.runDir) ||
    resolve(value.workspace) !== resolve(ctx.workspace) ||
    value.workItem.id !== ctx.workItem.id ||
    resolve(value.factoryStore?.factoryStateRoot ?? "") !==
      resolve(ctx.factoryStore?.factoryStateRoot ?? "")
  )
    throw new Error(`Completed Factory run metadata conflicts with ${ctx.runId}`);
  return value;
}

function readTriageArtifact(meta: FactoryRunMeta): FactoryTriageOutput {
  const triage = parseFactoryTriageOutput(
    JSON.parse(
      readFileSync(join(meta.runDir, meta.artifacts?.triage ?? "factory-triage.json"), "utf8"),
    ),
  );
  for (const evidence of triage.evidence) {
    if (evidence.path === null) continue;
    if (evidence.path.includes("\\") || !isFactoryRelativePathContained(evidence.path)) {
      throw new Error(`Factory triage evidence path is not portable: ${evidence.path}`);
    }
    assertFactoryPathContained(meta.workspace, resolve(meta.workspace, evidence.path));
  }
  return triage;
}

function buildTriageActionEvent(
  ctx: FactoryRunContext,
  meta: FactoryRunMeta,
  triage: FactoryTriageOutput | undefined,
  reaction: Extract<FactoryReaction, { kind: "invoke" }>,
): Extract<
  FactoryLifecycleEvent,
  { type: "triage.work_item.completed" | "factory.action.failed" }
> {
  const store = ctx.factoryStore;
  if (!store) throw new Error("Factory action requires durable store metadata");
  const actionKey = factoryActionKey({ ...reaction, phaseRunId: ctx.runId });
  const evidenceDir = join(
    ctx.runDir,
    "actions",
    String(reaction.attempt),
    reaction.handler,
    actionKey,
    "evidence",
  );
  const summaryPath = publishEvidence(
    join(meta.runDir, meta.artifacts?.summary ?? "meta.json"),
    join(evidenceDir, "summary.md"),
  );
  const runRef = createFactoryArtifactRef({
    base: "factory-store",
    root: store.projectRoot,
    path: relative(store.projectRoot, summaryPath),
  });
  const triagePath = triage
    ? publishEvidence(
        join(meta.runDir, meta.artifacts?.triage ?? "factory-triage.json"),
        join(evidenceDir, "factory-triage.json"),
      )
    : undefined;
  const triageRef = triagePath
    ? createFactoryArtifactRef({
        base: "factory-store",
        root: store.projectRoot,
        path: relative(store.projectRoot, triagePath),
      })
    : undefined;
  const common = {
    version: 1 as const,
    workItemKey: deriveFactoryWorkItemKey(ctx.workItem),
    occurredAt: new Date().toISOString(),
    phaseRunId: ctx.runId,
    data: {
      handler: "triageWorkItem" as const,
      handlerVersion: 1 as const,
      attempt: reaction.attempt,
      causationEventId: reaction.causationEventId,
      execution: { workspaceRef: store.repo.id, runRef },
      evidence: triageRef ? [runRef, triageRef] : [runRef],
    },
  };
  if (!triage || meta.status !== "completed")
    return {
      ...common,
      id: `factory.action.failed:${actionKey}`,
      type: "factory.action.failed",
      data: {
        ...common.data,
        phase: "triage",
        failureKind: meta.failureKind ?? "terminal",
        message: meta.error ?? "Factory triage failed.",
      },
    };
  const routePlan = JSON.parse(readFileSync(join(meta.runDir, "factory-route.json"), "utf8")) as {
    command?: unknown;
  };
  const nextCommand =
    typeof routePlan.command === "string" && routePlan.command.trim()
      ? routePlan.command.trim()
      : undefined;
  return {
    ...common,
    id: `triage.work_item.completed:${actionKey}`,
    type: "triage.work_item.completed",
    data: {
      ...common.data,
      route: triage.route,
      ...(nextCommand ? { nextCommand } : {}),
      rationale: triage.rationale,
    },
  };
}

function publishEvidence(source: string, destination: string): string {
  mkdirSync(dirname(destination), { recursive: true });
  if (existsSync(destination)) {
    if (!readFileSync(source).equals(readFileSync(destination)))
      throw new Error(`Factory action evidence conflicts with ${destination}`);
    return destination;
  }
  copyFileSync(source, destination);
  return destination;
}
