import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Agent,
  type AgentApprovalPolicy,
  type AgentProviderName,
  type AgentProviderOptions,
  type AgentReasoningEffort,
  type AgentRunInput,
  type AgentRunResult,
  type AgentSandboxMode,
} from "./agents.ts";
import { DEFAULT_AGENT_MODELS, DEFAULT_CODEX_REASONING_EFFORT } from "./agents.ts";
import { buildRunId, fillTemplate } from "./context.ts";
import {
  DRY_RUN_FACTORY_TRIAGE,
  renderFactoryRouteMarkdown,
  renderFactoryTriageSummary,
} from "./factory-intake.ts";
import {
  FactoryTriageError,
  parseFactoryTriageOutput,
  parseFactoryWorkItem,
  type FactoryRoutePlan,
  type FactoryTriageOutput,
  type FactoryWorkItem,
} from "./factory-schemas.ts";
import { FACTORY_TRIAGE_PROMPT } from "./prompts/index.ts";
import {
  WORKFLOW_EVENTS_FILE,
  createCompositeEventSink,
  createFileEventSink,
  noopEventSink,
  type WorkflowEventSink,
} from "./workflow-events.ts";

type FactoryRunStatus = "completed" | "dry_run" | "failed";

export type FactoryRunMeta = {
  runId: string;
  workflow: "factory-triage";
  status: FactoryRunStatus;
  workspace: string;
  runDir: string;
  workItem: {
    id: string;
    source: FactoryWorkItem["source"];
    title: string;
  };
  route?: FactoryTriageOutput["route"];
  nextAction?: FactoryRoutePlan["nextAction"];
  artifacts?: {
    triage: string;
    route: string;
    routeSummary: string;
    summary: string;
  };
  agent: {
    name: AgentProviderName;
    model: string;
    sandboxMode?: AgentSandboxMode;
    approvalPolicy?: AgentApprovalPolicy;
    modelReasoningEffort?: AgentReasoningEffort;
  };
  startedAt: string;
  durationMs: number;
  eventsFile?: typeof WORKFLOW_EVENTS_FILE;
  error?: string;
};

export type FactoryRunContext = {
  runId: string;
  runDir: string;
  workspace: string;
  workItem: FactoryWorkItem;
  dryRun?: boolean;
  eventSink: WorkflowEventSink;
  invokeTriageAgent(): Promise<FactoryTriageOutput>;
  export(input: { triage: FactoryTriageOutput; routePlan: FactoryRoutePlan }): FactoryRunMeta;
  exportFailed(error: unknown): FactoryRunMeta;
};

export type FactoryRunContextFactoryOptions = {
  workspace: string;
  runsDir?: string;
  workItem: FactoryWorkItem;
  agentProvider?: AgentProviderName;
  codexPathOverride?: string;
  model?: string;
  sandboxMode?: AgentSandboxMode;
  approvalPolicy?: AgentApprovalPolicy;
  modelReasoningEffort?: AgentReasoningEffort;
  maxRuntimeMs: number;
  dryRun?: boolean;
  signal?: AbortSignal;
  eventSink?: WorkflowEventSink;
  agentProviderFactory?: (options: AgentProviderOptions) => Agent;
};

const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IS_BUILT_OUTPUT = basename(MODULE_ROOT) === "dist";
const HARNESS_ROOT = IS_BUILT_OUTPUT ? resolve(MODULE_ROOT, "..") : MODULE_ROOT;
export const FACTORY_TRIAGE_SCHEMA_PATH = join(
  HARNESS_ROOT,
  "schemas/factory-triage-output.schema.json",
);
const FACTORY_TRIAGE_WORKFLOW = "factory-triage" as const;
const FACTORY_TRIAGE_STEP = "factory-triage" as const;
const FACTORY_SANDBOX_MODE = "read-only" satisfies AgentSandboxMode;
const FACTORY_APPROVAL_POLICY = "never" satisfies AgentApprovalPolicy;

export function readFactoryWorkItemFile(path: string): FactoryWorkItem {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new FactoryTriageError(`Invalid factory work item JSON: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  return parseFactoryWorkItem(parsed);
}

export function createFactoryRunContext(options: FactoryRunContextFactoryOptions) {
  return createFactoryRunContextInternal(options);
}

// Test-only seam for provider injection; production callers should use createFactoryRunContext.
export function createFactoryRunContextForTest(options: FactoryRunContextFactoryOptions) {
  return createFactoryRunContextInternal(options);
}

function createFactoryRunContextInternal(
  options: FactoryRunContextFactoryOptions,
): FactoryRunContext {
  const workspace = resolve(options.workspace);
  if (!existsSync(workspace)) {
    throw new FactoryTriageError(`Workspace does not exist: ${workspace}`);
  }

  const startedAt = new Date();
  const runId = buildRunId(startedAt);
  const runDir = join(resolve(options.runsDir ?? join(workspace, ".harness/runs/factory")), runId);
  let triageProvider: Agent;
  try {
    mkdirSync(runDir, { recursive: true });
    mkdirSync(join(runDir, "context"), { recursive: true });
    writeJson(join(runDir, "context/work-item.json"), options.workItem);
    writeFileSync(join(runDir, "factory-triage.prompt.md"), renderPrompt(options.workItem), "utf8");

    const agentProviderFactory = options.agentProviderFactory;
    if (!agentProviderFactory) {
      throw new FactoryTriageError("agentProviderFactory is required");
    }
    triageProvider = agentProviderFactory({
      provider: options.agentProvider ?? "cursor",
      codexPathOverride: options.codexPathOverride,
    });
  } catch (error) {
    cleanupOrphanedFactoryRunDir(runDir);
    throw asFactoryTriageError(error);
  }

  const eventSink = options.dryRun
    ? noopEventSink
    : options.eventSink
      ? createCompositeEventSink(createFileEventSink(runDir), options.eventSink)
      : createFileEventSink(runDir);
  const agentPolicyMeta = factoryPolicyOptions(triageProvider.name, options);
  const agentMeta = {
    name: triageProvider.name,
    model: resolvedAgentModel(triageProvider.name, options),
    ...agentPolicyMeta,
  };

  return {
    runId,
    runDir,
    workspace,
    workItem: options.workItem,
    dryRun: options.dryRun,
    eventSink,
    async invokeTriageAgent(): Promise<FactoryTriageOutput> {
      if (options.dryRun) {
        writeJson(join(runDir, "factory-triage.raw.json"), DRY_RUN_FACTORY_TRIAGE);
        writeJson(join(runDir, "factory-triage.json"), DRY_RUN_FACTORY_TRIAGE);
        return DRY_RUN_FACTORY_TRIAGE;
      }

      let result: AgentRunResult | undefined;
      try {
        result = await triageProvider.run({
          workspace,
          prompt: renderPrompt(options.workItem),
          schemaPath: FACTORY_TRIAGE_SCHEMA_PATH,
          model: resolvedAgentModel(triageProvider.name, options),
          ...agentPolicyMeta,
          maxRuntimeMs: options.maxRuntimeMs,
          logPath: join(runDir, "factory-triage.stream.jsonl"),
          signal: options.signal,
        });
        writeJson(join(runDir, "factory-triage.raw.json"), rawAgentArtifact(result));

        if (!result.ok) {
          const error = result.aborted
            ? "Agent was aborted: factory-triage"
            : `factory-triage failed: ${result.error}`;
          throw new FactoryTriageError(error);
        }

        const triage = parseFactoryTriageOutput(result.structuredOutput);
        writeJson(join(runDir, "factory-triage.json"), triage);
        return triage;
      } catch (error) {
        if (error instanceof FactoryTriageError) throw error;
        throw new FactoryTriageError(`factory-triage failed: ${errorMessage(error)}`, {
          cause: error,
        });
      }
    },
    export(input: { triage: FactoryTriageOutput; routePlan: FactoryRoutePlan }): FactoryRunMeta {
      try {
        writeJson(join(runDir, "factory-route.json"), input.routePlan);
        writeFileSync(
          join(runDir, "factory-route.md"),
          renderFactoryRouteMarkdown(options.workItem, input.triage, input.routePlan),
          "utf8",
        );
        writeFileSync(
          join(runDir, "summary.md"),
          renderFactoryTriageSummary(options.workItem, input.triage, input.routePlan),
          "utf8",
        );

        const meta = buildMeta({
          status: options.dryRun ? "dry_run" : "completed",
          startedAt,
          runId,
          runDir,
          workspace,
          workItem: options.workItem,
          triage: input.triage,
          routePlan: input.routePlan,
          agent: agentMeta,
          includeEventsFile: !options.dryRun,
        });
        writeJson(join(runDir, "meta.json"), meta);
        return meta;
      } catch (error) {
        throw new FactoryTriageError(
          `Failed to write factory triage artifacts: ${errorMessage(error)}`,
          {
            cause: error,
          },
        );
      }
    },
    exportFailed(error: unknown): FactoryRunMeta {
      const meta = buildMeta({
        status: "failed",
        startedAt,
        runId,
        runDir,
        workspace,
        workItem: options.workItem,
        agent: agentMeta,
        error: errorMessage(error),
        includeEventsFile: !options.dryRun,
      });
      writeJson(join(runDir, "meta.json"), meta);
      return meta;
    },
  };
}

function renderPrompt(workItem: FactoryWorkItem): string {
  return fillTemplate(FACTORY_TRIAGE_PROMPT, {
    WORK_ITEM_JSON: JSON.stringify(workItem, null, 2),
  });
}

function buildMeta(input: {
  status: FactoryRunStatus;
  startedAt: Date;
  runId: string;
  runDir: string;
  workspace: string;
  workItem: FactoryWorkItem;
  triage?: FactoryTriageOutput;
  routePlan?: FactoryRoutePlan;
  agent: FactoryRunMeta["agent"];
  error?: string;
  includeEventsFile: boolean;
}): FactoryRunMeta {
  return {
    runId: input.runId,
    workflow: FACTORY_TRIAGE_WORKFLOW,
    status: input.status,
    workspace: input.workspace,
    runDir: input.runDir,
    workItem: {
      id: input.workItem.id,
      source: input.workItem.source,
      title: input.workItem.title,
    },
    ...(input.triage ? { route: input.triage.route } : {}),
    ...(input.routePlan ? { nextAction: input.routePlan.nextAction } : {}),
    ...(input.routePlan
      ? {
          artifacts: {
            triage: "factory-triage.json",
            route: "factory-route.json",
            routeSummary: input.routePlan.artifactRelPath,
            summary: "summary.md",
          },
        }
      : {}),
    agent: input.agent,
    startedAt: input.startedAt.toISOString(),
    durationMs: Date.now() - input.startedAt.getTime(),
    ...(input.includeEventsFile ? { eventsFile: WORKFLOW_EVENTS_FILE } : {}),
    ...(input.error ? { error: input.error } : {}),
  };
}

function factoryPolicyOptions(
  providerName: AgentProviderName,
  options: FactoryRunContextFactoryOptions,
): Pick<AgentRunInput, "sandboxMode" | "approvalPolicy" | "modelReasoningEffort"> {
  if (providerName !== "codex") return {};
  return {
    sandboxMode: options.sandboxMode ?? FACTORY_SANDBOX_MODE,
    approvalPolicy: options.approvalPolicy ?? FACTORY_APPROVAL_POLICY,
    modelReasoningEffort: options.modelReasoningEffort ?? DEFAULT_CODEX_REASONING_EFFORT,
  };
}

function resolvedAgentModel(
  providerName: AgentProviderName,
  options: FactoryRunContextFactoryOptions,
): string {
  return options.model ?? DEFAULT_AGENT_MODELS[providerName];
}

function rawAgentArtifact(result: AgentRunResult): unknown {
  if (result.ok || result.raw !== undefined) return result.raw;
  return { error: result.error };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

function cleanupOrphanedFactoryRunDir(runDir: string): boolean {
  if (existsSync(join(runDir, "meta.json"))) {
    return false;
  }
  rmSync(runDir, { recursive: true, force: true });
  return true;
}

function asFactoryTriageError(error: unknown): FactoryTriageError {
  if (error instanceof FactoryTriageError) return error;
  return new FactoryTriageError(errorMessage(error), { cause: error });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const FACTORY_TRIAGE_STEP_OUTPUTS = [
  "factory-triage.prompt.md",
  "factory-triage.raw.json",
  "factory-triage.json",
  "factory-route.json",
  "factory-route.md",
  "summary.md",
  "meta.json",
] as const;

export const FACTORY_TRIAGE_EVENT_STEP = FACTORY_TRIAGE_STEP;
