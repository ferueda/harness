import type { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { formatFactoryActionOutput, withManualCommand } from "./factory-action-output.ts";
import { createFactoryArtifactRef } from "../lib/factory-artifact-ref.ts";
import {
  appendFactoryActionEvent,
  readFactoryActionEvents,
} from "../lib/factory-lifecycle-kernel.ts";
import type { FactoryLifecycleEvent } from "../lib/factory-lifecycle-events.ts";
import { readFactoryPhaseRunIdentity } from "../lib/factory-phase-run.ts";
import { producePlanCandidate } from "../lib/factory-plan-candidate-action.ts";
import { reviewPlanCandidate } from "../lib/factory-plan-review-action.ts";
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
  type FactoryReaction,
} from "../lib/factory-state-machine.ts";
import {
  loadFactoryConfigSnapshot,
  resolveFactoryLinearSettingsFromSnapshot,
  resolveFactoryPlanningSettingsFromSnapshot,
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
  for (const [name, description, merged] of [
    ["publish", "Record the reviewed plan pull request", false],
    ["mark-plan-merged", "Record the reviewed plan merge", true],
  ] as const) {
    const command = planning
      .command(name)
      .description(description)
      .requiredOption("--linear-issue <issue>")
      .requiredOption("--url <url>")
      .option("--apply", "apply Linear projection", false)
      .option("--workspace <path>", "target repo")
      .option("--factory-store-root <path>", "durable factory store root")
      .option("--factory-store-project-id <id>", "durable factory store project id");
    (merged
      ? command.requiredOption("--commit <sha>")
      : command.requiredOption("--plan <path>")
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
    lifecycleReadMode: "none",
    factoryStateRoot: store.factoryStateRoot,
  });
  const events = readFactoryActionEvents(
    store.factoryStateRoot,
    deriveFactoryWorkItemKey(resolved.workItem),
  );
  const state = reduceFactoryLifecycleEvents(events);
  if (options.linearIssue)
    assertLivePlanningStatus(
      resolved.workItem,
      linearSettings!,
      options.rerun,
      state,
      events.at(-1),
    );
  const result = await runOneFactoryPlanningAction({
    factoryStateRoot: store.factoryStateRoot,
    factoryStore,
    workspace,
    workItem: resolved.workItem,
    itemFile: options.itemFile,
    linearIssue: options.linearIssue,
    outputPlan: options.outputPlan,
    rerun: options.rerun,
    reviewCeiling: resolveFactoryPlanningSettingsFromSnapshot(snapshot).maxReviewIterations,
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
    repairStartProjection:
      options.apply &&
      state?.phase === "planning" &&
      state.status === "awaiting-candidate" &&
      events.at(-1)?.type === "planning.requested" &&
      resolved.workItem.metadata?.linearStatus !== linearSettings?.statuses.planning,
  });
  console.log(JSON.stringify(formatFactoryActionOutput({ phase: "planning", ...result }), null, 2));
}

function assertLivePlanningStatus(
  workItem: FactoryWorkItem,
  settings: FactoryLinearSettings,
  rerun: boolean,
  state: ReturnType<typeof reduceFactoryLifecycleEvents>,
  latest: FactoryLifecycleEvent | undefined,
): void {
  const status = workItem.metadata?.linearStatus;
  const pendingStartRepair =
    state?.phase === "planning" &&
    state.status === "awaiting-candidate" &&
    state.attempt === 1 &&
    latest?.type === "planning.requested";
  const allowed =
    state?.phase === "planning" && !rerun
      ? pendingStartRepair
        ? [
            settings.statuses.planning,
            settings.statuses.needsPlan,
            settings.statuses.needsInfo,
            settings.statuses.needsPlanReview,
            settings.statuses.planningFailed,
          ]
        : [settings.statuses.planning]
      : [
          settings.statuses.needsPlan,
          settings.statuses.needsInfo,
          settings.statuses.needsPlanReview,
          settings.statuses.planningFailed,
        ];
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
  rerun: boolean;
  reviewCeiling: number;
  plannerRole: FactoryRoleAgent;
  reviewerRole: FactoryRoleAgent;
  maxRuntimeMs: number;
  issueRef?: string;
  applyAdapter?: LinearFactoryAdapter;
  factoryStoreRoot?: string;
  factoryStoreProjectId?: string;
  repairStartProjection?: boolean;
}) {
  const key = deriveFactoryWorkItemKey(input.workItem);
  let events = readFactoryActionEvents(input.factoryStateRoot, key);
  let latest = events.at(-1);
  let state = reduceFactoryLifecycleEvents(events);
  let reaction = latest && state ? decideNextFactoryAction(state, latest) : undefined;
  const active = reaction?.kind === "invoke" && reaction.phase === "planning";
  if (!active) {
    if (state?.phase === "planning" && !input.rerun)
      return { phaseRunId: state.phaseRunId, next: reaction!, linearApplied: false };
    if (
      input.rerun &&
      !(
        state?.phase === "planning" &&
        (state.status === "needs-human" || state.status === "failed")
      )
    )
      throw new Error("planning --rerun is allowed only from needs-human or failed");
    const created = createFactoryPlanningRunContext({
      workspace: input.workspace,
      runsDir: join(input.factoryStore.projectRoot, "runs/factory"),
      workItem: input.workItem,
      plannerRole: input.plannerRole,
      reviewerRole: input.reviewerRole,
      outputPlan: input.outputPlan,
      publicationMode: input.linearIssue ? "pull-request" : "local",
      maxReviewIterations: input.reviewCeiling,
      maxRuntimeMs: input.maxRuntimeMs,
      agentProviderFactory: createAgentProvider,
      factoryStore: input.factoryStore,
    });
    if (!state) {
      const imported: FactoryLifecycleEvent = {
        version: 1,
        id: `work_item.imported:${key}`,
        type: "work_item.imported",
        workItemKey: key,
        occurredAt: new Date().toISOString(),
        data: { source: input.workItem.source },
      };
      ({ event: latest, state } = appendFactoryActionEvent({
        factoryStateRoot: input.factoryStateRoot,
        event: imported,
        expectedLastEventId: null,
      }));
    }
    const identity = readFactoryPhaseRunIdentity(created.runDir);
    if (identity.phase !== "planning") throw new Error("Created Factory phase is not planning");
    const request: FactoryLifecycleEvent = {
      version: 1,
      id: `planning.requested:${created.runId}`,
      type: "planning.requested",
      workItemKey: key,
      occurredAt: new Date().toISOString(),
      phaseRunId: created.runId,
      data: {
        expectedPredecessor: state!.lastEventId,
        inputRefs: [
          createFactoryArtifactRef({
            base: "factory-store",
            root: input.factoryStore.projectRoot,
            path: relative(
              input.factoryStore.projectRoot,
              join(created.runDir, "context/work-item.json"),
            ),
          }),
        ],
        intent: input.rerun ? "restart" : "start",
        reviewCeiling: identity.reviewCeiling,
        publicationMode: identity.publicationMode,
        outputPlan: identity.outputPlan,
      },
    };
    ({ event: latest, state } = appendFactoryActionEvent({
      factoryStateRoot: input.factoryStateRoot,
      event: request,
      expectedLastEventId: state!.lastEventId,
    }));
    reaction = decideNextFactoryAction(state, latest);
    if (input.applyAdapter)
      await input.applyAdapter.applyPlanningStarted({
        issueRef: input.issueRef!,
        runId: created.runId,
        runDir: created.runDir,
      });
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
  });
  if (input.repairStartProjection && input.applyAdapter)
    await input.applyAdapter.applyPlanningStarted({
      issueRef: input.issueRef!,
      runId: phaseRunId,
      runDir: ctx.runDir,
    });
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
  const handled =
    reaction.handler === "producePlanCandidate"
      ? await producePlanCandidate({
          ctx,
          factoryStateRoot: input.factoryStateRoot,
          reaction,
          maxRuntimeMs: input.maxRuntimeMs,
          agentProviderFactory: createAgentProvider,
        })
      : await reviewPlanCandidate({
          ctx,
          factoryStateRoot: input.factoryStateRoot,
          reaction,
          maxRuntimeMs: input.maxRuntimeMs,
          agentProviderFactory: createAgentProvider,
        });
  return {
    phaseRunId,
    action: { handler: reaction.handler, attempt: reaction.attempt, eventId: handled.event.id },
    next: withManualCommand(
      decideNextFactoryAction(handled.state, handled.event),
      planningCommand(input),
    ),
    linearApplied: false,
  };
}

function planningCommand(input: {
  workspace: string;
  itemFile?: string;
  linearIssue?: string;
  factoryStoreRoot?: string;
  factoryStoreProjectId?: string;
}): string {
  const args = ["harness", "factory", "planning", "run", "--workspace", input.workspace];
  if (input.itemFile) args.push("--item-file", input.itemFile);
  if (input.linearIssue) args.push("--linear-issue", input.linearIssue);
  if (input.factoryStoreRoot) args.push("--factory-store-root", input.factoryStoreRoot);
  if (input.factoryStoreProjectId)
    args.push("--factory-store-project-id", input.factoryStoreProjectId);
  return args.map(shellArg).join(" ");
}

async function recordPlanningPublication(
  options: {
    workspace?: string;
    linearIssue: string;
    url: string;
    plan?: string;
    commit?: string;
    apply?: boolean;
    factoryStoreRoot?: string;
    factoryStoreProjectId?: string;
  },
  kind: "opened" | "merged",
): Promise<void> {
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
  const work = await resolveFactoryWorkItemInput({
    workspace,
    linearIssue: options.linearIssue,
    linearSettings: settings,
    env: process.env,
    linearAdapterFactory: createLinearFactoryAdapter,
    lifecycleReadMode: "none",
    factoryStateRoot: store.factoryStateRoot,
  });
  const key = deriveFactoryWorkItemKey(work.workItem);
  const events = readFactoryActionEvents(store.factoryStateRoot, key);
  const latest = events.at(-1);
  const state = reduceFactoryLifecycleEvents(events);
  const recorded =
    (kind === "opened" && latest?.type === "plan_pr.opened") ||
    (kind === "merged" && latest?.type === "plan_pr.merged");
  if (
    !latest ||
    !state ||
    state.phase !== "planning" ||
    (!recorded && state.status !== "awaiting-plan-merge")
  )
    throw new Error("Planning publication requires an approved pull-request planning candidate");
  const candidate = events.findLast(
    (event) =>
      event.type === "planning.candidate.produced" && event.phaseRunId === state.phaseRunId,
  );
  if (!candidate || candidate.type !== "planning.candidate.produced")
    throw new Error("Planning publication has no reviewed candidate");
  if (kind === "opened") {
    const candidatePath = resolve(
      factoryStoreMetadata(store).projectRoot,
      candidate.data.candidate.path,
    );
    const supplied = resolve(workspace, options.plan!);
    if (!existsSync(supplied) || !readFileSync(supplied).equals(readFileSync(candidatePath)))
      throw new Error("Published plan does not match the reviewed immutable candidate");
  }
  const event: FactoryLifecycleEvent =
    kind === "opened"
      ? {
          version: 1,
          id: `plan_pr.opened:${state.phaseRunId}`,
          type: "plan_pr.opened",
          workItemKey: key,
          occurredAt: new Date().toISOString(),
          phaseRunId: state.phaseRunId,
          data: { url: options.url, plan: candidate.data.candidate },
        }
      : {
          version: 1,
          id: `plan_pr.merged:${state.phaseRunId}`,
          type: "plan_pr.merged",
          workItemKey: key,
          occurredAt: new Date().toISOString(),
          phaseRunId: state.phaseRunId,
          data: { url: options.url, commit: options.commit! },
        };
  if (recorded && (latest.type !== event.type || latest.data.url !== event.data.url))
    throw new Error("Planning publication retry conflicts with durable lifecycle truth");
  const appended = recorded
    ? { event: latest, state }
    : appendFactoryActionEvent({
        factoryStateRoot: store.factoryStateRoot,
        event,
        expectedLastEventId: latest.id,
      });
  console.log(
    JSON.stringify(
      formatFactoryActionOutput({
        phase: "planning",
        phaseRunId: state.phaseRunId,
        next: decideNextFactoryAction(appended.state, appended.event),
        linearApplied: false,
      }),
      null,
      2,
    ),
  );
}

function shellArg(value: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}
