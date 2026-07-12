import { InvalidArgumentError, type Command } from "commander";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { stdin as processStdin } from "node:process";
import type { Readable } from "node:stream";
import { factoryImplementationCliOutput } from "./factory-implementation-cli.ts";
import {
  factoryPlanningCliOutput,
  type FactoryPlanningLinearUpdate,
} from "./factory-planning-cli.ts";
import { factoryTriageCliOutput } from "./factory-triage-cli.ts";
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
import type { FactoryLifecycleEvent as FactoryActionLifecycleEvent } from "../lib/factory-lifecycle-events.ts";
import {
  readFactoryPhaseRunIdentity,
  writeFactoryPhaseRunIdentity,
} from "../lib/factory-phase-run.ts";
import { assertFactoryStoreFormat } from "../lib/factory-store-format.ts";
import {
  decideNextFactoryAction,
  reduceFactoryLifecycleEvents,
  type FactoryReaction,
} from "../lib/factory-state-machine.ts";
import { errorMessage } from "../lib/agent-invoke.ts";
import {
  resolveFactoryLinearSettings,
  resolveFactoryPlanningSettings,
  resolveFactoryRoleAgent,
  factoryTriageExecutionProfile,
  resolveHarnessWorkspace,
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
import { LinearImplementationTerminalApplyError } from "../lib/factory-linear-implementation-apply.ts";
import { withFactoryImplementationExecutionLease } from "../lib/factory-implementation-policy.ts";
import {
  createFactoryImplementationRunContext,
  type FactoryImplementationRunContext,
  type FactoryImplementationRunMeta,
} from "../lib/factory-implementation-run-context.ts";
import { factoryStatus } from "../lib/factory-status.ts";
import {
  deriveFactoryWorkItemKey,
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
import {
  parseFactoryTriageOutput,
  type FactoryTriageOutput,
  type FactoryWorkItem,
} from "../lib/factory-schemas.ts";
import type { WorkflowEvent } from "../lib/workflow-events.ts";
import { createAgentProvider } from "../providers/registry.ts";
import { run as runFactoryImplementation } from "../workflows/factory-implementation.workflow.ts";
import { run as runFactoryPlanning } from "../workflows/factory-planning.workflow.ts";
import { run as runFactoryTriage } from "../workflows/factory-triage.workflow.ts";

const unshippedPhaseUnavailable = (..._args: unknown[]): never => {
  throw new Error("This Factory phase is unavailable until its action PR ships.");
};
const appendImplementationStartedEvent = unshippedPhaseUnavailable;
const appendImplementationTerminalEvent = unshippedPhaseUnavailable;
const appendPlanPrMergedEvent = unshippedPhaseUnavailable;
const appendPlanPrOpenedEvent = unshippedPhaseUnavailable;
const appendPlanningStartedEvent = unshippedPhaseUnavailable;
const appendPlanningTerminalEvent = unshippedPhaseUnavailable;
const appendWorkItemImportedEvent = unshippedPhaseUnavailable;
const formatLifecycleArtifactPath = unshippedPhaseUnavailable;

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
  implementationExecutionLease?: typeof withFactoryImplementationExecutionLease;
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
    .action(async (_options: FactoryPlanningPublishOptions) => {
      throw new FactoryPlanningError(
        "Factory planning publication is unavailable until the planning action follow-up ships.",
      );
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
    .action(async (_options: FactoryPlanningMarkMergedOptions) => {
      throw new FactoryPlanningError(
        "Factory planning publication is unavailable until the planning action follow-up ships.",
      );
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
      rejectUnavailableImplementation();
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
      assertLegacyPhaseStoreAvailable(store.factoryStateRoot, "implementation");
      const factoryStore = factoryStoreForRun(store, options.runsDir);
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
      let implementationInput = resolveFactoryImplementationInput({
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
          const ctx = createFactoryImplementationRunContext({
            workspace: implementerRole.workspace,
            runsDir: options.runsDir ?? store.factoryRunsDir,
            factoryStore,
            workItem: activeInput.workItem,
            implementationInput,
            implementerRole,
            dryRun: Boolean(options.dryRun),
            maxRuntimeMs: options.maxRuntimeMs,
            signal: runAbort.signal,
            eventSink: options.verbose ? config.writeVerboseWorkflowEvent : undefined,
            linearApplyRequested: options.apply,
            agentProviderFactory: config.implementationAgentProviderFactory ?? createAgentProvider,
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
        };
        if (options.dryRun) await run();
        else {
          let leaseInput = input;
          let identityChanges = 0;
          for (;;) {
            let refreshedInput: typeof input | undefined;
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
                await run();
              },
            });
            if (!refreshedInput) break;
            leaseInput = refreshedInput;
          }
        }
      } finally {
        process.off("SIGINT", onRunAbort);
        process.off("SIGTERM", onRunAbort);
      }
    });
}

function rejectUnavailableImplementation(): void {
  throw new Error("Factory implementation is not available until its action follow-up ships.");
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

  // Item-file is an input reference, not a run artifact; keep its workspace path.
  const itemFileRelative = lifecycleItemFilePath(input.ctx.workspace, input.itemFile);
  appendFactoryImplementationStartAudit({
    ctx: input.ctx,
    factoryStateRoot: input.factoryStateRoot,
    issueRef: input.issueRef,
    itemFile: itemFileRelative,
  });
  return runFactoryImplementationToLocalTerminal({
    ctx: input.ctx,
    factoryStateRoot: input.factoryStateRoot,
    runImplementation,
  });
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
    ...(input.issueRef ? { linearIssue: input.issueRef } : {}),
    ...(input.itemFile ? { itemFile: input.itemFile } : {}),
  });
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
  appendFactoryImplementationStartAudit({
    ctx: input.ctx,
    factoryStateRoot: input.factoryStateRoot,
    issueRef: input.issueRef,
  });
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
    return {
      meta,
      startApplyFailed: true,
      terminalApplyFailed: false,
      startApplyError,
    };
  }
  const meta = await runFactoryImplementationToLocalTerminal({
    ctx: input.ctx,
    factoryStateRoot: input.factoryStateRoot,
    runImplementation: input.runImplementation ?? runFactoryImplementation,
  });
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
      "maximum completed plan reviews (default: factory.planning.maxReviewIterations or 3)",
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
      rejectUnavailablePlanning();
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
      assertLegacyPhaseStoreAvailable(store.factoryStateRoot, "planning");
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

function rejectUnavailablePlanning(): void {
  throw new Error("Factory planning is not available until its action follow-up ships.");
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
          const executionProfile = existingRunId
            ? readFactoryPhaseRunIdentity(
                join(options.runsDir ?? store.factoryRunsDir, existingRunId),
              ).actions.triageWorkItem
            : factoryTriageExecutionProfile(
                resolveFactoryRoleAgent({
                  workspace,
                  station: "triage",
                  role: "triager",
                }),
              );
          return createFactoryRunContext({
            workspace,
            runsDir: options.runsDir ?? store.factoryRunsDir,
            factoryStore,
            ...(existingRunId ? { existingRunId } : {}),
            workItem: input.workItem,
            executionProfile,
            maxRuntimeMs: options.maxRuntimeMs,
            dryRun: options.dryRun,
            signal,
            eventSink: options.verbose ? config.writeVerboseWorkflowEvent : undefined,
            agentProviderFactory: createAgentProvider,
          });
        },
      });
      if ("waiting" in result) {
        console.log(
          JSON.stringify(
            {
              outcome: "waiting",
              phase: "triage",
              ...(result.phaseRunId ? { phaseRunId: result.phaseRunId } : {}),
              next: result.next,
            },
            null,
            2,
          ),
        );
        process.exitCode = 0;
        return;
      }
      const { meta, startedUpdate, terminalUpdate, terminalApplyError } = result;
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
            outcome:
              meta.status === "completed"
                ? "action-completed"
                : meta.status === "dry_run"
                  ? "waiting"
                  : "failed",
            phase: "triage",
            phaseRunId: result.phaseRunId,
            ...(meta.status === "dry_run" ? {} : { action: result.action }),
            next: result.next,
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
      existingLatest.data.failureKind !== "retryable" &&
      !existingLatest.data.message.startsWith("Linear start projection failed:"));
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
    if (activeTriage && !ctx.dryRun) {
      const published = recoverCompletedTriageRun(ctx, activeTriage.reaction);
      if (published) {
        const actionDir = join(
          ctx.runDir,
          "actions",
          String(activeTriage.reaction.attempt),
          activeTriage.reaction.handler,
          factoryActionKey({ ...activeTriage.reaction, phaseRunId: ctx.runId }),
        );
        writeFactoryActionResult(actionDir, published.event);
        const appended = appendFactoryActionEvent({
          factoryStateRoot: input.factoryStateRoot,
          event: published.event,
          expectedLastEventId: activeTriage.reaction.causationEventId,
        });
        let terminalUpdate: LinearTriageUpdatePlan | undefined;
        let terminalApplyError: unknown;
        if (input.applyAdapter) {
          try {
            terminalUpdate = await input.applyAdapter.applyTriageCompleted({
              issueRef: input.issueRef,
              runId: ctx.runId,
              runDir: ctx.runDir,
              triage: published.triage,
            });
          } catch (error) {
            terminalApplyError = error;
          }
        }
        return {
          meta: published.meta,
          phaseRunId: ctx.runId,
          action: {
            handler: "triageWorkItem",
            attempt: 1,
            eventId: published.event.id,
          },
          next: decideNextFactoryAction(appended.state, appended.event),
          ...(terminalUpdate ? { terminalUpdate } : {}),
          ...(terminalApplyError ? { terminalApplyError } : {}),
        };
      }
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
      writeFactoryPhaseRunIdentity(ctx.runDir, {
        version: 1,
        phaseRunId: ctx.runId,
        phase: "triage",
        workItemKey: key,
        workspace: resolve(ctx.workspace),
        projectId: ctx.factoryStore!.projectId,
        factoryStateRoot: resolve(input.factoryStateRoot),
        actions: { triageWorkItem: ctx.executionProfile },
      });
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
    let startApplyError: unknown;
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
      try {
        startedUpdate = await input.applyAdapter.applyTriageStarted({
          issueRef: input.issueRef,
          runId: ctx.runId,
          runDir: ctx.runDir,
          rerun: input.rerun,
          continuation: Boolean(activeTriage),
        });
      } catch (error) {
        startApplyError = error;
      }
    }
    let meta: FactoryRunMeta;
    if (startApplyError) {
      meta = ctx.exportFailed(
        new Error(`Linear start projection failed: ${errorMessage(startApplyError)}`, {
          cause: startApplyError,
        }),
      );
    } else
      try {
        meta = await runTriage(ctx, {
          nextLiveRunRequiresRerun: !ctx.dryRun || policy.hadPriorCompletion,
        });
      } catch (error) {
        meta = ctx.exportFailed(error);
      }
    let completedTriage: FactoryTriageOutput | undefined;
    if (meta.status === "completed") {
      try {
        completedTriage = readFactoryTriageArtifact(meta);
      } catch (error) {
        meta = ctx.exportFailed(error);
      }
    }
    let terminalAction: FactoryActionLifecycleEvent | undefined;
    let next: FactoryReaction = { kind: "wait", reason: "human" };
    if (!ctx.dryRun && reaction?.kind === "invoke" && ctx.factoryStore) {
      try {
        terminalAction = buildTriageActionEvent(ctx, meta, completedTriage, reaction);
      } catch (error) {
        meta = ctx.exportFailed(error);
        completedTriage = undefined;
        terminalAction = buildTriageActionEvent(ctx, meta, undefined, reaction);
      }
      const actionDir = join(
        ctx.runDir,
        "actions",
        String(reaction.attempt),
        reaction.handler,
        factoryActionKey({ ...reaction, phaseRunId: ctx.runId }),
      );
      writeFactoryActionResult(actionDir, terminalAction);
      const appended = appendFactoryActionEvent({
        factoryStateRoot: input.factoryStateRoot,
        event: terminalAction,
        expectedLastEventId: reaction.causationEventId,
      });
      next = decideNextFactoryAction(appended.state, appended.event);
    }
    let terminalUpdate: LinearTriageUpdatePlan | undefined;
    let terminalApplyError: unknown;
    if (input.applyAdapter && !ctx.dryRun && !startApplyError && meta.failureKind !== "retryable") {
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
      ...(terminalApplyError || startApplyError
        ? { terminalApplyError: terminalApplyError ?? startApplyError }
        : {}),
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
            ? readVerifiedFactoryTriageArtifact(meta, latest)
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
              triage: readVerifiedFactoryTriageArtifact(meta, terminal),
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

function assertLegacyPhaseStoreAvailable(
  _factoryStateRoot: string,
  phase: "planning" | "implementation",
): void {
  throw new Error(
    `Factory ${phase} action coordination is unavailable until its dedicated follow-up PR ships.`,
  );
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

function recoverCompletedTriageRun(
  ctx: FactoryRunContext,
  reaction: Extract<FactoryReaction, { kind: "invoke" }>,
):
  | {
      meta: FactoryRunMeta;
      triage: FactoryTriageOutput;
      event: Extract<FactoryActionLifecycleEvent, { type: "triage.work_item.completed" }>;
    }
  | undefined {
  const metaPath = join(ctx.runDir, "meta.json");
  if (!existsSync(metaPath)) return undefined;
  const value: unknown = JSON.parse(readFileSync(metaPath, "utf8"));
  assertFactoryRunMeta(value);
  if (value.status !== "completed") return undefined;
  if (
    value.runId !== ctx.runId ||
    resolve(value.runDir) !== resolve(ctx.runDir) ||
    resolve(value.workspace) !== resolve(ctx.workspace) ||
    value.workItem.id !== ctx.workItem.id ||
    resolve(value.factoryStore?.factoryStateRoot ?? "") !==
      resolve(ctx.factoryStore?.factoryStateRoot ?? "")
  ) {
    throw new Error(`Completed Factory run metadata conflicts with ${ctx.runId}`);
  }
  const triage = readFactoryTriageArtifact(value);
  const event = buildTriageActionEvent(ctx, value, triage, reaction);
  if (event.type !== "triage.work_item.completed") {
    throw new Error(`Completed Factory run ${ctx.runId} produced a failure event`);
  }
  return { meta: value, triage, event };
}

function readVerifiedFactoryTriageArtifact(
  meta: FactoryRunMeta,
  event: Extract<FactoryActionLifecycleEvent, { type: "triage.work_item.completed" }>,
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
    "factory-store": dirname(meta.factoryStore?.factoryStateRoot ?? ""),
    repository: meta.workspace,
  };
  const evidencePaths = event.data.evidence.map((ref) =>
    resolve(verifyFactoryArtifactRef(ref, roots)),
  );
  const triagePath = evidencePaths.find(
    (path) =>
      basename(path) === basename(relativePath) && !relative(runRoot, path).startsWith(".."),
  );
  if (!triagePath) {
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

function buildTriageActionEvent(
  ctx: FactoryRunContext,
  meta: FactoryRunMeta,
  triage: FactoryTriageOutput | undefined,
  reaction: Extract<FactoryReaction, { kind: "invoke" }>,
): Extract<
  FactoryActionLifecycleEvent,
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
  const summaryPath = publishImmutableActionEvidence(
    join(meta.runDir, meta.artifacts?.summary ?? "meta.json"),
    join(evidenceDir, "summary.md"),
  );
  const runRef = createFactoryArtifactRef({
    base: "factory-store",
    root: store.projectRoot,
    path: relative(store.projectRoot, summaryPath),
  });
  const triagePath = triage
    ? publishImmutableActionEvidence(
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
  if (!triage || meta.status !== "completed") {
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
  }
  const routePlanPath = publishImmutableActionEvidence(
    join(meta.runDir, "factory-route.json"),
    join(evidenceDir, "factory-route.json"),
  );
  const routePlanValue: unknown = JSON.parse(readFileSync(routePlanPath, "utf8"));
  if (!isRecord(routePlanValue)) throw new Error("Factory triage route plan is invalid");
  const nextCommand =
    typeof routePlanValue.command === "string" && routePlanValue.command.trim()
      ? routePlanValue.command.trim()
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

function publishImmutableActionEvidence(source: string, destination: string): string {
  mkdirSync(dirname(destination), { recursive: true });
  if (existsSync(destination)) {
    if (!readFileSync(source).equals(readFileSync(destination))) {
      throw new Error(`Factory action evidence conflicts with ${destination}`);
    }
    return destination;
  }
  copyFileSync(source, destination);
  return destination;
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
