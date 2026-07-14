import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Agent, AgentProviderOptions, AgentSessionRef } from "./agents.ts";
import {
  createFactoryArtifactRef,
  FactoryArtifactRefSchema,
  type FactoryArtifactRef,
  verifyFactoryArtifactRef,
} from "./factory-artifact-ref.ts";
import { factoryActionKey } from "./factory-action-contract.ts";
import {
  factoryActionResultPath,
  readFactoryActionResult,
  writeFactoryActionResult,
} from "./factory-action-result.ts";
import { loadFactoryContinuationForReaction } from "./factory-continuation.ts";
import { appendFactoryActionEvent, readFactoryActionEvents } from "./factory-lifecycle-kernel.ts";
import type { FactoryActionEvent, FactoryLifecycleEvent } from "./factory-lifecycle-events.ts";
import type { openFactoryPlanningRunContext } from "./factory-planning-run-context.ts";
import { FACTORY_PLANNING_SCHEMA_PATH } from "./factory-planning-run-context.ts";
import {
  FactoryPlanningOutputSchema,
  parseFactoryPlanningOutput,
  type FactoryPlanningOutput,
} from "./factory-planning-schemas.ts";
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
    const providerResultPath = join(actionDir, "provider-result.json");
    const staged = readStagedProviderOutcome(providerResultPath, ctx, reaction);
    if (staged?.kind === "invalid") {
      const terminal = buildFailure(ctx, reaction, actionDir, staged.message, "terminal");
      writeFactoryActionResult(actionDir, terminal);
      return appendRecovered(input.factoryStateRoot, ctx, reaction, actionDir);
    }
    let previous: ReturnType<typeof revisionContext>;
    try {
      previous = revisionContext(ctx, input.factoryStateRoot, reaction);
    } catch (error) {
      if (error instanceof CandidateInputValidationError) {
        const terminal = buildFailure(ctx, reaction, actionDir, error.message, "terminal");
        writeFactoryActionResult(actionDir, terminal);
        return appendRecovered(input.factoryStateRoot, ctx, reaction, actionDir);
      }
      throw error;
    }
    let result: PlannerOutcome | undefined;
    if (staged) {
      result = staged.outcome;
    } else {
      const { draftPath } = ctx.preparePlannerScratch();
      if (previous) copyFileSync(previous.path, draftPath);
      const prompt = previous
        ? renderFactoryPlanningRevisionPrompt({
            draftPath,
            currentDate: new Date().toISOString().slice(0, 10),
            reviewFindingsJson: JSON.stringify(previous.blocking, null, 2),
            operatorResponse: previous.operatorResponse,
          })
        : renderFactoryPlanningInitialPrompt({
            workItemJson: JSON.stringify(ctx.workItem, null, 2),
            draftPath,
            currentDate: new Date().toISOString().slice(0, 10),
          });
      writeFileSync(join(actionDir, "planner.prompt.md"), prompt);
      const profile = ctx.identity.actions.producePlanCandidate;
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
      let providerResult: Awaited<ReturnType<Agent["run"]>> | undefined;
      try {
        providerResult = await provider.run({
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
      } catch (error) {
        finishTelemetry("failed", errorMessage(error));
        result = {
          kind: "provider-failure",
          error: errorMessage(error),
          ...(input.signal?.aborted ? { aborted: true } : {}),
          workspaceUnchanged: false,
        };
      }
      if (providerResult) {
        if (!providerResult.ok) {
          result = {
            kind: "provider-failure",
            error: providerResult.error,
            ...(providerResult.aborted ? { aborted: true } : {}),
            ...(providerResult.failureKind ? { failureKind: providerResult.failureKind } : {}),
            workspaceUnchanged: workspaceUnchanged(providerResult.raw),
          };
        } else if (!workspaceUnchanged(providerResult.raw)) {
          result = {
            kind: "provider-failure",
            error: "Agent runtime modified the workspace during planning",
            failureKind: "workspace-guard",
            workspaceUnchanged: false,
          };
        } else {
          result = captureProviderSuccess(
            ctx,
            actionDir,
            providerResult.structuredOutput,
            providerResult.session,
          );
        }
        writeFileSync(
          join(actionDir, "planner.raw.json"),
          `${JSON.stringify(providerResult.raw ?? providerResult, null, 2)}\n`,
        );
        finishTelemetry(
          result.kind === "completed" ? "completed" : "failed",
          result.kind === "completed" ? undefined : result.error,
        );
      }
      if (!result) throw new Error("Planner action produced no staged outcome");
      writeDurableFactoryFile(
        providerResultPath,
        `${JSON.stringify({ version: 1, action: { phaseRunId: ctx.runId, handler: reaction.handler, attempt: reaction.attempt, causationEventId: reaction.causationEventId }, outcome: result }, null, 2)}\n`,
        true,
      );
    }
    if (!result) throw new Error("Planner action produced no staged outcome");
    if (!existsSync(join(actionDir, "planner.raw.json")))
      writeFileSync(join(actionDir, "planner.raw.json"), "{}\n");
    if (result.kind === "completed") {
      try {
        if (previous && result.output.outcome === "draft-ready")
          validateDecisions(result.output.findingDecisions, previous.blocking);
        if (result.output.outcome === "draft-ready") {
          if (!result.candidate) throw new Error("Staged planner candidate is missing");
          verifyFactoryArtifactRef(result.candidate, {
            "factory-store": ctx.factoryStore.projectRoot,
            repository: ctx.workspace,
          });
        }
      } catch (error) {
        const terminal = buildFailure(
          ctx,
          reaction,
          actionDir,
          errorMessage(error),
          "terminal",
          previous?.candidateEventId,
        );
        writeFactoryActionResult(actionDir, terminal);
        return appendRecovered(input.factoryStateRoot, ctx, reaction, actionDir);
      }
    }
    const terminal: FactoryActionEvent =
      result.kind === "completed"
        ? buildSuccess(
            ctx,
            reaction,
            actionDir,
            result.output,
            normalizeSession(result.session ?? previous?.session),
            result.candidate,
            previous?.candidateEventId,
          )
        : buildFailure(
            ctx,
            reaction,
            actionDir,
            result.error,
            result.kind === "validation-failure" ? "terminal" : classifyProviderFailure(result),
            previous?.candidateEventId,
          );
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
type PlannerOutcome =
  | {
      kind: "completed";
      output: FactoryPlanningOutput;
      session?: AgentSessionRef;
      workspaceUnchanged: true;
      candidate?: FactoryArtifactRef;
    }
  | {
      kind: "provider-failure";
      error: string;
      aborted?: boolean;
      failureKind?: "workspace-guard";
      workspaceUnchanged: boolean;
    }
  | { kind: "validation-failure"; error: string };

const PlannerOutcomeSchema: z.ZodType<PlannerOutcome> = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("completed"),
    output: FactoryPlanningOutputSchema,
    session: AgentSessionSchema.optional(),
    workspaceUnchanged: z.literal(true),
    candidate: FactoryArtifactRefSchema.optional(),
  }),
  z.object({
    kind: z.literal("provider-failure"),
    error: z.string(),
    aborted: z.boolean().optional(),
    failureKind: z.literal("workspace-guard").optional(),
    workspaceUnchanged: z.boolean(),
  }),
  z.object({
    kind: z.literal("validation-failure"),
    error: z.string(),
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readStagedProviderOutcome(
  path: string,
  ctx: PlanningContext,
  reaction: Extract<FactoryReaction, { kind: "invoke" }>,
): { kind: "valid"; outcome: PlannerOutcome } | { kind: "invalid"; message: string } | undefined {
  if (!existsSync(path)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { kind: "invalid", message: `Invalid staged planner outcome: ${error.message}` };
  }
  if (hasConflictingActionIdentity(value, ctx, reaction))
    throw new Error("Staged planner outcome conflicts with action identity");
  const parsed = StagedProviderOutcomeSchema.safeParse(value);
  if (!parsed.success)
    return { kind: "invalid", message: `Invalid staged planner outcome: ${parsed.error.message}` };
  return { kind: "valid", outcome: parsed.data.outcome };
}

function hasConflictingActionIdentity(
  value: unknown,
  ctx: PlanningContext,
  reaction: Extract<FactoryReaction, { kind: "invoke" }>,
): boolean {
  if (!isRecord(value) || !isRecord(value.action)) return false;
  const action = value.action;
  return (
    ("phaseRunId" in action && action.phaseRunId !== ctx.runId) ||
    ("handler" in action && action.handler !== reaction.handler) ||
    ("attempt" in action && action.attempt !== reaction.attempt) ||
    ("causationEventId" in action && action.causationEventId !== reaction.causationEventId)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class CandidateInputValidationError extends Error {}

function captureProviderSuccess(
  ctx: PlanningContext,
  actionDir: string,
  structuredOutput: unknown,
  session: AgentSessionRef | undefined,
): PlannerOutcome {
  let output: FactoryPlanningOutput;
  try {
    output = parseFactoryPlanningOutput(structuredOutput);
  } catch (error) {
    return { kind: "validation-failure", error: errorMessage(error) };
  }
  if (output.outcome === "needs-human") {
    return {
      kind: "completed",
      output,
      session: normalizeSession(session),
      workspaceUnchanged: true,
    };
  }
  let bytes: Buffer;
  try {
    bytes = ctx.readPlannerDraft();
  } catch (error) {
    return { kind: "validation-failure", error: errorMessage(error) };
  }
  const candidatePath = join(actionDir, "candidate.md");
  // Immutable candidate publication must precede the outcome that references it.
  writeDurableFactoryFile(candidatePath, bytes.toString("utf8"), true);
  let candidate: FactoryArtifactRef;
  try {
    candidate = ref(ctx, candidatePath);
  } catch (error) {
    return { kind: "validation-failure", error: errorMessage(error) };
  }
  return {
    kind: "completed",
    output,
    session: normalizeSession(session),
    workspaceUnchanged: true,
    candidate,
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
  output: FactoryPlanningOutput,
  session: AgentSessionRef | undefined,
  candidate: FactoryArtifactRef | undefined,
  retainedCandidateEventId?: string,
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
      retainedCandidateEventId,
    );
  if (!candidate)
    return buildFailure(
      ctx,
      reaction,
      actionDir,
      "Staged planner candidate is missing",
      "terminal",
      retainedCandidateEventId,
    );
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
  result: Extract<PlannerOutcome, { kind: "provider-failure" }>,
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
  return (
    typeof status.before === "string" &&
    typeof status.after === "string" &&
    status.before === status.after
  );
}

function buildFailure(
  ctx: PlanningContext,
  reaction: Extract<FactoryReaction, { kind: "invoke" }>,
  actionDir: string,
  message: string,
  failureKind: "retryable" | "human-required" | "terminal",
  retainedCandidateEventId?: string,
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
      ...(retainedCandidateEventId ? { retainedCandidateEventId } : {}),
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

function revisionContext(
  ctx: PlanningContext,
  root: string,
  reaction: Extract<FactoryReaction, { kind: "invoke" }>,
):
  | {
      path: string;
      session: AgentSessionRef;
      operatorResponse: string;
      blocking: unknown[];
      candidateEventId: string;
    }
  | undefined {
  const events = readFactoryActionEvents(root, deriveFactoryWorkItemKey(ctx.workItem));
  const continuation = loadFactoryContinuationForReaction({
    events,
    causationEventId: reaction.causationEventId,
    phase: "planning",
    handler: "producePlanCandidate",
    attempt: reaction.attempt,
    phaseRunId: ctx.runId,
    workItemKey: deriveFactoryWorkItemKey(ctx.workItem),
    roots: { "factory-store": ctx.factoryStore.projectRoot, repository: ctx.workspace },
  });
  if (!continuation) {
    if (reaction.attempt === 1) return undefined;
    throw new Error("Planning revision has no accepted continuation");
  }
  if (
    continuation.event.data.decision !== "revise" ||
    continuation.candidate.type !== "planning.candidate.produced"
  )
    throw new Error("Planning revision continuation is invalid");
  const event = continuation.candidate;
  const session = event.data.effectiveSession;
  if (session.provider !== "cursor" && session.provider !== "codex")
    throw new Error("Planning candidate has an invalid provider session");
  try {
    let blocking: unknown[] = [];
    if (continuation.review) {
      if (continuation.review.type !== "planning.review.completed")
        throw new Error("Planning continuation review has the wrong phase");
      if (
        continuation.review.data.candidateEventId !== event.id ||
        continuation.review.data.candidateAttempt !== event.data.attempt
      )
        throw new Error("Planning continuation review conflicts with its candidate");
      if (continuation.review.data.blockingFindings)
        blocking = JSON.parse(
          readFileSync(
            verifyFactoryArtifactRef(continuation.review.data.blockingFindings, {
              "factory-store": ctx.factoryStore.projectRoot,
              repository: ctx.workspace,
            }),
            "utf8",
          ),
        );
    }
    return {
      path: verifyFactoryArtifactRef(event.data.candidate, {
        "factory-store": ctx.factoryStore.projectRoot,
        repository: ctx.workspace,
      }),
      session: { provider: session.provider, id: session.id },
      operatorResponse: continuation.response,
      blocking,
      candidateEventId: event.id,
    };
  } catch (error) {
    throw new CandidateInputValidationError(errorMessage(error));
  }
}
