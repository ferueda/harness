import type { Command } from "commander";
import { join } from "node:path";
import { formatFactoryActionOutput } from "./factory-action-output.ts";
import { decorateFactoryReaction } from "./factory-manual-command.ts";
import type { Agent, AgentProviderOptions } from "../lib/agents.ts";
import {
  loadFactoryConfigSnapshot,
  resolveFactoryLinearSettingsFromSnapshot,
  resolveFactoryRoleAgentFromSnapshot,
  resolveHarnessWorkspace,
  type FactoryRoleAgent,
} from "../lib/config.ts";
import {
  createFactoryOperationRef,
  executeFactoryOperation,
  type ExecuteFactoryOperationInput,
} from "../lib/factory-operation.ts";
import {
  readFactoryContinuationResponseFile,
  observeFactoryContinuation,
  recordFactoryContinuation,
  type FactoryContinuationDecision,
} from "../lib/factory-continuation.ts";
import { resolveFactoryImplementationInput } from "../lib/factory-implementation-input.ts";
import {
  markImplementationPullRequestMerged,
  publishImplementationPullRequest,
} from "../lib/factory-implementation-publication.ts";
import {
  createFactoryImplementationRunContext,
  openFactoryImplementationRunContext,
} from "../lib/factory-implementation-run-context.ts";
import { readFactoryActionEvents } from "../lib/factory-lifecycle-kernel.ts";
import type { FactoryLifecycleEvent } from "../lib/factory-lifecycle-events.ts";
import {
  createLinearFactoryAdapter,
  type LinearFactoryAdapter,
} from "../lib/factory-linear-adapter.ts";
import { deriveFactoryWorkItemKey } from "../lib/factory-lifecycle.ts";
import {
  appendPreparedFactoryPhaseRequest,
  prepareFactoryPhaseRequest,
} from "../lib/factory-phase-request.ts";
import type { FactoryWorkItem } from "../lib/factory-schemas.ts";
import {
  decideNextFactoryAction,
  reduceFactoryLifecycleEvents,
} from "../lib/factory-state-machine.ts";
import {
  factoryStoreMetadata,
  resolveFactoryStore,
  type FactoryStoreMeta,
} from "../lib/factory-store.ts";
import {
  resolveFactoryWorkItemInput,
  validateFactoryWorkItemInput,
} from "../lib/factory-triage-input.ts";
import type { WorkflowEventSink } from "../lib/workflow-events.ts";
import { createAgentProvider } from "../providers/registry.ts";

const REVIEW_DEFAULT_MS = 30 * 60 * 1000;

type Options = {
  workspace?: string;
  itemFile?: string;
  linearIssue?: string;
  maxRuntimeMs?: number;
  apply: boolean;
  rerun: boolean;
  verbose: boolean;
  factoryStoreRoot?: string;
  factoryStoreProjectId?: string;
};

export function addFactoryImplementationStationCommand(
  parent: Command,
  positiveNumber: (value: string) => number,
): void {
  const implementation = parent
    .command("implementation")
    .description("Manage factory implementation station");
  implementation
    .command("run", { isDefault: true })
    .description("Run exactly one pending implementation action")
    .option("--workspace <path>", "target repo")
    .option("--item-file <path>", "factory work item JSON file")
    .option("--linear-issue <issue>", "Linear issue identifier")
    .option("--max-runtime-ms <ms>", "current action timeout", positiveNumber)
    .option("--factory-store-root <path>", "durable factory store root")
    .option("--factory-store-project-id <id>", "durable factory store project id")
    .option("--apply", "apply Linear boundary projections", false)
    .option("--rerun", "restart after human/failed state without a reusable candidate", false)
    .option("--verbose", "emit workflow events as JSONL to stderr", false)
    .action(runImplementationCommand);
  implementation
    .command("continue")
    .description("Record an explicit implementation candidate continuation")
    .option("--workspace <path>", "target repo")
    .option("--item-file <path>", "factory work item JSON file")
    .option("--linear-issue <issue>", "Linear issue identifier")
    .requiredOption("--decision <decision>", "continuation decision: revise or re-review")
    .requiredOption("--response-file <path>", "absolute operator response file")
    .option("--factory-store-root <path>", "durable factory store root")
    .option("--factory-store-project-id <id>", "durable factory store project id")
    .action(runImplementationContinuationCommand);
  implementation
    .command("publish")
    .description("Publish the reviewed implementation pull request")
    .option("--workspace <path>", "target repo")
    .option("--item-file <path>", "factory work item JSON file")
    .option("--linear-issue <issue>", "Linear issue identifier")
    .option("--factory-store-root <path>", "durable factory store root")
    .option("--factory-store-project-id <id>", "durable factory store project id")
    .option("--apply", "apply Linear projection", false)
    .action((options) => runImplementationPublicationCommand(options, "opened"));
  implementation
    .command("mark-pr-merged")
    .description("Record the human-merged implementation pull request")
    .option("--workspace <path>", "target repo")
    .option("--item-file <path>", "factory work item JSON file")
    .option("--linear-issue <issue>", "Linear issue identifier")
    .requiredOption("--url <url>", "recorded pull request URL")
    .requiredOption("--commit <sha>", "local merge commit")
    .option("--factory-store-root <path>", "durable factory store root")
    .option("--factory-store-project-id <id>", "durable factory store project id")
    .option("--apply", "apply Linear projection", false)
    .action((options) => runImplementationPublicationCommand(options, "merged"));
}

export async function runImplementationPublicationCommand(
  options: Options & { url?: string; commit?: string },
  kind: "opened" | "merged",
): Promise<void> {
  validateFactoryWorkItemInput({ itemFile: options.itemFile, linearIssue: options.linearIssue });
  if (options.apply && !options.linearIssue) throw new Error("--apply requires --linear-issue");
  const workspace = resolveHarnessWorkspace(options.workspace, process.cwd());
  const snapshot = loadFactoryConfigSnapshot(workspace);
  const settings = options.linearIssue
    ? resolveFactoryLinearSettingsFromSnapshot(snapshot)
    : undefined;
  const store = resolveFactoryStore({
    workspace,
    factoryStoreRoot: options.factoryStoreRoot,
    factoryStoreProjectId: options.factoryStoreProjectId,
    env: process.env,
    configSnapshot: snapshot,
  });
  const work = await resolveFactoryWorkItemInput({
    workspace,
    itemFile: options.itemFile,
    linearIssue: options.linearIssue,
    linearSettings: settings,
    env: process.env,
    linearAdapterFactory: options.linearIssue ? createLinearFactoryAdapter : undefined,
  });
  const adapter = options.apply
    ? createLinearFactoryAdapter({ apiKey: process.env.LINEAR_API_KEY ?? "", settings: settings! })
    : undefined;
  const common = {
    workspace,
    factoryStateRoot: store.factoryStateRoot,
    factoryStore: factoryStoreMetadata(store),
    workItem: work.workItem,
    ...(options.linearIssue ? { issueRef: options.linearIssue } : {}),
    ...(adapter ? { applyAdapter: adapter } : {}),
  };
  const result =
    kind === "opened"
      ? await publishImplementationPullRequest(common)
      : await markImplementationPullRequestMerged({
          ...common,
          url: options.url!,
          commit: options.commit!,
        });
  console.log(
    JSON.stringify(
      formatFactoryActionOutput({
        phase: "implementation",
        phaseRunId: result.phaseRunId,
        next: decorateFactoryReaction(
          decideNextFactoryAction(result.state, result.event),
          result.state,
          implementationCommandProvenance({
            workspace,
            itemFile: options.itemFile,
            linearIssue: options.linearIssue,
            factoryStoreRoot: options.factoryStoreRoot,
            factoryStoreProjectId: options.factoryStoreProjectId,
          }),
        )!,
        linearApplied: result.linearApplied,
      }),
      null,
      2,
    ),
  );
}

async function runImplementationCommand(options: Options): Promise<void> {
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
  const resolved = await resolveFactoryWorkItemInput({
    workspace,
    itemFile: options.itemFile,
    linearIssue: options.linearIssue,
    linearSettings,
    env: process.env,
    linearAdapterFactory: options.linearIssue ? createLinearFactoryAdapter : undefined,
  });
  const adapter = options.apply
    ? createLinearFactoryAdapter({
        apiKey: process.env.LINEAR_API_KEY ?? "",
        settings: linearSettings!,
      })
    : undefined;
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const result = await runOneFactoryImplementationAction({
      factoryStateRoot: store.factoryStateRoot,
      factoryStore: factoryStoreMetadata(store),
      workspace,
      workItem: resolved.workItem,
      itemFile: options.itemFile,
      linearIssue: options.linearIssue,
      rerun: options.rerun,
      explicitMaxRuntimeMs: options.maxRuntimeMs,
      implementerRole: resolveFactoryRoleAgentFromSnapshot(snapshot, {
        station: "implementation",
        role: "implementer",
      }),
      reviewerRole: resolveFactoryRoleAgentFromSnapshot(snapshot, {
        station: "implementation",
        role: "reviewer",
      }),
      baseRef: snapshot.config.base ?? "main",
      applyAdapter: adapter,
      linearStatuses: linearSettings?.statuses,
      issueRef: options.linearIssue,
      factoryStoreRoot: options.factoryStoreRoot,
      factoryStoreProjectId: options.factoryStoreProjectId,
      eventSink: options.verbose ? (event) => console.error(JSON.stringify(event)) : undefined,
      signal: controller.signal,
    });
    console.log(
      JSON.stringify(formatFactoryActionOutput({ phase: "implementation", ...result }), null, 2),
    );
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}

async function runImplementationContinuationCommand(options: {
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
    assertLiveImplementationStatus(
      resolved.workItem,
      reduceFactoryLifecycleEvents(events),
      events.at(-1),
      false,
      linearSettings!.statuses,
    );
  const result = recordFactoryContinuation({
    phase: "implementation",
    decision: options.decision as FactoryContinuationDecision,
    response: readFactoryContinuationResponseFile(options.responseFile),
    factoryStateRoot: store.factoryStateRoot,
    factoryStore: factoryStoreMetadata(store),
    workItemKey: deriveFactoryWorkItemKey(resolved.workItem),
    observed: observeFactoryContinuation(events, "implementation"),
  });
  console.log(
    JSON.stringify(
      formatFactoryActionOutput({
        phase: "implementation",
        phaseRunId: result.phaseRunId,
        next: decorateFactoryReaction(
          result.next,
          result.state,
          implementationCommandProvenance({
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

export async function runOneFactoryImplementationAction(input: {
  factoryStateRoot: string;
  factoryStore: FactoryStoreMeta;
  workspace: string;
  workItem: FactoryWorkItem;
  itemFile?: string;
  linearIssue?: string;
  rerun: boolean;
  explicitMaxRuntimeMs?: number;
  implementerRole: FactoryRoleAgent;
  reviewerRole: FactoryRoleAgent;
  baseRef?: string;
  applyAdapter?: LinearFactoryAdapter;
  linearStatuses?: {
    readyToImplement: string;
    implementing: string;
    readyForReview: string;
    done: string;
    implementationFailed: string;
  };
  issueRef?: string;
  factoryStoreRoot?: string;
  factoryStoreProjectId?: string;
  eventSink?: WorkflowEventSink;
  signal?: AbortSignal;
  agentProviderFactory?: (options: AgentProviderOptions) => Agent;
  reviewRunner?: ExecuteFactoryOperationInput["implementationReviewRunner"];
}) {
  const key = deriveFactoryWorkItemKey(input.workItem);
  let events = readFactoryActionEvents(input.factoryStateRoot, key);
  let state = reduceFactoryLifecycleEvents(events);
  let latest = events.at(-1);
  let reaction = state && latest ? decideNextFactoryAction(state, latest) : undefined;
  if (input.linearIssue) {
    if (!input.linearStatuses) throw new Error("Linear implementation statuses are unavailable");
    assertLiveImplementationStatus(
      input.workItem,
      state,
      latest,
      input.rerun,
      input.linearStatuses,
    );
  }
  const pendingRequestEvent =
    state?.phase === "implementation" &&
    state.status === "awaiting-candidate" &&
    latest?.type === "implementation.requested"
      ? latest
      : undefined;
  let prepared = input.rerun
    ? prepareFactoryPhaseRequest({
        projectId: input.factoryStore.projectId,
        workItem: input.workItem,
        phase: "implementation",
        intent: "restart",
        expectedPredecessor: pendingRequestEvent
          ? pendingRequestEvent.data.expectedPredecessor
          : (latest?.id ?? null),
        factoryStore: input.factoryStore,
      })
    : undefined;
  const active = reaction?.kind === "invoke" && reaction.phase === "implementation";
  if (!active) {
    if (state?.phase === "implementation" && !input.rerun) {
      let linearApplied = false;
      if (input.applyAdapter) {
        linearApplied = await repairTerminalProjection({
          adapter: input.applyAdapter,
          issueRef: input.issueRef!,
          state,
          latest,
          runDir: join(input.factoryStore.projectRoot, "runs/factory", state.phaseRunId),
          events,
        });
      }
      return {
        phaseRunId: state.phaseRunId,
        next: decorateFactoryReaction(reaction!, state, implementationCommandProvenance(input))!,
        linearApplied,
      };
    }
    if (input.linearIssue && !input.applyAdapter)
      throw new Error("Linear implementation start and --rerun require --apply");
    prepared ??= prepareFactoryPhaseRequest({
      projectId: input.factoryStore.projectId,
      workItem: input.workItem,
      phase: "implementation",
      intent: "start",
      expectedPredecessor: latest?.id ?? null,
      factoryStore: input.factoryStore,
    });
    const implementationInput = resolveFactoryImplementationInput(events);
    const created = createFactoryImplementationRunContext({
      workspace: input.workspace,
      runsDir: join(input.factoryStore.projectRoot, "runs/factory"),
      workItem: input.workItem,
      factoryStore: input.factoryStore,
      implementationInput,
      baseRef: input.baseRef ?? "main",
      implementerRole: input.implementerRole,
      reviewerRole: input.reviewerRole,
      eventSink: input.eventSink,
    });
    const appended = appendPreparedFactoryPhaseRequest({
      prepared,
      phaseRunId: created.runId,
    });
    latest = appended.event;
    state = appended.state;
    reaction = appended.next;
  }
  if (!reaction || reaction.kind !== "invoke" || reaction.phase !== "implementation")
    throw new Error("Factory implementation has no invokable action");
  const phaseRunId = latest!.phaseRunId!;
  const ctx = openFactoryImplementationRunContext({
    workspace: input.workspace,
    runsDir: join(input.factoryStore.projectRoot, "runs/factory"),
    phaseRunId,
    workItem: input.workItem,
    factoryStore: input.factoryStore,
    eventSink: input.eventSink,
  });
  let linearApplied = false;
  // Repair the causative attention projection before either selected continuation action.
  if (
    input.applyAdapter &&
    latest?.type === "factory.continuation.recorded" &&
    latest.data.phase === "implementation"
  ) {
    if (latest.data.reviewEventId) {
      const review = events.find(
        (
          event,
        ): event is Extract<FactoryLifecycleEvent, { type: "implementation.review.completed" }> =>
          event.id === latest.data.reviewEventId &&
          event.type === "implementation.review.completed",
      );
      if (!review) throw new Error("Implementation continuation review is unavailable");
      if (review.data.verdict === "pass")
        throw new Error("Implementation continuation cannot follow a passing review");
      await input.applyAdapter.applyImplementationAttention({
        issueRef: input.issueRef!,
        runId: phaseRunId,
        runDir: ctx.runDir,
        verdict: review.data.verdict,
        candidateCommit: readReviewCandidateCommit(events, review),
      });
      linearApplied = true;
    } else {
      const predecessor = events.find((event) => event.id === latest.data.expectedPredecessor);
      if (
        predecessor?.type === "factory.action.failed" &&
        predecessor.data.retainedCandidateEventId
      ) {
        await input.applyAdapter.applyImplementationAttention({
          issueRef: input.issueRef!,
          runId: phaseRunId,
          runDir: ctx.runDir,
          verdict: "human_required",
          message: predecessor.data.message,
          ...optionalCandidateCommit(events, phaseRunId),
        });
        linearApplied = true;
      }
    }
  }
  if (input.linearIssue && pendingImplementationStart(state, latest)) {
    if (!input.applyAdapter)
      throw new Error("Pending Linear implementation start requires --apply");
    await input.applyAdapter.applyImplementationStarted({
      issueRef: input.issueRef ?? input.linearIssue,
      runId: phaseRunId,
      runDir: ctx.runDir,
      intent: latest.type === "implementation.requested" ? latest.data.intent : "start",
    });
    linearApplied = true;
  }
  console.error(
    JSON.stringify({
      harnessFactory: "action-started",
      phase: "implementation",
      phaseRunId,
      runDir: ctx.runDir,
      handler: reaction.handler,
      attempt: reaction.attempt,
    }),
  );
  const maxRuntimeMs =
    input.explicitMaxRuntimeMs ??
    (reaction.handler === "produceImplementationCandidate" ? 0 : REVIEW_DEFAULT_MS);
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
    maxRuntimeMs,
    signal: input.signal,
    eventSink: input.eventSink,
    agentProviderFactory: input.agentProviderFactory ?? createAgentProvider,
    implementationReviewRunner: input.reviewRunner,
  });
  if (
    input.applyAdapter &&
    handled.event.type === "implementation.review.completed" &&
    handled.event.data.verdict !== "pass"
  ) {
    await input.applyAdapter.applyImplementationAttention({
      issueRef: input.issueRef!,
      runId: phaseRunId,
      runDir: ctx.runDir,
      verdict: handled.event.data.verdict,
      candidateCommit: readReviewCandidateCommit(eventsFor(input, key), handled.event),
    });
    linearApplied = true;
  } else if (
    input.applyAdapter &&
    handled.event.type === "factory.action.failed" &&
    (handled.event.data.failureKind === "human-required" ||
      handled.event.data.retainedCandidateEventId !== undefined)
  ) {
    await input.applyAdapter.applyImplementationAttention({
      issueRef: input.issueRef!,
      runId: phaseRunId,
      runDir: ctx.runDir,
      verdict: "human_required",
      message: handled.event.data.message,
      ...optionalCandidateCommit(eventsFor(input, key), phaseRunId),
    });
    linearApplied = true;
  } else if (
    input.applyAdapter &&
    handled.event.type === "factory.action.failed" &&
    handled.event.data.failureKind === "terminal"
  ) {
    await input.applyAdapter.applyImplementationFailed({
      issueRef: input.issueRef!,
      runId: phaseRunId,
      runDir: ctx.runDir,
      error: handled.event.data.message,
    });
    linearApplied = true;
  }
  return {
    phaseRunId,
    action: { handler: reaction.handler, attempt: reaction.attempt, eventId: handled.event.id },
    next: decorateFactoryReaction(
      decideNextFactoryAction(handled.state, handled.event),
      handled.state,
      implementationCommandProvenance(input),
    )!,
    linearApplied,
  };
}

async function repairTerminalProjection(input: {
  adapter: LinearFactoryAdapter;
  issueRef: string;
  state: Extract<
    NonNullable<ReturnType<typeof reduceFactoryLifecycleEvents>>,
    { phase: "implementation" }
  >;
  latest: FactoryLifecycleEvent | undefined;
  runDir: string;
  events: FactoryLifecycleEvent[];
}): Promise<boolean> {
  if (
    input.state.status === "needs-human" &&
    input.latest?.type === "factory.action.failed" &&
    input.latest.data.failureKind === "human-required"
  ) {
    await input.adapter.applyImplementationAttention({
      issueRef: input.issueRef,
      runId: input.state.phaseRunId,
      runDir: input.runDir,
      verdict: "human_required",
      message: input.latest.data.message,
      ...optionalCandidateCommit(input.events, input.state.phaseRunId),
    });
    return true;
  }
  if (
    input.state.status === "awaiting-continuation" &&
    input.latest?.type === "implementation.review.completed" &&
    input.latest.data.verdict !== "pass"
  ) {
    const candidateCommit = readReviewCandidateCommit(input.events, input.latest);
    await input.adapter.applyImplementationAttention({
      issueRef: input.issueRef,
      runId: input.state.phaseRunId,
      runDir: input.runDir,
      verdict: input.latest.data.verdict,
      candidateCommit,
    });
    return true;
  }
  if (
    input.state.status === "awaiting-continuation" &&
    input.latest?.type === "factory.action.failed" &&
    input.latest.data.retainedCandidateEventId
  ) {
    await input.adapter.applyImplementationAttention({
      issueRef: input.issueRef,
      runId: input.state.phaseRunId,
      runDir: input.runDir,
      verdict: "human_required",
      message: input.latest.data.message,
      ...optionalCandidateCommit(input.events, input.state.phaseRunId),
    });
    return true;
  }
  if (input.state.status === "failed") {
    await input.adapter.applyImplementationFailed({
      issueRef: input.issueRef,
      runId: input.state.phaseRunId,
      runDir: input.runDir,
      error: "Factory implementation action failed; inspect durable action evidence.",
    });
    return true;
  }
  return false;
}

export function assertLiveImplementationStatus(
  workItem: FactoryWorkItem,
  state: ReturnType<typeof reduceFactoryLifecycleEvents>,
  latest: FactoryLifecycleEvent | undefined,
  rerun: boolean,
  statuses: {
    readyToImplement: string;
    implementing: string;
    readyForReview: string;
    done: string;
    implementationFailed: string;
  },
): void {
  const status = workItem.metadata?.linearStatus;
  const pending = latest?.type === "implementation.requested" && state?.phase === "implementation";
  const allowed = pending
    ? latest.data.intent === "restart"
      ? [statuses.implementationFailed, statuses.implementing]
      : [statuses.readyToImplement, statuses.implementing]
    : state?.phase === "implementation" && !rerun
      ? state.status === "failed"
        ? [statuses.implementing, statuses.implementationFailed]
        : state.status === "awaiting-pr-merge"
          ? [statuses.readyForReview]
          : state.status === "complete"
            ? [statuses.done]
            : [statuses.implementing]
      : rerun
        ? [statuses.implementationFailed, statuses.implementing]
        : [statuses.readyToImplement];
  if (
    typeof status !== "string" ||
    !allowed.some((candidate) => candidate.toLowerCase() === status.toLowerCase())
  )
    throw new Error(
      `Linear issue status ${String(status ?? "unknown")} is not valid for Factory implementation`,
    );
}

function pendingImplementationStart(
  state: ReturnType<typeof reduceFactoryLifecycleEvents>,
  latest: FactoryLifecycleEvent | undefined,
): latest is Extract<FactoryLifecycleEvent, { type: "implementation.requested" }> {
  return (
    state?.phase === "implementation" &&
    state.status === "awaiting-candidate" &&
    state.candidateAttempt === 0 &&
    latest?.type === "implementation.requested"
  );
}

function eventsFor(input: { factoryStateRoot: string }, key: string) {
  return readFactoryActionEvents(input.factoryStateRoot, key);
}

function readReviewCandidateCommit(
  events: FactoryLifecycleEvent[],
  review: Extract<FactoryLifecycleEvent, { type: "implementation.review.completed" }>,
): string {
  const candidate = events.find((event) => event.id === review.data.candidateEventId);
  if (
    !candidate ||
    candidate.type !== "implementation.candidate.produced" ||
    candidate.phaseRunId !== review.phaseRunId ||
    candidate.workItemKey !== review.workItemKey ||
    candidate.data.attempt !== review.data.candidateAttempt
  )
    throw new Error("Implementation review has no matching candidate commit");
  return candidate.data.commit;
}

function optionalCandidateCommit(events: FactoryLifecycleEvent[], phaseRunId: string) {
  const candidate = events.findLast(
    (event) =>
      event.type === "implementation.candidate.produced" && event.phaseRunId === phaseRunId,
  );
  return candidate?.type === "implementation.candidate.produced"
    ? { candidateCommit: candidate.data.commit }
    : {};
}

function implementationCommandProvenance(input: {
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
