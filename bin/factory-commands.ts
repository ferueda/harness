import { InvalidArgumentError, type Command } from "commander";
import { factoryTriageCliOutput } from "./factory-triage-cli.ts";
import {
  resolveFactoryLinearSettings,
  resolveFactoryPlanningSettings,
  resolveFactoryRoleAgent,
  resolveHarnessOptions,
} from "../lib/config.ts";
import { factoryInboxStatus } from "../lib/factory-inbox.ts";
import { createLinearFactoryAdapter } from "../lib/factory-linear-adapter.ts";
import {
  createFactoryPlanningRunContext,
  type FactoryPlanningRunMeta,
} from "../lib/factory-planning-run-context.ts";
import {
  assertFactoryItemFileExists,
  resolveFactoryTriageWorkItem,
  validateFactoryTriageWorkItemInput,
} from "../lib/factory-triage-input.ts";
import {
  createFactoryRunContext,
  readFactoryWorkItemFile,
  type FactoryRunMeta,
} from "../lib/factory-run-context.ts";
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
  dryRun: boolean;
  verbose: boolean;
};

type FactoryPlanningStationOptions = {
  workspace?: string;
  itemFile: string;
  runsDir?: string;
  outputPlan?: string;
  maxReviewIterations?: number;
  maxRuntimeMs: number;
  dryRun: boolean;
  verbose: boolean;
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
      const settings = resolveFactoryLinearSettings({ workspace: options.workspace });
      const apiKey = process.env.LINEAR_API_KEY;
      if (!apiKey) {
        throw new Error("LINEAR_API_KEY is required for Linear commands.");
      }
      const adapter = createLinearFactoryAdapter({ apiKey, settings });
      const workItem = await adapter.fetchWorkItem(issue);
      console.log(JSON.stringify(workItem, null, 2));
    });
}

function addFactoryPlanningStationCommand(parent: Command, config: FactoryCommandOptions): void {
  parent
    .command("planning")
    .description("Run one factory work item through the planning station")
    .option("--workspace <path>", "target repo")
    .requiredOption("--item-file <path>", "factory work item JSON file")
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
    .option("--dry-run", "prepare context and placeholder plan only", false)
    .option("--verbose", "emit workflow events as JSONL to stderr", false)
    .action(async (options: FactoryPlanningStationOptions) => {
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
      const itemPath = assertFactoryItemFileExists(settings.workspace, options.itemFile);
      const workItem = readFactoryWorkItemFile(itemPath);

      const runAbort = new AbortController();
      const onRunAbort = () => runAbort.abort();
      process.once("SIGINT", onRunAbort);
      process.once("SIGTERM", onRunAbort);
      let meta: FactoryPlanningRunMeta;
      try {
        const ctx = createFactoryPlanningRunContext({
          workspace: settings.workspace,
          runsDir: options.runsDir,
          workItem,
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
        meta = await runFactoryPlanning(ctx);
      } finally {
        process.off("SIGINT", onRunAbort);
        process.off("SIGTERM", onRunAbort);
      }
      console.log(JSON.stringify(factoryPlanningCliOutput(meta), null, 2));
      process.exitCode =
        meta.status === "planning-failed" || meta.status === "plan-review-unresolved" ? 1 : 0;
    });
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("must be a positive integer");
  }
  return parsed;
}

function factoryPlanningCliOutput(meta: FactoryPlanningRunMeta) {
  return {
    runId: meta.runId,
    workflow: meta.workflow,
    status: meta.status,
    workspace: meta.workspace,
    runDir: meta.runDir,
    workItem: meta.workItem,
    outputPlan: meta.outputPlan,
    iterations: meta.iterations.length,
    summaryPath: meta.summaryPath,
    metaPath: meta.metaPath,
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
    .option("--dry-run", "prepare context and placeholder routing only", false)
    .option("--verbose", "emit workflow events as JSONL to stderr", false)
    .action(async (options: FactoryTriageStationOptions) => {
      const role = resolveFactoryRoleAgent({
        workspace: options.workspace,
        station: "triage",
        role: "triager",
      });
      validateFactoryTriageWorkItemInput(options);
      const linearSettings = options.linearIssue
        ? resolveFactoryLinearSettings({ workspace: role.workspace })
        : undefined;
      const input = await resolveFactoryTriageWorkItem({
        workspace: role.workspace,
        itemFile: options.itemFile,
        linearIssue: options.linearIssue,
        linearSettings,
        env: process.env,
      });

      const runAbort = new AbortController();
      const onRunAbort = () => runAbort.abort();
      process.once("SIGINT", onRunAbort);
      process.once("SIGTERM", onRunAbort);
      let meta: FactoryRunMeta;
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
        meta = await runFactoryTriage(ctx);
      } finally {
        process.off("SIGINT", onRunAbort);
        process.off("SIGTERM", onRunAbort);
      }
      console.log(
        JSON.stringify(
          factoryTriageCliOutput(meta, { linearApplied: input.linearApplied }),
          null,
          2,
        ),
      );
      process.exitCode = meta.status === "failed" ? 1 : 0;
    });
}
