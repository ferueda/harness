import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { formatFactoryActionOutput } from "./factory-action-output.ts";
import { decorateFactoryReaction } from "./factory-manual-command.ts";
import { verifyFactoryArtifactRef } from "../lib/factory-artifact-ref.ts";
import {
  readFactoryContinuationResponseFile,
  observeFactoryContinuation,
  recordFactoryContinuation,
  type FactoryContinuationDecision,
} from "../lib/factory-continuation.ts";
import {
  markPlanPullRequestMerged,
  publishPlanPullRequest,
} from "../lib/factory-plan-publication.ts";
import { readFactoryActionEvents } from "../lib/factory-lifecycle-kernel.ts";
import type { FactoryLifecycleEvent } from "../lib/factory-lifecycle-events.ts";
import {
  appendPreparedFactoryPhaseRequest,
  prepareFactoryPhaseRequest,
} from "../lib/factory-phase-request.ts";
import { createFactoryOperationRef, executeFactoryOperation } from "../lib/factory-operation.ts";
import {
  createFactoryPlanningRunContext,
  openFactoryPlanningRunContext,
} from "../lib/factory-planning-run-context.ts";
import { deriveFactoryWorkItemKey } from "../lib/factory-lifecycle.ts";
import {
  createLinearFactoryAdapter,
  type LinearFactoryAdapter,
} from "../lib/factory-linear-adapter.ts";
import {
  resolveFactoryWorkItemInput,
  validateFactoryWorkItemInput,
} from "../lib/factory-triage-input.ts";
import type { FactoryWorkItem } from "../lib/factory-schemas.ts";
import {
  decideNextFactoryAction,
  reduceFactoryLifecycleEvents,
} from "../lib/factory-state-machine.ts";
import {
  loadFactoryConfigSnapshot,
  resolveFactoryLinearSettingsFromSnapshot,
  resolveFactoryRoleAgentFromSnapshot,
  resolveHarnessWorkspace,
  type FactoryLinearSettings,
  type FactoryRoleAgent,
} from "../lib/config.ts";
import {
  factoryStoreMetadata,
  resolveFactoryStore,
  type FactoryStoreMeta,
} from "../lib/factory-store.ts";
import { createAgentProvider } from "../providers/registry.ts";
import type { WorkflowEventSink } from "../lib/workflow-events.ts";
import type { Agent, AgentProviderOptions } from "../lib/agents.ts";

type PlanningOptions = {
  workspace?: string;
  itemFile?: string;
  linearIssue?: string;
  outputPlan?: string;
  maxRuntimeMs: number;
  apply: boolean;
  rerun: boolean;
  verbose: boolean;
  factoryStoreRoot?: string;
  factoryStoreProjectId?: string;
};

export function addFactoryPlanningStationCommand(
  parent: Command,
  defaultMaxRuntimeMs: number,
): void {
  const planning = parent.command("planning").description("Manage factory planning station");
  planning
    .command("run", { isDefault: true })
    .description("Run exactly one pending planning action")
    .option("--workspace <path>", "target repo")
    .option("--item-file <path>", "factory work item JSON file")
    .option("--linear-issue <issue>", "Linear issue identifier")
    .option("--output-plan <path>", "plan path under dev/plans")
    .option("--max-runtime-ms <ms>", "action timeout", Number, defaultMaxRuntimeMs)
    .option("--factory-store-root <path>", "durable factory store root")
    .option("--factory-store-project-id <id>", "durable factory store project id")
    .option("--apply", "apply Linear boundary projections", false)
    .option("--rerun", "restart planning after human/failed state", false)
    .option("--verbose", "emit workflow events as JSONL to stderr", false)
    .action(runPlanningCommand);
  planning
    .command("continue")
    .description("Record an explicit planning candidate continuation")
    .option("--workspace <path>", "target repo")
    .option("--item-file <path>", "factory work item JSON file")
    .option("--linear-issue <issue>", "Linear issue identifier")
    .requiredOption("--decision <decision>", "continuation decision: revise or re-review")
    .requiredOption("--response-file <path>", "absolute operator response file")
    .option("--factory-store-root <path>", "durable factory store root")
    .option("--factory-store-project-id <id>", "durable factory store project id")
    .action(runPlanningContinuationCommand);
  for (const [name, description, merged] of [
    ["publish", "Publish the reviewed plan pull request", false],
    ["mark-plan-merged", "Record the reviewed plan merge", true],
  ] as const) {
    const command = planning
      .command(name)
      .description(description)
      .requiredOption("--linear-issue <issue>")
      .option("--apply", "apply Linear projection", false)
      .option("--workspace <path>", "target repo")
      .option("--factory-store-root <path>", "durable factory store root")
      .option("--factory-store-project-id <id>", "durable factory store project id");
    (merged
      ? command.requiredOption("--url <url>").requiredOption("--commit <sha>")
      : command
    ).action((options) => recordPlanningPublication(options, merged ? "merged" : "opened"));
  }
}

async function runPlanningCommand(options: PlanningOptions): Promise<void> {
  validateFactoryWorkItemInput({ itemFile: options.itemFile, linearIssue: options.linearIssue });
  if (options.apply && !options.linearIssue) throw new Error("--apply requires --linear-issue");
  const workspace = resolveHarnessWorkspace(options.workspace, process.cwd());
  const snapshot = loadFactoryConfigSnapshot(workspace);
  const linearSettings = options.linearIssue
    ? resolveFactoryLinearSettingsFromSnapshot(snapshot)
    : undefined;
  const store = resolveFactoryStore({
    workspace,
    factoryStoreRoot: options.factoryStoreRoot,
    factoryStoreProjectId: options.factoryStoreProjectId,
    env: process.env,
    configSnapshot: snapshot,
  });
  const factoryStore = factoryStoreMetadata(store);
  const resolved = await resolveFactoryWorkItemInput({
    workspace,
    itemFile: options.itemFile,
    linearIssue: options.linearIssue,
    linearSettings,
    env: process.env,
    linearAdapterFactory: options.linearIssue ? createLinearFactoryAdapter : undefined,
  });
  const events = readFactoryActionEvents(
    store.factoryStateRoot,
    deriveFactoryWorkItemKey(resolved.workItem),
  );
  const state = reduceFactoryLifecycleEvents(events);
  const latest = events.at(-1);
  const pendingStartProjection = isPendingPlanningStartProjection(state, latest);
  if (
    options.linearIssue &&
    !options.apply &&
    (options.rerun || !state || state.phase !== "planning" || pendingStartProjection)
  )
    throw new Error("Linear planning start and --rerun require --apply");
  if (options.linearIssue)
    assertLivePlanningStatus(resolved.workItem, linearSettings!, options.rerun, state, latest);
  const runAbort = new AbortController();
  const onRunAbort = () => runAbort.abort();
  process.once("SIGINT", onRunAbort);
  process.once("SIGTERM", onRunAbort);
  try {
    const result = await runOneFactoryPlanningAction({
      factoryStateRoot: store.factoryStateRoot,
      factoryStore,
      workspace,
      workItem: resolved.workItem,
      itemFile: options.itemFile,
      linearIssue: options.linearIssue,
      outputPlan: options.outputPlan,
      baseRef: snapshot.config.base ?? "main",
      rerun: options.rerun,
      plannerRole: resolveFactoryRoleAgentFromSnapshot(snapshot, {
        station: "planning",
        role: "planner",
      }),
      reviewerRole: resolveFactoryRoleAgentFromSnapshot(snapshot, {
        station: "planning",
        role: "reviewer",
      }),
      maxRuntimeMs: options.maxRuntimeMs,
      issueRef: options.linearIssue,
      applyAdapter: options.apply
        ? createLinearFactoryAdapter({
            apiKey: process.env.LINEAR_API_KEY ?? "",
            settings: linearSettings!,
          })
        : undefined,
      factoryStoreRoot: options.factoryStoreRoot,
      factoryStoreProjectId: options.factoryStoreProjectId,
      eventSink: options.verbose ? (event) => console.error(JSON.stringify(event)) : undefined,
      signal: runAbort.signal,
    });
    console.log(
      JSON.stringify(formatFactoryActionOutput({ phase: "planning", ...result }), null, 2),
    );
  } finally {
    process.off("SIGINT", onRunAbort);
    process.off("SIGTERM", onRunAbort);
  }
}

async function runPlanningContinuationCommand(options: {
  workspace?: string;
  itemFile?: string;
  linearIssue?: string;
  decision: string;
  responseFile: string;
  factoryStoreRoot?: string;
  factoryStoreProjectId?: string;
}): Promise<void> {
  validateFactoryWorkItemInput({ itemFile: options.itemFile, linearIssue: options.linearIssue });
  const workspace = resolveHarnessWorkspace(options.workspace, process.cwd());
  const snapshot = loadFactoryConfigSnapshot(workspace);
  const linearSettings = options.linearIssue
    ? resolveFactoryLinearSettingsFromSnapshot(snapshot)
    : undefined;
  const store = resolveFactoryStore({
    workspace,
    factoryStoreRoot: options.factoryStoreRoot,
    factoryStoreProjectId: options.factoryStoreProjectId,
    env: process.env,
    configSnapshot: snapshot,
  });
  const resolved = await resolveFactoryWorkItemInput({
    workspace,
    itemFile: options.itemFile,
    linearIssue: options.linearIssue,
    linearSettings,
    env: process.env,
    linearAdapterFactory: options.linearIssue ? createLinearFactoryAdapter : undefined,
  });
  const events = readFactoryActionEvents(
    store.factoryStateRoot,
    deriveFactoryWorkItemKey(resolved.workItem),
  );
  if (options.linearIssue)
    assertLivePlanningStatus(
      resolved.workItem,
      linearSettings!,
      false,
      reduceFactoryLifecycleEvents(events),
      events.at(-1),
    );
  const result = recordFactoryContinuation({
    phase: "planning",
    decision: options.decision as FactoryContinuationDecision,
    response: readFactoryContinuationResponseFile(options.responseFile),
    factoryStateRoot: store.factoryStateRoot,
    factoryStore: factoryStoreMetadata(store),
    workItemKey: deriveFactoryWorkItemKey(resolved.workItem),
    observed: observeFactoryContinuation(events, "planning"),
  });
  console.log(
    JSON.stringify(
      formatFactoryActionOutput({
        phase: "planning",
        phaseRunId: result.phaseRunId,
        next: decorateFactoryReaction(
          result.next,
          planningCommandProvenance({
            workspace,
            itemFile: options.itemFile,
            linearIssue: options.linearIssue,
            factoryStoreRoot: options.factoryStoreRoot,
            factoryStoreProjectId: options.factoryStoreProjectId,
          }),
        )!,
        linearApplied: false,
      }),
      null,
      2,
    ),
  );
}

export function assertLivePlanningStatus(
  workItem: FactoryWorkItem,
  settings: FactoryLinearSettings,
  rerun: boolean,
  state: ReturnType<typeof reduceFactoryLifecycleEvents>,
  latest: FactoryLifecycleEvent | undefined,
): void {
  const status = workItem.metadata?.linearStatus;
  const pendingStartProjection = isPendingPlanningStartProjection(state, latest);
  const active = Boolean(
    state &&
    latest &&
    state.phase === "planning" &&
    decideNextFactoryAction(state, latest).kind === "invoke",
  );
  const readyToPlan =
    state?.phase === "triage" && state.status === "routed" && state.route === "ready-to-plan";
  const entryStatuses = [
    settings.statuses.needsPlan,
    settings.statuses.needsInfo,
    settings.statuses.needsPlanReview,
    settings.statuses.planningFailed,
    ...(readyToPlan ? [settings.statuses.planning] : []),
  ];
  const allowed = pendingStartProjection
    ? [...entryStatuses, settings.statuses.planning]
    : active
      ? [settings.statuses.planning]
      : !state || state.phase !== "planning" || rerun
        ? entryStatuses
        : state.status === "failed"
          ? [settings.statuses.planning, settings.statuses.planningFailed]
          : state.status === "needs-human"
            ? [
                settings.statuses.planning,
                settings.statuses.needsInfo,
                settings.statuses.needsPlanReview,
              ]
            : [settings.statuses.planning, settings.statuses.needsPlanReview];
  if (
    typeof status !== "string" ||
    !allowed.some((value) => value.toLowerCase() === status.toLowerCase())
  )
    throw new Error(
      `Linear issue status ${String(status ?? "unknown")} is not valid for Factory planning`,
    );
}

export async function runOneFactoryPlanningAction(input: {
  factoryStateRoot: string;
  factoryStore: FactoryStoreMeta;
  workspace: string;
  workItem: FactoryWorkItem;
  itemFile?: string;
  linearIssue?: string;
  outputPlan?: string;
  baseRef?: string;
  rerun: boolean;
  plannerRole: FactoryRoleAgent;
  reviewerRole: FactoryRoleAgent;
  maxRuntimeMs: number;
  issueRef?: string;
  applyAdapter?: LinearFactoryAdapter;
  factoryStoreRoot?: string;
  factoryStoreProjectId?: string;
  eventSink?: WorkflowEventSink;
  agentProviderFactory?: (options: AgentProviderOptions) => Agent;
  signal?: AbortSignal;
}) {
  const agentProviderFactory = input.agentProviderFactory ?? createAgentProvider;
  let linearApplied = false;
  const key = deriveFactoryWorkItemKey(input.workItem);
  let events = readFactoryActionEvents(input.factoryStateRoot, key);
  let latest = events.at(-1);
  let state = reduceFactoryLifecycleEvents(events);
  let reaction = latest && state ? decideNextFactoryAction(state, latest) : undefined;
  const pendingRestartProjection =
    isPendingPlanningStartProjection(state, latest) &&
    latest?.type === "planning.requested" &&
    latest.data.intent === "restart";
  let prepared = input.rerun
    ? prepareFactoryPhaseRequest({
        projectId: input.factoryStore.projectId,
        workItem: input.workItem,
        phase: "planning",
        intent: "restart",
        expectedPredecessor:
          pendingRestartProjection && latest?.type === "planning.requested"
            ? latest.data.expectedPredecessor
            : (latest?.id ?? null),
        factoryStore: input.factoryStore,
      })
    : undefined;
  const active = reaction?.kind === "invoke" && reaction.phase === "planning";
  if (!active) {
    if (state?.phase === "planning" && !input.rerun) {
      const terminalStatus = terminalPlanningProjectionStatus(state.status, latest);
      if (input.applyAdapter && terminalStatus) {
        await applyTerminalPlanningProjection({
          adapter: input.applyAdapter,
          issueRef: input.issueRef!,
          runId: state.phaseRunId,
          runDir: join(input.factoryStore.projectRoot, "runs/factory", state.phaseRunId),
          status: terminalStatus,
          latest,
          factoryStoreRoot: input.factoryStore.projectRoot,
          workspace: input.workspace,
        });
        linearApplied = true;
      }
      return {
        phaseRunId: state.phaseRunId,
        next: decorateFactoryReaction(reaction!, planningCommandProvenance(input))!,
        linearApplied,
      };
    }
    if (input.linearIssue && !input.applyAdapter)
      throw new Error("Linear planning start and --rerun require --apply");
    prepared ??= prepareFactoryPhaseRequest({
      projectId: input.factoryStore.projectId,
      workItem: input.workItem,
      phase: "planning",
      intent: "start",
      expectedPredecessor: latest?.id ?? null,
      factoryStore: input.factoryStore,
    });
    const created = createFactoryPlanningRunContext({
      workspace: input.workspace,
      runsDir: join(input.factoryStore.projectRoot, "runs/factory"),
      workItem: input.workItem,
      plannerRole: input.plannerRole,
      reviewerRole: input.reviewerRole,
      outputPlan: input.outputPlan,
      publicationMode: input.linearIssue ? "pull-request" : "local",
      baseRef: input.baseRef ?? "main",
      maxRuntimeMs: input.maxRuntimeMs,
      agentProviderFactory,
      factoryStore: input.factoryStore,
      eventSink: input.eventSink,
      signal: input.signal,
    });
    const appended = appendPreparedFactoryPhaseRequest({
      prepared,
      phaseRunId: created.runId,
    });
    latest = appended.event;
    state = appended.state;
    reaction = appended.next;
  }
  if (!reaction || reaction.kind !== "invoke" || reaction.phase !== "planning")
    throw new Error("Factory planning has no invokable action");
  const phaseRunId = latest!.phaseRunId!;
  const ctx = openFactoryPlanningRunContext({
    workspace: input.workspace,
    runsDir: join(input.factoryStore.projectRoot, "runs/factory"),
    phaseRunId,
    workItem: input.workItem,
    factoryStore: input.factoryStore,
    eventSink: input.eventSink,
  });
  if (input.linearIssue && isPendingPlanningStartProjection(state, latest)) {
    if (!input.applyAdapter)
      throw new Error("Pending Linear planning start projection requires --apply");
    await input.applyAdapter.applyPlanningStarted({
      issueRef: input.issueRef ?? input.linearIssue,
      runId: phaseRunId,
      runDir: ctx.runDir,
    });
    linearApplied = true;
  }
  console.error(
    JSON.stringify({
      harnessFactory: "action-started",
      phase: "planning",
      phaseRunId,
      runDir: ctx.runDir,
      handler: reaction.handler,
      attempt: reaction.attempt,
    }),
  );
  const handled = await executeFactoryOperation({
    operation: createFactoryOperationRef({
      phaseRunId,
      handler: reaction.handler,
      attempt: reaction.attempt,
      causationEventId: reaction.causationEventId,
    }),
    factoryStore: input.factoryStore,
    workspace: input.workspace,
    workItem: input.workItem,
    maxRuntimeMs: input.maxRuntimeMs,
    signal: input.signal,
    eventSink: input.eventSink,
    agentProviderFactory,
  });
  const terminalStatus = terminalPlanningProjectionStatus(handled.state.status, handled.event);
  if (input.applyAdapter && terminalStatus) {
    await applyTerminalPlanningProjection({
      adapter: input.applyAdapter,
      issueRef: input.issueRef!,
      runId: phaseRunId,
      runDir: ctx.runDir,
      status: terminalStatus,
      latest: handled.event,
      factoryStoreRoot: input.factoryStore.projectRoot,
      workspace: input.workspace,
    });
    linearApplied = true;
  }
  return {
    phaseRunId,
    action: { handler: reaction.handler, attempt: reaction.attempt, eventId: handled.event.id },
    next: decorateFactoryReaction(
      decideNextFactoryAction(handled.state, handled.event),
      planningCommandProvenance(input),
    )!,
    linearApplied,
  };
}

type TerminalPlanningProjectionStatus = "needs-human" | "awaiting-continuation" | "failed";

function terminalPlanningProjectionStatus(
  status: string,
  latest: FactoryLifecycleEvent | undefined,
): TerminalPlanningProjectionStatus | undefined {
  if (status === "needs-human" || status === "failed") return status;
  if (
    status === "awaiting-continuation" &&
    latest?.type === "factory.action.failed" &&
    latest.data.failureKind === "human-required"
  )
    return status;
  return undefined;
}

function isPendingPlanningStartProjection(
  state: ReturnType<typeof reduceFactoryLifecycleEvents>,
  latest: FactoryLifecycleEvent | undefined,
): boolean {
  return (
    state?.phase === "planning" &&
    state.status === "awaiting-candidate" &&
    state.candidateAttempt === 0 &&
    latest?.type === "planning.requested"
  );
}

async function applyTerminalPlanningProjection(input: {
  adapter: LinearFactoryAdapter;
  issueRef: string;
  runId: string;
  runDir: string;
  status: TerminalPlanningProjectionStatus;
  latest: FactoryLifecycleEvent | undefined;
  factoryStoreRoot: string;
  workspace: string;
}): Promise<void> {
  if (input.status === "failed") {
    await input.adapter.applyPlanningFailed({
      issueRef: input.issueRef,
      runId: input.runId,
      runDir: input.runDir,
      error: "Factory planning action failed; inspect durable action evidence.",
    });
    return;
  }
  await input.adapter.applyPlanningCompleted({
    issueRef: input.issueRef,
    runId: input.runId,
    runDir: input.runDir,
    status:
      input.latest?.type === "planning.input.required"
        ? "plan-needs-human"
        : "plan-review-unresolved",
    ...(input.latest?.type === "planning.input.required"
      ? {
          humanQuestions: readAuthenticatedPlanningQuestions(input.latest, {
            "factory-store": input.factoryStoreRoot,
            repository: input.workspace,
          }),
        }
      : {}),
    ...(input.latest?.type === "factory.action.failed" ? { error: input.latest.data.message } : {}),
  });
}

const PlanningQuestionsSchema = z.array(z.string().min(1)).min(1);

function readAuthenticatedPlanningQuestions(
  event: Extract<FactoryLifecycleEvent, { type: "planning.input.required" }>,
  roots: { "factory-store": string; repository: string },
): string[] {
  if (event.data.questions.base !== "factory-store")
    throw new Error("Planning questions artifact must be stored in the Factory store");
  const path = verifyFactoryArtifactRef(event.data.questions, roots);
  return PlanningQuestionsSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

function planningCommandProvenance(input: {
  workspace: string;
  itemFile?: string;
  linearIssue?: string;
  issueRef?: string;
  factoryStoreRoot?: string;
  factoryStoreProjectId?: string;
}) {
  return {
    workspace: input.workspace,
    ...(input.itemFile ? { itemFile: input.itemFile } : {}),
    ...((input.linearIssue ?? input.issueRef)
      ? { linearIssue: input.linearIssue ?? input.issueRef }
      : {}),
    ...(input.factoryStoreRoot ? { factoryStoreRoot: input.factoryStoreRoot } : {}),
    ...(input.factoryStoreProjectId ? { factoryStoreProjectId: input.factoryStoreProjectId } : {}),
  };
}

export async function recordPlanningPublication(
  options: {
    workspace?: string;
    linearIssue: string;
    url?: string;
    commit?: string;
    apply?: boolean;
    factoryStoreRoot?: string;
    factoryStoreProjectId?: string;
  },
  kind: "opened" | "merged",
  deps: {
    linearAdapterFactory?: typeof createLinearFactoryAdapter;
    resolveWorkItemInput?: typeof resolveFactoryWorkItemInput;
  } = {},
): Promise<void> {
  const linearAdapterFactory = deps.linearAdapterFactory ?? createLinearFactoryAdapter;
  const resolveWorkItemInput = deps.resolveWorkItemInput ?? resolveFactoryWorkItemInput;
  const workspace = resolveHarnessWorkspace(options.workspace, process.cwd());
  const snapshot = loadFactoryConfigSnapshot(workspace);
  const settings = resolveFactoryLinearSettingsFromSnapshot(snapshot);
  const store = resolveFactoryStore({
    workspace,
    factoryStoreRoot: options.factoryStoreRoot,
    factoryStoreProjectId: options.factoryStoreProjectId,
    env: process.env,
    configSnapshot: snapshot,
  });
  const work = await resolveWorkItemInput({
    workspace,
    linearIssue: options.linearIssue,
    linearSettings: settings,
    env: process.env,
    linearAdapterFactory,
  });
  const factoryStore = factoryStoreMetadata(store);
  const adapter = options.apply
    ? linearAdapterFactory({ apiKey: process.env.LINEAR_API_KEY ?? "", settings })
    : undefined;
  const result =
    kind === "opened"
      ? await publishPlanPullRequest({
          workspace,
          factoryStateRoot: store.factoryStateRoot,
          factoryStore,
          workItem: work.workItem,
          issueRef: options.linearIssue,
          ...(adapter ? { applyAdapter: adapter } : {}),
        })
      : await markPlanPullRequestMerged({
          workspace,
          factoryStateRoot: store.factoryStateRoot,
          factoryStore,
          workItem: work.workItem,
          issueRef: options.linearIssue,
          url: options.url!,
          commit: options.commit!,
          ...(adapter ? { applyAdapter: adapter } : {}),
        });
  console.log(
    JSON.stringify(
      formatFactoryActionOutput({
        phase: "planning",
        phaseRunId: result.phaseRunId,
        next: decorateFactoryReaction(decideNextFactoryAction(result.state, result.event), {
          workspace,
          linearIssue: options.linearIssue,
          ...(options.factoryStoreRoot ? { factoryStoreRoot: options.factoryStoreRoot } : {}),
          ...(options.factoryStoreProjectId
            ? { factoryStoreProjectId: options.factoryStoreProjectId }
            : {}),
        })!,
        linearApplied: result.linearApplied,
      }),
      null,
      2,
    ),
  );
}
