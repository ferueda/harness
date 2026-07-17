import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Agent,
  type AgentProviderName,
  type AgentProviderOptions,
  type AgentRunInput,
  type AgentRunResult,
} from "./agents.ts";
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
import {
  factoryExecutionProvenance,
  type FactoryExecutionProvenance,
  type FactoryStoreMeta,
} from "./factory-store.ts";
import type { FactoryActionExecutionProfile } from "./factory-phase-run.ts";
import { readFactoryPhaseRunIdentity, writeFactoryPhaseRunIdentity } from "./factory-phase-run.ts";
import { assertFactoryPhaseWorkspace, snapshotFactoryPhaseGit } from "./factory-phase-git.ts";
import { deriveFactoryWorkItemKey } from "./factory-lifecycle.ts";
import { writeDurableFactoryFile } from "./factory-durable-file.ts";

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
    sandboxMode?: AgentRunInput["sandboxMode"];
    approvalPolicy?: AgentRunInput["approvalPolicy"];
    modelReasoningEffort?: AgentRunInput["modelReasoningEffort"];
  };
  startedAt: string;
  durationMs: number;
  eventsFile?: typeof WORKFLOW_EVENTS_FILE;
  error?: string;
  failureKind?: "retryable" | "human-required" | "terminal";
  factoryStore?: FactoryStoreMeta;
  execution?: FactoryExecutionProvenance;
};

export type FactoryRunContext = {
  runId: string;
  runDir: string;
  workspace: string;
  workItem: FactoryWorkItem;
  factoryStore?: FactoryStoreMeta;
  dryRun?: boolean;
  maxRuntimeMs: number;
  executionProfile: FactoryActionExecutionProfile;
  eventSink: WorkflowEventSink;
  bindActionOutcome?(input: {
    path: string;
    action: {
      phaseRunId: string;
      handler: "triageWorkItem";
      attempt: number;
      causationEventId: string;
    };
  }): void;
  invokeTriageAgent(): Promise<FactoryTriageOutput>;
  export(input: { triage: FactoryTriageOutput; routePlan: FactoryRoutePlan }): FactoryRunMeta;
  exportFailed(error: unknown, options?: { publishActionOutcome?: boolean }): FactoryRunMeta;
};

export type FactoryRunContextFactoryOptions = {
  workspace: string;
  runsDir?: string;
  workItem: FactoryWorkItem;
  executionProfile: FactoryActionExecutionProfile;
  maxRuntimeMs: number;
  dryRun?: boolean;
  signal?: AbortSignal;
  eventSink?: WorkflowEventSink;
  agentProviderFactory?: (options: AgentProviderOptions) => Agent;
  factoryStore?: FactoryStoreMeta;
};

export type OpenFactoryRunContextOptions = Omit<
  FactoryRunContextFactoryOptions,
  "executionProfile" | "runsDir"
> & {
  runsDir: string;
  phaseRunId: string;
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

export function readFactoryWorkItemFile(path: string): FactoryWorkItem {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new FactoryTriageError(`Invalid factory work item JSON: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  return parseFactoryWorkItem(stripFetchWarnings(parsed));
}

function stripFetchWarnings(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const candidate = value as Record<string, unknown>;
  // Historical fetch output could include top-level warnings. Keep accepting
  // those saved item files even though current fetches return the work item directly.
  if (!Array.isArray(candidate.warnings)) return value;
  const { warnings: _warnings, ...workItem } = candidate;
  return workItem;
}

export function assertFactoryItemFileExists(workspace: string, itemFile: string): string {
  const resolvedItemPath = isAbsolute(itemFile) ? itemFile : join(workspace, itemFile);
  if (!existsSync(resolvedItemPath)) {
    throw new Error(`Factory item file does not exist: ${itemFile}`);
  }
  return resolvedItemPath;
}

export function createFactoryRunContext(options: FactoryRunContextFactoryOptions) {
  return createFactoryRunContextInternal(options, "create");
}

export function openFactoryRunContext(options: OpenFactoryRunContextOptions) {
  const runDir = join(resolve(options.runsDir), options.phaseRunId);
  const identity = readFactoryPhaseRunIdentity(runDir);
  const workspace = resolve(options.workspace);
  if (
    identity.phaseRunId !== options.phaseRunId ||
    identity.phase !== "triage" ||
    identity.workItemKey !== deriveFactoryWorkItemKey(options.workItem) ||
    !options.factoryStore ||
    identity.projectId !== options.factoryStore.projectId ||
    identity.factoryStateRoot !== resolve(options.factoryStore.factoryStateRoot)
  ) {
    throw new FactoryTriageError(`Factory phase-run identity conflicts with ${options.phaseRunId}`);
  }
  try {
    assertFactoryPhaseWorkspace(identity, workspace);
  } catch (error) {
    throw new FactoryTriageError(
      `Factory phase-run identity conflicts with ${options.phaseRunId}`,
      {
        cause: error,
      },
    );
  }
  return createFactoryRunContextInternal(
    { ...options, executionProfile: identity.actions.triageWorkItem },
    "open",
    options.phaseRunId,
  );
}

// Test-only seam for provider injection; production callers should use createFactoryRunContext.
export function createFactoryRunContextForTest(options: FactoryRunContextFactoryOptions) {
  return createFactoryRunContextInternal(options, "create");
}

function createFactoryRunContextInternal(
  options: FactoryRunContextFactoryOptions,
  mode: "create" | "open",
  existingRunId?: string,
): FactoryRunContext {
  const workspace = resolve(options.workspace);
  if (!existsSync(workspace)) {
    throw new FactoryTriageError(`Workspace does not exist: ${workspace}`);
  }

  const startedAt = new Date();
  const executionProfile = options.executionProfile;
  const runId = existingRunId ?? buildRunId(startedAt);
  const runDir = join(resolve(options.runsDir ?? join(workspace, ".harness/runs/factory")), runId);
  const workItem =
    mode === "open"
      ? readFactoryWorkItemFile(join(runDir, "context/work-item.json"))
      : options.workItem;
  const prompt = renderPrompt(workItem);
  let actionOutcomeBinding:
    | {
        path: string;
        action: {
          phaseRunId: string;
          handler: "triageWorkItem";
          attempt: number;
          causationEventId: string;
        };
      }
    | undefined;
  let triageProvider: Agent;
  try {
    if (mode === "open") {
      if (
        !existsSync(join(runDir, "context/work-item.json")) ||
        !existsSync(join(runDir, "factory-triage.prompt.md"))
      ) {
        throw new FactoryTriageError(`Factory phase run is incomplete: ${runDir}`);
      }
    } else {
      mkdirSync(runDir, { recursive: true });
      mkdirSync(join(runDir, "context"), { recursive: true });
      writeJson(join(runDir, "context/work-item.json"), workItem);
      writeDurableFactoryFile(join(runDir, "factory-triage.prompt.md"), prompt);
      if (options.factoryStore) {
        writeFactoryPhaseRunIdentity(runDir, {
          version: 2,
          phaseRunId: runId,
          phase: "triage",
          workItemKey: deriveFactoryWorkItemKey(workItem),
          workspace,
          projectId: options.factoryStore.projectId,
          factoryStateRoot: resolve(options.factoryStore.factoryStateRoot),
          git: snapshotFactoryPhaseGit(workspace, { optional: true }),
          actions: { triageWorkItem: executionProfile },
        });
      }
    }

    const agentProviderFactory = options.agentProviderFactory;
    if (!agentProviderFactory) {
      throw new FactoryTriageError("agentProviderFactory is required");
    }
    triageProvider = agentProviderFactory({
      provider: executionProfile.provider,
      ...(executionProfile.provider === "codex" && executionProfile.executable
        ? { codexPathOverride: executionProfile.executable }
        : {}),
    });
  } catch (error) {
    if (mode === "create") cleanupOrphanedFactoryRunDir(runDir);
    throw asFactoryTriageError(error);
  }

  const eventSink = options.dryRun
    ? noopEventSink
    : options.eventSink
      ? createCompositeEventSink(createFileEventSink(runDir), options.eventSink)
      : createFileEventSink(runDir);
  if (triageProvider.name !== executionProfile.provider) {
    throw new FactoryTriageError(
      `Factory triage provider conflicts with execution profile: expected ${executionProfile.provider}, got ${triageProvider.name}`,
    );
  }
  const agentPolicyMeta = factoryPolicyOptions(executionProfile);
  const agentMeta = {
    name: triageProvider.name,
    model: executionProfile.model,
    ...agentPolicyMeta,
  };

  return {
    runId,
    runDir,
    workspace,
    workItem,
    factoryStore: options.factoryStore,
    dryRun: options.dryRun,
    maxRuntimeMs: options.maxRuntimeMs,
    executionProfile,
    eventSink,
    bindActionOutcome(binding): void {
      if (actionOutcomeBinding)
        throw new Error(`Factory action outcome already bound for ${runId}`);
      actionOutcomeBinding = binding;
    },
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
          prompt,
          schemaPath: FACTORY_TRIAGE_SCHEMA_PATH,
          model: executionProfile.model,
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
          throw new FactoryTriageError(error, {
            failureKind:
              result.aborted || result.failureKind === "workspace-guard"
                ? "human-required"
                : "retryable",
          });
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
        writeDurableFactoryFile(
          join(runDir, "factory-route.md"),
          renderFactoryRouteMarkdown(workItem, input.triage, input.routePlan),
        );
        writeDurableFactoryFile(
          join(runDir, "summary.md"),
          renderFactoryTriageSummary(workItem, input.triage, input.routePlan),
        );

        const meta = buildMeta({
          status: options.dryRun ? "dry_run" : "completed",
          startedAt,
          runId,
          runDir,
          workspace,
          workItem,
          triage: input.triage,
          routePlan: input.routePlan,
          agent: agentMeta,
          includeEventsFile: !options.dryRun,
          factoryStore: options.factoryStore,
        });
        publishBoundActionOutcome(actionOutcomeBinding, meta);
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
    exportFailed(error: unknown, exportOptions = {}): FactoryRunMeta {
      const meta = buildMeta({
        status: "failed",
        startedAt,
        runId,
        runDir,
        workspace,
        workItem,
        agent: agentMeta,
        error: errorMessage(error),
        failureKind:
          error instanceof FactoryTriageError
            ? error.failureKind
            : options.signal?.aborted
              ? "human-required"
              : "terminal",
        includeEventsFile: !options.dryRun,
        factoryStore: options.factoryStore,
      });
      if (exportOptions.publishActionOutcome !== false) {
        publishBoundActionOutcome(actionOutcomeBinding, meta);
      }
      writeJson(join(runDir, "meta.json"), meta);
      return meta;
    },
  };
}

function publishBoundActionOutcome(
  binding: Parameters<NonNullable<FactoryRunContext["bindActionOutcome"]>>[0] | undefined,
  meta: FactoryRunMeta,
): void {
  if (!binding) return;
  writeDurableFactoryFile(
    binding.path,
    `${JSON.stringify({ version: 1, action: binding.action, meta }, null, 2)}\n`,
    true,
  );
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
  failureKind?: FactoryRunMeta["failureKind"];
  includeEventsFile: boolean;
  factoryStore?: FactoryStoreMeta;
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
    ...(input.failureKind ? { failureKind: input.failureKind } : {}),
    ...(input.factoryStore ? { factoryStore: input.factoryStore } : {}),
    execution: factoryExecutionProvenance(input.workspace, input.runDir),
  };
}

function factoryPolicyOptions(
  profile: FactoryActionExecutionProfile,
): Pick<AgentRunInput, "sandboxMode" | "approvalPolicy" | "modelReasoningEffort"> {
  if (profile.provider !== "codex") return {};
  return {
    sandboxMode: profile.sandbox,
    approvalPolicy: profile.approvalPolicy,
    modelReasoningEffort: profile.reasoningEffort,
  };
}

function rawAgentArtifact(result: AgentRunResult): unknown {
  if (result.ok || result.raw !== undefined) return result.raw;
  return { error: result.error };
}

function writeJson(path: string, value: unknown): void {
  writeDurableFactoryFile(path, JSON.stringify(value, null, 2));
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
