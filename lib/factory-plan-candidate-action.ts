import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Agent, AgentProviderOptions, AgentSessionRef } from "./agents.ts";
import { createFactoryArtifactRef, verifyFactoryArtifactRef } from "./factory-artifact-ref.ts";
import { factoryActionKey } from "./factory-action-contract.ts";
import {
  factoryActionResultPath,
  readFactoryActionResult,
  writeFactoryActionResult,
} from "./factory-action-result.ts";
import { appendFactoryActionEvent, readFactoryActionEvents } from "./factory-lifecycle-kernel.ts";
import type { FactoryActionEvent, FactoryLifecycleEvent } from "./factory-lifecycle-events.ts";
import type { openFactoryPlanningRunContext } from "./factory-planning-run-context.ts";
import { FACTORY_PLANNING_SCHEMA_PATH } from "./factory-planning-run-context.ts";
import { parseFactoryPlanningOutput } from "./factory-planning-schemas.ts";
import { deriveFactoryWorkItemKey } from "./factory-lifecycle.ts";
import { writeDurableFactoryFile } from "./factory-durable-file.ts";
import { z } from "zod";
import { startFactoryActionTelemetry } from "./factory-action-telemetry.ts";
import {
  renderFactoryPlanningInitialPrompt,
  renderFactoryPlanningRevisionPrompt,
} from "./prompts/index.ts";
import {
  decideNextFactoryAction,
  reduceFactoryLifecycleEvents,
  type FactoryLifecycleState,
  type FactoryReaction,
} from "./factory-state-machine.ts";

type PlanningContext = ReturnType<typeof openFactoryPlanningRunContext>;

export async function producePlanCandidate(input: {
  ctx: PlanningContext;
  factoryStateRoot: string;
  reaction: Extract<FactoryReaction, { kind: "invoke" }>;
  maxRuntimeMs: number;
  signal?: AbortSignal;
  agentProviderFactory: (options: AgentProviderOptions) => Agent;
}): Promise<{ event: FactoryLifecycleEvent; state: FactoryLifecycleState }> {
  const { ctx, reaction } = input;
  assertReaction(ctx, input.factoryStateRoot, reaction);
  const actionDir = join(
    ctx.runDir,
    "actions",
    String(reaction.attempt),
    reaction.handler,
    factoryActionKey({ ...reaction, phaseRunId: ctx.runId }),
  );
  const resultPath = factoryActionResultPath(actionDir);
  if (!existsSync(resultPath)) {
    mkdirSync(actionDir, { recursive: true });
    const { draftPath } = ctx.preparePlannerScratch();
    const previous = previousCandidate(ctx, input.factoryStateRoot, reaction);
    if (previous) copyFileSync(previous.path, draftPath);
    const blocking = previous ? latestBlocking(ctx, input.factoryStateRoot) : [];
    const prompt = previous
      ? renderFactoryPlanningRevisionPrompt({
          draftPath,
          currentDate: new Date().toISOString().slice(0, 10),
          reviewFindingsJson: JSON.stringify(blocking, null, 2),
        })
      : renderFactoryPlanningInitialPrompt({
          workItemJson: JSON.stringify(ctx.workItem, null, 2),
          draftPath,
          currentDate: new Date().toISOString().slice(0, 10),
        });
    writeFileSync(join(actionDir, "planner.prompt.md"), prompt);
    const profile = ctx.identity.actions.producePlanCandidate;
    const providerResultPath = join(actionDir, "provider-result.json");
    let result: PlannerOutcome;
    if (existsSync(providerResultPath)) {
      const staged = StagedProviderOutcomeSchema.parse(
        JSON.parse(readFileSync(providerResultPath, "utf8")),
      );
      if (
        staged.version !== 1 ||
        staged.action?.phaseRunId !== ctx.runId ||
        staged.action?.handler !== reaction.handler ||
        staged.action?.attempt !== reaction.attempt ||
        staged.action?.causationEventId !== reaction.causationEventId ||
        !staged.outcome
      )
        throw new Error("Staged planner outcome conflicts with action identity");
      result = staged.outcome;
    } else {
      const provider = input.agentProviderFactory({
        provider: profile.provider,
        ...(profile.provider === "codex" && profile.executable
          ? { codexPathOverride: profile.executable }
          : {}),
      });
      const finishTelemetry = startFactoryActionTelemetry({
        eventSink: ctx.eventSink,
        runId: ctx.runId,
        runDir: actionDir,
        workspace: ctx.workspace,
        stepId: reaction.handler,
      });
      try {
        const providerResult = await provider.run({
          workspace: ctx.workspace,
          prompt,
          schemaPath: FACTORY_PLANNING_SCHEMA_PATH,
          model: profile.model,
          ...(profile.provider === "codex"
            ? {
                sandboxMode: profile.sandbox,
                approvalPolicy: profile.approvalPolicy,
                modelReasoningEffort: profile.reasoningEffort,
              }
            : {}),
          workspaceGuard: "record",
          maxRuntimeMs: input.maxRuntimeMs,
          logPath: join(actionDir, "planner.stream.jsonl"),
          ...(previous?.session ? { session: previous.session } : {}),
          signal: input.signal,
        });
        result = providerResult.ok
          ? {
              ok: true,
              structuredOutput: providerResult.structuredOutput,
              session: normalizeSession(providerResult.session),
              workspaceUnchanged: workspaceUnchanged(providerResult.raw),
            }
          : {
              ok: false,
              error: providerResult.error,
              ...(providerResult.aborted ? { aborted: true } : {}),
              ...(providerResult.failureKind ? { failureKind: providerResult.failureKind } : {}),
              workspaceUnchanged: workspaceUnchanged(providerResult.raw),
            };
        writeFileSync(
          join(actionDir, "planner.raw.json"),
          `${JSON.stringify(providerResult.raw ?? providerResult, null, 2)}\n`,
        );
        finishTelemetry(result.ok ? "completed" : "failed", result.ok ? undefined : result.error);
      } catch (error) {
        finishTelemetry("failed", errorMessage(error));
        const terminal = buildFailure(
          ctx,
          reaction,
          actionDir,
          errorMessage(error),
          isAbortError(error) ? "human-required" : "terminal",
        );
        writeFactoryActionResult(actionDir, terminal);
        return appendRecovered(input.factoryStateRoot, ctx, reaction, actionDir);
      }
      writeDurableFactoryFile(
        providerResultPath,
        `${JSON.stringify({ version: 1, action: { phaseRunId: ctx.runId, handler: reaction.handler, attempt: reaction.attempt, causationEventId: reaction.causationEventId }, outcome: result }, null, 2)}\n`,
        true,
      );
    }
    if (!existsSync(join(actionDir, "planner.raw.json")))
      writeFileSync(join(actionDir, "planner.raw.json"), "{}\n");
    if (result.ok && !result.workspaceUnchanged) {
      const terminal = buildFailure(
        ctx,
        reaction,
        actionDir,
        "Agent runtime modified the workspace during planning",
        "human-required",
      );
      writeFactoryActionResult(actionDir, terminal);
      return appendRecovered(input.factoryStateRoot, ctx, reaction, actionDir);
    }
    let output: ReturnType<typeof parseFactoryPlanningOutput> | undefined;
    if (result.ok) {
      try {
        output = parseFactoryPlanningOutput(result.structuredOutput);
        if (previous && output.outcome === "draft-ready")
          validateDecisions(output.findingDecisions, blocking);
      } catch (error) {
        const terminal = buildFailure(ctx, reaction, actionDir, errorMessage(error), "terminal");
        writeFactoryActionResult(actionDir, terminal);
        return appendRecovered(input.factoryStateRoot, ctx, reaction, actionDir);
      }
    }
    const terminal: FactoryActionEvent = result.ok
      ? buildSuccess(
          ctx,
          reaction,
          actionDir,
          output!,
          normalizeSession(result.session ?? previous?.session),
        )
      : buildFailure(ctx, reaction, actionDir, result.error, classifyProviderFailure(result));
    writeFactoryActionResult(actionDir, terminal);
  }
  const recovered = readFactoryActionResult(actionDir);
  assertRecoveredResult(ctx, reaction, recovered);
  return appendFactoryActionEvent({
    factoryStateRoot: input.factoryStateRoot,
    event: recovered,
    expectedLastEventId: reaction.causationEventId,
  });
}

const AgentSessionSchema = z.object({
  provider: z.enum(["cursor", "codex"]),
  id: z.string().trim().min(1),
});
const PlannerOutcomeSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    structuredOutput: z.unknown().optional(),
    session: AgentSessionSchema.optional(),
    workspaceUnchanged: z.boolean(),
  }),
  z.object({
    ok: z.literal(false),
    error: z.string(),
    aborted: z.boolean().optional(),
    failureKind: z.literal("workspace-guard").optional(),
    workspaceUnchanged: z.boolean(),
  }),
]);
const StagedProviderOutcomeSchema = z.object({
  version: z.literal(1),
  action: z.object({
    phaseRunId: z.string(),
    handler: z.literal("producePlanCandidate"),
    attempt: z.number().int().positive(),
    causationEventId: z.string(),
  }),
  outcome: PlannerOutcomeSchema,
});
type PlannerOutcome = z.infer<typeof PlannerOutcomeSchema>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function assertRecoveredResult(
  ctx: PlanningContext,
  reaction: Extract<FactoryReaction, { kind: "invoke" }>,
  event: FactoryActionEvent,
): void {
  if (
    event.workItemKey !== deriveFactoryWorkItemKey(ctx.workItem) ||
    event.phaseRunId !== ctx.runId ||
    event.data.handler !== "producePlanCandidate" ||
    event.data.attempt !== reaction.attempt ||
    event.data.causationEventId !== reaction.causationEventId ||
    event.data.execution.workspaceRef !== ctx.factoryStore.repo.id
  )
    throw new Error("Recovered planning candidate result conflicts with phase identity");
  const roots = { "factory-store": ctx.factoryStore.projectRoot, repository: ctx.workspace };
  verifyFactoryArtifactRef(event.data.execution.runRef, roots);
  for (const evidence of event.data.evidence) verifyFactoryArtifactRef(evidence, roots);
}

function validateDecisions(decisions: Array<{ findingId: string }>, blocking: unknown[]): void {
  const expected = new Set(
    blocking.flatMap((value) =>
      typeof value === "object" && value && "id" in value && typeof value.id === "string"
        ? [value.id]
        : [],
    ),
  );
  const seen = new Set(decisions.map((decision) => decision.findingId));
  if (
    seen.size !== decisions.length ||
    seen.size !== expected.size ||
    [...expected].some((id) => !seen.has(id))
  )
    throw new Error("Planner finding decisions do not match the latest must_fix findings");
}

function buildSuccess(
  ctx: PlanningContext,
  reaction: Extract<FactoryReaction, { kind: "invoke" }>,
  actionDir: string,
  output: ReturnType<typeof parseFactoryPlanningOutput>,
  session: AgentSessionRef | undefined,
): FactoryActionEvent {
  const common = eventCommon(ctx, reaction, actionDir);
  writeFileSync(join(actionDir, "planner.json"), `${JSON.stringify(output, null, 2)}\n`);
  if (output.outcome === "needs-human") {
    writeFileSync(
      join(actionDir, "questions.json"),
      `${JSON.stringify(output.humanQuestions, null, 2)}\n`,
    );
    const questions = ref(ctx, join(actionDir, "questions.json"));
    return {
      ...common,
      id: `planning.input.required:${factoryActionKey({ ...reaction, phaseRunId: ctx.runId })}`,
      type: "planning.input.required",
      data: { ...common.data, evidence: [questions], questions },
    };
  }
  if (!session)
    return buildFailure(
      ctx,
      reaction,
      actionDir,
      "Planner session was not captured",
      "human-required",
    );
  const candidatePath = join(actionDir, "candidate.md");
  let bytes: Buffer;
  try {
    bytes = ctx.readPlannerDraft();
  } catch (error) {
    return buildFailure(ctx, reaction, actionDir, errorMessage(error), "terminal");
  }
  writeDurableFactoryFile(candidatePath, bytes.toString("utf8"), true);
  const candidate = ref(ctx, candidatePath);
  return {
    ...common,
    id: `planning.candidate.produced:${factoryActionKey({ ...reaction, phaseRunId: ctx.runId })}`,
    type: "planning.candidate.produced",
    data: { ...common.data, evidence: [candidate], candidate, effectiveSession: session },
  };
}

function normalizeSession(session: AgentSessionRef | undefined): AgentSessionRef | undefined {
  return session ? { provider: session.provider, id: session.id } : undefined;
}

function classifyProviderFailure(
  result: Extract<PlannerOutcome, { ok: false }>,
): "retryable" | "human-required" | "terminal" {
  if (result.aborted || result.failureKind === "workspace-guard") return "human-required";
  return result.workspaceUnchanged ? "retryable" : "human-required";
}

function workspaceUnchanged(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("workspaceStatus" in raw))
    return false;
  const status = raw.workspaceStatus;
  if (!status || typeof status !== "object" || !("before" in status) || !("after" in status))
    return false;
  return status.before === status.after;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message));
}

function buildFailure(
  ctx: PlanningContext,
  reaction: Extract<FactoryReaction, { kind: "invoke" }>,
  actionDir: string,
  message: string,
  failureKind: "retryable" | "human-required" | "terminal",
): FactoryActionEvent {
  const common = eventCommon(ctx, reaction, actionDir);
  const failurePath = join(actionDir, "failure.json");
  writeDurableFactoryFile(
    failurePath,
    `${JSON.stringify({ message, failureKind }, null, 2)}\n`,
    true,
  );
  const failure = ref(ctx, failurePath);
  return {
    ...common,
    id: `factory.action.failed:${factoryActionKey({ ...reaction, phaseRunId: ctx.runId })}`,
    type: "factory.action.failed",
    data: {
      ...common.data,
      evidence: [failure],
      execution: { ...common.data.execution, runRef: failure },
      phase: "planning",
      failureKind,
      message,
    },
  };
}

function eventCommon(
  ctx: PlanningContext,
  reaction: Extract<FactoryReaction, { kind: "invoke" }>,
  actionDir: string,
) {
  const placeholder = join(actionDir, "planner.raw.json");
  if (!existsSync(placeholder)) writeFileSync(placeholder, "{}\n");
  return {
    version: 1 as const,
    workItemKey: deriveFactoryWorkItemKey(ctx.workItem),
    occurredAt: new Date().toISOString(),
    phaseRunId: ctx.runId,
    data: {
      handler: "producePlanCandidate" as const,
      handlerVersion: 1 as const,
      attempt: reaction.attempt,
      causationEventId: reaction.causationEventId,
      execution: { workspaceRef: ctx.factoryStore.repo.id, runRef: ref(ctx, placeholder) },
      evidence: [ref(ctx, placeholder)],
    },
  };
}

function ref(ctx: PlanningContext, path: string) {
  return createFactoryArtifactRef({
    base: "factory-store",
    root: ctx.factoryStore.projectRoot,
    path: relative(ctx.factoryStore.projectRoot, path),
  });
}

function assertReaction(
  ctx: PlanningContext,
  root: string,
  reaction: Extract<FactoryReaction, { kind: "invoke" }>,
) {
  const events = readFactoryActionEvents(root, deriveFactoryWorkItemKey(ctx.workItem));
  const state = reduceFactoryLifecycleEvents(events);
  const latest = events.at(-1);
  if (
    !state ||
    !latest ||
    reaction.handler !== "producePlanCandidate" ||
    JSON.stringify(decideNextFactoryAction(state, latest)) !== JSON.stringify(reaction)
  )
    throw new Error("producePlanCandidate reaction conflicts with durable Factory state");
}

function previousCandidate(
  ctx: PlanningContext,
  root: string,
  reaction: Extract<FactoryReaction, { kind: "invoke" }>,
): { path: string; session: AgentSessionRef } | undefined {
  if (reaction.attempt === 1) return undefined;
  const event = readFactoryActionEvents(root, deriveFactoryWorkItemKey(ctx.workItem)).findLast(
    (candidate) =>
      candidate.type === "planning.candidate.produced" && candidate.phaseRunId === ctx.runId,
  );
  if (!event || event.type !== "planning.candidate.produced")
    throw new Error("Planning revision has no prior candidate");
  const session = event.data.effectiveSession;
  if (session.provider !== "cursor" && session.provider !== "codex")
    throw new Error("Planning candidate has an invalid provider session");
  return {
    path: verifyFactoryArtifactRef(event.data.candidate, {
      "factory-store": ctx.factoryStore.projectRoot,
      repository: ctx.workspace,
    }),
    session: { provider: session.provider, id: session.id },
  };
}

function latestBlocking(ctx: PlanningContext, root: string): unknown[] {
  const event = readFactoryActionEvents(root, deriveFactoryWorkItemKey(ctx.workItem)).findLast(
    (candidate) =>
      candidate.type === "planning.review.completed" && candidate.phaseRunId === ctx.runId,
  );
  if (!event || event.type !== "planning.review.completed" || !event.data.blockingFindings)
    throw new Error("Planning revision has no blocking findings");
  return JSON.parse(
    readFileSync(
      verifyFactoryArtifactRef(event.data.blockingFindings, {
        "factory-store": ctx.factoryStore.projectRoot,
        repository: ctx.workspace,
      }),
      "utf8",
    ),
  );
}
