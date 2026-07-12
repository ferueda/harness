import {
  constants,
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  linkSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, basename, isAbsolute, join, relative, resolve, sep } from "node:path";
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
  parseFactoryWorkItem,
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
import type { FactoryActionExecutionProfile } from "./factory-phase-run.ts";
import { readFactoryPhaseRunIdentity, writeFactoryPhaseRunIdentity } from "./factory-phase-run.ts";
import { deriveFactoryWorkItemKey } from "./factory-lifecycle.ts";

export type DraftValidationReason =
  | "missing"
  | "symlinked"
  | "non-regular"
  | "empty"
  | "parent-unsafe"
  | "outside-workspace"
  | "read-failed";

export type PlannerFailureClassification =
  | "provider-failed"
  | "provider-aborted"
  | "provider-timeout"
  | "invocation-threw"
  | "structured-output-invalid"
  | "workspace-guard-failed"
  | "finding-decisions-invalid"
  | "draft-invalid"
  | "publication-failed";

export type PublicationStage = "stage" | "iteration-link" | "canonical-rename" | "rollback";

export class DraftValidationError extends FactoryPlanningError {
  readonly reason: DraftValidationReason;

  constructor(reason: DraftValidationReason, cause?: unknown) {
    super(draftValidationMessage(reason), { cause });
    this.name = "DraftValidationError";
    this.reason = reason;
  }
}

export class FactoryPlanningPublicationError extends FactoryPlanningError {
  readonly stage: PublicationStage;

  constructor(stage: PublicationStage, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "FactoryPlanningPublicationError";
    this.stage = stage;
  }
}

export class FactoryPlanningIterationCollisionError extends FactoryPlanningPublicationError {
  constructor(cause?: unknown) {
    super("iteration-link", "Immutable plan snapshot already exists", cause);
    this.name = "FactoryPlanningIterationCollisionError";
  }
}

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
  publicationMode?: "local" | "pull-request";
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

export type FactoryPlanningTestHooks = {
  runIdGenerator?: () => string;
  beforeFinalScratchValidation?: () => void;
  beforeScratchRead?: () => void;
  stageFailure?: (stage: "canonical" | "iteration") => void;
  linkFailure?: () => void;
  iterationCleanupFailure?: () => void;
  canonicalRenameFailure?: () => void;
  rollbackFailure?: () => void;
};

type FileIdentity = { dev: number; ino: number };
type ScratchIdentity = {
  workspaceReal: string;
  harnessReal: string;
  draftsReal: string;
  scratchReal: string;
  workspace: FileIdentity;
  harness: FileIdentity;
  drafts: FileIdentity;
  scratch: FileIdentity;
};

export type FactoryPlanningRunContext = {
  runId: string;
  runDir: string;
  scratchRunDir: string;
  draftPath: string;
  durableDraftPath: string;
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
  preparePlannerScratch(): void;
  preparePlannerIteration(index: number): void;
  plannerProvider(): Agent;
  iterationDir(index: number): string;
  writePlannerEvidence(input: { index: number; prompt: string; raw: unknown }): void;
  writePlannerStructuredArtifact(index: number, output: FactoryPlanningOutput): void;
  publishPlannerDraft(index: number): string;
  writePlannerFailureArtifacts(input: {
    index: number;
    classification: PlannerFailureClassification;
    message: string;
    raw: unknown;
    draftReason?: DraftValidationReason;
    exitCode?: number;
    aborted?: boolean;
    publicationStage?: PublicationStage;
  }): void;
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
const MAX_RUN_ID_ATTEMPTS = 8;
const MAX_DRAFT_BYTES = 2 * 1024 * 1024;
const O_NOFOLLOW = constants.O_NOFOLLOW;

export function createFactoryPlanningRunContext(
  options: FactoryPlanningRunContextOptions,
): FactoryPlanningRunContext {
  return createFactoryPlanningRunContextInternal(options);
}

// Test-only seam for provider/reviewer and deterministic filesystem-boundary injection.
export function createFactoryPlanningRunContextForTest(
  options: FactoryPlanningRunContextOptions & { testHooks?: FactoryPlanningTestHooks },
): FactoryPlanningRunContext {
  return createFactoryPlanningRunContextInternal(options, options.testHooks);
}

function createFactoryPlanningRunContextInternal(
  options: FactoryPlanningRunContextOptions,
  hooks?: FactoryPlanningTestHooks,
): FactoryPlanningRunContext {
  const workspace = resolve(options.workspace);
  assertWorkspace(workspace);
  if (!Number.isInteger(options.maxReviewIterations) || options.maxReviewIterations < 1) {
    throw new FactoryPlanningError("maxReviewIterations must be a positive integer");
  }

  const startedAt = new Date();
  const scratchRoot = join(workspace, ".harness", "factory-drafts");
  const runsRoot = resolve(options.runsDir ?? join(workspace, ".harness/runs/factory"));
  let allocation: { runId: string; runDir: string } | undefined;
  let runsRootReady = false;

  for (let attempt = 0; attempt < MAX_RUN_ID_ATTEMPTS; attempt += 1) {
    const runId = hooks?.runIdGenerator?.() ?? buildRunId(startedAt);
    const runDir = join(runsRoot, runId);
    assertProspectivePathSafety({
      workspace,
      runDir,
      scratchRunDir: join(scratchRoot, runId),
      dryRun: options.dryRun,
    });
    try {
      if (!runsRootReady) {
        mkdirSync(runsRoot, { recursive: true });
        const rootStats = statSync(runsRoot);
        if (!rootStats.isDirectory())
          throw new FactoryPlanningError(
            `Factory planning run root is not a directory: ${runsRoot}`,
          );
        runsRootReady = true;
      }
      mkdirSync(runDir);
      allocation = { runId, runDir };
      break;
    } catch (error) {
      if (isNodeError(error, "EEXIST") && !runsRootReady)
        throw new FactoryPlanningError(
          `Factory planning run root is not a directory: ${runsRoot}`,
          {
            cause: error,
          },
        );
      if (isNodeError(error, "EEXIST") && attempt + 1 < MAX_RUN_ID_ATTEMPTS) continue;
      if (isNodeError(error, "EEXIST")) {
        throw new FactoryPlanningError(
          `Unable to allocate unique factory planning run directory after ${MAX_RUN_ID_ATTEMPTS} attempts`,
          { cause: error },
        );
      }
      throw asFactoryPlanningError(error);
    }
  }
  if (!allocation) {
    throw new FactoryPlanningError(
      `Unable to allocate unique factory planning run directory after ${MAX_RUN_ID_ATTEMPTS} attempts`,
    );
  }

  const { runId, runDir } = allocation;
  const scratchRunDir = join(scratchRoot, runId);
  const durableDraftPath = join(runDir, "planning", "draft.md");
  const draftPath = join(scratchRunDir, "draft.md");
  assertRealPathSafety({ workspace, runDir, scratchRunDir, dryRun: options.dryRun });
  try {
    mkdirSync(join(runDir, "context"));
    mkdirSync(join(runDir, "planning"));
    writeJson(join(runDir, "context/work-item.json"), options.workItem);
    if (options.factoryStore) {
      writeFactoryPhaseRunIdentity(runDir, {
        version: 1,
        phaseRunId: runId,
        phase: "planning",
        workItemKey: deriveFactoryWorkItemKey(options.workItem),
        workspace,
        projectId: options.factoryStore.projectId,
        factoryStateRoot: resolve(options.factoryStore.factoryStateRoot),
        reviewCeiling: options.maxReviewIterations,
        outputPlan: relative(
          workspace,
          resolveOutputPlan({
            workspace,
            outputPlan: options.outputPlan,
            startedAt,
            workItem: options.workItem,
          }),
        ),
        publicationMode: options.publicationMode ?? "local",
        actions: {
          producePlanCandidate: planningExecutionProfile(options.plannerRole),
          reviewPlanCandidate: planningExecutionProfile(options.reviewerRole),
        },
      });
    }
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
  let plannerProvider: Agent | undefined;
  let preparedScratch: ScratchIdentity | undefined;

  const context: FactoryPlanningRunContext = {
    runId,
    runDir,
    scratchRunDir,
    draftPath,
    durableDraftPath,
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
    preparePlannerScratch(): void {
      if (preparedScratch) {
        validatePreparedScratch({ workspace, scratchRunDir, runDir, expected: preparedScratch });
        return;
      }
      ensureScratchDirectory(join(workspace, ".harness"), workspace, runDir, scratchRunDir);
      ensureScratchDirectory(
        join(workspace, ".harness", "factory-drafts"),
        workspace,
        runDir,
        scratchRunDir,
      );
      createExclusiveScratchRunDir(scratchRunDir, workspace, runDir);
      preparedScratch = validatePreparedScratch({ workspace, scratchRunDir, runDir });
    },
    preparePlannerIteration(index: number): void {
      prepareDurablePublicationParents(runDir, index);
    },
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
    writePlannerEvidence(input): void {
      context.preparePlannerIteration(input.index);
      writeFileSync(
        join(context.iterationDir(input.index), "planner.prompt.md"),
        input.prompt,
        "utf8",
      );
      writeJson(join(context.iterationDir(input.index), "planner.raw.json"), input.raw);
    },
    writePlannerStructuredArtifact(index, output): void {
      writeJson(join(context.iterationDir(index), "planner.json"), output);
    },
    publishPlannerDraft(index): string {
      return publishDraft(context, index);
    },
    writePlannerFailureArtifacts(input): void {
      writeJson(join(context.iterationDir(input.index), "planner.failure.json"), {
        classification: input.classification,
        message: input.message,
        ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
        ...(input.aborted !== undefined ? { aborted: input.aborted } : {}),
        ...(input.publicationStage ? { publicationStage: input.publicationStage } : {}),
        raw:
          input.classification === "draft-invalid"
            ? { reason: input.draftReason ?? "read-failed" }
            : redactScratchPaths(input.raw, {
                draftPath,
                scratchRunDir,
                scratchRoot,
              }),
      });
    },
    writeReviewRef(index, review): void {
      writeJson(join(context.iterationDir(index), "plan-review-ref.json"), review);
    },
    writeReviewFindings(index, findings): void {
      writeJson(join(context.iterationDir(index), "review-findings.json"), findings);
    },
    writeFinalPlan(planPath): string {
      validateSupportedTracker(options.workItem);
      validateDurablePlanSnapshot(planPath, runDir);
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
  return context;

  function publishDraft(ctx: FactoryPlanningRunContext, index: number): string {
    if (!preparedScratch) throw new DraftValidationError("parent-unsafe");
    try {
      prepareDurablePublicationParents(runDir, index);
    } catch (error) {
      if (error instanceof FactoryPlanningPublicationError) throw error;
      throw new FactoryPlanningPublicationError(
        "stage",
        `Failed to prepare immutable plan snapshot: ${errorMessage(error)}`,
        error,
      );
    }
    const bytes = readValidatedScratchDraft({
      workspace,
      scratchRunDir,
      draftPath,
      runDir,
      expected: preparedScratch,
      hooks,
    });
    return publishPlanBytes({
      durableDraftPath,
      planPath: join(ctx.iterationDir(index), "plan.md"),
      bytes,
      hooks,
    });
  }
}

function planningExecutionProfile(role: FactoryPlanningAgentRole): FactoryActionExecutionProfile {
  if (role.agent === "cursor")
    return { provider: "cursor", model: role.model ?? DEFAULT_AGENT_MODELS.cursor };
  return {
    provider: "codex",
    model: role.model ?? DEFAULT_AGENT_MODELS.codex,
    ...(role.codexPathOverride ? { executable: role.codexPathOverride } : {}),
    sandbox: role.sandboxMode ?? "read-only",
    approvalPolicy: role.approvalPolicy ?? "never",
    reasoningEffort: role.modelReasoningEffort ?? "medium",
  };
}

export type OpenFactoryPlanningRunContextOptions = {
  workspace: string;
  runsDir: string;
  phaseRunId: string;
  workItem: FactoryWorkItem;
  factoryStore: FactoryStoreMeta;
};

/** Reopen immutable planning policy without allocating or consulting config. */
export function openFactoryPlanningRunContext(options: OpenFactoryPlanningRunContextOptions) {
  const runDir = join(resolve(options.runsDir), options.phaseRunId);
  const identity = readFactoryPhaseRunIdentity(runDir);
  if (
    identity.phase !== "planning" ||
    identity.phaseRunId !== options.phaseRunId ||
    identity.workItemKey !== deriveFactoryWorkItemKey(options.workItem) ||
    identity.workspace !== resolve(options.workspace) ||
    identity.projectId !== options.factoryStore.projectId ||
    identity.factoryStateRoot !== resolve(options.factoryStore.factoryStateRoot)
  )
    throw new FactoryPlanningError(
      `Factory planning phase-run identity conflicts with ${options.phaseRunId}`,
    );
  const persisted = parseFactoryWorkItem(
    JSON.parse(readFileSync(join(runDir, "context/work-item.json"), "utf8")),
  );
  if (deriveFactoryWorkItemKey(persisted) !== identity.workItemKey)
    throw new FactoryPlanningError(`Factory planning input conflicts with ${options.phaseRunId}`);
  return {
    runId: identity.phaseRunId,
    runDir,
    workspace: identity.workspace,
    workItem: persisted,
    factoryStore: options.factoryStore,
    identity,
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
    workItem: { id: input.workItem.id, source: input.workItem.source, title: input.workItem.title },
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
  if (rel.startsWith("..") || rel === "" || isAbsolute(rel))
    throw new FactoryPlanningError(`Output plan must be inside workspace: ${planPath}`);
  if (rel !== "dev/plans" && !rel.startsWith(`dev${sep}plans${sep}`))
    throw new FactoryPlanningError(`Output plan must be under dev/plans: ${planPath}`);
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
    if (!parsed)
      throw new FactoryPlanningError(`Invalid Linear tracker id for plan path: ${tracker.id}`);
    return { fileName: `${parsed.teamKey}-${parsed.number}.md` };
  }
  if (tracker.source === "github") {
    const match = /^[-.A-Za-z0-9_]+\/[-.A-Za-z0-9_.]+#(\d+)$/.exec(tracker.id);
    if (!match)
      throw new FactoryPlanningError(`Invalid GitHub tracker id for plan path: ${tracker.id}`);
    return { fileName: `GH-${match[1]}.md` };
  }
  throw new FactoryPlanningError(`Unsupported tracker source for plan path: ${tracker.source}`);
}

function dateSlug(date: Date): string {
  return `${String(date.getUTCFullYear()).slice(-2)}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
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

function assertWorkspace(workspace: string): void {
  try {
    const stats = statSync(workspace);
    if (!stats.isDirectory())
      throw new FactoryPlanningError(`Workspace is not a directory: ${workspace}`);
    realpathSync(workspace);
  } catch (error) {
    if (error instanceof FactoryPlanningError) throw error;
    throw new FactoryPlanningError(`Workspace does not exist: ${workspace}`, { cause: error });
  }
}

function prepareDurablePublicationParents(runDir: string, index: number): void {
  const runReal = realpathSync(runDir);
  ensureDurableDirectory(join(runDir, "planning"), runReal);
  const iterationsReal = ensureDurableDirectory(join(runDir, "iterations"), runReal);
  ensureDurableDirectory(join(runDir, "iterations", String(index)), iterationsReal);
}

function ensureDurableDirectory(path: string, parentReal: string): string {
  try {
    mkdirSync(path);
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
  }
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory())
    throw new Error(`Durable publication parent is unsafe: ${path}`);
  const real = realpathSync(path);
  if (!isWithin(real, parentReal))
    throw new Error(`Durable publication parent is outside the run: ${path}`);
  return real;
}

function assertProspectivePathSafety(input: {
  workspace: string;
  runDir: string;
  scratchRunDir: string;
  dryRun?: boolean;
}): void {
  const workspaceReal = realpathSync(input.workspace);
  const runReal = prospectiveRealPath(input.runDir);
  const scratchReal = prospectiveRealPath(input.scratchRunDir);
  if (pathsOverlap(runReal, scratchReal))
    throw new FactoryPlanningError("Factory planning run and scratch paths overlap");
  if (!input.dryRun && isWithin(runReal, workspaceReal))
    throw new FactoryPlanningError("Live factory planning run directory must be outside workspace");
}

function assertRealPathSafety(input: {
  workspace: string;
  runDir: string;
  scratchRunDir: string;
  dryRun?: boolean;
}): void {
  const workspaceReal = realpathSync(input.workspace);
  const runReal = realpathSync(input.runDir);
  if (pathsOverlap(runReal, prospectiveRealPath(input.scratchRunDir)))
    throw new FactoryPlanningError("Factory planning run and scratch paths overlap");
  if (!input.dryRun && isWithin(runReal, workspaceReal))
    throw new FactoryPlanningError("Live factory planning run directory must be outside workspace");
}

function prospectiveRealPath(path: string): string {
  const unresolved: string[] = [];
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    unresolved.unshift(basename(current));
    if (parent === current) return current;
    current = parent;
  }
  return join(realpathSync(current), ...unresolved);
}

function pathsOverlap(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left);
}
function isWithin(path: string, parent: string): boolean {
  return path === parent || path.startsWith(`${parent}${sep}`);
}

function ensureScratchDirectory(
  path: string,
  workspace: string,
  runDir: string,
  scratchRunDir: string,
): void {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw new DraftValidationError("parent-unsafe", error);
    mkdirSync(path);
    stats = lstatSync(path);
  }
  if (stats.isSymbolicLink() || !stats.isDirectory())
    throw new DraftValidationError("parent-unsafe");
  validateScratchParents({ workspace, runDir, path, scratchRunDir });
}

function validateScratchParents(input: {
  workspace: string;
  runDir: string;
  path: string;
  scratchRunDir: string;
}): void {
  try {
    const workspaceReal = realpathSync(input.workspace);
    const parentReal = realpathSync(input.path);
    const runReal = realpathSync(input.runDir);
    if (!isWithin(parentReal, workspaceReal)) throw new DraftValidationError("outside-workspace");
    if (pathsOverlap(prospectiveRealPath(input.scratchRunDir), runReal))
      throw new DraftValidationError("parent-unsafe");
  } catch (error) {
    if (error instanceof DraftValidationError) throw error;
    throw new DraftValidationError("parent-unsafe", error);
  }
}

function createExclusiveScratchRunDir(path: string, workspace: string, runDir: string): void {
  try {
    mkdirSync(path);
  } catch (error) {
    if (isNodeError(error, "EEXIST")) throw new DraftValidationError("parent-unsafe", error);
    throw new DraftValidationError("parent-unsafe", error);
  }
  validatePreparedScratch({ workspace, scratchRunDir: path, runDir });
}

function validatePreparedScratch(input: {
  workspace: string;
  scratchRunDir: string;
  runDir: string;
  expected?: ScratchIdentity;
}): ScratchIdentity {
  // These checks reject unsafe completed path state. Node does not expose a
  // portable directory-fd traversal API, so this is not protection against a
  // continuously racing same-account process replacing parents.
  try {
    const workspacePath = input.workspace;
    const harnessPath = join(input.workspace, ".harness");
    const draftsPath = join(harnessPath, "factory-drafts");
    const workspace = statSync(workspacePath);
    const harness = lstatSync(harnessPath);
    const drafts = lstatSync(draftsPath);
    const scratch = lstatSync(input.scratchRunDir);
    if (
      harness.isSymbolicLink() ||
      drafts.isSymbolicLink() ||
      scratch.isSymbolicLink() ||
      !workspace.isDirectory() ||
      !harness.isDirectory() ||
      !drafts.isDirectory() ||
      !scratch.isDirectory()
    )
      throw new DraftValidationError("parent-unsafe");
    const workspaceReal = realpathSync(workspacePath);
    const harnessReal = realpathSync(harnessPath);
    const draftsReal = realpathSync(draftsPath);
    const scratchReal = realpathSync(input.scratchRunDir);
    const runReal = realpathSync(input.runDir);
    if (!isWithin(scratchReal, workspaceReal)) throw new DraftValidationError("outside-workspace");
    if (pathsOverlap(scratchReal, runReal)) throw new DraftValidationError("parent-unsafe");
    const identity: ScratchIdentity = {
      workspaceReal,
      harnessReal,
      draftsReal,
      scratchReal,
      workspace: fileIdentity(workspace),
      harness: fileIdentity(harness),
      drafts: fileIdentity(drafts),
      scratch: fileIdentity(scratch),
    };
    if (
      input.expected &&
      (identity.workspaceReal !== input.expected.workspaceReal ||
        identity.harnessReal !== input.expected.harnessReal ||
        identity.draftsReal !== input.expected.draftsReal ||
        identity.scratchReal !== input.expected.scratchReal ||
        !sameFile(identity.workspace, input.expected.workspace) ||
        !sameFile(identity.harness, input.expected.harness) ||
        !sameFile(identity.drafts, input.expected.drafts) ||
        !sameFile(identity.scratch, input.expected.scratch))
    ) {
      throw new DraftValidationError("parent-unsafe");
    }
    return identity;
  } catch (error) {
    if (error instanceof DraftValidationError) throw error;
    throw new DraftValidationError("parent-unsafe", error);
  }
}

function fileIdentity(stats: { dev: number; ino: number }): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function readValidatedScratchDraft(input: {
  workspace: string;
  scratchRunDir: string;
  draftPath: string;
  runDir: string;
  expected: ScratchIdentity;
  hooks?: FactoryPlanningTestHooks;
}): Buffer {
  try {
    validatePreparedScratch({
      workspace: input.workspace,
      scratchRunDir: input.scratchRunDir,
      runDir: input.runDir,
      expected: input.expected,
    });
    input.hooks?.beforeFinalScratchValidation?.();
    validatePreparedScratch({
      workspace: input.workspace,
      scratchRunDir: input.scratchRunDir,
      runDir: input.runDir,
      expected: input.expected,
    });
    input.hooks?.beforeScratchRead?.();
    validatePreparedScratch({
      workspace: input.workspace,
      scratchRunDir: input.scratchRunDir,
      runDir: input.runDir,
      expected: input.expected,
    });
    const draftStats = lstatSync(input.draftPath);
    if (draftStats.isSymbolicLink()) throw new DraftValidationError("symlinked");
    if (!draftStats.isFile()) throw new DraftValidationError("non-regular");
    const draftReal = realpathSync(input.draftPath);
    const scratchReal = realpathSync(input.scratchRunDir);
    const workspaceReal = realpathSync(input.workspace);
    if (!isWithin(draftReal, scratchReal)) throw new DraftValidationError("outside-workspace");
    if (!isWithin(draftReal, workspaceReal)) throw new DraftValidationError("outside-workspace");
    if (draftStats.size === 0) throw new DraftValidationError("empty");
    let fd: number | undefined;
    try {
      fd = openSync(input.draftPath, 0 | O_NOFOLLOW);
      const opened = fstatSync(fd);
      if (!opened.isFile()) throw new DraftValidationError("non-regular");
      if (opened.size === 0) throw new DraftValidationError("empty");
      if (opened.size > MAX_DRAFT_BYTES) throw new DraftValidationError("read-failed");
      const bytes = Buffer.alloc(opened.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, null);
        if (count === 0) throw new DraftValidationError("read-failed");
        offset += count;
      }
      const finalStats = fstatSync(fd);
      if (!finalStats.isFile() || finalStats.size !== opened.size || offset !== bytes.length)
        throw new DraftValidationError("read-failed");
      if (
        containsScratchPath(bytes.toString("utf8"), {
          draftPath: input.draftPath,
          scratchRunDir: input.scratchRunDir,
          scratchRoot: join(input.workspace, ".harness/factory-drafts"),
        })
      )
        throw new DraftValidationError("read-failed");
      return bytes;
    } catch (error) {
      if (error instanceof DraftValidationError) throw error;
      throw new DraftValidationError("read-failed", error);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  } catch (error) {
    if (error instanceof DraftValidationError) throw error;
    if (isNodeError(error, "ENOENT")) throw new DraftValidationError("missing", error);
    if (isNodeError(error, "ELOOP")) throw new DraftValidationError("symlinked", error);
    throw new DraftValidationError("read-failed", error);
  }
}

function containsScratchPath(
  value: string,
  paths: { draftPath: string; scratchRunDir: string; scratchRoot: string },
): boolean {
  return (
    value.includes(paths.draftPath) ||
    value.includes(paths.scratchRunDir) ||
    value.includes(paths.scratchRoot)
  );
}

function validateDurablePlanSnapshot(planPath: string, runDir: string): void {
  const resolvedPlan = resolve(planPath);
  const iterationsDir = resolve(runDir, "iterations");
  const rel = relative(iterationsDir, resolvedPlan);
  const relParts = rel.split(sep);
  if (rel.startsWith("..") || isAbsolute(rel) || relParts.length !== 2 || relParts[1] !== "plan.md")
    throw new FactoryPlanningError("Plan snapshot is outside the durable iterations directory");
  try {
    const runStats = lstatSync(runDir);
    const iterationsStats = lstatSync(iterationsDir);
    const iterationDir = dirname(resolvedPlan);
    const iterationStats = lstatSync(iterationDir);
    const stats = lstatSync(resolvedPlan);
    if (
      runStats.isSymbolicLink() ||
      iterationsStats.isSymbolicLink() ||
      iterationStats.isSymbolicLink() ||
      stats.isSymbolicLink()
    )
      throw new FactoryPlanningError("Plan snapshot path is symlinked");
    if (!runStats.isDirectory() || !iterationsStats.isDirectory() || !iterationStats.isDirectory())
      throw new FactoryPlanningError("Plan snapshot parent is not a directory");
    const runReal = realpathSync(runDir);
    const iterationsReal = realpathSync(iterationsDir);
    const iterationReal = realpathSync(iterationDir);
    if (iterationsReal !== join(runReal, "iterations") || !isWithin(iterationReal, iterationsReal))
      throw new FactoryPlanningError("Plan snapshot parent is outside the durable run");
    if (!stats.isFile() || stats.size === 0)
      throw new FactoryPlanningError("Plan snapshot is not a non-empty file");
  } catch (error) {
    if (error instanceof FactoryPlanningError) throw error;
    throw new FactoryPlanningError("Plan snapshot is unavailable", { cause: error });
  }
}

function publishPlanBytes(input: {
  durableDraftPath: string;
  planPath: string;
  bytes: Buffer;
  hooks?: FactoryPlanningTestHooks;
}): string {
  const iterationTemp = join(
    dirname(input.planPath),
    `.plan.md.${process.pid}-${randomBytes(5).toString("hex")}.tmp`,
  );
  const canonicalTemp = join(
    dirname(input.durableDraftPath),
    `.draft.md.${process.pid}-${randomBytes(5).toString("hex")}.tmp`,
  );
  let iterationLinked = false;
  try {
    stageBytes(iterationTemp, input.bytes, input.hooks, "iteration");
    stageBytes(canonicalTemp, input.bytes, input.hooks, "canonical");
    try {
      input.hooks?.linkFailure?.();
      linkSync(iterationTemp, input.planPath);
      iterationLinked = true;
    } catch (error) {
      const cleanupError = unlinkQuietly(iterationTemp);
      if (cleanupError) {
        throw new FactoryPlanningPublicationError(
          "rollback",
          `Failed to clean immutable plan staging file: ${errorMessage(cleanupError)}`,
          cleanupError,
        );
      }
      if (isNodeError(error, "EEXIST")) {
        throw new FactoryPlanningIterationCollisionError(error);
      }
      throw new FactoryPlanningPublicationError(
        "iteration-link",
        `Failed to publish immutable plan snapshot: ${errorMessage(error)}`,
        error,
      );
    }
    if (iterationLinked) {
      try {
        input.hooks?.iterationCleanupFailure?.();
        unlinkSync(iterationTemp);
      } catch (error) {
        try {
          input.hooks?.rollbackFailure?.();
          unlinkSync(input.planPath);
        } catch (rollbackError) {
          throw new FactoryPlanningPublicationError(
            "rollback",
            `Failed to publish immutable plan snapshot: ${errorMessage(error)}`,
            rollbackError,
          );
        }
        throw new FactoryPlanningPublicationError(
          "rollback",
          `Failed to publish immutable plan snapshot: ${errorMessage(error)}`,
          error,
        );
      }
    }
    try {
      input.hooks?.canonicalRenameFailure?.();
      renameSync(canonicalTemp, input.durableDraftPath);
    } catch (error) {
      try {
        input.hooks?.rollbackFailure?.();
        unlinkSync(input.planPath);
        const cleanupError = unlinkQuietly(canonicalTemp);
        if (cleanupError) throw cleanupError;
      } catch (rollbackError) {
        throw new FactoryPlanningPublicationError(
          "rollback",
          `Failed to publish canonical draft: ${errorMessage(error)}`,
          rollbackError,
        );
      }
      throw new FactoryPlanningPublicationError(
        "canonical-rename",
        `Failed to publish canonical draft: ${errorMessage(error)}`,
        error,
      );
    }
    return input.planPath;
  } catch (error) {
    const cleanupError = cleanupPublicationTemps([iterationTemp, canonicalTemp]);
    if (cleanupError) {
      throw new FactoryPlanningPublicationError(
        "rollback",
        `${errorMessage(error)}; failed to clean publication staging files: ${errorMessage(cleanupError)}`,
        cleanupError,
      );
    }
    if (error instanceof FactoryPlanningPublicationError) throw error;
    throw new FactoryPlanningPublicationError(
      "stage",
      `Failed to stage planning artifacts: ${errorMessage(error)}`,
      error,
    );
  }
}

function stageBytes(
  path: string,
  bytes: Buffer,
  hooks: FactoryPlanningTestHooks | undefined,
  stage: "canonical" | "iteration",
): void {
  let fd: number | undefined;
  try {
    hooks?.stageFailure?.(stage);
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
      0o600,
    );
    let offset = 0;
    while (offset < bytes.length) offset += requireWrite(fd, bytes, offset);
    fsyncSync(fd);
  } catch (error) {
    throw new FactoryPlanningPublicationError(
      "stage",
      `Failed to stage planning artifacts: ${errorMessage(error)}`,
      error,
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function requireWrite(fd: number, bytes: Buffer, offset: number): number {
  // writeFileSync(fd, ...) does not expose partial-write handling; use a small
  // descriptor write through the synchronous file API instead.
  const written = writeSync(fd, bytes, offset, bytes.length - offset);
  if (written <= 0) throw new Error("staging write made no progress");
  return written;
}

function cleanupPublicationTemps(paths: string[]): unknown {
  let firstError: unknown;
  for (const path of paths) {
    const error = unlinkQuietly(path);
    if (error && !firstError) firstError = error;
  }
  return firstError;
}

function unlinkQuietly(path: string): unknown {
  try {
    unlinkSync(path);
    return undefined;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    return error;
  }
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
function redactScratchPaths(
  value: unknown,
  paths: { draftPath: string; scratchRunDir: string; scratchRoot: string },
): unknown {
  if (typeof value === "string") {
    return value
      .replaceAll(paths.draftPath, "[planner-scratch]/draft.md")
      .replaceAll(paths.scratchRunDir, "[planner-scratch]")
      .replaceAll(paths.scratchRoot, "[planner-scratch-root]")
      .replaceAll("factory-drafts", "[planner-scratch-root]");
  }
  if (Array.isArray(value)) return value.map((item) => redactScratchPaths(item, paths));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redactScratchPaths(key, paths),
        redactScratchPaths(item, paths),
      ]),
    );
  }
  return value;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
function draftValidationMessage(reason: DraftValidationReason): string {
  switch (reason) {
    case "missing":
      return "Planner did not write draft plan: missing";
    case "symlinked":
      return "Planner draft is symlinked: symlinked";
    case "non-regular":
      return "Planner draft is not a file: non-regular";
    case "empty":
      return "Planner draft is empty: empty";
    case "parent-unsafe":
      return "Planner draft parent is unsafe: parent-unsafe";
    case "outside-workspace":
      return "Planner draft is outside the workspace: outside-workspace";
    case "read-failed":
      return "Planner draft could not be read: read-failed";
  }
}

export function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}
