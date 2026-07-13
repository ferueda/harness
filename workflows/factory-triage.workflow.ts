import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import {
  assertFactoryPathContained,
  createFactoryArtifactRef,
  isFactoryRelativePathContained,
  verifyFactoryArtifactRef,
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
import { readFactoryPhaseRunIdentity } from "../lib/factory-phase-run.ts";
import { buildFactoryRoutePlan } from "../lib/factory-intake.ts";
import { deriveFactoryWorkItemKey } from "../lib/factory-lifecycle.ts";
import { copyDurableFactoryFile, writeDurableFactoryFile } from "../lib/factory-durable-file.ts";
import {
  FACTORY_TRIAGE_EVENT_STEP,
  FACTORY_TRIAGE_STEP_OUTPUTS,
  type FactoryRunContext,
  type FactoryRunMeta,
} from "../lib/factory-run-context.ts";
import {
  FactoryTriageError,
  FactoryRoutePlanSchema,
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
  const workItemKey = deriveFactoryWorkItemKey(ctx.workItem);
  const events = readFactoryActionEvents(input.factoryStateRoot, workItemKey);
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
  const request = events.findLast(
    (event): event is Extract<FactoryLifecycleEvent, { type: "triage.requested" }> =>
      event.type === "triage.requested" && event.phaseRunId === ctx.runId,
  );
  if (!request || request.data.inputRefs.length === 0) {
    throw new Error(`Factory triage phase ${ctx.runId} has no durable input evidence`);
  }
  const roots = { "factory-store": ctx.factoryStore!.projectRoot, repository: ctx.workspace };
  for (const ref of request.data.inputRefs) verifyFactoryArtifactRef(ref, roots);

  const actionDir = join(
    ctx.runDir,
    "actions",
    String(reaction.attempt),
    reaction.handler,
    factoryActionKey({ ...reaction, phaseRunId: ctx.runId }),
  );
  const resultPath = factoryActionResultPath(actionDir);
  if (!existsSync(resultPath)) {
    const providerOutcomePath = join(actionDir, "provider-result.json");
    const actionIdentity = {
      phaseRunId: ctx.runId,
      handler: "triageWorkItem" as const,
      attempt: reaction.attempt,
      causationEventId: reaction.causationEventId,
    };
    ctx.bindActionOutcome?.({ path: providerOutcomePath, action: actionIdentity });
    let providerOutcome = readActionProviderOutcome(providerOutcomePath, ctx, reaction);
    if (!providerOutcome) {
      let meta: FactoryRunMeta;
      try {
        meta = await (input.runProvider ?? run)(ctx, {
          nextLiveRunRequiresRerun: input.nextLiveRunRequiresRerun,
        });
      } catch (error) {
        meta = ctx.exportFailed(error);
      }
      if (!existsSync(providerOutcomePath)) {
        writeActionProviderOutcome(providerOutcomePath, actionIdentity, meta);
      }
      providerOutcome = readActionProviderOutcome(providerOutcomePath, ctx, reaction);
    }
    let terminal: Extract<
      FactoryLifecycleEvent,
      { type: "triage.work_item.completed" | "factory.action.failed" }
    >;
    if (!providerOutcome) {
      throw new Error(`Factory provider outcome was not published for ${ctx.runId}`);
    }
    const failureEvidencePath = join(actionDir, "evidence", "failure.json");
    let terminalMeta = readRecoveredFailureEvidence(failureEvidencePath, ctx);
    if (terminalMeta) {
      terminal = buildTriageActionEvent(ctx, terminalMeta, undefined, reaction);
    } else {
      terminalMeta = providerOutcome.meta;
      try {
        const triage =
          terminalMeta.status === "completed" ? readTriageArtifact(terminalMeta) : undefined;
        terminal = buildTriageActionEvent(ctx, terminalMeta, triage, reaction);
      } catch (error) {
        terminalMeta = ctx.exportFailed(error, { publishActionOutcome: false });
        terminal = buildTriageActionEvent(ctx, terminalMeta, undefined, reaction);
      }
    }
    ensureCanonicalRunMeta(ctx, terminalMeta);
    input.onMeta?.(terminalMeta);
    writeFactoryActionResult(actionDir, terminal);
  }
  const terminal = readFactoryActionResult(actionDir);
  const recoveredEvidence = assertRecoveredActionResult({
    terminal,
    ctx,
    reaction,
    factoryStateRoot: input.factoryStateRoot,
    workItemKey,
    actionDir,
  });
  const recoveredMeta =
    recoveredEvidence.kind === "failed"
      ? recoveredEvidence.meta
      : readActionProviderOutcome(join(actionDir, "provider-result.json"), ctx, reaction)?.meta;
  if (!recoveredMeta) throw new Error(`Factory action metadata is missing for ${ctx.runId}`);
  if (recoveredEvidence.kind === "completed") {
    const expectedNextAction = buildFactoryRoutePlan(
      ctx.workItem,
      recoveredEvidence.triage,
    ).nextAction;
    if (
      recoveredMeta.status !== "completed" ||
      recoveredMeta.route !== recoveredEvidence.triage.route ||
      recoveredMeta.nextAction !== expectedNextAction
    ) {
      throw new Error("Recovered Factory completion conflicts with action-bound provider metadata");
    }
  }
  ensureCanonicalRunMeta(ctx, recoveredMeta);
  input.onMeta?.(recoveredMeta);
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

function readActionProviderOutcome(
  path: string,
  ctx: FactoryRunContext,
  reaction: Extract<FactoryReaction, { kind: "invoke" }>,
): { meta: FactoryRunMeta } | undefined {
  if (!existsSync(path)) return undefined;
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.action) || !isRecord(value.meta)) {
    throw new Error(`Factory action provider result is invalid: ${path}`);
  }
  if (
    value.action.phaseRunId !== ctx.runId ||
    value.action.handler !== reaction.handler ||
    value.action.attempt !== reaction.attempt ||
    value.action.causationEventId !== reaction.causationEventId
  ) {
    throw new Error(`Factory action provider result identity conflicts with ${ctx.runId}`);
  }
  const meta = value.meta as FactoryRunMeta;
  assertRecoveredMetaIdentity(meta, ctx);
  return { meta };
}

function writeActionProviderOutcome(
  path: string,
  action: {
    phaseRunId: string;
    handler: "triageWorkItem";
    attempt: number;
    causationEventId: string;
  },
  meta: FactoryRunMeta,
): void {
  writeDurableFactoryFile(path, `${JSON.stringify({ version: 1, action, meta }, null, 2)}\n`, true);
}

function assertRecoveredMetaIdentity(value: FactoryRunMeta, ctx: FactoryRunContext): void {
  if (value.status !== "completed" && value.status !== "failed") {
    throw new Error(`Factory action metadata has no terminal provider status for ${ctx.runId}`);
  }
  const valueStore = value.factoryStore;
  const contextStore = ctx.factoryStore;
  const identity = readFactoryPhaseRunIdentity(ctx.runDir);
  if (identity.phase !== "triage") throw new Error(`Factory phase is not triage: ${ctx.runId}`);
  const profile = identity.actions.triageWorkItem;
  if (
    value.runId !== ctx.runId ||
    resolve(value.runDir) !== resolve(ctx.runDir) ||
    resolve(value.workspace) !== resolve(ctx.workspace) ||
    value.workItem.id !== ctx.workItem.id ||
    value.workItem.source !== ctx.workItem.source ||
    value.workItem.title !== ctx.workItem.title ||
    !valueStore ||
    !contextStore ||
    resolve(valueStore.factoryStateRoot) !== resolve(contextStore.factoryStateRoot) ||
    valueStore.projectId !== contextStore.projectId ||
    resolve(valueStore.projectRoot) !== resolve(contextStore.projectRoot) ||
    valueStore.repo.id !== contextStore.repo.id ||
    valueStore.repo.name !== contextStore.repo.name ||
    valueStore.repo.idSource !== contextStore.repo.idSource ||
    identity.phaseRunId !== ctx.runId ||
    identity.projectId !== contextStore.projectId ||
    identity.factoryStateRoot !== resolve(contextStore.factoryStateRoot) ||
    identity.workspace !== resolve(ctx.workspace) ||
    value.agent.name !== profile.provider ||
    value.agent.model !== profile.model ||
    (profile.provider === "codex" &&
      (value.agent.sandboxMode !== profile.sandbox ||
        value.agent.approvalPolicy !== profile.approvalPolicy ||
        value.agent.modelReasoningEffort !== profile.reasoningEffort)) ||
    (profile.provider === "cursor" &&
      (value.agent.sandboxMode !== undefined ||
        value.agent.approvalPolicy !== undefined ||
        value.agent.modelReasoningEffort !== undefined))
  ) {
    throw new Error(`Completed Factory run metadata conflicts with ${ctx.runId}`);
  }
}

function assertRecoveredActionResult(input: {
  terminal: FactoryLifecycleEvent;
  ctx: FactoryRunContext;
  reaction: Extract<FactoryReaction, { kind: "invoke" }>;
  factoryStateRoot: string;
  workItemKey: string;
  actionDir: string;
}): { kind: "completed"; triage: FactoryTriageOutput } | { kind: "failed"; meta: FactoryRunMeta } {
  const { terminal, ctx, reaction } = input;
  if (terminal.type !== "triage.work_item.completed" && terminal.type !== "factory.action.failed") {
    throw new Error("Recovered triage action result is not terminal");
  }
  if (
    terminal.workItemKey !== input.workItemKey ||
    terminal.phaseRunId !== ctx.runId ||
    terminal.data.handler !== "triageWorkItem" ||
    terminal.data.attempt !== reaction.attempt ||
    terminal.data.causationEventId !== reaction.causationEventId ||
    (terminal.type === "factory.action.failed" && terminal.data.phase !== "triage")
  ) {
    throw new Error("Recovered triage action result conflicts with durable Factory state");
  }
  const identity = readFactoryPhaseRunIdentity(ctx.runDir);
  if (
    identity.phaseRunId !== ctx.runId ||
    identity.phase !== "triage" ||
    identity.workItemKey !== input.workItemKey ||
    identity.workspace !== resolve(ctx.workspace) ||
    identity.projectId !== ctx.factoryStore?.projectId ||
    identity.factoryStateRoot !== resolve(input.factoryStateRoot) ||
    terminal.data.execution.workspaceRef !== identity.projectId
  ) {
    throw new Error(`Recovered Factory phase identity conflicts with ${ctx.runId}`);
  }
  const roots = { "factory-store": ctx.factoryStore!.projectRoot, repository: ctx.workspace };
  const evidencePaths = terminal.data.evidence.map((ref) =>
    resolve(verifyFactoryArtifactRef(ref, roots)),
  );
  const runPath = resolve(verifyFactoryArtifactRef(terminal.data.execution.runRef, roots));
  if (!evidencePaths.includes(runPath)) {
    throw new Error("Recovered Factory action result omits its execution evidence");
  }
  const expectedRunName =
    terminal.type === "triage.work_item.completed" ? "summary.md" : "failure.json";
  if (runPath !== resolve(input.actionDir, "evidence", expectedRunName)) {
    throw new Error(`Recovered Factory action result requires ${expectedRunName}`);
  }
  if (
    terminal.type === "triage.work_item.completed" &&
    !evidencePaths.includes(resolve(input.actionDir, "evidence", "factory-triage.json"))
  ) {
    throw new Error("Recovered Factory completion has no immutable triage evidence");
  }
  if (terminal.type === "triage.work_item.completed") {
    if (terminal.data.nextCommand !== undefined) {
      throw new Error("Recovered PR 1 triage completion cannot contain a next command");
    }
    if (evidencePaths.length !== 2) {
      throw new Error("Recovered Factory completion has unexpected evidence");
    }
    const triage = parseFactoryTriageOutput(
      JSON.parse(readFileSync(resolve(input.actionDir, "evidence", "factory-triage.json"), "utf8")),
    );
    if (triage.route !== terminal.data.route || triage.rationale !== terminal.data.rationale) {
      throw new Error("Recovered Factory completion conflicts with immutable triage evidence");
    }
    return { kind: "completed", triage };
  } else {
    if (evidencePaths.length !== 1) {
      throw new Error("Recovered Factory failure has unexpected evidence");
    }
    const failureValue: unknown = JSON.parse(readFileSync(runPath, "utf8"));
    if (!isRecord(failureValue)) throw new Error("Recovered Factory failure evidence is invalid");
    const failure = failureValue as FactoryRunMeta;
    assertRecoveredMetaIdentity(failure, ctx);
    if (
      failure.status !== "failed" ||
      failure.error !== terminal.data.message ||
      (failure.failureKind ?? "terminal") !== terminal.data.failureKind
    ) {
      throw new Error("Recovered Factory failure conflicts with immutable evidence");
    }
    return { kind: "failed", meta: failure };
  }
}

function readRecoveredFailureEvidence(
  path: string,
  ctx: FactoryRunContext,
): FactoryRunMeta | undefined {
  if (!existsSync(path)) return undefined;
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(value)) throw new Error(`Factory action failure evidence is invalid: ${path}`);
  const meta = value as FactoryRunMeta;
  assertRecoveredMetaIdentity(meta, ctx);
  if (meta.status !== "failed") {
    throw new Error(`Factory action failure evidence is not failed: ${path}`);
  }
  return meta;
}

function ensureCanonicalRunMeta(ctx: FactoryRunContext, meta: FactoryRunMeta): void {
  writeDurableFactoryFile(join(ctx.runDir, "meta.json"), JSON.stringify(meta, null, 2));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTriageArtifact(meta: FactoryRunMeta): FactoryTriageOutput {
  const triagePath = resolveRunArtifact(
    meta.runDir,
    meta.artifacts?.triage ?? "factory-triage.json",
    "factory-triage.json",
  );
  const triage = parseFactoryTriageOutput(JSON.parse(readFileSync(triagePath, "utf8")));
  for (const evidence of triage.evidence) {
    if (evidence.path === null || evidence.kind === "tracker") continue;
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
  const completed = meta.status === "completed" && triage !== undefined;
  const summarySource = completed
    ? resolveRunArtifact(meta.runDir, meta.artifacts?.summary ?? "summary.md", "summary.md")
    : undefined;
  const routePlan = completed
    ? FactoryRoutePlanSchema.parse(
        JSON.parse(
          readFileSync(
            resolveRunArtifact(meta.runDir, "factory-route.json", "factory-route.json"),
            "utf8",
          ),
        ),
      )
    : undefined;
  if (
    completed &&
    (routePlan?.route !== triage.route ||
      meta.route !== triage.route ||
      meta.nextAction !== routePlan.nextAction)
  ) {
    throw new Error("Factory route artifact conflicts with completed triage output");
  }
  const triageSource = completed
    ? resolveRunArtifact(
        meta.runDir,
        meta.artifacts?.triage ?? "factory-triage.json",
        "factory-triage.json",
      )
    : undefined;
  const summaryPath = completed
    ? publishEvidence(summarySource!, join(evidenceDir, "summary.md"))
    : publishFailureEvidence(meta, join(evidenceDir, "failure.json"));
  const runRef = createFactoryArtifactRef({
    base: "factory-store",
    root: store.projectRoot,
    path: relative(store.projectRoot, summaryPath),
  });
  const triagePath = triageSource
    ? publishEvidence(triageSource, join(evidenceDir, "factory-triage.json"))
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
  if (!completed)
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
  const nextCommand =
    typeof routePlan?.command === "string" && routePlan.command.trim()
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
  if (existsSync(destination)) {
    if (!readFileSync(source).equals(readFileSync(destination)))
      throw new Error(`Factory action evidence conflicts with ${destination}`);
    return destination;
  }
  copyDurableFactoryFile(source, destination);
  return destination;
}

function publishFailureEvidence(meta: FactoryRunMeta, destination: string): string {
  writeDurableFactoryFile(destination, `${JSON.stringify(meta, null, 2)}\n`, true);
  return destination;
}

function resolveRunArtifact(runDir: string, path: string, expectedName: string): string {
  if (basename(path) !== expectedName || path !== expectedName) {
    throw new Error(`Factory run artifact must be ${expectedName}`);
  }
  const runRoot = realpathSync(runDir);
  const artifact = realpathSync(resolve(runDir, path));
  assertFactoryPathContained(runRoot, artifact);
  return artifact;
}
