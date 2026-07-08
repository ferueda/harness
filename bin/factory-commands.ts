import { InvalidArgumentError, type Command } from "commander";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
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
import { factoryInboxStatus } from "../lib/factory-inbox.ts";
import {
  appendPlanPrMergedEvent,
  appendPlanPrOpenedEvent,
  appendPlanningStartedEvent,
  appendPlanningTerminalEvent,
  appendTriageStartedEvent,
  appendTriageTerminalEvent,
  appendWorkItemImportedEvent,
} from "../lib/factory-lifecycle-writes.ts";
import {
  createLinearFactoryAdapter,
  parseLinearIssueIdentifier,
  type LinearFactoryAdapter,
  type LinearTriageUpdatePlan,
} from "../lib/factory-linear-adapter.ts";
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
import { createFactoryRunContext, type FactoryRunMeta } from "../lib/factory-run-context.ts";
import {
  parseFactoryTriageOutput,
  type FactoryTriageOutput,
  type FactoryWorkItem,
} from "../lib/factory-schemas.ts";
import type { WorkflowEvent } from "../lib/workflow-events.ts";
import { createAgentProvider } from "../providers/registry.ts";
import { run as runFactoryPlanning } from "../workflows/factory-planning.workflow.ts";
import { run as runFactoryTriage } from "../workflows/factory-triage.workflow.ts";

type FactoryStatusOptions = {
  workspace?: string;
  inboxDir?: string;
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
};

type FactoryPlanningPublishOptions = {
  runDir: string;
  prUrl: string;
  linearIssue?: string;
  apply: boolean;
};

type FactoryPlanningMarkMergedOptions = {
  runDir: string;
  commit: string;
  linearIssue?: string;
  apply: boolean;
};

type FactoryLinearFetchOptions = {
  workspace?: string;
};

type FactoryCommandOptions = {
  positiveNumber: (value: string) => number;
  defaultMaxRuntimeMs: number;
  writeVerboseWorkflowEvent: (event: WorkflowEvent) => void;
};

export function addFactoryCommands(parent: Command, options: FactoryCommandOptions): void {
  const factory = parent.command("factory").description("Manage local factory intake");
  addFactoryStatusCommand(factory);
  addFactoryLinearCommand(factory);
  addFactoryTriageStationCommand(factory, options);
  addFactoryPlanningStationCommand(factory, options);
}

function addFactoryStatusCommand(parent: Command): void {
  parent
    .command("status")
    .description("Inspect local factory inbox state")
    .option("--workspace <path>", "target repo")
    .option(
      "--inbox-dir <path>",
      "factory inbox root (default: <workspace>/.harness/inbox/factory)",
    )
    .action((options: FactoryStatusOptions) => {
      const resolvedOptions = resolveHarnessOptions({
        workspace: options.workspace,
      });
      const result = factoryInboxStatus({
        workspace: resolvedOptions.workspace,
        inboxDir: options.inboxDir,
      });
      console.log(JSON.stringify(result, null, 2));
    });
}

function addFactoryLinearCommand(parent: Command): void {
  const linear = parent.command("linear").description("Read Linear issues as factory work items");

  linear
    .command("fetch")
    .description("Fetch one Linear issue and print a factory work item")
    .argument("<issue>", "Linear issue identifier, e.g. TEAM-123")
    .option("--workspace <path>", "target repo")
    .action(async (issue: string, options: FactoryLinearFetchOptions) => {
      const workItem = await fetchFactoryLinearWorkItem({
        issue,
        workspace: options.workspace,
        env: process.env,
      });
      console.log(JSON.stringify(workItem, null, 2));
    });
}

export async function fetchFactoryLinearWorkItem(input: {
  issue: string;
  workspace?: string;
  env?: NodeJS.ProcessEnv;
  resolveLinearSettings?: (input: { workspace?: string }) => FactoryLinearSettings;
  adapterFactory?: (input: {
    apiKey: string;
    settings: FactoryLinearSettings;
  }) => LinearFactoryAdapter;
}): Promise<FactoryWorkItem> {
  const settings = (input.resolveLinearSettings ?? resolveFactoryLinearSettings)({
    workspace: input.workspace,
  });
  const apiKey = input.env?.LINEAR_API_KEY;
  if (!apiKey) {
    throw new Error("LINEAR_API_KEY is required for Linear commands.");
  }
  const adapter = (input.adapterFactory ?? createLinearFactoryAdapter)({ apiKey, settings });
  return mergeLifecycleState({
    workspace: resolveHarnessOptions({ workspace: input.workspace }).workspace,
    workItem: await adapter.fetchWorkItem(input.issue),
  });
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
    .option("--apply", "apply deterministic Linear status/comment updates", false)
    .action(async (options: FactoryPlanningPublishOptions) => {
      const result = await runFactoryPlanningPublicationWithLinearApply({
        mode: "publish",
        runDir: options.runDir,
        prUrl: options.prUrl,
        issueRef: options.linearIssue,
        apply: options.apply,
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
    .option("--apply", "apply deterministic Linear status/comment updates", false)
    .action(async (options: FactoryPlanningMarkMergedOptions) => {
      const result = await runFactoryPlanningPublicationWithLinearApply({
        mode: "mark-plan-merged",
        runDir: options.runDir,
        commit: options.commit,
        issueRef: options.linearIssue,
        apply: options.apply,
        env: process.env,
      });
      console.log(JSON.stringify(result.output, null, 2));
      if (result.terminalApplyError) {
        throw result.terminalApplyError;
      }
    });
}

function addFactoryPlanningRunCommand(parent: Command, config: FactoryCommandOptions): void {
  parent
    .command("run", { isDefault: true })
    .description("Run one factory work item through the planning station")
    .option("--workspace <path>", "target repo")
    .option("--item-file <path>", "factory work item JSON file")
    .option("--linear-issue <issue>", "Linear issue identifier, e.g. TEAM-123")
    .option("--runs-dir <path>", "output root (default: <workspace>/.harness/runs/factory)")
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
          runsDir: options.runsDir,
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
        const applyAdapter = options.apply ? requireLinearApplyAdapter(linearAdapter) : undefined;
        ({ meta, linearUpdate, terminalApplyError } = await runFactoryPlanningWithLinearApply({
          ctx,
          issueRef: options.linearIssue ?? "",
          itemFile: options.itemFile,
          applyAdapter,
        }));
      } finally {
        process.off("SIGINT", onRunAbort);
        process.off("SIGTERM", onRunAbort);
      }
      console.log(
        JSON.stringify(
          factoryPlanningCliOutput(
            meta,
            options.apply
              ? { linearApplied: true, linearUpdate }
              : options.linearIssue
                ? { linearApplied: false }
                : {},
          ),
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
}): Promise<{
  meta: FactoryPlanningRunMeta;
  linearUpdate?: FactoryPlanningLinearUpdate;
  terminalApplyError?: unknown;
}> {
  const runPlanning = input.runPlanning ?? runFactoryPlanning;
  let startedUpdate: LinearPlanningUpdatePlan | undefined;
  let terminalUpdate: LinearPlanningUpdatePlan | undefined;
  if (!input.ctx.dryRun) {
    appendWorkItemImportedEvent({
      workspace: input.ctx.workspace,
      workItem: input.ctx.workItem,
      execution: { workspace: input.ctx.workspace, runDir: input.ctx.runDir },
    });
    appendPlanningStartedEvent({
      workspace: input.ctx.workspace,
      workItem: input.ctx.workItem,
      runId: input.ctx.runId,
      execution: { workspace: input.ctx.workspace, runDir: input.ctx.runDir },
      ...(input.issueRef ? { linearIssue: input.issueRef } : {}),
      ...(input.itemFile ? { itemFile: input.itemFile } : {}),
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
    appendPlanningTerminalEvent({ meta });
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
  const existingMeta = loadFactoryPlanningRunMeta(input.runDir);
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
    appendPlanPrOpenedEvent({ meta });
  } else {
    appendPlanPrMergedEvent({ meta });
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
    .option("--runs-dir <path>", "output root (default: <workspace>/.harness/runs/factory)")
    .option(
      "--max-runtime-ms <ms>",
      `triage timeout (default: ${config.defaultMaxRuntimeMs})`,
      config.positiveNumber,
      config.defaultMaxRuntimeMs,
    )
    .option("--apply", "apply deterministic Linear status/comment updates", false)
    .option("--dry-run", "prepare context and placeholder routing only", false)
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
      });

      const runAbort = new AbortController();
      const onRunAbort = () => runAbort.abort();
      process.once("SIGINT", onRunAbort);
      process.once("SIGTERM", onRunAbort);
      let meta: FactoryRunMeta;
      let startedUpdate: LinearTriageUpdatePlan | undefined;
      let terminalUpdate: LinearTriageUpdatePlan | undefined;
      let terminalApplyError: unknown;
      try {
        const ctx = createFactoryRunContext({
          workspace: role.workspace,
          runsDir: options.runsDir,
          workItem: input.workItem,
          agentProvider: role.agent,
          codexPathOverride: role.codexPathOverride,
          model: role.model,
          sandboxMode: role.sandboxMode,
          approvalPolicy: role.approvalPolicy,
          modelReasoningEffort: role.modelReasoningEffort,
          maxRuntimeMs: options.maxRuntimeMs,
          dryRun: options.dryRun,
          signal: runAbort.signal,
          eventSink: options.verbose ? config.writeVerboseWorkflowEvent : undefined,
          agentProviderFactory: createAgentProvider,
        });
        const applyAdapter = options.apply ? requireLinearApplyAdapter(linearAdapter) : undefined;
        if (!options.dryRun) {
          appendWorkItemImportedEvent({
            workspace: role.workspace,
            workItem: input.workItem,
            execution: { workspace: ctx.workspace, runDir: ctx.runDir },
          });
          appendTriageStartedEvent({
            workspace: role.workspace,
            workItem: input.workItem,
            runId: ctx.runId,
            execution: { workspace: ctx.workspace, runDir: ctx.runDir },
            linearIssue: options.linearIssue,
            itemFile: options.itemFile,
          });
        }
        if (applyAdapter) {
          startedUpdate = await applyAdapter.applyTriageStarted({
            issueRef: options.linearIssue ?? "",
            runId: ctx.runId,
            runDir: ctx.runDir,
          });
        }
        try {
          meta = await runFactoryTriage(ctx);
        } catch (error) {
          meta = ctx.exportFailed(error);
        }
        const completedTriage =
          meta.status === "completed" ? readFactoryTriageArtifact(meta) : undefined;
        if (!options.dryRun) {
          appendTriageTerminalEvent({
            workspace: role.workspace,
            workItem: input.workItem,
            meta,
            triage: completedTriage,
          });
        }
        if (applyAdapter) {
          try {
            if (completedTriage) {
              terminalUpdate = await applyAdapter.applyTriageCompleted({
                issueRef: options.linearIssue ?? "",
                runId: ctx.runId,
                runDir: ctx.runDir,
                triage: completedTriage,
              });
            } else {
              terminalUpdate = await applyAdapter.applyTriageFailed({
                issueRef: options.linearIssue ?? "",
                runId: ctx.runId,
                runDir: ctx.runDir,
                error: meta.error ?? "Factory triage failed.",
              });
            }
          } catch (error) {
            terminalApplyError = error;
          }
        }
      } finally {
        process.off("SIGINT", onRunAbort);
        process.off("SIGTERM", onRunAbort);
      }
      console.log(
        JSON.stringify(
          factoryTriageCliOutput(meta, {
            linearApplied: options.apply ? true : input.linearApplied,
            ...(options.apply
              ? { linearUpdate: { started: startedUpdate, terminal: terminalUpdate } }
              : {}),
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
      (meta.outputPlan ? relative(meta.workspace, meta.outputPlan) : undefined),
    draftPlanPath: latestIteration?.planPath
      ? relative(meta.workspace, latestIteration.planPath)
      : undefined,
    reviewFindingsPath:
      meta.status === "plan-review-unresolved" && latestIterationDir
        ? relative(meta.workspace, join(latestIterationDir, "review-findings.json"))
        : undefined,
    humanQuestions: meta.humanQuestions,
    error: meta.error,
  };
}
