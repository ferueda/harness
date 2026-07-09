import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Agent,
  AgentApprovalPolicy,
  AgentProviderName,
  AgentProviderOptions,
  AgentReasoningEffort,
  AgentSandboxMode,
  AgentSessionRef,
} from "./agents.ts";
import { DEFAULT_AGENT_MODELS } from "./agents.ts";
import type { FactoryRoleAgent } from "./config.ts";
import { buildRunId } from "./context.ts";
import { parseLinearIssueIdentifier } from "./factory-linear-adapter.ts";
import { renderFactoryPlanningSummary } from "./factory-planning-handoff.ts";
import { FactoryPlanningError, type FactoryPlanningOutput } from "./factory-planning-schemas.ts";
import {
  FactoryWorkItemMetadataSchema,
  deriveFactoryWorkItemPlanSlug,
  type FactoryStage,
  type FactoryWorkItem,
  type FactoryWorkItemMetadata,
} from "./factory-schemas.ts";
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

export type FactoryPlanningRunWarning = {
  code: string;
  message: string;
  factoryStateRoot?: string;
};

export type FactoryPlanningRunStatus =
  | "dry_run"
  | "plan-approved"
  | "plan-needs-human"
  | "plan-review-unresolved"
  | "planning-failed";

export type FactoryPlanningReviewRef = {
  runId: string;
  runDir: string;
  status: string;
  verdict?: "pass" | "needs_changes" | "blocked";
  specReviewPath: string;
  summaryPath?: string;
};

export type FactoryPlanningRunMeta = {
  runId: string;
  workflow: "factory-planning";
  status: FactoryPlanningRunStatus;
  workspace: string;
  runDir: string;
  workItem: { id: string; source: FactoryWorkItem["source"]; title: string };
  outputPlan?: string;
  factoryMetadata?: FactoryWorkItemMetadata;
  iterations: Array<{
    index: number;
    planPath?: string;
    review?: FactoryPlanningReviewRef;
  }>;
  humanQuestions?: string[];
  plannerAgent: FactoryPlanningAgentMeta;
  reviewerAgent: FactoryPlanningAgentMeta;
  plannerSession?: AgentSessionRef;
  summaryPath: string;
  metaPath: string;
  startedAt: string;
  durationMs: number;
  eventsFile?: typeof WORKFLOW_EVENTS_FILE;
  error?: string;
  factoryStore?: FactoryStoreMeta;
  warnings?: FactoryPlanningRunWarning[];
  execution?: FactoryExecutionProvenance;
};

export type FactoryPlanningAgentRole = FactoryRoleAgent;

export type FactoryPlanningAgentMeta = {
  name: AgentProviderName;
  model: string;
  sandboxMode?: AgentSandboxMode;
  approvalPolicy?: AgentApprovalPolicy;
  modelReasoningEffort?: AgentReasoningEffort;
};

export type FactoryPlanningReviewContext = {
  runId?: string;
  runDir?: string;
  [key: string]: unknown;
};

export type FactoryPlanningReviewMeta = {
  runId?: unknown;
  runDir?: unknown;
  status?: unknown;
  verdict?: unknown;
  [key: string]: unknown;
};

export type FactoryPlanningReviewRunner = (
  context: FactoryPlanningReviewContext,
) => FactoryPlanningReviewMeta | Promise<FactoryPlanningReviewMeta>;

export type FactoryPlanningRunContextOptions = {
  workspace: string;
  runsDir?: string;
  workItem: FactoryWorkItem;
  plannerRole: FactoryPlanningAgentRole;
  reviewerRole: FactoryPlanningAgentRole;
  outputPlan?: string;
  maxReviewIterations: number;
  maxRuntimeMs: number;
  dryRun?: boolean;
  signal?: AbortSignal;
  eventSink?: WorkflowEventSink;
  agentProviderFactory: (options: AgentProviderOptions) => Agent;
  planReviewRunner?: FactoryPlanningReviewRunner;
  factoryStore?: FactoryStoreMeta;
  reviewRunsDir?: string;
};

export type FactoryPlanningRunContext = {
  runId: string;
  runDir: string;
  draftPath: string;
  workspace: string;
  startedAt: Date;
  workItem: FactoryWorkItem;
  plannerRole: FactoryPlanningAgentRole;
  reviewerRole: FactoryPlanningAgentRole;
  plannerAgent: FactoryPlanningAgentMeta;
  reviewerAgent: FactoryPlanningAgentMeta;
  outputPlan?: string;
  maxReviewIterations: number;
  maxRuntimeMs: number;
  dryRun?: boolean;
  signal?: AbortSignal;
  eventSink: WorkflowEventSink;
  agentProviderFactory: (options: AgentProviderOptions) => Agent;
  planReviewRunner?: FactoryPlanningReviewRunner;
  factoryStore?: FactoryStoreMeta;
  reviewRunsDir?: string;
  plannerProvider(): Agent;
  iterationDir(index: number): string;
  writePlannerArtifacts(input: {
    index: number;
    prompt: string;
    raw: unknown;
    output: FactoryPlanningOutput;
  }): string | undefined;
  writeReviewRef(index: number, review: FactoryPlanningReviewRef): void;
  writeReviewFindings(index: number, findings: unknown): void;
  writeFinalPlan(planPath: string): string;
  removeFinalPlan(path: string): void;
  export(input: {
    status: FactoryPlanningRunStatus;
    iterations: FactoryPlanningRunMeta["iterations"];
    outputPlan?: string;
    plannerSession?: AgentSessionRef;
    humanQuestions?: string[];
    error?: string;
  }): FactoryPlanningRunMeta;
};

const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IS_BUILT_OUTPUT = basename(MODULE_ROOT) === "dist";
const HARNESS_ROOT = IS_BUILT_OUTPUT ? resolve(MODULE_ROOT, "..") : MODULE_ROOT;
export const FACTORY_PLANNING_SCHEMA_PATH = join(
  HARNESS_ROOT,
  "schemas/factory-planning-output.schema.json",
);

const WORKFLOW = "factory-planning" as const;

export function createFactoryPlanningRunContext(
  options: FactoryPlanningRunContextOptions,
): FactoryPlanningRunContext {
  return createFactoryPlanningRunContextInternal(options);
}

// Test-only seam for provider/reviewer injection; production callers should use createFactoryPlanningRunContext.
export function createFactoryPlanningRunContextForTest(
  options: FactoryPlanningRunContextOptions,
): FactoryPlanningRunContext {
  return createFactoryPlanningRunContextInternal(options);
}

function createFactoryPlanningRunContextInternal(
  options: FactoryPlanningRunContextOptions,
): FactoryPlanningRunContext {
  const workspace = resolve(options.workspace);
  if (!existsSync(workspace)) {
    throw new FactoryPlanningError(`Workspace does not exist: ${workspace}`);
  }
  if (!Number.isInteger(options.maxReviewIterations) || options.maxReviewIterations < 1) {
    throw new FactoryPlanningError("maxReviewIterations must be a positive integer");
  }

  const startedAt = new Date();
  const runId = buildRunId(startedAt);
  const runDir = join(resolve(options.runsDir ?? join(workspace, ".harness/runs/factory")), runId);
  const draftPath = join(runDir, "planning", "draft.md");
  let plannerProvider: Agent | undefined;

  try {
    mkdirSync(runDir, { recursive: true });
    mkdirSync(join(runDir, "context"), { recursive: true });
    mkdirSync(dirname(draftPath), { recursive: true });
    writeJson(join(runDir, "context/work-item.json"), options.workItem);
  } catch (error) {
    cleanupOrphanedFactoryPlanningRunDir(runDir);
    throw asFactoryPlanningError(error);
  }

  const eventSink = options.dryRun
    ? noopEventSink
    : options.eventSink
      ? createCompositeEventSink(createFileEventSink(runDir), options.eventSink)
      : createFileEventSink(runDir);
  const plannerAgent = buildAgentMeta(options.plannerRole);
  const reviewerAgent = buildAgentMeta(options.reviewerRole);

  return {
    runId,
    runDir,
    draftPath,
    workspace,
    startedAt,
    workItem: options.workItem,
    plannerRole: options.plannerRole,
    reviewerRole: options.reviewerRole,
    plannerAgent,
    reviewerAgent,
    outputPlan: options.outputPlan,
    maxReviewIterations: options.maxReviewIterations,
    maxRuntimeMs: options.maxRuntimeMs,
    dryRun: options.dryRun,
    signal: options.signal,
    eventSink,
    agentProviderFactory: options.agentProviderFactory,
    planReviewRunner: options.planReviewRunner,
    factoryStore: options.factoryStore,
    reviewRunsDir: options.reviewRunsDir,
    plannerProvider(): Agent {
      if (!plannerProvider && !options.dryRun) {
        plannerProvider = options.agentProviderFactory({
          provider: options.plannerRole.agent,
          codexPathOverride: options.plannerRole.codexPathOverride,
        });
      }
      if (!plannerProvider) {
        throw new FactoryPlanningError("Planner provider is unavailable during dry-run");
      }
      return plannerProvider;
    },
    iterationDir(index: number): string {
      return join(runDir, "iterations", String(index));
    },
    writePlannerArtifacts(input): string | undefined {
      const iterationDir = this.iterationDir(input.index);
      mkdirSync(iterationDir, { recursive: true });
      writeFileSync(join(iterationDir, "planner.prompt.md"), input.prompt, "utf8");
      writeJson(join(iterationDir, "planner.raw.json"), input.raw);
      writeJson(join(iterationDir, "planner.json"), input.output);
      if (input.output.outcome !== "draft-ready") return undefined;
      validateDraftPath(draftPath);

      const planPath = join(iterationDir, "plan.md");
      copyFileSync(draftPath, planPath);
      return planPath;
    },
    writeReviewRef(index, review): void {
      writeJson(join(this.iterationDir(index), "plan-review-ref.json"), review);
    },
    writeReviewFindings(index, findings): void {
      writeJson(join(this.iterationDir(index), "review-findings.json"), findings);
    },
    writeFinalPlan(planPath): string {
      validateSupportedTracker(options.workItem);
      const outputPlan = resolveOutputPlan({
        workspace,
        outputPlan: options.outputPlan,
        startedAt,
        workItem: options.workItem,
      });
      mkdirSync(dirname(outputPlan), { recursive: true });
      if (existsSync(outputPlan)) {
        throw new FactoryPlanningError(`Output plan already exists: ${outputPlan}`);
      }
      validateDraftPath(planPath);
      copyFileSync(planPath, outputPlan);
      return outputPlan;
    },
    removeFinalPlan(path): void {
      rmSync(path, { force: true });
    },
    export(input): FactoryPlanningRunMeta {
      const meta = buildMeta({
        ...input,
        startedAt,
        runId,
        runDir,
        workspace,
        workItem: options.workItem,
        plannerAgent,
        reviewerAgent,
        includeEventsFile: !options.dryRun,
        factoryStore: options.factoryStore,
      });
      writeFileSync(join(runDir, "summary.md"), renderFactoryPlanningSummary(meta), "utf8");
      writeJson(join(runDir, "meta.json"), meta);
      return meta;
    },
  };
}

function buildMeta(input: {
  status: FactoryPlanningRunStatus;
  startedAt: Date;
  runId: string;
  runDir: string;
  workspace: string;
  workItem: FactoryWorkItem;
  iterations: FactoryPlanningRunMeta["iterations"];
  outputPlan?: string;
  humanQuestions?: string[];
  plannerAgent: FactoryPlanningAgentMeta;
  reviewerAgent: FactoryPlanningAgentMeta;
  plannerSession?: AgentSessionRef;
  error?: string;
  includeEventsFile: boolean;
  factoryStore?: FactoryStoreMeta;
}): FactoryPlanningRunMeta {
  return {
    runId: input.runId,
    workflow: WORKFLOW,
    status: input.status,
    workspace: input.workspace,
    runDir: input.runDir,
    workItem: {
      id: input.workItem.id,
      source: input.workItem.source,
      title: input.workItem.title,
    },
    ...(input.outputPlan ? { outputPlan: input.outputPlan } : {}),
    factoryMetadata: buildFactoryMetadata(input),
    iterations: input.iterations,
    ...(input.humanQuestions ? { humanQuestions: input.humanQuestions } : {}),
    plannerAgent: input.plannerAgent,
    reviewerAgent: input.reviewerAgent,
    ...(input.plannerSession ? { plannerSession: input.plannerSession } : {}),
    summaryPath: join(input.runDir, "summary.md"),
    metaPath: join(input.runDir, "meta.json"),
    startedAt: input.startedAt.toISOString(),
    durationMs: Date.now() - input.startedAt.getTime(),
    ...(input.includeEventsFile ? { eventsFile: WORKFLOW_EVENTS_FILE } : {}),
    ...(input.error ? { error: input.error } : {}),
    ...(input.factoryStore ? { factoryStore: input.factoryStore } : {}),
    execution: factoryExecutionProvenance(input.workspace, input.runDir),
  };
}

function buildFactoryMetadata(input: {
  status: FactoryPlanningRunStatus;
  runId: string;
  workspace: string;
  outputPlan?: string;
  workItem: FactoryWorkItem;
}): FactoryWorkItemMetadata {
  const parsed = FactoryWorkItemMetadataSchema.safeParse(input.workItem.metadata ?? {});
  const metadata = parsed.success ? parsed.data : {};
  const stage = planningStage(input.status, input.workItem);
  return {
    ...metadata,
    factoryRunId: input.runId,
    ...(stage ? { factoryStage: stage } : {}),
    ...(input.outputPlan ? { approvedPlanPath: relative(input.workspace, input.outputPlan) } : {}),
  };
}

function planningStage(
  status: FactoryPlanningRunStatus,
  workItem: FactoryWorkItem,
): FactoryStage | undefined {
  if (status === "dry_run") return undefined;
  if (status === "plan-approved" && hasSupportedTracker(workItem)) return "plan-pr-open";
  return status;
}

function buildAgentMeta(role: FactoryPlanningAgentRole): FactoryPlanningAgentMeta {
  return {
    name: role.agent,
    model: role.model ?? DEFAULT_AGENT_MODELS[role.agent],
    ...(role.agent === "codex"
      ? {
          sandboxMode: role.sandboxMode,
          approvalPolicy: role.approvalPolicy,
          modelReasoningEffort: role.modelReasoningEffort,
        }
      : {}),
  };
}

function resolveOutputPlan(input: {
  workspace: string;
  outputPlan?: string;
  startedAt: Date;
  workItem: FactoryWorkItem;
}): string {
  const planPath = input.outputPlan
    ? isAbsolute(input.outputPlan)
      ? resolve(input.outputPlan)
      : resolve(input.workspace, input.outputPlan)
    : (deriveTrackerPlanPath(input.workspace, input.workItem) ??
      join(
        input.workspace,
        "dev/plans",
        `${dateSlug(input.startedAt)}-${safeSlug(deriveFactoryWorkItemPlanSlug(input.workItem))}.md`,
      ));
  const rel = relative(input.workspace, planPath);
  if (rel.startsWith("..") || rel === "" || isAbsolute(rel)) {
    throw new FactoryPlanningError(`Output plan must be inside workspace: ${planPath}`);
  }
  if (rel !== "dev/plans" && !rel.startsWith(`dev${sep}plans${sep}`)) {
    throw new FactoryPlanningError(`Output plan must be under dev/plans: ${planPath}`);
  }
  return planPath;
}

function deriveTrackerPlanPath(workspace: string, workItem: FactoryWorkItem): string | undefined {
  const tracker = parseTrackerPlanRef(workItem);
  return tracker ? join(workspace, "dev/plans", tracker.fileName) : undefined;
}

function validateSupportedTracker(workItem: FactoryWorkItem): void {
  parseTrackerPlanRef(workItem);
}

function hasSupportedTracker(workItem: FactoryWorkItem): boolean {
  return parseTrackerPlanRef(workItem) !== undefined;
}

function parseTrackerPlanRef(workItem: FactoryWorkItem): { fileName: string } | undefined {
  const metadata = FactoryWorkItemMetadataSchema.safeParse(workItem.metadata ?? {});
  const tracker = metadata.success ? metadata.data.tracker : undefined;
  if (!tracker) return undefined;
  if (tracker.source === "linear") {
    const parsed = parseLinearIssueIdentifier(tracker.id);
    if (!parsed) {
      throw new FactoryPlanningError(`Invalid Linear tracker id for plan path: ${tracker.id}`);
    }
    return { fileName: `${parsed.teamKey}-${parsed.number}.md` };
  }
  if (tracker.source === "github") {
    const match = /^[-.A-Za-z0-9_]+\/[-.A-Za-z0-9_.]+#(\d+)$/.exec(tracker.id);
    if (!match) {
      throw new FactoryPlanningError(`Invalid GitHub tracker id for plan path: ${tracker.id}`);
    }
    return { fileName: `GH-${match[1]}.md` };
  }
  throw new FactoryPlanningError(`Unsupported tracker source for plan path: ${tracker.source}`);
}

function dateSlug(date: Date): string {
  const year = String(date.getUTCFullYear()).slice(-2);
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function safeSlug(slug: string): string {
  const sanitized = slug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!sanitized) throw new FactoryPlanningError("Plan slug must contain a path-safe character");
  return sanitized;
}

function validateDraftPath(path: string): void {
  if (!existsSync(path))
    throw new FactoryPlanningError(`Planner did not write draft plan: ${path}`);
  const stats = statSync(path);
  if (!stats.isFile()) throw new FactoryPlanningError(`Planner draft is not a file: ${path}`);
  if (stats.size === 0) throw new FactoryPlanningError(`Planner draft is empty: ${path}`);
}

function cleanupOrphanedFactoryPlanningRunDir(runDir: string): boolean {
  if (existsSync(join(runDir, "meta.json"))) return false;
  rmSync(runDir, { recursive: true, force: true });
  return true;
}

function asFactoryPlanningError(error: unknown): FactoryPlanningError {
  if (error instanceof FactoryPlanningError) return error;
  return new FactoryPlanningError(errorMessage(error), { cause: error });
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}
