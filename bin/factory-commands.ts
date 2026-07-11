import { InvalidArgumentError, type Command } from "commander";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { stdin as processStdin } from "node:process";
import { hostname } from "node:os";
import type { Readable } from "node:stream";
import { factoryImplementationCliOutput } from "./factory-implementation-cli.ts";
import {
  factoryPlanningCliOutput,
  type FactoryPlanningLinearUpdate,
} from "./factory-planning-cli.ts";
import { factoryTriageCliOutput } from "./factory-triage-cli.ts";
import { errorMessage } from "../lib/agent-invoke.ts";
import {
  resolveFactoryLinearSettings,
  resolveFactoryPlanningSettings,
  resolveFactoryRoleAgent,
  resolveHarnessOptions,
} from "../lib/config.ts";
import {
  factoryExecutionProvenance,
  factoryLifecycleExecutionProvenance,
  factoryStoreMetadata,
  resolveFactoryStore,
  type FactoryStoreMeta,
  type FactoryStoreResolution,
} from "../lib/factory-store.ts";
import {
  factoryImplementationAttempt,
  resolveFactoryImplementationInput,
} from "../lib/factory-implementation-input.ts";
import type {
  LinearImplementationUpdatePlan,
  LinearImplementationUpdateSummary,
} from "../lib/factory-linear-implementation-apply.ts";
import {
  LinearImplementationStartApplyError,
  LinearImplementationTerminalApplyError,
} from "../lib/factory-linear-implementation-apply.ts";
import { withFactoryImplementationExecutionLease } from "../lib/factory-implementation-policy.ts";
import {
  allocateFactoryRun,
  releaseEmptyFactoryRunReservation,
  writeFactoryRunReservation,
} from "../lib/factory-run-allocation.ts";
import { buildRunId } from "../lib/context.ts";
import {
  acquireFactoryWorkspaceWriterLease,
  releaseFactoryWorkspaceWriterLease,
} from "../lib/factory-locks.ts";
import {
  createFactoryImplementationRunContext,
  type FactoryImplementationRunContext,
  type FactoryImplementationRunMeta,
} from "../lib/factory-implementation-run-context.ts";
import type {
  FactoryImplementationReviewRunContext,
  FactoryImplementationReviewRunMeta,
} from "../lib/factory-implementation-review-run-context.ts";
import { factoryStatus } from "../lib/factory-status.ts";
import {
  appendImplementationStartedEvent,
  appendImplementationStartUnresolvedEvent,
  appendImplementationRecoveredFailureEvent,
  appendImplementationStaleOwnerEvent,
  appendImplementationTerminalEvent,
  appendPlanPrMergedEvent,
  appendPlanPrOpenedEvent,
  appendPlanningStartedEvent,
  appendPlanningTerminalEvent,
  appendTriageStartedEvent,
  appendTriageTerminalEvent,
  appendWorkItemImportedEvent,
  formatLifecycleArtifactPath,
} from "../lib/factory-lifecycle-writes.ts";
import {
  deriveFactoryWorkItemKey,
  readFactoryLifecycleEvents,
  type FactoryLifecycleWarning,
} from "../lib/factory-lifecycle.ts";
import {
  createLinearFactoryAdapter,
  parseLinearFactoryStatusKeys,
  parseLinearIssueIdentifier,
  type LinearFactoryAdapter,
  type LinearTriageUpdatePlan,
} from "../lib/factory-linear-adapter.ts";
import type { LinearCreateWorkItemResult } from "../lib/factory-linear-create.ts";
import type { FactoryLinearSettings } from "../lib/config.ts";
import {
  renderLinearPlanningApprovedComment,
  renderLinearPlanningReadyComment,
  type LinearPlanningHandoffUpdatePlan,
} from "../lib/factory-linear-planning-handoff.ts";
import type {
  LinearPlanningCompletedInput,
  LinearPlanningUpdatePlan,
} from "../lib/factory-linear-planning-apply.ts";
import {
  loadFactoryPlanningRunMeta,
  updateFactoryPlanningHandoff,
  updateFactoryPlanningRunMeta,
} from "../lib/factory-planning-handoff.ts";
import { FactoryPlanningError } from "../lib/factory-planning-schemas.ts";
import {
  createFactoryPlanningRunContext,
  type FactoryPlanningRunContext,
  type FactoryPlanningRunMeta,
} from "../lib/factory-planning-run-context.ts";
import { assertFactoryPlanningLinearEntry } from "../lib/factory-planning-input.ts";
import {
  mergeLifecycleState,
  resolveFactoryWorkItemInput,
  validateFactoryWorkItemInput,
} from "../lib/factory-triage-input.ts";
import {
  createFactoryRunContext,
  assertFactoryItemFileExists,
  type FactoryRunContext,
  type FactoryRunMeta,
} from "../lib/factory-run-context.ts";
import { announceFactoryRunStarted } from "../lib/factory-run-started.ts";
import { assertFactoryTriageAllowed } from "../lib/factory-triage-policy.ts";
import {
  parseFactoryTriageOutput,
  type FactoryTriageOutput,
  type FactoryWorkItem,
} from "../lib/factory-schemas.ts";
import type { WorkflowEvent } from "../lib/workflow-events.ts";
import { createAgentProvider } from "../providers/registry.ts";
import { run as runFactoryImplementation } from "../workflows/factory-implementation.workflow.ts";
import { captureFactoryWorkspaceChanges } from "../lib/factory-workspace-changes.ts";
import { run as runFactoryPlanning } from "../workflows/factory-planning.workflow.ts";
import { addFactoryImplementationReviewCommand } from "./factory-implementation-review-command.ts";
import { run as runFactoryTriage } from "../workflows/factory-triage.workflow.ts";

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

type FactoryPlanningStationOptions = {
  workspace?: string;
  itemFile?: string;
  linearIssue?: string;
  runsDir?: string;
  outputPlan?: string;
  maxReviewIterations?: number;
  maxRuntimeMs: number;
  apply: boolean;
  dryRun: boolean;
  verbose: boolean;
  factoryStoreRoot?: string;
  factoryStoreProjectId?: string;
};

type FactoryPlanningPublishOptions = {
  runDir: string;
  prUrl: string;
  linearIssue?: string;
  apply: boolean;
  factoryStoreRoot?: string;
  factoryStoreProjectId?: string;
};

type FactoryPlanningMarkMergedOptions = {
  runDir: string;
  commit: string;
  linearIssue?: string;
  apply: boolean;
  factoryStoreRoot?: string;
  factoryStoreProjectId?: string;
};

type FactoryImplementationStationOptions = {
  workspace?: string;
  itemFile?: string;
  linearIssue?: string;
  runsDir?: string;
  maxRuntimeMs: number;
  apply: boolean;
  dryRun: boolean;
  verbose: boolean;
  factoryStoreRoot?: string;
  factoryStoreProjectId?: string;
};

const IMPLEMENTATION_LEASE_IDENTITY_RETRY_LIMIT = 3;

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
  implementationLinearAdapterFactory?: typeof createLinearFactoryAdapter;
  implementationAgentProviderFactory?: typeof createAgentProvider;
  implementationRunner?: (
    ctx: FactoryImplementationRunContext,
  ) => Promise<FactoryImplementationRunMeta>;
  implementationReviewRunner?: (
    ctx: FactoryImplementationReviewRunContext,
  ) => Promise<FactoryImplementationReviewRunMeta>;
  implementationExecutionLease?: typeof withFactoryImplementationExecutionLease;
};

function factoryStoreForRun(
  resolution: FactoryStoreResolution,
  runsDir: string | undefined,
  persistRunsDir = false,
): FactoryStoreMeta {
  const meta = factoryStoreMetadata(resolution);
  return {
    ...meta,
    ...(persistRunsDir && runsDir ? { factoryRunsDir: resolve(runsDir) } : {}),
    overrides: {
      ...meta.overrides,
      ...(runsDir ? { runsDir: resolve(runsDir) } : {}),
    },
  };
}

function lifecycleExecutionForRun(
  workspace: string,
  runDir: string,
  factoryStore: FactoryStoreMeta | undefined,
) {
  return factoryLifecycleExecutionProvenance(
    factoryExecutionProvenance(workspace, runDir),
    factoryStore,
  );
}

/** Item-file provenance is workspace-relative when it is inside the workspace. */
function lifecycleItemFilePath(
  workspace: string,
  itemFile: string | undefined,
): string | undefined {
  if (!itemFile) return undefined;
  const absolutePath = resolve(workspace, itemFile);
  const path = relative(resolve(workspace), absolutePath);
  return path === ".." || path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    ? absolutePath
    : path;
}

export function addFactoryCommands(parent: Command, options: FactoryCommandOptions): void {
  const factory = parent.command("factory").description("Manage local factory intake");
  addFactoryStatusCommand(factory);
  addFactoryLinearCommand(factory);
  addFactoryTriageStationCommand(factory, options);
  addFactoryPlanningStationCommand(factory, options);
  addFactoryImplementationStationCommand(factory, options);
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
    lifecycleReadMode: "inspect",
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

function addFactoryPlanningStationCommand(parent: Command, config: FactoryCommandOptions): void {
  const planning = parent.command("planning").description("Manage factory planning station");
  addFactoryPlanningRunCommand(planning, config);
  planning
    .command("publish")
    .description("Register the plan PR for an approved planning run")
    .requiredOption("--run-dir <path>", "factory planning run directory")
    .requiredOption("--pr-url <url>", "plan PR URL")
    .option("--linear-issue <issue>", "Linear issue identifier, e.g. TEAM-123")
    .option("--factory-store-root <path>", "durable factory store root")
    .option("--factory-store-project-id <id>", "durable factory store project id")
    .option("--apply", "apply deterministic Linear status/comment updates", false)
    .action(async (options: FactoryPlanningPublishOptions) => {
      const result = await runFactoryPlanningPublicationWithLinearApply({
        mode: "publish",
        runDir: options.runDir,
        prUrl: options.prUrl,
        issueRef: options.linearIssue,
        apply: options.apply,
        factoryStoreRoot: options.factoryStoreRoot,
        factoryStoreProjectId: options.factoryStoreProjectId,
        env: process.env,
      });
      console.log(JSON.stringify(result.output, null, 2));
      if (result.terminalApplyError) {
        throw result.terminalApplyError;
      }
    });
  planning
    .command("mark-plan-merged")
    .description("Register the merged plan commit for an approved planning run")
    .requiredOption("--run-dir <path>", "factory planning run directory")
    .requiredOption("--commit <sha>", "merged plan commit")
    .option("--linear-issue <issue>", "Linear issue identifier, e.g. TEAM-123")
    .option("--factory-store-root <path>", "durable factory store root")
    .option("--factory-store-project-id <id>", "durable factory store project id")
    .option("--apply", "apply deterministic Linear status/comment updates", false)
    .action(async (options: FactoryPlanningMarkMergedOptions) => {
      const result = await runFactoryPlanningPublicationWithLinearApply({
        mode: "mark-plan-merged",
        runDir: options.runDir,
        commit: options.commit,
        issueRef: options.linearIssue,
        apply: options.apply,
        factoryStoreRoot: options.factoryStoreRoot,
        factoryStoreProjectId: options.factoryStoreProjectId,
        env: process.env,
      });
      console.log(JSON.stringify(result.output, null, 2));
      if (result.terminalApplyError) {
        throw result.terminalApplyError;
      }
    });
}

function addFactoryImplementationStationCommand(
  parent: Command,
  config: FactoryCommandOptions,
): void {
  const implementation = parent
    .command("implementation")
    .description("Manage factory implementation station");
  implementation
    .command("run", { isDefault: true })
    .description("Run one factory work item through the implementation station")
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
      `per-agent timeout (default: ${config.defaultMaxRuntimeMs})`,
      config.positiveNumber,
      config.defaultMaxRuntimeMs,
    )
    .option("--apply", "apply deterministic Linear status/comment updates", false)
    .option("--dry-run", "prepare implementation prompt and handoff artifacts", false)
    .option("--verbose", "emit workflow events as JSONL to stderr", false)
    .action(async (options: FactoryImplementationStationOptions) => {
      validateFactoryApplyOptions(options);
      validateFactoryWorkItemInput(options);
      const implementerRole = resolveFactoryRoleAgent({
        workspace: options.workspace,
        station: "implementation",
        role: "implementer",
      });
      const linearSettings = options.linearIssue
        ? resolveFactoryLinearSettings({ workspace: implementerRole.workspace })
        : undefined;
      const store = resolveFactoryStore({
        workspace: implementerRole.workspace,
        factoryStoreRoot: options.factoryStoreRoot,
        factoryStoreProjectId: options.factoryStoreProjectId,
        env: process.env,
      });
      const factoryStore = factoryStoreForRun(store, options.runsDir, true);
      const implementationAdapter = options.apply
        ? (config.implementationLinearAdapterFactory ?? createLinearFactoryAdapter)({
            apiKey:
              process.env.LINEAR_API_KEY ??
              (() => {
                throw new Error("LINEAR_API_KEY is required for Linear commands.");
              })(),
            settings: linearSettings!,
          })
        : undefined;
      const input = await resolveFactoryWorkItemInput({
        workspace: implementerRole.workspace,
        itemFile: options.itemFile,
        linearIssue: options.linearIssue,
        linearSettings,
        ...(implementationAdapter ? { linearAdapterFactory: () => implementationAdapter } : {}),
        env: process.env,
        lifecycleReadMode: options.dryRun ? "inspect" : "load",
        factoryStateRoot: store.factoryStateRoot,
      });
      let activeInput = input;
      let implementationInput =
        !options.dryRun && input.workItem.metadata?.factoryStage === "implementation-started"
          ? undefined
          : resolveFactoryImplementationInput({
              workspace: implementerRole.workspace,
              resolvedInput: input,
              ...(linearSettings
                ? {
                    linearProjection: implementationLinearProjection(linearSettings, options.apply),
                  }
                : {}),
            });
      const runAbort = new AbortController();
      const onRunAbort = () => runAbort.abort();
      process.once("SIGINT", onRunAbort);
      process.once("SIGTERM", onRunAbort);
      let meta: FactoryImplementationRunMeta | undefined;
      try {
        const run = async () => {
          const runId = options.dryRun ? undefined : `implementation-${buildRunId()}`;
          let workspaceLease: ReturnType<typeof acquireFactoryWorkspaceWriterLease> | undefined;
          let allocation: ReturnType<typeof allocateFactoryRun> | undefined;
          try {
            if (runId) {
              workspaceLease = acquireFactoryWorkspaceWriterLease({
                workspace: implementerRole.workspace,
                factoryProjectId: store.projectId,
                storeRoot: store.storeRoot,
                workItemKey: deriveFactoryWorkItemKey(activeInput.workItem),
                runId,
                operation: "implementation",
              });
            }
            if (runId) {
              allocation = allocateFactoryRun({
                factoryRunsDir: options.runsDir ?? store.factoryRunsDir,
                idPrefix: "implementation",
                runId,
              });
              writeFactoryRunReservation(allocation);
            }
          } catch (error) {
            if (allocation) {
              releaseEmptyFactoryRunReservation({
                runDir: allocation.runDir,
                factoryRunsDir: dirname(allocation.runDir),
                reservationToken: allocation.reservationToken,
              });
            }
            if (workspaceLease) releaseFactoryWorkspaceWriterLease({ handle: workspaceLease });
            throw error;
          }
          try {
            const ctx = createFactoryImplementationRunContext({
              workspace: implementerRole.workspace,
              runsDir: options.runsDir ?? store.factoryRunsDir,
              ...(allocation ? { allocation } : {}),
              ...(workspaceLease ? { writerLease: workspaceLease } : {}),
              deferInitialization: !options.dryRun,
              factoryStore,
              workItem: activeInput.workItem,
              implementationInput: implementationInput!,
              implementerRole,
              dryRun: Boolean(options.dryRun),
              maxRuntimeMs: options.maxRuntimeMs,
              signal: runAbort.signal,
              eventSink: options.verbose ? config.writeVerboseWorkflowEvent : undefined,
              linearApplyRequested: options.apply,
              agentProviderFactory:
                config.implementationAgentProviderFactory ?? createAgentProvider,
            });
            announceFactoryRunStarted({
              station: "implementation",
              runId: ctx.runId,
              runDir: ctx.runDir,
              workspace: ctx.workspace,
            });
            const result = options.apply
              ? await runFactoryImplementationWithLinearApply({
                  ctx,
                  adapter: implementationAdapter!,
                  issueRef: options.linearIssue!,
                  factoryStateRoot: store.factoryStateRoot,
                  ...(config.implementationRunner
                    ? { runImplementation: config.implementationRunner }
                    : {}),
                })
              : {
                  meta: await runFactoryImplementationWithLifecycle({
                    ctx,
                    issueRef: options.linearIssue,
                    itemFile: options.itemFile,
                    factoryStateRoot: store.factoryStateRoot,
                    ...(config.implementationRunner
                      ? { runImplementation: config.implementationRunner }
                      : {}),
                  }),
                  linearUpdate: undefined,
                  startApplyFailed: false,
                  terminalApplyFailed: false,
                  startApplyError: undefined,
                  terminalApplyError: undefined,
                };
            meta = result.meta;
            console.log(
              JSON.stringify(
                factoryImplementationCliOutput(meta, {
                  warnings: activeInput.warnings,
                  ...(options.apply
                    ? {
                        linearApplied: !result.startApplyFailed && !result.terminalApplyFailed,
                        linearUpdate: result.linearUpdate,
                      }
                    : {}),
                }),
                null,
                2,
              ),
            );
            if (meta.status === "implementation-failed") process.exitCode = 1;
            if (result.startApplyFailed) throw result.startApplyError;
            if (result.terminalApplyFailed) throw result.terminalApplyError;
          } finally {
            if (workspaceLease) releaseFactoryWorkspaceWriterLease({ handle: workspaceLease });
          }
        };
        if (options.dryRun) await run();
        else {
          let leaseInput = input;
          let identityChanges = 0;
          for (;;) {
            let refreshedInput: typeof input | undefined;
            let runAfterLease = false;
            await (config.implementationExecutionLease ?? withFactoryImplementationExecutionLease)({
              factoryStateRoot: store.factoryStateRoot,
              workspace: implementerRole.workspace,
              workItem: leaseInput.workItem,
              action: async () => {
                activeInput = await resolveFactoryWorkItemInput({
                  workspace: implementerRole.workspace,
                  ...(options.linearIssue
                    ? {
                        linearIssue: options.linearIssue,
                        linearSettings,
                        ...(implementationAdapter
                          ? { linearAdapterFactory: () => implementationAdapter }
                          : {}),
                      }
                    : { itemFile: options.itemFile! }),
                  env: process.env,
                  lifecycleReadMode: "load",
                  factoryStateRoot: store.factoryStateRoot,
                });
                if (
                  deriveFactoryWorkItemKey(activeInput.workItem) !==
                  deriveFactoryWorkItemKey(leaseInput.workItem)
                ) {
                  identityChanges += 1;
                  if (identityChanges > IMPLEMENTATION_LEASE_IDENTITY_RETRY_LIMIT) {
                    throw new Error(
                      "Implementation item identity changed repeatedly during lease acquisition.",
                    );
                  }
                  refreshedInput = activeInput;
                  return;
                }
                if (
                  await recoverStaleImplementationOwner({
                    workspace: implementerRole.workspace,
                    workItem: activeInput.workItem,
                    factoryStateRoot: store.factoryStateRoot,
                    factoryStore: {
                      ...store,
                      factoryRunsDir: factoryStore.factoryRunsDir,
                    },
                    ...(options.linearIssue && implementationAdapter
                      ? { issueRef: options.linearIssue, linearAdapter: implementationAdapter }
                      : {}),
                  })
                ) {
                  throw new Error(
                    "Recovered a stale implementation owner; inspect durable evidence and retry the implementation command.",
                  );
                }
                implementationInput = resolveFactoryImplementationInput({
                  workspace: implementerRole.workspace,
                  resolvedInput: activeInput,
                  ...(linearSettings
                    ? {
                        linearProjection: implementationLinearProjection(
                          linearSettings,
                          options.apply,
                        ),
                      }
                    : {}),
                });
                // Claim/validation lock ends before provider execution. The physical
                // workspace writer lease remains the provider serialization boundary.
                runAfterLease = true;
              },
            });
            if (refreshedInput) {
              leaseInput = refreshedInput;
              continue;
            }
            if (runAfterLease) await run();
            break;
          }
        }
      } finally {
        process.off("SIGINT", onRunAbort);
        process.off("SIGTERM", onRunAbort);
      }
    });
  addFactoryImplementationReviewCommand(implementation, {
    defaultMaxRuntimeMs: config.defaultMaxRuntimeMs,
    positiveNumber: config.positiveNumber,
    writeVerboseWorkflowEvent: config.writeVerboseWorkflowEvent,
    implementationAgentProviderFactory: config.implementationAgentProviderFactory,
    implementationReviewRunner: config.implementationReviewRunner,
  });
}

function implementationLinearProjection(settings: FactoryLinearSettings, apply: boolean) {
  return {
    mode: apply ? ("apply" as const) : ("observe" as const),
    readyToImplement: settings.statuses.readyToImplement,
    implementationFailed: settings.statuses.implementationFailed,
  };
}

export async function runFactoryImplementationWithLifecycle(input: {
  ctx: FactoryImplementationRunContext;
  issueRef?: string;
  itemFile?: string;
  factoryStateRoot?: string;
  runImplementation?: (
    ctx: FactoryImplementationRunContext,
  ) => Promise<FactoryImplementationRunMeta>;
}): Promise<FactoryImplementationRunMeta> {
  const runImplementation = input.runImplementation ?? runFactoryImplementation;
  if (input.ctx.dryRun) {
    return runImplementation(input.ctx);
  }

  const callerOwnedLease = Boolean(input.ctx.writerLease);
  ensureImplementationWriterLease(input.ctx);

  // Item-file is an input reference, not a run artifact; keep its workspace path.
  const itemFileRelative = lifecycleItemFilePath(input.ctx.workspace, input.itemFile);
  try {
    try {
      input.ctx.initialize();
    } catch (error) {
      const message = errorMessage(error);
      const meta = input.ctx.export({
        status: "implementation-failed",
        error: message,
        includeLiveArtifacts: false,
        preProviderFailure: true,
      });
      input.ctx.writeRejection(message);
      return meta;
    }
    try {
      appendFactoryImplementationStartAudit({
        ctx: input.ctx,
        factoryStateRoot: input.factoryStateRoot,
        issueRef: input.issueRef,
        itemFile: itemFileRelative,
      });
    } catch (error) {
      input.ctx.writeRejection(errorMessage(error));
      throw error;
    }
    return await runFactoryImplementationToLocalTerminal({
      ctx: input.ctx,
      factoryStateRoot: input.factoryStateRoot,
      runImplementation,
    });
  } finally {
    if (!callerOwnedLease) releaseImplementationWriterLease(input.ctx);
  }
}

function appendFactoryImplementationStartAudit(input: {
  ctx: FactoryImplementationRunContext;
  factoryStateRoot?: string;
  issueRef?: string;
  itemFile?: string;
}): void {
  const execution = lifecycleExecutionForRun(
    input.ctx.workspace,
    input.ctx.runDir,
    input.ctx.factoryStore,
  );
  appendWorkItemImportedEvent({
    workspace: input.ctx.workspace,
    workItem: input.ctx.workItem,
    factoryStateRoot: input.factoryStateRoot,
    execution,
  });
  appendImplementationStartedEvent({
    workspace: input.ctx.workspace,
    workItem: input.ctx.workItem,
    runId: input.ctx.runId,
    factoryStateRoot: input.factoryStateRoot,
    execution,
    owner: {
      pid: process.pid,
      hostname: hostname(),
      runDir: input.ctx.runDir,
      startedAt: input.ctx.startedAt.toISOString(),
    },
    ...(input.issueRef ? { linearIssue: input.issueRef } : {}),
    ...(input.itemFile ? { itemFile: input.itemFile } : {}),
  });
}

export async function recoverStaleImplementationOwner(input: {
  workspace: string;
  workItem: FactoryWorkItem;
  factoryStateRoot: string;
  factoryStore: FactoryStoreResolution;
  issueRef?: string;
  linearAdapter?: LinearFactoryAdapter;
  workspaceLeaseEnv?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const metadata = input.workItem.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const factoryStage = (metadata as Record<string, unknown>).factoryStage;
  if (factoryStage !== "implementation-started") return false;
  const runId = (metadata as Record<string, unknown>).factoryRunId;
  if (typeof runId !== "string" || !runId) {
    throw new Error("Implementation-started lifecycle state is missing its owning run ID.");
  }
  const events = readFactoryLifecycleEvents({
    factoryStateRoot: input.factoryStateRoot,
    workItemKey: deriveFactoryWorkItemKey(input.workItem),
  });
  const started = [...events]
    .reverse()
    .find((event) => event.type === "implementation.started" && event.runId === runId);
  if (
    !started ||
    started.type !== "implementation.started" ||
    !started.runId ||
    !started.data.owner
  ) {
    throw new Error(
      `Implementation owner evidence is missing for stale run ${runId}; human recovery required.`,
    );
  }
  const execution = lifecycleExecutionForRun(
    input.workspace,
    started.data.owner.runDir,
    factoryStoreMetadata(input.factoryStore),
  );
  const sameHost = started.data.owner.hostname === hostname();
  const liveness = sameHost ? implementationOwnerLiveness(started.data.owner.pid) : "unknown";
  if (sameHost && liveness === "alive") {
    throw new Error(`Implementation run ${runId} is still owned by PID ${started.data.owner.pid}.`);
  }
  const ownerNeedsHumanRecovery = !sameHost || liveness === "unknown";

  const recordedFactoryRunsDir = dirname(resolve(started.data.owner.runDir));
  const recoveryStore = {
    ...input.factoryStore,
    factoryRunsDir: recordedFactoryRunsDir,
  };
  assertImplementationRunReservation({
    runDir: started.data.owner.runDir,
    runId,
    factoryRunsDir: recoveryStore.factoryRunsDir,
    workspace: input.workspace,
    workItem: input.workItem,
    factoryStore: recoveryStore,
  });

  let linearStage: "ready-to-implement" | "implementation-started" | undefined;
  if (input.linearAdapter && input.issueRef) {
    try {
      const live = await input.linearAdapter.fetchWorkItem(input.issueRef);
      const stage = decodeFactoryImplementationLinearStage(live.metadata);
      if (stage === "ready-to-implement" || stage === "implementation-started") {
        linearStage = stage;
      }
    } catch {
      linearStage = undefined;
    }
  }

  const workspaceLease = acquireFactoryWorkspaceWriterLease({
    workspace: input.workspace,
    factoryProjectId: input.factoryStore.projectId,
    storeRoot: input.factoryStore.storeRoot,
    workItemKey: deriveFactoryWorkItemKey(input.workItem),
    runId,
    operation: "implementation",
    ...(input.workspaceLeaseEnv ? { env: input.workspaceLeaseEnv } : {}),
  });
  try {
    let treeDrift = false;
    try {
      const workspaceStatus = captureFactoryWorkspaceChanges({ workspace: input.workspace });
      const head = execGit(input.workspace, ["rev-parse", "HEAD"]);
      treeDrift =
        Boolean(workspaceStatus.porcelain.trim()) ||
        (started.execution?.head !== undefined && head !== started.execution.head);
    } catch {
      treeDrift = true;
    }
    if (treeDrift || !linearStage || ownerNeedsHumanRecovery) {
      appendImplementationStaleOwnerEvent({
        workspace: input.workspace,
        workItem: input.workItem,
        runId,
        factoryStateRoot: input.factoryStateRoot,
        execution,
        runDir: started.data.owner.runDir,
        error: treeDrift
          ? "Stale implementation owner left workspace edits or changed HEAD; human recovery required."
          : ownerNeedsHumanRecovery
            ? sameHost
              ? `Cannot prove stale implementation owner PID ${started.data.owner.pid} is dead; human recovery required.`
              : "Implementation run has a remote owner; human recovery required."
            : "Stale implementation owner Linear status is unknown; human recovery required.",
        treeDrift,
      });
      return true;
    }
    appendImplementationRecoveredFailureEvent({
      workspace: input.workspace,
      workItem: input.workItem,
      runId,
      factoryStateRoot: input.factoryStateRoot,
      execution,
      error:
        "Recovered stale implementation owner before provider terminalization; retry is allowed.",
      linearStartState: linearStage === "implementation-started" ? "implementing" : "not-started",
    });
    // Lifecycle execution locking protects this projection after the physical
    // lease is released; Linear I/O must not block workspace writers.
    if (linearStage === "implementation-started" && input.linearAdapter && input.issueRef) {
      if (workspaceLease) {
        releaseFactoryWorkspaceWriterLease({ handle: workspaceLease });
      }
      await input.linearAdapter.applyImplementationFailed({
        issueRef: input.issueRef,
        runId,
        runDir: started.data.owner.runDir,
        error:
          "Recovered stale implementation owner before provider terminalization; retry is allowed.",
      });
    }
  } finally {
    if (workspaceLease) releaseFactoryWorkspaceWriterLease({ handle: workspaceLease });
  }
  return true;
}

function assertImplementationRunReservation(input: {
  runDir: string;
  runId: string;
  factoryRunsDir: string;
  workspace: string;
  workItem: FactoryWorkItem;
  factoryStore: FactoryStoreResolution;
}): void {
  const root = resolve(input.factoryRunsDir);
  const runDir = resolve(input.runDir);
  const relativeRun = relative(root, runDir);
  if (!relativeRun || relativeRun.includes("/") || relativeRun !== input.runId) {
    throw new Error("Stale implementation owner run directory is not a direct durable run child.");
  }
  const runStat = lstatSync(runDir);
  if (runStat.isSymbolicLink() || !runStat.isDirectory()) {
    throw new Error("Stale implementation owner run directory is missing or symlinked.");
  }
  const realRoot = realpathSync(root);
  const realRun = realpathSync(runDir);
  const realRelative = relative(realRoot, realRun);
  if (!realRelative || realRelative !== input.runId) {
    throw new Error("Stale implementation owner run directory escapes the durable run root.");
  }
  const manifestPath = join(runDir, "attempt-reservation.json");
  const reservationPath = join(runDir, "implementation-reservation.json");
  const contextPath = join(runDir, "context", "run-reservation.json");
  if (
    !existsSync(manifestPath) ||
    !existsSync(reservationPath) ||
    !existsSync(contextPath) ||
    lstatSync(manifestPath).isSymbolicLink() ||
    lstatSync(reservationPath).isSymbolicLink() ||
    lstatSync(contextPath).isSymbolicLink()
  ) {
    throw new Error("Stale implementation owner reservation evidence is incomplete.");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  const reservation = JSON.parse(readFileSync(reservationPath, "utf8")) as Record<string, unknown>;
  const context = JSON.parse(readFileSync(contextPath, "utf8")) as Record<string, unknown>;
  const workItemKey = deriveFactoryWorkItemKey(input.workItem);
  const expected = {
    station: "implementation",
    workItemKey,
    workspace: resolve(input.workspace),
    storeRoot: input.factoryStore.storeRoot,
    factoryProjectId: input.factoryStore.projectId,
    factoryStateRoot: input.factoryStore.factoryStateRoot,
    factoryRunsDir: input.factoryStore.factoryRunsDir,
    reviewRunsDir: input.factoryStore.reviewRunsDir,
  };
  if (
    manifest.runId !== input.runId ||
    typeof manifest.reservationToken !== "string" ||
    reservation.runId !== input.runId ||
    reservation.reservationToken !== manifest.reservationToken ||
    context.runId !== input.runId ||
    context.reservationToken !== manifest.reservationToken ||
    Object.entries(expected).some(
      ([key, value]) => reservation[key] !== value || context[key] !== value,
    )
  ) {
    throw new Error(
      "Stale implementation owner reservation evidence does not match its provenance.",
    );
  }
}

function implementationOwnerLiveness(pid: number): "alive" | "dead" | "unknown" {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") {
      return "dead";
    }
    return "unknown";
  }
}

function isGitWorkspace(workspace: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: workspace,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function execGit(workspace: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

type ImplementationWorkspaceState = {
  head: string;
  porcelain: string;
};

function captureImplementationWorkspaceState(
  ctx: FactoryImplementationRunContext,
): ImplementationWorkspaceState | undefined {
  if (!isGitWorkspace(ctx.workspace)) return undefined;
  return {
    head: execGit(ctx.workspace, ["rev-parse", "HEAD"]),
    porcelain: captureFactoryWorkspaceChanges({ workspace: ctx.workspace }).porcelain,
  };
}

function assertImplementationWorkspaceStateUnchanged(
  ctx: FactoryImplementationRunContext,
  before: ImplementationWorkspaceState | undefined,
): void {
  if (!before) return;
  const after = captureImplementationWorkspaceState(ctx);
  if (!after) throw new Error("Implementation workspace stopped being a Git workspace.");
  if (before.head !== after.head || before.porcelain !== after.porcelain) {
    throw new Error("Workspace changed while Linear implementation status was being projected.");
  }
}

async function runFactoryImplementationToLocalTerminal(input: {
  ctx: FactoryImplementationRunContext;
  factoryStateRoot?: string;
  runImplementation: (
    ctx: FactoryImplementationRunContext,
  ) => Promise<FactoryImplementationRunMeta>;
}): Promise<FactoryImplementationRunMeta> {
  let meta: FactoryImplementationRunMeta;
  let providerError: unknown;
  try {
    meta = await input.runImplementation(input.ctx);
  } catch (error) {
    providerError = error;
    try {
      meta = input.ctx.export({
        status: "implementation-failed",
        error: errorMessage(error),
        includeLiveArtifacts: false,
      });
    } catch (exportError) {
      throw new AggregateError(
        [error, exportError],
        `Failed to export factory implementation failure: ${errorMessage(error)}; export failed: ${errorMessage(exportError)}`,
      );
    }
  }
  try {
    appendImplementationTerminalEvent({
      meta,
      factoryStateRoot: input.factoryStateRoot,
      ...(meta.error ? { error: meta.error } : {}),
    });
  } catch (terminalizationError) {
    throw new AggregateError(
      providerError ? [providerError, terminalizationError] : [terminalizationError],
      `Failed to append factory implementation terminal lifecycle event: ${errorMessage(terminalizationError)}`,
    );
  }
  return meta;
}

export type FactoryImplementationApplyRunResult = {
  meta: FactoryImplementationRunMeta;
  linearUpdate?: LinearImplementationUpdateSummary;
  startApplyFailed: boolean;
  terminalApplyFailed: boolean;
  startApplyError?: unknown;
  terminalApplyError?: unknown;
};

export async function runFactoryImplementationWithLinearApply(input: {
  ctx: FactoryImplementationRunContext;
  adapter: LinearFactoryAdapter;
  issueRef: string;
  factoryStateRoot?: string;
  runImplementation?: (
    ctx: FactoryImplementationRunContext,
  ) => Promise<FactoryImplementationRunMeta>;
}): Promise<FactoryImplementationApplyRunResult> {
  ensureImplementationWriterLease(input.ctx);
  try {
    return await runFactoryImplementationWithLinearApplyInternal(input);
  } finally {
    releaseImplementationWriterLease(input.ctx);
  }
}

async function runFactoryImplementationWithLinearApplyInternal(input: {
  ctx: FactoryImplementationRunContext;
  adapter: LinearFactoryAdapter;
  issueRef: string;
  factoryStateRoot?: string;
  runImplementation?: (
    ctx: FactoryImplementationRunContext,
  ) => Promise<FactoryImplementationRunMeta>;
}): Promise<FactoryImplementationApplyRunResult> {
  try {
    input.ctx.initialize();
  } catch (initializationError) {
    return terminalizeNotStartedImplementationFailure(input, initializationError);
  }
  try {
    appendFactoryImplementationStartAudit({
      ctx: input.ctx,
      factoryStateRoot: input.factoryStateRoot,
      issueRef: input.issueRef,
    });
  } catch (error) {
    input.ctx.writeRejection(errorMessage(error));
    throw error;
  }
  const workspaceBeforeStartProjection = captureImplementationWorkspaceState(input.ctx);
  releaseImplementationWriterLease(input.ctx);
  let started: LinearImplementationUpdatePlan;
  try {
    started = await input.adapter.applyImplementationStarted({
      issueRef: input.issueRef,
      runId: input.ctx.runId,
      runDir: input.ctx.runDir,
      attempt: factoryImplementationAttempt(input.ctx.implementationInput),
    });
  } catch (startApplyError) {
    let meta: FactoryImplementationRunMeta;
    try {
      meta = input.ctx.export({
        status: "implementation-failed",
        error: errorMessage(startApplyError),
        includeLiveArtifacts: false,
        preProviderFailure: true,
      });
    } catch (exportError) {
      throw new AggregateError(
        [startApplyError, exportError],
        `Failed to export implementation start-apply failure: ${errorMessage(startApplyError)}; export failed: ${errorMessage(exportError)}`,
      );
    }
    const typedStartError =
      startApplyError instanceof LinearImplementationStartApplyError ? startApplyError : undefined;
    let linearStage = typedStartError?.implementingStatusVerified
      ? "implementation-started"
      : undefined;
    if (
      !linearStage &&
      (typedStartError?.phase === "mutation" || typedStartError?.phase === "postcondition")
    ) {
      linearStage = await probeImplementationLinearStage(input.adapter, input.issueRef);
    }
    const startMutationConfirmed = typedStartError?.update?.statusMutationCompleted === true;
    const execution = factoryLifecycleExecutionProvenance(
      factoryExecutionProvenance(input.ctx.workspace, input.ctx.runDir),
      input.ctx.factoryStore,
    );
    let terminal: LinearImplementationUpdatePlan | undefined;
    if (
      linearStage === "implementation-started" &&
      startMutationConfirmed &&
      input.adapter.applyImplementationFailed
    ) {
      appendImplementationTerminalEvent({
        meta,
        factoryStateRoot: input.factoryStateRoot,
        error: errorMessage(startApplyError),
        linearStartState: "implementing",
      });
      try {
        terminal = await input.adapter.applyImplementationFailed({
          issueRef: input.issueRef,
          runId: input.ctx.runId,
          runDir: input.ctx.runDir,
          error: errorMessage(startApplyError),
        });
      } catch (terminalApplyError) {
        return {
          meta,
          linearUpdate: {
            ...(typedStartError?.update ? { started: typedStartError.update } : {}),
            ...(terminalApplyError instanceof LinearImplementationTerminalApplyError
              ? { terminal: terminalApplyError.update }
              : {}),
          },
          startApplyFailed: true,
          terminalApplyFailed: true,
          startApplyError,
          terminalApplyError,
        };
      }
    } else if (
      linearStage === "ready-to-implement" ||
      linearStage === "implementation-failed" ||
      typedStartError?.phase === "validation" ||
      typedStartError?.phase === "fetch"
    ) {
      appendImplementationTerminalEvent({
        meta,
        factoryStateRoot: input.factoryStateRoot,
        error: errorMessage(startApplyError),
        linearStartState: "not-started",
      });
    } else {
      appendImplementationStartUnresolvedEvent({
        workspace: input.ctx.workspace,
        workItem: input.ctx.workItem,
        runId: input.ctx.runId,
        runDir: input.ctx.runDir,
        factoryStateRoot: input.factoryStateRoot,
        execution,
        error: errorMessage(startApplyError),
        phase: typedStartError?.phase ?? "fetch",
        linearStartState: "unknown",
      });
    }
    return {
      meta,
      linearUpdate: {
        ...(typedStartError?.update ? { started: typedStartError.update } : {}),
        ...(terminal ? { terminal } : {}),
      },
      startApplyFailed: true,
      terminalApplyFailed: false,
      startApplyError,
    };
  }
  try {
    ensureImplementationWriterLease(input.ctx);
    assertImplementationWorkspaceStateUnchanged(input.ctx, workspaceBeforeStartProjection);
  } catch (leaseError) {
    return terminalizeStartedImplementationFailure(input, started, leaseError);
  }
  let meta: FactoryImplementationRunMeta;
  meta = await runFactoryImplementationToLocalTerminal({
    ctx: input.ctx,
    factoryStateRoot: input.factoryStateRoot,
    runImplementation: input.runImplementation ?? runFactoryImplementation,
  });
  releaseImplementationWriterLease(input.ctx);
  try {
    const terminal =
      meta.status === "implementation-complete"
        ? await input.adapter.applyImplementationCompleted({
            issueRef: input.issueRef,
            runId: meta.runId,
            runDir: meta.runDir,
            reviewBase: requireImplementationReviewRef(meta.reviewBase, "reviewBase"),
            reviewHead: requireImplementationReviewRef(meta.reviewHead, "reviewHead"),
            reviewCommitSha: requireImplementationReviewRef(
              meta.reviewCommitSha,
              "reviewCommitSha",
            ),
          })
        : await input.adapter.applyImplementationFailed({
            issueRef: input.issueRef,
            runId: meta.runId,
            runDir: meta.runDir,
            error: meta.error ?? "Factory implementation failed.",
          });
    return {
      meta,
      linearUpdate: { started, terminal },
      startApplyFailed: false,
      terminalApplyFailed: false,
    };
  } catch (terminalApplyError) {
    return {
      meta,
      linearUpdate: {
        started,
        ...(terminalApplyError instanceof LinearImplementationTerminalApplyError
          ? { terminal: terminalApplyError.update }
          : {}),
      },
      startApplyFailed: false,
      terminalApplyFailed: true,
      terminalApplyError,
    };
  }
}

async function terminalizeStartedImplementationFailure(
  input: {
    ctx: FactoryImplementationRunContext;
    adapter: LinearFactoryAdapter;
    issueRef: string;
    factoryStateRoot?: string;
  },
  started: LinearImplementationUpdatePlan | undefined,
  failure: unknown,
): Promise<FactoryImplementationApplyRunResult> {
  const error = errorMessage(failure);
  const meta = input.ctx.export({
    status: "implementation-failed",
    error,
    includeLiveArtifacts: false,
    preProviderFailure: true,
  });
  appendImplementationTerminalEvent({
    meta,
    factoryStateRoot: input.factoryStateRoot,
    error,
    linearStartState: "implementing",
  });
  releaseImplementationWriterLease(input.ctx);
  try {
    const terminal = await input.adapter.applyImplementationFailed({
      issueRef: input.issueRef,
      runId: input.ctx.runId,
      runDir: input.ctx.runDir,
      error,
    });
    return {
      meta,
      linearUpdate: { ...(started ? { started } : {}), terminal },
      startApplyFailed: false,
      terminalApplyFailed: false,
    };
  } catch (terminalApplyError) {
    return {
      meta,
      linearUpdate: {
        ...(started ? { started } : {}),
        ...(terminalApplyError instanceof LinearImplementationTerminalApplyError
          ? { terminal: terminalApplyError.update }
          : {}),
      },
      startApplyFailed: false,
      terminalApplyFailed: true,
      terminalApplyError,
    };
  }
}

async function terminalizeNotStartedImplementationFailure(
  input: {
    ctx: FactoryImplementationRunContext;
    adapter: LinearFactoryAdapter;
    issueRef: string;
  },
  failure: unknown,
): Promise<FactoryImplementationApplyRunResult> {
  const error = errorMessage(failure);
  const meta = input.ctx.export({
    status: "implementation-failed",
    error,
    includeLiveArtifacts: false,
    preProviderFailure: true,
  });
  input.ctx.writeRejection(error);
  return {
    meta,
    linearUpdate: undefined,
    startApplyFailed: true,
    terminalApplyFailed: false,
    startApplyError: failure,
  };
}

function releaseImplementationWriterLease(ctx: FactoryImplementationRunContext): void {
  if (ctx.writerLease) {
    const lease = ctx.writerLease;
    ctx.writerLease = undefined;
    releaseFactoryWorkspaceWriterLease({ handle: lease });
  }
}

function ensureImplementationWriterLease(ctx: FactoryImplementationRunContext): void {
  if (ctx.writerLease || !ctx.factoryStore) return;
  ctx.writerLease = acquireFactoryWorkspaceWriterLease({
    workspace: ctx.workspace,
    factoryProjectId: ctx.factoryStore.projectId,
    storeRoot: ctx.factoryStore.storeRoot,
    workItemKey: deriveFactoryWorkItemKey(ctx.workItem),
    runId: ctx.runId,
    operation: "implementation",
    ...(ctx.workspaceLeaseEnv ? { env: ctx.workspaceLeaseEnv } : {}),
  });
}

async function probeImplementationLinearStage(
  adapter: LinearFactoryAdapter,
  issueRef: string,
): Promise<"ready-to-implement" | "implementation-started" | "implementation-failed" | undefined> {
  try {
    const workItem = await adapter.fetchWorkItem(issueRef);
    return decodeFactoryImplementationLinearStage(workItem.metadata);
  } catch {
    return undefined;
  }
}

type FactoryImplementationLinearStage =
  | "ready-to-implement"
  | "implementation-started"
  | "implementation-failed";

function decodeFactoryImplementationLinearStage(
  metadata: unknown,
): FactoryImplementationLinearStage | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const stage = (metadata as Record<string, unknown>).factoryStage;
  return stage === "ready-to-implement" ||
    stage === "implementation-started" ||
    stage === "implementation-failed"
    ? stage
    : undefined;
}

function requireImplementationReviewRef(value: string | undefined, name: string): string {
  if (value) return value;
  throw new Error(`Completed factory implementation is missing ${name}.`);
}

function addFactoryPlanningRunCommand(parent: Command, config: FactoryCommandOptions): void {
  parent
    .command("run", { isDefault: true })
    .description("Run one factory work item through the planning station")
    .option("--workspace <path>", "target repo")
    .option("--item-file <path>", "factory work item JSON file")
    .option("--linear-issue <issue>", "Linear issue identifier, e.g. TEAM-123")
    .option(
      "--runs-dir <path>",
      "output root override (default: durable factory store runs/factory)",
    )
    .option("--factory-store-root <path>", "durable factory store root")
    .option("--factory-store-project-id <id>", "durable factory store project id")
    .option("--output-plan <path>", "final plan path under dev/plans")
    .option(
      "--max-review-iterations <count>",
      "maximum plan-review loops (default: factory.planning.maxReviewIterations or 3)",
      positiveInteger,
    )
    .option(
      "--max-runtime-ms <ms>",
      `per-agent timeout (default: ${config.defaultMaxRuntimeMs})`,
      config.positiveNumber,
      config.defaultMaxRuntimeMs,
    )
    .option("--apply", "apply deterministic Linear status/comment updates", false)
    .option("--dry-run", "prepare context and placeholder plan only", false)
    .option("--verbose", "emit workflow events as JSONL to stderr", false)
    .action(async (options: FactoryPlanningStationOptions) => {
      // Validate source flags before role/config resolution so CLI usage errors win.
      validateFactoryApplyOptions(options);
      validateFactoryWorkItemInput(options);
      const settings = resolveFactoryPlanningSettings({ workspace: options.workspace });
      const plannerRole = resolveFactoryRoleAgent({
        workspace: settings.workspace,
        station: "planning",
        role: "planner",
      });
      const reviewerRole = resolveFactoryRoleAgent({
        workspace: settings.workspace,
        station: "planning",
        role: "reviewer",
      });
      const linearSettings = options.linearIssue
        ? resolveFactoryLinearSettings({ workspace: settings.workspace })
        : undefined;
      const store = resolveFactoryStore({
        workspace: settings.workspace,
        factoryStoreRoot: options.factoryStoreRoot,
        factoryStoreProjectId: options.factoryStoreProjectId,
        env: process.env,
      });
      const factoryStore = factoryStoreForRun(store, options.runsDir);
      let linearAdapter: LinearFactoryAdapter | undefined;
      const linearAdapterFactory = options.linearIssue
        ? (adapterInput: Parameters<typeof createLinearFactoryAdapter>[0]) => {
            linearAdapter ??= createLinearFactoryAdapter(adapterInput);
            return linearAdapter;
          }
        : undefined;
      const input = await resolveFactoryWorkItemInput({
        workspace: settings.workspace,
        itemFile: options.itemFile,
        linearIssue: options.linearIssue,
        linearSettings,
        env: process.env,
        linearAdapterFactory,
        lifecycleReadMode: options.dryRun ? "inspect" : "load",
        factoryStateRoot: store.factoryStateRoot,
      });
      assertFactoryPlanningLinearEntry(input);

      const runAbort = new AbortController();
      const onRunAbort = () => runAbort.abort();
      process.once("SIGINT", onRunAbort);
      process.once("SIGTERM", onRunAbort);
      let meta: FactoryPlanningRunMeta;
      let linearUpdate: FactoryPlanningLinearUpdate | undefined;
      let terminalApplyError: unknown;
      try {
        const ctx = createFactoryPlanningRunContext({
          workspace: settings.workspace,
          runsDir: options.runsDir ?? store.factoryRunsDir,
          factoryStore,
          reviewRunsDir: store.reviewRunsDir,
          workItem: input.workItem,
          plannerRole,
          reviewerRole,
          outputPlan: options.outputPlan,
          maxReviewIterations: options.maxReviewIterations ?? settings.maxReviewIterations,
          maxRuntimeMs: options.maxRuntimeMs,
          dryRun: options.dryRun,
          signal: runAbort.signal,
          eventSink: options.verbose ? config.writeVerboseWorkflowEvent : undefined,
          agentProviderFactory: createAgentProvider,
        });
        announceFactoryRunStarted({
          station: "planning",
          runId: ctx.runId,
          runDir: ctx.runDir,
          workspace: ctx.workspace,
        });
        const applyAdapter = options.apply ? requireLinearApplyAdapter(linearAdapter) : undefined;
        ({ meta, linearUpdate, terminalApplyError } = await runFactoryPlanningWithLinearApply({
          ctx,
          issueRef: options.linearIssue ?? "",
          itemFile: options.itemFile,
          applyAdapter,
          factoryStateRoot: store.factoryStateRoot,
        }));
      } finally {
        process.off("SIGINT", onRunAbort);
        process.off("SIGTERM", onRunAbort);
      }
      console.log(
        JSON.stringify(
          factoryPlanningCliOutput(meta, {
            ...(options.apply
              ? { linearApplied: true, linearUpdate }
              : options.linearIssue
                ? { linearApplied: false }
                : {}),
            ...(input.warnings ? { warnings: input.warnings } : {}),
          }),
          null,
          2,
        ),
      );
      if (terminalApplyError) {
        throw terminalApplyError;
      }
      process.exitCode =
        meta.status === "planning-failed" || meta.status === "plan-review-unresolved" ? 1 : 0;
    });
}

export async function runFactoryPlanningWithLinearApply(input: {
  ctx: FactoryPlanningRunContext;
  issueRef: string;
  itemFile?: string;
  applyAdapter?: LinearFactoryAdapter;
  runPlanning?: (ctx: FactoryPlanningRunContext) => Promise<FactoryPlanningRunMeta>;
  factoryStateRoot?: string;
}): Promise<{
  meta: FactoryPlanningRunMeta;
  linearUpdate?: FactoryPlanningLinearUpdate;
  terminalApplyError?: unknown;
}> {
  const runPlanning = input.runPlanning ?? runFactoryPlanning;
  const itemFilePath = lifecycleItemFilePath(input.ctx.workspace, input.itemFile);
  let startedUpdate: LinearPlanningUpdatePlan | undefined;
  let terminalUpdate: LinearPlanningUpdatePlan | undefined;
  if (!input.ctx.dryRun) {
    appendWorkItemImportedEvent({
      workspace: input.ctx.workspace,
      workItem: input.ctx.workItem,
      factoryStateRoot: input.factoryStateRoot,
      execution: lifecycleExecutionForRun(
        input.ctx.workspace,
        input.ctx.runDir,
        input.ctx.factoryStore,
      ),
    });
    appendPlanningStartedEvent({
      workspace: input.ctx.workspace,
      workItem: input.ctx.workItem,
      runId: input.ctx.runId,
      factoryStateRoot: input.factoryStateRoot,
      execution: lifecycleExecutionForRun(
        input.ctx.workspace,
        input.ctx.runDir,
        input.ctx.factoryStore,
      ),
      ...(input.issueRef ? { linearIssue: input.issueRef } : {}),
      ...(itemFilePath ? { itemFile: itemFilePath } : {}),
    });
  }
  if (input.applyAdapter) {
    startedUpdate = await input.applyAdapter.applyPlanningStarted({
      issueRef: input.issueRef,
      runId: input.ctx.runId,
      runDir: input.ctx.runDir,
    });
  }
  let meta: FactoryPlanningRunMeta;
  try {
    meta = await runPlanning(input.ctx);
  } catch (error) {
    if (!input.ctx.dryRun && typeof input.ctx.export === "function") {
      const failedMeta = input.ctx.export({
        status: "planning-failed",
        iterations: [],
        error: errorMessage(error),
      });
      appendPlanningTerminalEvent({
        meta: failedMeta,
        error: errorMessage(error),
        factoryStateRoot: input.factoryStateRoot,
      });
    }
    if (input.applyAdapter && startedUpdate) {
      try {
        terminalUpdate = await input.applyAdapter.applyPlanningFailed({
          issueRef: input.issueRef,
          runId: input.ctx.runId,
          runDir: input.ctx.runDir,
          error: errorMessage(error),
        });
      } catch {
        // Preserve the planning/provider error. Cleanup failures are secondary.
      }
    }
    throw error;
  }
  if (!input.ctx.dryRun) {
    appendPlanningTerminalEvent({ meta, factoryStateRoot: input.factoryStateRoot });
  }
  let terminalApplyError: unknown;
  if (input.applyAdapter) {
    try {
      terminalUpdate = await input.applyAdapter.applyPlanningCompleted(
        linearPlanningCompletedInput(meta, input.issueRef),
      );
    } catch (error) {
      terminalApplyError = error;
    }
  }
  return {
    meta,
    ...(input.applyAdapter
      ? { linearUpdate: { started: startedUpdate, terminal: terminalUpdate } }
      : {}),
    ...(terminalApplyError ? { terminalApplyError } : {}),
  };
}

type FactoryPlanningPublicationMode = "publish" | "mark-plan-merged";

type FactoryPlanningPublicationOutput = ReturnType<typeof factoryPlanningPublicationCliOutput> & {
  linearApplied?: boolean;
  linearUpdate?: {
    terminal?: LinearPlanningHandoffUpdatePlan;
  };
};

export async function runFactoryPlanningPublicationWithLinearApply(input: {
  mode: FactoryPlanningPublicationMode;
  runDir: string;
  issueRef?: string;
  prUrl?: string;
  commit?: string;
  apply: boolean;
  factoryStateRoot?: string;
  factoryStoreRoot?: string;
  factoryStoreProjectId?: string;
  env?: NodeJS.ProcessEnv;
  resolveLinearSettings?: (input: { workspace?: string }) => FactoryLinearSettings;
  adapterFactory?: (input: {
    apiKey: string;
    settings: FactoryLinearSettings;
  }) => LinearFactoryAdapter;
}): Promise<{
  output: FactoryPlanningPublicationOutput;
  terminalApplyError?: unknown;
}> {
  let existingMeta = loadFactoryPlanningRunMeta(input.runDir);
  const fallbackStore = existingMeta.factoryStore
    ? undefined
    : resolveFactoryStore({
        workspace: existingMeta.workspace,
        factoryStoreRoot: input.factoryStoreRoot,
        factoryStoreProjectId: input.factoryStoreProjectId,
        env: input.env,
      });
  if (fallbackStore) {
    const factoryStore = factoryStoreMetadata(fallbackStore);
    existingMeta = updateFactoryPlanningRunMeta(input.runDir, {
      factoryStore,
      warnings: [
        {
          code: "factory-store-meta-missing",
          message:
            "Planning run metadata lacked factoryStore; durable store metadata was resolved and persisted.",
          factoryStateRoot: factoryStore.factoryStateRoot,
        },
      ],
    });
  }
  const factoryStateRoot = existingMeta.factoryStore?.factoryStateRoot ?? input.factoryStateRoot;
  if (!factoryStateRoot) {
    throw new FactoryPlanningError(
      "Factory planning publication requires a durable factoryStateRoot.",
    );
  }
  let applyAdapter: LinearFactoryAdapter | undefined;
  if (input.apply) {
    if (!input.issueRef) {
      throw new FactoryPlanningError("--apply requires --linear-issue");
    }
    assertLinearPublicationIssueMatches(existingMeta, input.issueRef);
    const apiKey = input.env?.LINEAR_API_KEY;
    if (!apiKey) {
      throw new FactoryPlanningError("LINEAR_API_KEY is required for Linear commands.");
    }
    const settings = (input.resolveLinearSettings ?? resolveFactoryLinearSettings)({
      workspace: existingMeta.workspace,
    });
    applyAdapter = (input.adapterFactory ?? createLinearFactoryAdapter)({ apiKey, settings });
  }

  const meta =
    input.mode === "publish"
      ? updateFactoryPlanningHandoff(input.runDir, {
          approvedPlanPrUrl: requirePrUrl(input.prUrl),
          factoryStage: "plan-pr-open",
        })
      : updateFactoryPlanningHandoff(input.runDir, {
          approvedPlanCommit: requireCommit(input.commit),
          factoryStage: "plan-approved",
        });
  if (input.mode === "publish") {
    appendPlanPrOpenedEvent({ meta, factoryStateRoot });
  } else {
    appendPlanPrMergedEvent({ meta, factoryStateRoot });
  }
  const metadata = requirePlanningFactoryMetadata(meta);
  const linearComment =
    input.mode === "publish"
      ? renderLinearPlanningReadyComment({
          runId: meta.runId,
          runDir: meta.runDir,
          approvedPlanPath: metadata.approvedPlanPath,
          approvedPlanPrUrl: metadata.approvedPlanPrUrl,
        })
      : renderLinearPlanningApprovedComment({
          runId: meta.runId,
          runDir: meta.runDir,
          approvedPlanPath: metadata.approvedPlanPath,
          approvedPlanPrUrl: metadata.approvedPlanPrUrl,
          approvedPlanCommit: metadata.approvedPlanCommit,
        });

  if (!input.apply || !applyAdapter) {
    return {
      output: factoryPlanningPublicationCliOutput(meta, linearComment),
    };
  }

  try {
    const terminal =
      input.mode === "publish"
        ? await applyAdapter.applyPlanningPublished({
            issueRef: input.issueRef ?? "",
            runId: meta.runId,
            runDir: meta.runDir,
            approvedPlanPath: metadata.approvedPlanPath,
            approvedPlanPrUrl: metadata.approvedPlanPrUrl,
          })
        : await applyAdapter.applyPlanningMerged({
            issueRef: input.issueRef ?? "",
            runId: meta.runId,
            runDir: meta.runDir,
            approvedPlanPath: metadata.approvedPlanPath,
            approvedPlanPrUrl: metadata.approvedPlanPrUrl,
            approvedPlanCommit: metadata.approvedPlanCommit,
          });
    return {
      output: factoryPlanningPublicationCliOutput(meta, linearComment, {
        linearApplied: true,
        linearUpdate: { terminal },
      }),
    };
  } catch (error) {
    return {
      output: factoryPlanningPublicationCliOutput(meta, linearComment, {
        linearApplied: false,
      }),
      terminalApplyError: error,
    };
  }
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
  if (parsed > 100) {
    throw new InvalidArgumentError("must be between 1 and 100");
  }
  return parsed;
}

function factoryPlanningPublicationCliOutput(
  meta: FactoryPlanningRunMeta,
  linearComment: string,
  extra: {
    linearApplied?: boolean;
    linearUpdate?: { terminal?: LinearPlanningHandoffUpdatePlan };
  } = {},
) {
  return {
    runId: meta.runId,
    workflow: meta.workflow,
    status: meta.status,
    workspace: meta.workspace,
    runDir: meta.runDir,
    factoryMetadata: meta.factoryMetadata,
    ...(meta.factoryStore ? { factoryStore: meta.factoryStore } : {}),
    ...(meta.warnings?.length ? { warnings: meta.warnings } : {}),
    summaryPath: meta.summaryPath,
    metaPath: meta.metaPath,
    linearComment,
    ...extra,
  };
}

function assertLinearPublicationIssueMatches(meta: FactoryPlanningRunMeta, issueRef: string): void {
  const tracker = meta.factoryMetadata?.tracker;
  if (tracker?.source !== "linear") {
    throw new FactoryPlanningError("Linear apply requires linear tracker metadata.");
  }
  const expected = parseLinearIssueIdentifier(tracker.id);
  const actual = parseLinearIssueIdentifier(issueRef);
  if (!expected || !actual) {
    throw new FactoryPlanningError(
      `Linear apply requires issue identifiers like TEAM-123: ${issueRef}`,
    );
  }
  if (expected.teamKey !== actual.teamKey || expected.number !== actual.number) {
    throw new FactoryPlanningError(
      `--linear-issue ${issueRef} does not match planning run tracker ${tracker.id}.`,
    );
  }
}

function requirePrUrl(value: string | undefined): string {
  if (!value) throw new FactoryPlanningError("--pr-url is required");
  return value;
}

function requireCommit(value: string | undefined): string {
  if (!value) throw new FactoryPlanningError("--commit is required");
  return value;
}

function requirePlanningFactoryMetadata(meta: FactoryPlanningRunMeta): {
  approvedPlanPath: string;
  approvedPlanPrUrl: string;
  approvedPlanCommit: string;
} {
  const metadata = meta.factoryMetadata;
  if (!metadata?.approvedPlanPath) {
    throw new FactoryPlanningError("Planning run is missing approvedPlanPath");
  }
  if (!metadata.approvedPlanPrUrl) {
    throw new FactoryPlanningError("Planning run is missing approvedPlanPrUrl");
  }
  return {
    approvedPlanPath: metadata.approvedPlanPath,
    approvedPlanPrUrl: metadata.approvedPlanPrUrl,
    approvedPlanCommit: metadata.approvedPlanCommit ?? "",
  };
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
      const role = resolveFactoryRoleAgent({
        workspace: options.workspace,
        station: "triage",
        role: "triager",
      });
      const linearSettings = options.linearIssue
        ? resolveFactoryLinearSettings({ workspace: role.workspace })
        : undefined;
      const store = resolveFactoryStore({
        workspace: role.workspace,
        factoryStoreRoot: options.factoryStoreRoot,
        factoryStoreProjectId: options.factoryStoreProjectId,
        env: process.env,
      });
      const factoryStore = factoryStoreForRun(store, options.runsDir);
      let linearAdapter: LinearFactoryAdapter | undefined;
      const linearAdapterFactory = options.linearIssue
        ? (adapterInput: Parameters<typeof createLinearFactoryAdapter>[0]) => {
            linearAdapter ??= createLinearFactoryAdapter(adapterInput);
            return linearAdapter;
          }
        : undefined;
      const input = await resolveFactoryWorkItemInput({
        workspace: role.workspace,
        itemFile: options.itemFile,
        linearIssue: options.linearIssue,
        linearSettings,
        env: process.env,
        linearAdapterFactory,
        lifecycleReadMode: options.dryRun ? "inspect" : "load",
        factoryStateRoot: store.factoryStateRoot,
      });

      const applyAdapter = options.apply ? requireLinearApplyAdapter(linearAdapter) : undefined;
      const { meta, startedUpdate, terminalUpdate, terminalApplyError } =
        await runFactoryTriageWithLinearApply({
          factoryStateRoot: store.factoryStateRoot,
          workItem: input.workItem,
          rerun: options.rerun,
          issueRef: options.linearIssue ?? "",
          itemFile: options.itemFile,
          applyAdapter,
          createContext: (signal) =>
            createFactoryRunContext({
              workspace: role.workspace,
              runsDir: options.runsDir ?? store.factoryRunsDir,
              factoryStore,
              workItem: input.workItem,
              agentProvider: role.agent,
              codexPathOverride: role.codexPathOverride,
              model: role.model,
              sandboxMode: role.sandboxMode,
              approvalPolicy: role.approvalPolicy,
              modelReasoningEffort: role.modelReasoningEffort,
              maxRuntimeMs: options.maxRuntimeMs,
              dryRun: options.dryRun,
              signal,
              eventSink: options.verbose ? config.writeVerboseWorkflowEvent : undefined,
              agentProviderFactory: createAgentProvider,
            }),
        });
      console.log(
        JSON.stringify(
          factoryTriageCliOutput(meta, {
            linearApplied: options.apply ? true : input.linearApplied,
            ...(options.apply
              ? { linearUpdate: { started: startedUpdate, terminal: terminalUpdate } }
              : {}),
            ...(input.warnings ? { warnings: input.warnings } : {}),
          }),
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

export async function runFactoryTriageWithLinearApply(input: {
  factoryStateRoot: string;
  workItem: FactoryWorkItem;
  rerun: boolean;
  issueRef: string;
  itemFile?: string;
  applyAdapter?: LinearFactoryAdapter;
  createContext: (signal: AbortSignal) => FactoryRunContext;
  runTriage?: (
    ctx: FactoryRunContext,
    options: { nextLiveRunRequiresRerun: boolean },
  ) => Promise<FactoryRunMeta>;
  announceRunStarted?: (input: Parameters<typeof announceFactoryRunStarted>[0]) => void;
  appendImported?: (input: Parameters<typeof appendWorkItemImportedEvent>[0]) => void;
  appendStarted?: (input: Parameters<typeof appendTriageStartedEvent>[0]) => void;
  appendTerminal?: (input: Parameters<typeof appendTriageTerminalEvent>[0]) => void;
}): Promise<{
  meta: FactoryRunMeta;
  startedUpdate?: LinearTriageUpdatePlan;
  terminalUpdate?: LinearTriageUpdatePlan;
  terminalApplyError?: unknown;
}> {
  const policy = assertFactoryTriageAllowed({
    factoryStateRoot: input.factoryStateRoot,
    workItem: input.workItem,
    rerun: input.rerun,
  });
  const announceRunStarted = input.announceRunStarted ?? announceFactoryRunStarted;
  const appendImported = input.appendImported ?? appendWorkItemImportedEvent;
  const appendStarted = input.appendStarted ?? appendTriageStartedEvent;
  const appendTerminal = input.appendTerminal ?? appendTriageTerminalEvent;
  const runTriage = input.runTriage ?? runFactoryTriage;
  const runAbort = new AbortController();
  const onRunAbort = () => runAbort.abort();
  process.once("SIGINT", onRunAbort);
  process.once("SIGTERM", onRunAbort);
  try {
    const ctx = input.createContext(runAbort.signal);
    announceRunStarted({
      station: "triage",
      runId: ctx.runId,
      runDir: ctx.runDir,
      workspace: ctx.workspace,
    });
    if (!ctx.dryRun) {
      const execution = lifecycleExecutionForRun(ctx.workspace, ctx.runDir, ctx.factoryStore);
      appendImported({
        workspace: ctx.workspace,
        workItem: input.workItem,
        factoryStateRoot: input.factoryStateRoot,
        execution,
      });
      const itemFile = lifecycleItemFilePath(ctx.workspace, input.itemFile);
      appendStarted({
        workspace: ctx.workspace,
        workItem: input.workItem,
        runId: ctx.runId,
        factoryStateRoot: input.factoryStateRoot,
        execution,
        ...(input.issueRef ? { linearIssue: input.issueRef } : {}),
        ...(itemFile ? { itemFile } : {}),
      });
    }
    let startedUpdate: LinearTriageUpdatePlan | undefined;
    if (input.applyAdapter) {
      startedUpdate = await input.applyAdapter.applyTriageStarted({
        issueRef: input.issueRef,
        runId: ctx.runId,
        runDir: ctx.runDir,
        rerun: input.rerun,
      });
    }
    let meta: FactoryRunMeta;
    try {
      meta = await runTriage(ctx, {
        nextLiveRunRequiresRerun: !ctx.dryRun || policy.hadPriorCompletion,
      });
    } catch (error) {
      meta = ctx.exportFailed(error);
    }
    const completedTriage =
      meta.status === "completed" ? readFactoryTriageArtifact(meta) : undefined;
    if (!ctx.dryRun) {
      appendTerminal({
        workspace: ctx.workspace,
        workItem: input.workItem,
        meta,
        triage: completedTriage,
        factoryStateRoot: input.factoryStateRoot,
      });
    }
    let terminalUpdate: LinearTriageUpdatePlan | undefined;
    let terminalApplyError: unknown;
    if (input.applyAdapter) {
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
      ...(startedUpdate ? { startedUpdate } : {}),
      ...(terminalUpdate ? { terminalUpdate } : {}),
      ...(terminalApplyError ? { terminalApplyError } : {}),
    };
  } finally {
    process.off("SIGINT", onRunAbort);
    process.off("SIGTERM", onRunAbort);
  }
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
  return parseFactoryTriageOutput(JSON.parse(readFileSync(triagePath, "utf8")));
}

function linearPlanningCompletedInput(
  meta: FactoryPlanningRunMeta,
  issueRef: string,
): LinearPlanningCompletedInput {
  const latestIteration = meta.iterations.at(-1);
  const latestIterationDir = latestIteration
    ? join(meta.runDir, "iterations", String(latestIteration.index))
    : undefined;
  return {
    issueRef,
    runId: meta.runId,
    runDir: meta.runDir,
    status: meta.status,
    approvedPlanPath:
      meta.factoryMetadata?.approvedPlanPath ??
      (meta.outputPlan ? formatPlanningDisplayPath(meta, meta.outputPlan) : undefined),
    draftPlanPath: latestIteration?.planPath
      ? formatPlanningDisplayPath(meta, latestIteration.planPath)
      : undefined,
    reviewFindingsPath:
      meta.status === "plan-review-unresolved" && latestIterationDir
        ? formatPlanningDisplayPath(meta, join(latestIterationDir, "review-findings.json"))
        : undefined,
    humanQuestions: meta.humanQuestions,
    error: meta.error,
  };
}

function formatPlanningDisplayPath(meta: FactoryPlanningRunMeta, path: string): string {
  return formatLifecycleArtifactPath({
    runDir: meta.runDir,
    projectRoot: meta.factoryStore?.projectRoot,
    path,
  });
}
