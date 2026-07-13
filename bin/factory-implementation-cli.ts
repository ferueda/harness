import type { Command } from "commander";
import { join } from "node:path";
import { formatFactoryActionOutput, withManualCommand } from "./factory-action-output.ts";
import type { Agent, AgentProviderOptions } from "../lib/agents.ts";
import {
  loadFactoryConfigSnapshot,
  resolveFactoryLinearSettingsFromSnapshot,
  resolveFactoryRoleAgentFromSnapshot,
  resolveHarnessWorkspace,
  type FactoryRoleAgent,
} from "../lib/config.ts";
import { produceImplementationCandidate } from "../lib/factory-implementation-candidate-action.ts";
import { resolveFactoryImplementationInput } from "../lib/factory-implementation-input.ts";
import { reviewImplementationCandidate } from "../lib/factory-implementation-review-action.ts";
import {
  createFactoryImplementationRunContext,
  openFactoryImplementationRunContext,
} from "../lib/factory-implementation-run-context.ts";
import {
  appendFactoryActionEvent,
  readFactoryActionEvents,
} from "../lib/factory-lifecycle-kernel.ts";
import type { FactoryLifecycleEvent } from "../lib/factory-lifecycle-events.ts";
import {
  createLinearFactoryAdapter,
  type LinearFactoryAdapter,
} from "../lib/factory-linear-adapter.ts";
import { deriveFactoryWorkItemKey } from "../lib/factory-lifecycle.ts";
import { readFactoryPhaseRunIdentity } from "../lib/factory-phase-run.ts";
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
  parent
    .command("implementation")
    .description("Manage factory implementation station")
    .command("run", { isDefault: true })
    .description("Run exactly one pending implementation action")
    .option("--workspace <path>", "target repo")
    .option("--item-file <path>", "factory work item JSON file")
    .option("--linear-issue <issue>", "Linear issue identifier")
    .option("--max-runtime-ms <ms>", "current action timeout", positiveNumber)
    .option("--factory-store-root <path>", "durable factory store root")
    .option("--factory-store-project-id <id>", "durable factory store project id")
    .option("--apply", "apply Linear boundary projections", false)
    .option("--rerun", "restart after human/failed state", false)
    .option("--verbose", "emit workflow events as JSONL to stderr", false)
    .action(runImplementationCommand);
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
    lifecycleReadMode: "none",
    factoryStateRoot: store.factoryStateRoot,
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
  applyAdapter?: LinearFactoryAdapter;
  linearStatuses?: {
    readyToImplement: string;
    implementing: string;
    implementationFailed: string;
  };
  issueRef?: string;
  factoryStoreRoot?: string;
  factoryStoreProjectId?: string;
  eventSink?: WorkflowEventSink;
  signal?: AbortSignal;
  agentProviderFactory?: (options: AgentProviderOptions) => Agent;
  reviewRunner?: Parameters<typeof reviewImplementationCandidate>[0]["reviewRunner"];
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
  const pendingRequest =
    state?.phase === "implementation" &&
    state.status === "awaiting-candidate" &&
    latest?.type === "implementation.requested";
  if (
    input.rerun &&
    !pendingRequest &&
    !(
      state?.phase === "implementation" &&
      (state.status === "needs-human" || state.status === "failed")
    )
  )
    throw new Error("implementation --rerun is allowed only from needs-human or failed");
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
      return { phaseRunId: state.phaseRunId, next: reaction!, linearApplied };
    }
    if (input.linearIssue && !input.applyAdapter)
      throw new Error("Linear implementation start and --rerun require --apply");
    const implementationInput = resolveFactoryImplementationInput(events);
    const created = createFactoryImplementationRunContext({
      workspace: input.workspace,
      runsDir: join(input.factoryStore.projectRoot, "runs/factory"),
      workItem: input.workItem,
      factoryStore: input.factoryStore,
      implementationInput,
      implementerRole: input.implementerRole,
      reviewerRole: input.reviewerRole,
      eventSink: input.eventSink,
    });
    const identity = readFactoryPhaseRunIdentity(created.runDir);
    if (identity.phase !== "implementation") throw new Error("Created phase is not implementation");
    const request: FactoryLifecycleEvent = {
      version: 1,
      id: `implementation.requested:${created.runId}`,
      type: "implementation.requested",
      workItemKey: key,
      occurredAt: new Date().toISOString(),
      phaseRunId: created.runId,
      data: {
        expectedPredecessor: state?.lastEventId ?? null,
        inputRefs: implementationInputRefs(identity.input),
        reviewCeiling: 1,
        intent: input.rerun ? "restart" : "start",
      },
    };
    ({ event: latest, state } = appendFactoryActionEvent({
      factoryStateRoot: input.factoryStateRoot,
      event: request,
      expectedLastEventId: state?.lastEventId ?? null,
    }));
    reaction = decideNextFactoryAction(state, latest);
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
  const handled =
    reaction.handler === "produceImplementationCandidate"
      ? await produceImplementationCandidate({
          ctx,
          factoryStateRoot: input.factoryStateRoot,
          reaction,
          maxRuntimeMs,
          signal: input.signal,
          agentProviderFactory: input.agentProviderFactory ?? createAgentProvider,
        })
      : await reviewImplementationCandidate({
          ctx,
          factoryStateRoot: input.factoryStateRoot,
          reaction,
          maxRuntimeMs,
          signal: input.signal,
          agentProviderFactory: input.agentProviderFactory ?? createAgentProvider,
          reviewRunner: input.reviewRunner,
        });
  if (
    input.applyAdapter &&
    handled.event.type === "implementation.review.completed" &&
    handled.event.data.verdict === "pass"
  ) {
    await input.applyAdapter.applyImplementationCompleted({
      issueRef: input.issueRef!,
      runId: phaseRunId,
      runDir: ctx.runDir,
      reviewBase: ctx.identity.baseSha,
      reviewHead: `refs/harness/factory/${phaseRunId}/${handled.event.data.attempt}`,
      reviewCommitSha: readCandidateCommit(eventsFor(input, key), phaseRunId),
    });
    linearApplied = true;
  } else if (
    input.applyAdapter &&
    handled.event.type === "implementation.review.completed" &&
    handled.event.data.verdict !== "pass"
  ) {
    await input.applyAdapter.applyImplementationAttention({
      issueRef: input.issueRef!,
      runId: phaseRunId,
      runDir: ctx.runDir,
      verdict: handled.event.data.verdict,
      candidateCommit: readCandidateCommit(eventsFor(input, key), phaseRunId),
    });
    linearApplied = true;
  } else if (
    input.applyAdapter &&
    handled.event.type === "factory.action.failed" &&
    handled.event.data.failureKind === "human-required"
  ) {
    await input.applyAdapter.applyImplementationAttention({
      issueRef: input.issueRef!,
      runId: phaseRunId,
      runDir: ctx.runDir,
      verdict: "human_required",
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
    next: withManualCommand(
      decideNextFactoryAction(handled.state, handled.event),
      implementationCommand(input),
    ),
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
    input.state.status === "complete" &&
    input.latest?.type === "implementation.review.completed"
  ) {
    const candidateCommit = readCandidateCommit(input.events, input.state.phaseRunId);
    const identity = readFactoryPhaseRunIdentity(input.runDir);
    if (identity.phase !== "implementation")
      throw new Error("Implementation phase identity missing");
    await input.adapter.applyImplementationCompleted({
      issueRef: input.issueRef,
      runId: input.state.phaseRunId,
      runDir: input.runDir,
      reviewBase: identity.baseSha,
      reviewHead: `refs/harness/factory/${input.state.phaseRunId}/${input.state.attempt}`,
      reviewCommitSha: candidateCommit,
    });
    return true;
  }
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
      ...optionalCandidateCommit(input.events, input.state.phaseRunId),
    });
    return true;
  }
  if (
    input.state.status === "needs-human" &&
    input.latest?.type === "implementation.review.completed" &&
    input.latest.data.verdict !== "pass"
  ) {
    const candidateCommit = readCandidateCommit(input.events, input.state.phaseRunId);
    await input.adapter.applyImplementationAttention({
      issueRef: input.issueRef,
      runId: input.state.phaseRunId,
      runDir: input.runDir,
      verdict: input.latest.data.verdict,
      candidateCommit,
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
  statuses: { readyToImplement: string; implementing: string; implementationFailed: string },
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
    state.attempt === 1 &&
    latest?.type === "implementation.requested"
  );
}

function implementationInputRefs(
  input: Extract<
    ReturnType<typeof readFactoryPhaseRunIdentity>,
    { phase: "implementation" }
  >["input"],
) {
  return input.mode === "direct"
    ? [input.workItem, input.readiness]
    : [input.workItem, input.planCandidate];
}

function eventsFor(input: { factoryStateRoot: string }, key: string) {
  return readFactoryActionEvents(input.factoryStateRoot, key);
}

function readCandidateCommit(events: FactoryLifecycleEvent[], phaseRunId: string): string {
  const candidate = events.findLast(
    (event) =>
      event.type === "implementation.candidate.produced" && event.phaseRunId === phaseRunId,
  );
  if (!candidate || candidate.type !== "implementation.candidate.produced")
    throw new Error("Implementation review has no candidate commit");
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

function implementationCommand(input: {
  workspace: string;
  itemFile?: string;
  linearIssue?: string;
  factoryStoreRoot?: string;
  factoryStoreProjectId?: string;
  applyAdapter?: LinearFactoryAdapter;
}): string {
  const args = ["harness", "factory", "implementation", "run", "--workspace", input.workspace];
  if (input.itemFile) args.push("--item-file", input.itemFile);
  if (input.linearIssue) args.push("--linear-issue", input.linearIssue);
  if (input.applyAdapter) args.push("--apply");
  if (input.factoryStoreRoot) args.push("--factory-store-root", input.factoryStoreRoot);
  if (input.factoryStoreProjectId)
    args.push("--factory-store-project-id", input.factoryStoreProjectId);
  return args.map(shellArg).join(" ");
}

function shellArg(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
