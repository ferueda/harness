import { InvalidArgumentError, type Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { stdin as processStdin } from "node:process";
import type { Readable } from "node:stream";
import { formatFactoryActionOutput, withManualCommand } from "./factory-action-output.ts";
import { factoryTriageCliOutput } from "./factory-triage-cli.ts";
import {
  assertFactoryPathContained,
  createFactoryArtifactRef,
  isFactoryRelativePathContained,
  verifyFactoryArtifactRef,
} from "../lib/factory-artifact-ref.ts";
import { factoryActionResultPath, readFactoryActionResult } from "../lib/factory-action-result.ts";
import { factoryActionKey } from "../lib/factory-action-contract.ts";
import {
  appendFactoryActionEvent,
  readFactoryActionEvents,
} from "../lib/factory-lifecycle-kernel.ts";
import type { FactoryLifecycleEvent as FactoryActionLifecycleEvent } from "../lib/factory-lifecycle-events.ts";
import { readFactoryPhaseRunIdentity } from "../lib/factory-phase-run.ts";
import { assertFactoryStoreFormat } from "../lib/factory-store-format.ts";
import {
  decideNextFactoryAction,
  reduceFactoryLifecycleEvents,
  type FactoryReaction,
} from "../lib/factory-state-machine.ts";
import { errorMessage } from "../lib/agent-invoke.ts";
import {
  factoryTriageExecutionProfile,
  resolveFactoryLinearSettings,
  resolveFactoryRoleAgent,
  resolveHarnessOptions,
  resolveHarnessWorkspace,
  type FactoryLinearSettings,
} from "../lib/config.ts";
import {
  factoryStoreMetadata,
  resolveFactoryStore,
  type FactoryStoreMeta,
  type FactoryStoreResolution,
} from "../lib/factory-store.ts";
import { factoryStatus } from "../lib/factory-status.ts";
import {
  deriveFactoryWorkItemKey,
  type FactoryLifecycleWarning,
} from "../lib/factory-lifecycle.ts";
import {
  createLinearFactoryAdapter,
  parseLinearFactoryStatusKeys,
  type LinearFactoryAdapter,
  type LinearTriageUpdatePlan,
} from "../lib/factory-linear-adapter.ts";
import type { LinearCreateWorkItemResult } from "../lib/factory-linear-create.ts";
import {
  mergeLifecycleState,
  resolveFactoryWorkItemInput,
  validateFactoryWorkItemInput,
} from "../lib/factory-triage-input.ts";
import {
  assertFactoryItemFileExists,
  createFactoryRunContext,
  openFactoryRunContext,
  type FactoryRunContext,
  type FactoryRunMeta,
} from "../lib/factory-run-context.ts";
import { announceFactoryRunStarted } from "../lib/factory-run-started.ts";
import {
  parseFactoryTriageOutput,
  type FactoryTriageOutput,
  type FactoryWorkItem,
} from "../lib/factory-schemas.ts";
import type { WorkflowEvent } from "../lib/workflow-events.ts";
import { createAgentProvider } from "../providers/registry.ts";
import { run as runFactoryTriage, triageWorkItem } from "../workflows/factory-triage.workflow.ts";

type FactoryStatusOptions = {
  workspace?: string;
  inboxDir?: string;
  factoryStoreRoot?: string;
  factoryStoreProjectId?: string;
};

type FactoryTriageStationOptions = {
  workspace?: string;
  itemFile?: string;
  linearIssue?: string;
  runsDir?: string;
  maxRuntimeMs: number;
  apply: boolean;
  dryRun: boolean;
  verbose: boolean;
  rerun: boolean;
  factoryStoreRoot?: string;
  factoryStoreProjectId?: string;
};

type FactoryLinearFetchOptions = {
  workspace?: string;
  factoryStoreRoot?: string;
  factoryStoreProjectId?: string;
};

type FactoryLinearListOptions = {
  workspace?: string;
  status: string[];
  first: number;
  after?: string;
  all: boolean;
};

type FactoryLinearCreateOptions = {
  workspace?: string;
  title: string;
  body?: string;
  bodyFile?: string;
};

export type FactoryCommandOptions = {
  positiveNumber: (value: string) => number;
  defaultMaxRuntimeMs: number;
  writeVerboseWorkflowEvent: (event: WorkflowEvent) => void;
};

function factoryStoreForRun(
  resolution: FactoryStoreResolution,
  runsDir: string | undefined,
): FactoryStoreMeta {
  const meta = factoryStoreMetadata(resolution);
  return {
    ...meta,
    overrides: {
      ...meta.overrides,
      ...(runsDir ? { runsDir: resolve(runsDir) } : {}),
    },
  };
}

export function addFactoryCommands(parent: Command, options: FactoryCommandOptions): void {
  const factory = parent.command("factory").description("Manage local factory intake");
  addFactoryStatusCommand(factory);
  addFactoryLinearCommand(factory);
  addFactoryTriageStationCommand(factory, options);
  addFactoryPlanningStationCommand(factory);
  addFactoryImplementationStationCommand(factory);
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("must be a positive integer");
  }
  return parsed;
}

function collectValues(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function boundedFirstPageSize(value: string): number {
  const parsed = positiveInteger(value);
  if (parsed > 100) throw new InvalidArgumentError("must be between 1 and 100");
  return parsed;
}

function addFactoryStatusCommand(parent: Command): void {
  parent
    .command("status")
    .description("Inspect factory inbox, durable store, and lifecycle locks")
    .option("--workspace <path>", "target repo")
    .option("--factory-store-root <path>", "durable factory store root")
    .option("--factory-store-project-id <id>", "durable factory store project id")
    .option(
      "--inbox-dir <path>",
      "factory inbox root (default: <workspace>/.harness/inbox/factory)",
    )
    .action((options: FactoryStatusOptions) => {
      const resolvedOptions = resolveHarnessOptions({
        workspace: options.workspace,
      });
      const store = resolveFactoryStore({
        workspace: resolvedOptions.workspace,
        factoryStoreRoot: options.factoryStoreRoot,
        factoryStoreProjectId: options.factoryStoreProjectId,
        env: process.env,
      });
      const result = factoryStatus({
        workspace: resolvedOptions.workspace,
        inboxDir: options.inboxDir,
        store,
      });
      console.log(JSON.stringify(result, null, 2));
    });
}

function addFactoryLinearCommand(parent: Command): void {
  const linear = parent.command("linear").description("Use Linear factory intake helpers");

  linear
    .command("list")
    .description("List Linear issues by configured factory status")
    .option("--workspace <path>", "target repo")
    .option("--status <key>", "factory.linear.statuses key; repeatable", collectValues, [])
    .option("--first <count>", "page size, 1-100 (default: 50)", boundedFirstPageSize, 50)
    .option("--after <cursor>", "Linear pagination cursor")
    .option("--all", "fetch every page", false)
    .action(async (options: FactoryLinearListOptions) => {
      if (options.status.length === 0) {
        throw new Error("--status is required");
      }
      if (options.all && options.after) {
        throw new Error("--all cannot be combined with --after");
      }
      const settings = resolveFactoryLinearSettings({ workspace: options.workspace });
      const apiKey = process.env.LINEAR_API_KEY;
      if (!apiKey) {
        throw new Error("LINEAR_API_KEY is required for Linear commands.");
      }
      const statusKeys = parseLinearFactoryStatusKeys(settings, options.status);
      const adapter = createLinearFactoryAdapter({ apiKey, settings });
      const result = await adapter.listWorkItemsByStatus({
        statusKeys,
        first: options.first,
        after: options.after,
        all: options.all,
      });
      console.log(JSON.stringify(result, null, 2));
    });

  linear
    .command("fetch")
    .description("Fetch one Linear issue and print a factory work item")
    .argument("<issue>", "Linear issue identifier, e.g. TEAM-123")
    .option("--workspace <path>", "target repo")
    .option("--factory-store-root <path>", "durable factory store root")
    .option("--factory-store-project-id <id>", "durable factory store project id")
    .action(async (issue: string, options: FactoryLinearFetchOptions) => {
      const workItem = await fetchFactoryLinearWorkItem({
        issue,
        workspace: options.workspace,
        factoryStoreRoot: options.factoryStoreRoot,
        factoryStoreProjectId: options.factoryStoreProjectId,
        env: process.env,
      });
      console.log(JSON.stringify(workItem, null, 2));
    });

  linear
    .command("create")
    .description("Create one Linear intake issue in the configured factory project")
    .option("--workspace <path>", "target repo")
    .requiredOption("--title <title>", "Linear issue title")
    .option("--body <body>", "Linear issue body")
    .option("--body-file <path>", "Linear issue body markdown file")
    .action(async (options: FactoryLinearCreateOptions) => {
      const result = await createFactoryLinearWorkItem({
        workspace: options.workspace,
        title: options.title,
        body: options.body,
        bodyFile: options.bodyFile,
        env: process.env,
        stdin: processStdin,
      });
      console.log(JSON.stringify(result, null, 2));
    });
}

export type FactoryLinearFetchOutput = FactoryWorkItem & {
  warnings?: FactoryLifecycleWarning[];
};

export async function fetchFactoryLinearWorkItem(input: {
  issue: string;
  workspace?: string;
  factoryStateRoot?: string;
  factoryStoreRoot?: string;
  factoryStoreProjectId?: string;
  env?: NodeJS.ProcessEnv;
  resolveLinearSettings?: (input: { workspace?: string }) => FactoryLinearSettings;
  adapterFactory?: (input: {
    apiKey: string;
    settings: FactoryLinearSettings;
  }) => LinearFactoryAdapter;
}): Promise<FactoryLinearFetchOutput> {
  const settings = (input.resolveLinearSettings ?? resolveFactoryLinearSettings)({
    workspace: input.workspace,
  });
  const apiKey = input.env?.LINEAR_API_KEY;
  if (!apiKey) {
    throw new Error("LINEAR_API_KEY is required for Linear commands.");
  }
  const adapter = (input.adapterFactory ?? createLinearFactoryAdapter)({ apiKey, settings });
  const workspace = resolveHarnessOptions({ workspace: input.workspace }).workspace;
  const factoryStateRoot =
    input.factoryStateRoot ??
    resolveFactoryStore({
      workspace,
      factoryStoreRoot: input.factoryStoreRoot,
      factoryStoreProjectId: input.factoryStoreProjectId,
      env: input.env,
    }).factoryStateRoot;
  const merged = mergeLifecycleState({
    workspace,
    factoryStateRoot,
    workItem: await adapter.fetchWorkItem(input.issue),
    lifecycleReadMode: "none",
  });
  return {
    ...merged.workItem,
    ...(merged.warnings.length > 0 ? { warnings: merged.warnings } : {}),
  };
}

export async function createFactoryLinearWorkItem(input: {
  workspace?: string;
  title: string;
  body?: string;
  bodyFile?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: NodeJS.ReadStream | Readable;
  resolveLinearSettings?: (input: { workspace?: string }) => FactoryLinearSettings;
  adapterFactory?: (input: {
    apiKey: string;
    settings: FactoryLinearSettings;
  }) => LinearFactoryAdapter;
}): Promise<LinearCreateWorkItemResult> {
  const title = input.title.trim();
  if (!title) {
    throw new Error("Linear create title must be non-empty.");
  }
  const body = (
    await resolveFactoryLinearCreateBody({
      workspace: input.workspace,
      body: input.body,
      bodyFile: input.bodyFile,
      stdin: input.stdin ?? processStdin,
    })
  ).trim();
  if (!body) {
    throw new Error("Linear create body must be non-empty.");
  }

  const settings = (input.resolveLinearSettings ?? resolveFactoryLinearSettings)({
    workspace: input.workspace,
  });
  const apiKey = input.env?.LINEAR_API_KEY;
  if (!apiKey) {
    throw new Error("LINEAR_API_KEY is required for Linear commands.");
  }
  const adapter = (input.adapterFactory ?? createLinearFactoryAdapter)({ apiKey, settings });
  return adapter.createWorkItem({ title, body });
}

async function resolveFactoryLinearCreateBody(input: {
  workspace?: string;
  body?: string;
  bodyFile?: string;
  stdin: NodeJS.ReadStream | Readable;
}): Promise<string> {
  const hasBody = input.body !== undefined;
  const hasBodyFile = input.bodyFile !== undefined;
  if (hasBody && hasBodyFile) {
    throw new Error("--body and --body-file are mutually exclusive");
  }
  if (hasBody) {
    return input.body as string;
  }
  if (hasBodyFile) {
    const workspace = resolveHarnessOptions({ workspace: input.workspace }).workspace;
    const bodyFile = input.bodyFile as string;
    const resolvedPath = assertFactoryItemFileExists(workspace, bodyFile);
    return readFileSync(resolvedPath, "utf8");
  }

  const stdin = input.stdin;
  if ("isTTY" in stdin && stdin.isTTY === true) {
    throw new Error("one of --body, --body-file, or stdin is required");
  }
  const fromStdin = await readStreamToString(stdin);
  if (fromStdin.length === 0) {
    throw new Error("one of --body, --body-file, or stdin is required");
  }
  return fromStdin;
}

async function readStreamToString(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function addFactoryPlanningStationCommand(parent: Command): void {
  const planning = parent.command("planning").description("Manage factory planning station");
  addUnavailableFactoryPhaseCommand(planning, "run", "planning", true);
  addUnavailableFactoryPhaseCommand(planning, "publish", "planning publication");
  addUnavailableFactoryPhaseCommand(planning, "mark-plan-merged", "planning publication");
}

function addFactoryImplementationStationCommand(parent: Command): void {
  const implementation = parent
    .command("implementation")
    .description("Manage factory implementation station");
  addUnavailableFactoryPhaseCommand(implementation, "run", "implementation", true);
}

function addUnavailableFactoryPhaseCommand(
  parent: Command,
  name: string,
  label: string,
  isDefault = false,
): void {
  parent
    .command(name, { isDefault })
    .description(`Factory ${label} action shell`)
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => {
      throw new Error(`Factory ${label} is not available until its dedicated action PR ships.`);
    });
}

function addFactoryTriageStationCommand(parent: Command, config: FactoryCommandOptions): void {
  parent
    .command("triage")
    .description("Run one factory work item through the triage station")
    .option("--workspace <path>", "target repo")
    .option("--item-file <path>", "factory work item JSON file")
    .option("--linear-issue <issue>", "Linear issue identifier, e.g. TEAM-123")
    .option(
      "--runs-dir <path>",
      "output root override (default: durable factory store runs/factory)",
    )
    .option("--factory-store-root <path>", "durable factory store root")
    .option("--factory-store-project-id <id>", "durable factory store project id")
    .option(
      "--max-runtime-ms <ms>",
      `triage timeout (default: ${config.defaultMaxRuntimeMs})`,
      config.positiveNumber,
      config.defaultMaxRuntimeMs,
    )
    .option("--apply", "apply deterministic Linear status/comment updates", false)
    .option("--dry-run", "prepare context and placeholder routing only", false)
    .option("--rerun", "intentionally repeat previously completed triage", false)
    .option("--verbose", "emit workflow events as JSONL to stderr", false)
    .action(async (options: FactoryTriageStationOptions) => {
      // Validate source flags before role/config resolution so CLI usage errors win.
      validateFactoryApplyOptions(options);
      validateFactoryWorkItemInput(options);
      const workspace = resolveHarnessWorkspace(options.workspace, process.cwd());
      const linearSettings = options.linearIssue
        ? resolveFactoryLinearSettings({ workspace })
        : undefined;
      const store = resolveFactoryStore({
        workspace,
        factoryStoreRoot: options.factoryStoreRoot,
        factoryStoreProjectId: options.factoryStoreProjectId,
        env: process.env,
      });
      const factoryStore = factoryStoreForRun(store, options.runsDir);
      if (!options.dryRun && options.runsDir) {
        throw new Error(
          "Live Factory triage does not support --runs-dir in the action store; use the durable store run root.",
        );
      }
      let linearAdapter: LinearFactoryAdapter | undefined;
      const linearAdapterFactory = options.linearIssue
        ? (adapterInput: Parameters<typeof createLinearFactoryAdapter>[0]) => {
            linearAdapter ??= createLinearFactoryAdapter(adapterInput);
            return linearAdapter;
          }
        : undefined;
      const input = await resolveFactoryWorkItemInput({
        workspace,
        itemFile: options.itemFile,
        linearIssue: options.linearIssue,
        linearSettings,
        env: process.env,
        linearAdapterFactory,
        lifecycleReadMode: "none",
        factoryStateRoot: store.factoryStateRoot,
      });

      const applyAdapter = options.apply ? requireLinearApplyAdapter(linearAdapter) : undefined;
      const result = await runFactoryTriageWithLinearApply({
        factoryStateRoot: store.factoryStateRoot,
        workspace,
        projectId: store.projectId,
        workItem: input.workItem,
        rerun: options.rerun,
        dryRun: options.dryRun,
        issueRef: options.linearIssue ?? "",
        itemFile: options.itemFile,
        applyAdapter,
        createContext: (signal, existingRunId) => {
          const common = {
            workspace,
            runsDir: options.runsDir ?? store.factoryRunsDir,
            factoryStore,
            workItem: input.workItem,
            maxRuntimeMs: options.maxRuntimeMs,
            dryRun: options.dryRun,
            signal,
            eventSink: options.verbose ? config.writeVerboseWorkflowEvent : undefined,
            agentProviderFactory: createAgentProvider,
          };
          if (existingRunId) {
            return openFactoryRunContext({ ...common, phaseRunId: existingRunId });
          }
          return createFactoryRunContext({
            ...common,
            executionProfile: factoryTriageExecutionProfile(
              resolveFactoryRoleAgent({
                workspace,
                station: "triage",
                role: "triager",
              }),
            ),
          });
        },
      });
      if ("waiting" in result) {
        const next = withManualCommand(result.next, factoryTriageManualCommand(options, workspace));
        const output = formatFactoryActionOutput({
          phase: "triage",
          ...(result.phaseRunId ? { phaseRunId: result.phaseRunId } : {}),
          next,
          linearApplied: input.linearApplied ?? false,
        });
        console.log(JSON.stringify(output, null, 2));
        process.exitCode = output.outcome === "failed" ? 1 : 0;
        return;
      }
      const { meta, startedUpdate, terminalUpdate, terminalApplyError } = result;
      const next = withManualCommand(result.next, factoryTriageManualCommand(options, workspace));
      const actionOutput = formatFactoryActionOutput({
        phase: "triage",
        phaseRunId: result.phaseRunId,
        ...(meta.status === "dry_run" ? {} : { action: result.action }),
        next,
        linearApplied: options.apply ? !terminalApplyError : (input.linearApplied ?? false),
      });
      console.log(
        JSON.stringify(
          {
            ...factoryTriageCliOutput(meta, {
              linearApplied: options.apply ? !terminalApplyError : input.linearApplied,
              ...(options.apply
                ? { linearUpdate: { started: startedUpdate, terminal: terminalUpdate } }
                : {}),
              ...(input.warnings ? { warnings: input.warnings } : {}),
            }),
            ...actionOutput,
          },
          null,
          2,
        ),
      );
      if (terminalApplyError) {
        throw terminalApplyError;
      }
      process.exitCode = meta.status === "failed" ? 1 : 0;
    });
}

function factoryTriageManualCommand(
  options: FactoryTriageStationOptions,
  workspace: string,
): string {
  const args = ["harness", "factory", "triage", "--workspace", workspace];
  if (options.linearIssue) args.push("--linear-issue", options.linearIssue);
  else if (options.itemFile) args.push("--item-file", options.itemFile);
  if (options.apply) args.push("--apply");
  if (options.rerun) args.push("--rerun");
  if (options.factoryStoreRoot) args.push("--factory-store-root", options.factoryStoreRoot);
  if (options.factoryStoreProjectId)
    args.push("--factory-store-project-id", options.factoryStoreProjectId);
  return args.map(shellArg).join(" ");
}

function shellArg(value: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

export async function runFactoryTriageWithLinearApply(input: {
  factoryStateRoot: string;
  workspace?: string;
  projectId?: string;
  workItem: FactoryWorkItem;
  rerun: boolean;
  dryRun?: boolean;
  issueRef: string;
  itemFile?: string;
  applyAdapter?: LinearFactoryAdapter;
  createContext: (signal: AbortSignal, existingRunId?: string) => FactoryRunContext;
  runTriage?: (
    ctx: FactoryRunContext,
    options: { nextLiveRunRequiresRerun: boolean },
  ) => Promise<FactoryRunMeta>;
  announceRunStarted?: (input: Parameters<typeof announceFactoryRunStarted>[0]) => void;
}): Promise<
  | {
      meta: FactoryRunMeta;
      phaseRunId: string;
      action: { handler: "triageWorkItem"; attempt: 1; eventId: string };
      next: FactoryReaction;
      startedUpdate?: LinearTriageUpdatePlan;
      terminalUpdate?: LinearTriageUpdatePlan;
      terminalApplyError?: unknown;
    }
  | {
      waiting: true;
      phaseRunId?: string;
      next: Extract<FactoryReaction, { kind: "wait" }>;
    }
> {
  if (input.dryRun) assertFactoryStoreFormat(input.factoryStateRoot);
  const existingEvents = input.dryRun
    ? []
    : readFactoryActionEvents(input.factoryStateRoot, deriveFactoryWorkItemKey(input.workItem));
  const existingLatest = existingEvents.at(-1);
  const existingState = reduceFactoryLifecycleEvents(existingEvents);
  const existingReaction =
    existingLatest && existingState
      ? decideNextFactoryAction(existingState, existingLatest)
      : undefined;
  const terminalProjectionRecoverable =
    existingLatest?.type === "triage.work_item.completed" ||
    (existingLatest?.type === "factory.action.failed" &&
      existingLatest.data.phase === "triage" &&
      existingLatest.data.failureKind !== "retryable");
  if (
    !input.dryRun &&
    !input.rerun &&
    existingLatest?.type !== "work_item.imported" &&
    existingReaction?.kind === "wait"
  ) {
    // Explicit apply may repair a failed terminal projection from immutable completion evidence.
    if (input.applyAdapter && terminalProjectionRecoverable) {
      const recovered = await recoverTriageActionResult(input);
      if (recovered) return recovered;
    }
    return {
      waiting: true,
      ...(existingLatest?.phaseRunId ? { phaseRunId: existingLatest.phaseRunId } : {}),
      next: existingReaction,
    };
  }
  if (!input.dryRun && !input.rerun) {
    const recovered = await recoverTriageActionResult(input);
    if (recovered) return recovered;
  }
  const activeTriage =
    existingReaction?.kind === "invoke" && existingReaction.phase === "triage"
      ? {
          phaseRunId: "phaseRunId" in existingLatest! ? existingLatest!.phaseRunId : undefined,
          reaction: existingReaction,
        }
      : undefined;
  if (activeTriage && !activeTriage.phaseRunId) {
    throw new Error("Active Factory triage reaction has no phase-run identity");
  }
  const policy = input.dryRun
    ? { hadPriorCompletion: false }
    : assertFactoryActionTriageAllowed(input);
  const announceRunStarted = input.announceRunStarted ?? announceFactoryRunStarted;
  const runTriage = input.runTriage ?? runFactoryTriage;
  const runAbort = new AbortController();
  const onRunAbort = () => runAbort.abort();
  process.once("SIGINT", onRunAbort);
  process.once("SIGTERM", onRunAbort);
  try {
    const ctx = input.createContext(runAbort.signal, activeTriage?.phaseRunId);
    if (!ctx.dryRun && !ctx.factoryStore) {
      throw new Error("Live Factory triage requires durable store metadata");
    }
    if (activeTriage) {
      const identity = readFactoryPhaseRunIdentity(ctx.runDir);
      if (
        identity.phaseRunId !== ctx.runId ||
        identity.phase !== "triage" ||
        identity.workItemKey !== deriveFactoryWorkItemKey(input.workItem) ||
        identity.workspace !== resolve(ctx.workspace) ||
        identity.projectId !== ctx.factoryStore!.projectId ||
        identity.factoryStateRoot !== resolve(input.factoryStateRoot)
      ) {
        throw new Error(`Factory phase-run identity conflicts with ${ctx.runId}`);
      }
      const request = existingEvents.findLast(
        (event): event is Extract<FactoryActionLifecycleEvent, { type: "triage.requested" }> =>
          event.type === "triage.requested" && event.phaseRunId === ctx.runId,
      );
      if (!request || request.data.inputRefs.length === 0) {
        throw new Error(`Factory phase run ${ctx.runId} has no immutable input reference`);
      }
      for (const ref of request.data.inputRefs) {
        verifyFactoryArtifactRef(ref, {
          "factory-store": ctx.factoryStore!.projectRoot,
          repository: ctx.workspace,
        });
      }
    }
    if (ctx.dryRun) {
      announceRunStarted({
        station: "triage",
        runId: ctx.runId,
        runDir: ctx.runDir,
        workspace: ctx.workspace,
      });
    }
    let actionRequest:
      | Extract<FactoryActionLifecycleEvent, { type: "triage.requested" }>
      | undefined;
    let reaction = activeTriage?.reaction;
    if (!ctx.dryRun && !activeTriage) {
      const key = deriveFactoryWorkItemKey(input.workItem);
      const importedEvent: FactoryActionLifecycleEvent = {
        version: 1,
        id: `work_item.imported:${key}`,
        type: "work_item.imported",
        workItemKey: key,
        occurredAt: new Date().toISOString(),
        data: { source: input.workItem.source },
      };
      const importedResult = appendFactoryActionEvent({
        factoryStateRoot: input.factoryStateRoot,
        event: importedEvent,
        expectedLastEventId: null,
      });
      actionRequest = {
        version: 1,
        id: `triage.requested:${ctx.runId}`,
        type: "triage.requested",
        workItemKey: key,
        occurredAt: new Date().toISOString(),
        phaseRunId: ctx.runId,
        data: {
          expectedPredecessor: importedResult.state.lastEventId,
          intent: policy.hadPriorCompletion ? "restart" : "start",
          inputRefs: ctx.factoryStore
            ? [
                createFactoryArtifactRef({
                  base: "factory-store",
                  root: ctx.factoryStore.projectRoot,
                  path: relative(
                    ctx.factoryStore.projectRoot,
                    join(ctx.runDir, "context/work-item.json"),
                  ),
                }),
              ]
            : [],
        },
      };
      const requested = appendFactoryActionEvent({
        factoryStateRoot: input.factoryStateRoot,
        event: actionRequest,
        expectedLastEventId: importedResult.state.lastEventId,
      });
      const requestedReaction = decideNextFactoryAction(requested.state, requested.event);
      if (requestedReaction.kind !== "invoke") {
        throw new Error("New Factory triage request did not produce an action reaction");
      }
      reaction = requestedReaction;
    }
    if (!ctx.dryRun && (!reaction || reaction.kind !== "invoke")) {
      throw new Error("Factory triage has no invokable action");
    }
    let startedUpdate: LinearTriageUpdatePlan | undefined;
    if (!ctx.dryRun && reaction?.kind === "invoke") {
      console.error(
        JSON.stringify({
          harnessFactory: "action-started",
          phase: "triage",
          phaseRunId: ctx.runId,
          runDir: ctx.runDir,
          handler: reaction.handler,
          attempt: reaction.attempt,
        }),
      );
    }
    // The idempotent start projection is also the pre-provider status guard for continuations.
    if (input.applyAdapter && reaction?.kind === "invoke") {
      const providerAttemptPersisted = existsSync(join(ctx.runDir, "meta.json"));
      try {
        startedUpdate = await input.applyAdapter.applyTriageStarted({
          issueRef: input.issueRef,
          runId: ctx.runId,
          runDir: ctx.runDir,
          rerun: input.rerun || Boolean(activeTriage && !providerAttemptPersisted),
          continuation: Boolean(activeTriage && providerAttemptPersisted),
        });
      } catch (error) {
        throw new Error(`Linear start projection failed: ${errorMessage(error)}`, { cause: error });
      }
    }
    let meta: FactoryRunMeta;
    let terminalAction: FactoryActionLifecycleEvent | undefined;
    let next: FactoryReaction = { kind: "wait", reason: "human" };
    if (ctx.dryRun) {
      meta = await runTriage(ctx, {
        nextLiveRunRequiresRerun: !ctx.dryRun || policy.hadPriorCompletion,
      });
    } else {
      let handledMeta: FactoryRunMeta | undefined;
      const appended = await triageWorkItem({
        ctx,
        factoryStateRoot: input.factoryStateRoot,
        reaction: reaction!,
        nextLiveRunRequiresRerun: !ctx.dryRun || policy.hadPriorCompletion,
        runProvider: runTriage,
        onMeta: (value) => {
          handledMeta = value;
        },
      });
      if (handledMeta) meta = handledMeta;
      else {
        const metaValue: unknown = JSON.parse(readFileSync(join(ctx.runDir, "meta.json"), "utf8"));
        assertFactoryRunMeta(metaValue);
        meta = metaValue;
      }
      terminalAction = appended.event;
      next = decideNextFactoryAction(appended.state, appended.event);
    }
    let completedTriage: FactoryTriageOutput | undefined;
    if (meta.status === "completed") {
      completedTriage =
        terminalAction?.type === "triage.work_item.completed"
          ? readVerifiedFactoryTriageArtifact(meta, terminalAction, ctx.factoryStore?.projectRoot)
          : readFactoryTriageArtifact(meta);
    }
    let terminalUpdate: LinearTriageUpdatePlan | undefined;
    let terminalApplyError: unknown;
    if (input.applyAdapter && !ctx.dryRun && meta.failureKind !== "retryable") {
      try {
        terminalUpdate = completedTriage
          ? await input.applyAdapter.applyTriageCompleted({
              issueRef: input.issueRef,
              runId: ctx.runId,
              runDir: ctx.runDir,
              triage: completedTriage,
            })
          : await input.applyAdapter.applyTriageFailed({
              issueRef: input.issueRef,
              runId: ctx.runId,
              runDir: ctx.runDir,
              error: meta.error ?? "Factory triage failed.",
            });
      } catch (error) {
        terminalApplyError = error;
      }
    }
    return {
      meta,
      phaseRunId: ctx.runId,
      action: {
        handler: "triageWorkItem",
        attempt: 1,
        eventId: terminalAction?.id ?? `triage.completed:${ctx.runId}`,
      },
      next,
      ...(startedUpdate ? { startedUpdate } : {}),
      ...(terminalUpdate ? { terminalUpdate } : {}),
      ...(terminalApplyError ? { terminalApplyError } : {}),
    };
  } finally {
    process.off("SIGINT", onRunAbort);
    process.off("SIGTERM", onRunAbort);
  }
}

async function recoverTriageActionResult(input: {
  factoryStateRoot: string;
  workspace?: string;
  projectId?: string;
  workItem: FactoryWorkItem;
  issueRef: string;
  applyAdapter?: LinearFactoryAdapter;
}): Promise<
  | {
      meta: FactoryRunMeta;
      phaseRunId: string;
      action: { handler: "triageWorkItem"; attempt: 1; eventId: string };
      next: FactoryReaction;
      terminalUpdate?: LinearTriageUpdatePlan;
      terminalApplyError?: unknown;
    }
  | undefined
> {
  const key = deriveFactoryWorkItemKey(input.workItem);
  const events = readFactoryActionEvents(input.factoryStateRoot, key);
  const latest = events.at(-1);
  if (
    latest?.type === "triage.work_item.completed" ||
    (latest?.type === "factory.action.failed" &&
      latest.data.phase === "triage" &&
      latest.data.failureKind !== "retryable")
  ) {
    const runDir = join(dirname(input.factoryStateRoot), "runs", "factory", latest.phaseRunId);
    const metaValue: unknown = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8"));
    assertFactoryRunMeta(metaValue);
    const meta = metaValue;
    const identity = readFactoryPhaseRunIdentity(runDir);
    if (
      identity.phaseRunId !== latest.phaseRunId ||
      identity.workItemKey !== key ||
      identity.factoryStateRoot !== resolve(input.factoryStateRoot) ||
      (input.workspace !== undefined && identity.workspace !== resolve(input.workspace)) ||
      (input.projectId !== undefined && identity.projectId !== input.projectId) ||
      meta.workItem.id !== input.workItem.id ||
      meta.runId !== latest.phaseRunId ||
      resolve(meta.runDir) !== resolve(runDir) ||
      resolve(meta.workspace) !== identity.workspace ||
      resolve(meta.factoryStore?.factoryStateRoot ?? "") !== resolve(input.factoryStateRoot) ||
      latest.data.execution.workspaceRef !== identity.projectId
    ) {
      throw new Error(`Recovered Factory run metadata conflicts with ${latest.phaseRunId}`);
    }
    const roots = { "factory-store": dirname(input.factoryStateRoot), repository: meta.workspace };
    const request = events.findLast(
      (event): event is Extract<FactoryActionLifecycleEvent, { type: "triage.requested" }> =>
        event.type === "triage.requested" && event.phaseRunId === latest.phaseRunId,
    );
    if (!request || request.data.inputRefs.length === 0) {
      throw new Error(`Recovered Factory phase run ${latest.phaseRunId} has no input evidence`);
    }
    for (const ref of request.data.inputRefs) verifyFactoryArtifactRef(ref, roots);
    const resolvedRunRef = verifyFactoryArtifactRef(latest.data.execution.runRef, roots);
    assertFactoryPathContained(runDir, resolvedRunRef);
    for (const ref of latest.data.evidence) verifyFactoryArtifactRef(ref, roots);
    let terminalUpdate: LinearTriageUpdatePlan | undefined;
    let terminalApplyError: unknown;
    if (input.applyAdapter) {
      try {
        const triage =
          latest.type === "triage.work_item.completed"
            ? readVerifiedFactoryTriageArtifact(meta, latest, dirname(input.factoryStateRoot))
            : undefined;
        if (
          triage &&
          latest.type === "triage.work_item.completed" &&
          (triage.route !== latest.data.route || triage.rationale !== latest.data.rationale)
        ) {
          throw new Error("Persisted triage evidence conflicts with the terminal Factory event");
        }
        terminalUpdate = triage
          ? await input.applyAdapter.applyTriageCompleted({
              issueRef: input.issueRef,
              runId: meta.runId,
              runDir: meta.runDir,
              triage,
            })
          : await input.applyAdapter.applyTriageFailed({
              issueRef: input.issueRef,
              runId: meta.runId,
              runDir: meta.runDir,
              error: meta.error ?? "Factory triage failed.",
            });
      } catch (error) {
        terminalApplyError = error;
      }
    }
    const state = reduceFactoryLifecycleEvents(events)!;
    return {
      meta,
      phaseRunId: latest.phaseRunId,
      action: {
        handler: "triageWorkItem",
        attempt: 1,
        eventId: latest.id,
      },
      next: decideNextFactoryAction(state, latest),
      ...(terminalUpdate ? { terminalUpdate } : {}),
      ...(terminalApplyError ? { terminalApplyError } : {}),
    };
  }
  if (
    latest?.type !== "triage.requested" &&
    !(
      latest?.type === "factory.action.failed" &&
      latest.data.phase === "triage" &&
      latest.data.failureKind === "retryable"
    )
  )
    return undefined;
  const runDir = join(dirname(input.factoryStateRoot), "runs", "factory", latest.phaseRunId);
  const reaction = decideNextFactoryAction(reduceFactoryLifecycleEvents(events)!, latest);
  if (reaction.kind !== "invoke" || reaction.handler !== "triageWorkItem") return undefined;
  const actionDir = join(
    runDir,
    "actions",
    String(reaction.attempt),
    reaction.handler,
    factoryActionKey({ ...reaction, phaseRunId: latest.phaseRunId }),
  );
  if (!existsSync(factoryActionResultPath(actionDir))) return undefined;
  const terminal = readFactoryActionResult(actionDir);
  if (
    !["triage.work_item.completed", "factory.action.failed"].includes(terminal.type) ||
    terminal.workItemKey !== key ||
    terminal.phaseRunId !== latest.phaseRunId ||
    terminal.data.causationEventId !== latest.id ||
    terminal.data.handler !== "triageWorkItem" ||
    (terminal.type === "factory.action.failed" && terminal.data.phase !== "triage") ||
    terminal.data.attempt !== 1 ||
    terminal.data.attempt !== reaction.attempt
  ) {
    throw new Error(
      `Recovered Factory action result conflicts with active run ${latest.phaseRunId}`,
    );
  }
  const metaValue: unknown = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8"));
  assertFactoryRunMeta(metaValue);
  const meta = metaValue;
  const identity = readFactoryPhaseRunIdentity(runDir);
  if (
    meta.runId !== latest.phaseRunId ||
    resolve(meta.runDir) !== resolve(runDir) ||
    meta.workItem.id !== input.workItem.id ||
    resolve(meta.factoryStore?.factoryStateRoot ?? "") !== resolve(input.factoryStateRoot) ||
    identity.phaseRunId !== latest.phaseRunId ||
    identity.workItemKey !== key ||
    identity.factoryStateRoot !== resolve(input.factoryStateRoot) ||
    (input.workspace !== undefined && identity.workspace !== resolve(input.workspace)) ||
    (input.projectId !== undefined && identity.projectId !== input.projectId) ||
    resolve(meta.workspace) !== identity.workspace
  ) {
    throw new Error(`Recovered Factory run metadata conflicts with ${latest.phaseRunId}`);
  }
  const roots = { "factory-store": dirname(input.factoryStateRoot), repository: meta.workspace };
  const request = events.findLast(
    (event): event is Extract<FactoryActionLifecycleEvent, { type: "triage.requested" }> =>
      event.type === "triage.requested" && event.phaseRunId === latest.phaseRunId,
  );
  if (!request || request.data.inputRefs.length === 0) {
    throw new Error(`Recovered Factory phase run ${latest.phaseRunId} has no input evidence`);
  }
  for (const ref of request.data.inputRefs) verifyFactoryArtifactRef(ref, roots);
  if (terminal.data.execution.workspaceRef !== identity.projectId) {
    throw new Error(`Recovered Factory execution identity conflicts with ${latest.phaseRunId}`);
  }
  const resolvedRunRef = verifyFactoryArtifactRef(terminal.data.execution.runRef, roots);
  assertFactoryPathContained(runDir, resolvedRunRef);
  for (const ref of terminal.data.evidence) verifyFactoryArtifactRef(ref, roots);
  const appended = appendFactoryActionEvent({
    factoryStateRoot: input.factoryStateRoot,
    event: terminal,
    expectedLastEventId: latest.id,
  });
  let terminalUpdate: LinearTriageUpdatePlan | undefined;
  let terminalApplyError: unknown;
  if (input.applyAdapter) {
    try {
      terminalUpdate =
        terminal.type === "triage.work_item.completed"
          ? await input.applyAdapter.applyTriageCompleted({
              issueRef: input.issueRef,
              runId: meta.runId,
              runDir: meta.runDir,
              triage: readVerifiedFactoryTriageArtifact(
                meta,
                terminal,
                dirname(input.factoryStateRoot),
              ),
            })
          : await input.applyAdapter.applyTriageFailed({
              issueRef: input.issueRef,
              runId: meta.runId,
              runDir: meta.runDir,
              error: meta.error ?? "Factory triage failed.",
            });
    } catch (error) {
      terminalApplyError = error;
    }
  }
  return {
    meta,
    phaseRunId: latest.phaseRunId,
    action: { handler: "triageWorkItem", attempt: 1, eventId: terminal.id },
    next: decideNextFactoryAction(appended.state, appended.event),
    ...(terminalUpdate ? { terminalUpdate } : {}),
    ...(terminalApplyError ? { terminalApplyError } : {}),
  };
}

function validateFactoryApplyOptions(options: {
  apply: boolean;
  itemFile?: string;
  linearIssue?: string;
  dryRun: boolean;
}): void {
  if (!options.apply) return;
  if (options.itemFile) {
    throw new Error("--apply cannot be used with --item-file");
  }
  if (!options.linearIssue) {
    throw new Error("--apply requires --linear-issue");
  }
  if (options.dryRun) {
    throw new Error("--apply cannot be combined with --dry-run");
  }
}

function requireLinearApplyAdapter(
  adapter: LinearFactoryAdapter | undefined,
): LinearFactoryAdapter {
  if (!adapter) {
    throw new Error("Linear adapter is required for --apply.");
  }
  return adapter;
}

function readFactoryTriageArtifact(meta: FactoryRunMeta): FactoryTriageOutput {
  const triagePath = join(meta.runDir, meta.artifacts?.triage ?? "factory-triage.json");
  const triage = parseFactoryTriageOutput(JSON.parse(readFileSync(triagePath, "utf8")));
  assertTriageEvidenceContained(meta.workspace, triage);
  return triage;
}

function assertTriageEvidenceContained(workspace: string, triage: FactoryTriageOutput): void {
  for (const evidence of triage.evidence) {
    if (evidence.path === null) continue;
    if (evidence.path.includes("\\") || !isFactoryRelativePathContained(evidence.path)) {
      throw new Error(`Factory triage evidence path is not portable: ${evidence.path}`);
    }
    assertFactoryPathContained(workspace, resolve(workspace, evidence.path));
  }
}

function readVerifiedFactoryTriageArtifact(
  meta: FactoryRunMeta,
  event: Extract<FactoryActionLifecycleEvent, { type: "triage.work_item.completed" }>,
  projectRoot?: string,
): FactoryTriageOutput {
  const relativePath = meta.artifacts?.triage ?? "factory-triage.json";
  if (resolve(relativePath) === relativePath) {
    throw new Error("Recovered Factory triage artifact path must be relative");
  }
  const declaredTriagePath = resolve(meta.runDir, relativePath);
  const runRoot = resolve(meta.runDir);
  if (relative(runRoot, declaredTriagePath).startsWith("..")) {
    throw new Error(`Recovered Factory triage artifact escapes ${meta.runId}`);
  }
  const roots = {
    "factory-store": projectRoot ?? dirname(meta.factoryStore?.factoryStateRoot ?? ""),
    repository: meta.workspace,
  };
  const actionKey = factoryActionKey({
    phaseRunId: event.phaseRunId,
    handler: event.data.handler,
    attempt: event.data.attempt,
    causationEventId: event.data.causationEventId,
  });
  const expectedTriagePath = resolve(
    runRoot,
    "actions",
    String(event.data.attempt),
    event.data.handler,
    actionKey,
    "evidence/factory-triage.json",
  );
  const triagePath = event.data.evidence
    .map((ref) => resolve(verifyFactoryArtifactRef(ref, roots)))
    .find((path) => path === expectedTriagePath);
  if (!triagePath || relative(runRoot, triagePath).startsWith("..")) {
    throw new Error("Recovered Factory triage artifact is not immutable terminal evidence");
  }
  const triage = parseFactoryTriageOutput(JSON.parse(readFileSync(triagePath, "utf8")));
  assertTriageEvidenceContained(meta.workspace, triage);
  return triage;
}

function assertFactoryRunMeta(value: unknown): asserts value is FactoryRunMeta {
  if (
    !isRecord(value) ||
    typeof value.runId !== "string" ||
    value.workflow !== "factory-triage" ||
    !["completed", "dry_run", "failed"].includes(String(value.status)) ||
    typeof value.workspace !== "string" ||
    typeof value.runDir !== "string" ||
    !isRecord(value.workItem) ||
    typeof value.workItem.id !== "string" ||
    typeof value.workItem.source !== "string" ||
    typeof value.workItem.title !== "string" ||
    !isRecord(value.agent) ||
    !["cursor", "codex"].includes(String(value.agent.name)) ||
    typeof value.agent.model !== "string" ||
    typeof value.startedAt !== "string" ||
    typeof value.durationMs !== "number" ||
    (value.factoryStore !== undefined &&
      (!isRecord(value.factoryStore) || typeof value.factoryStore.factoryStateRoot !== "string"))
  ) {
    throw new Error("Recovered Factory run metadata is invalid");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertFactoryActionTriageAllowed(input: {
  factoryStateRoot: string;
  workItem: FactoryWorkItem;
  rerun: boolean;
}): { hadPriorCompletion: boolean } {
  const key = deriveFactoryWorkItemKey(input.workItem);
  const events = readFactoryActionEvents(input.factoryStateRoot, key);
  const state = reduceFactoryLifecycleEvents(events);
  const requiresRestart =
    state?.phase === "triage" &&
    ["routed", "parked", "needs-human", "failed"].includes(state.status);
  if (requiresRestart && !input.rerun) {
    throw new Error(
      `Factory triage already completed for ${key}; use --rerun to start an explicit new triage phase run.`,
    );
  }
  return { hadPriorCompletion: requiresRestart };
}
