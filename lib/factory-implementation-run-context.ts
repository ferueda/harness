import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Agent, AgentProviderOptions, AgentSessionRef } from "./agents.ts";
import type { FactoryRoleAgent } from "./config.ts";
import type { FactoryWorkspaceWriterLeaseHandle } from "./factory-locks.ts";
import type { FactoryRunAllocation } from "./factory-run-allocation.ts";
import { buildRunId } from "./context.ts";
import { factoryRoleAgentMeta, type FactoryStationAgentMeta } from "./factory-agent-meta.ts";
import { deriveFactoryWorkItemKey } from "./factory-lifecycle.ts";
import type { FactoryImplementationInput } from "./factory-implementation-input.ts";
import type { FactoryWorkItem, FactoryWorkItemMetadata } from "./factory-schemas.ts";
import {
  factoryExecutionProvenance,
  type FactoryExecutionProvenance,
  type FactoryStoreMeta,
} from "./factory-store.ts";
import {
  WORKFLOW_EVENTS_FILE,
  createCompositeEventSink,
  createFileEventSink,
  noopEventSink,
  type WorkflowEventSink,
} from "./workflow-events.ts";

export const FACTORY_IMPLEMENTATION_WORKFLOW = "factory-implementation" as const;

export class FactoryImplementationRunError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "FactoryImplementationRunError";
  }
}

export type FactoryImplementationRunStatus =
  | "dry_run"
  | "implementation-complete"
  | "implementation-failed";

export type FactoryImplementationAgentMeta = FactoryStationAgentMeta;

type FactoryImplementationBaseArtifacts = {
  workItem: string;
  implementationInput: string;
  planRef?: string;
  sourceMaterial?: string;
  summary: string;
  meta: string;
};

export type FactoryImplementationArtifacts = FactoryImplementationBaseArtifacts & {
  prompt: string;
  changeReviewHandoff: string;
  rawOutput?: "implementation/implementer.raw.json";
  streamLog?: "implementation/implementer.stream.jsonl";
  workspaceStatus?: "implementation/workspace-status.json";
  diff?: "implementation/diff.patch";
};

export type FactoryImplementationPreProviderFailureArtifacts =
  FactoryImplementationBaseArtifacts & {
    prompt?: never;
    changeReviewHandoff?: never;
    rawOutput?: never;
    streamLog?: never;
    workspaceStatus?: never;
    diff?: never;
  };

type FactoryImplementationRunMetaBase = {
  runId: string;
  workflow: typeof FACTORY_IMPLEMENTATION_WORKFLOW;
  status: FactoryImplementationRunStatus;
  mode: FactoryImplementationInput["mode"];
  workspace: string;
  runDir: string;
  workItem: {
    id: string;
    source: FactoryWorkItem["source"];
    title: string;
  };
  implementerAgent: FactoryImplementationAgentMeta;
  summaryPath: string;
  metaPath: string;
  startedAt: string;
  durationMs: number;
  error?: string;
  implementerSession?: AgentSessionRef;
  reviewBase?: string;
  reviewHead?: string;
  reviewCommitSha?: string;
  reviewTree?: string;
  factoryMetadata?: FactoryWorkItemMetadata;
  factoryStore?: FactoryStoreMeta;
  execution?: FactoryExecutionProvenance;
};

export type FactoryImplementationRunMeta =
  | (FactoryImplementationRunMetaBase & {
      status: "implementation-failed";
      artifacts: FactoryImplementationPreProviderFailureArtifacts;
      eventsFile?: never;
    })
  | (FactoryImplementationRunMetaBase & {
      artifacts: FactoryImplementationArtifacts;
      eventsFile?: typeof WORKFLOW_EVENTS_FILE;
    });

export type FactoryImplementationRunContextOptions = {
  workspace: string;
  runsDir?: string;
  workItem: FactoryWorkItem;
  factoryStore?: FactoryStoreMeta;
  implementationInput: FactoryImplementationInput;
  implementerRole: FactoryRoleAgent;
  dryRun: boolean;
  maxRuntimeMs?: number;
  signal?: AbortSignal;
  eventSink?: WorkflowEventSink;
  linearApplyRequested?: boolean;
  agentProviderFactory?: (options: AgentProviderOptions) => Agent;
  allocation?: FactoryRunAllocation;
  writerLease?: FactoryWorkspaceWriterLeaseHandle;
};

export type FactoryImplementationLiveArtifactsInput = {
  raw: unknown;
  workspaceStatus: unknown;
  diff: string;
  changeReviewHandoff: string;
};

type FactoryImplementationExportInputBase = {
  error?: string;
  implementerSession?: AgentSessionRef;
  reviewBase?: string;
  reviewHead?: string;
  reviewCommitSha?: string;
  reviewTree?: string;
  includeLiveArtifacts?: boolean;
};

export type FactoryImplementationExportInput = FactoryImplementationExportInputBase &
  (
    | {
        status: "implementation-failed";
        preProviderFailure: true;
      }
    | {
        status: FactoryImplementationRunStatus;
        preProviderFailure?: never;
      }
  );

export type FactoryImplementationRunContext = {
  runId: string;
  runDir: string;
  workspace: string;
  startedAt: Date;
  workItem: FactoryWorkItem;
  factoryStore?: FactoryStoreMeta;
  implementationInput: FactoryImplementationInput;
  implementerAgent: FactoryImplementationAgentMeta;
  implementerRole: FactoryRoleAgent;
  dryRun: boolean;
  maxRuntimeMs: number;
  linearApplyRequested: boolean;
  signal?: AbortSignal;
  eventSink: WorkflowEventSink;
  writerLease?: FactoryWorkspaceWriterLeaseHandle;
  writeDryRunArtifacts(input: { prompt: string; changeReviewHandoff: string }): void;
  writePromptArtifact(input: { prompt: string }): void;
  writeLiveArtifacts(input: FactoryImplementationLiveArtifactsInput): void;
  /** @deprecated Prefer writeDryRunArtifacts / writePromptArtifact / writeLiveArtifacts. */
  writeImplementationArtifacts(input: { prompt: string; changeReviewHandoff: string }): void;
  implementerProvider(): Agent;
  export(input: FactoryImplementationExportInput): FactoryImplementationRunMeta;
};

export function createFactoryImplementationRunContext(
  options: FactoryImplementationRunContextOptions,
): FactoryImplementationRunContext {
  return createFactoryImplementationRunContextInternal(options);
}

// Test-only seam; production callers should use createFactoryImplementationRunContext.
export function createFactoryImplementationRunContextForTest(
  options: FactoryImplementationRunContextOptions,
): FactoryImplementationRunContext {
  return createFactoryImplementationRunContextInternal(options);
}

function createFactoryImplementationRunContextInternal(
  options: FactoryImplementationRunContextOptions,
): FactoryImplementationRunContext {
  const workspace = resolve(options.workspace);
  if (!existsSync(workspace)) {
    throw new FactoryImplementationRunError(`Workspace does not exist: ${workspace}`);
  }
  if (options.dryRun !== true && options.dryRun !== false) {
    throw new FactoryImplementationRunError(
      "Factory implementation context requires an explicit dryRun boolean",
    );
  }
  if (!options.dryRun) {
    if (options.maxRuntimeMs === undefined) {
      throw new FactoryImplementationRunError("Live factory implementation requires maxRuntimeMs");
    }
    if (!options.agentProviderFactory) {
      throw new FactoryImplementationRunError(
        "Live factory implementation requires agentProviderFactory",
      );
    }
  }

  const startedAt = new Date();
  const runId = options.allocation?.runId ?? buildRunId(startedAt);
  const runDir =
    options.allocation?.runDir ??
    join(resolve(options.runsDir ?? join(workspace, ".harness/runs/factory")), runId);
  const implementerAgent = factoryRoleAgentMeta(options.implementerRole);
  let implementerProvider: Agent | undefined;
  let liveArtifactsWritten = false;

  try {
    mkdirSync(join(runDir, "context"), { recursive: true });
    mkdirSync(join(runDir, "implementation"), { recursive: true });
    writeJson(join(runDir, "context/work-item.json"), options.workItem);
    writeJson(join(runDir, "context/implementation-input.json"), options.implementationInput);
    if (options.allocation) {
      writeJson(join(runDir, "context/run-reservation.json"), {
        station: "implementation",
        workItemKey: deriveFactoryWorkItemKey(options.workItem),
        runId: options.allocation.runId,
        reservationToken: options.allocation.reservationToken,
        workspace,
        ...(options.factoryStore
          ? {
              storeRoot: options.factoryStore.storeRoot,
              factoryProjectId: options.factoryStore.projectId,
              factoryStateRoot: options.factoryStore.factoryStateRoot,
              factoryRunsDir: options.factoryStore.factoryRunsDir,
              reviewRunsDir: options.factoryStore.reviewRunsDir,
            }
          : {}),
      });
      writeJson(join(runDir, "implementation-reservation.json"), {
        station: "implementation",
        workItemKey: deriveFactoryWorkItemKey(options.workItem),
        runId: options.allocation.runId,
        reservationToken: options.allocation.reservationToken,
        workspace,
        ...(options.factoryStore
          ? {
              storeRoot: options.factoryStore.storeRoot,
              factoryProjectId: options.factoryStore.projectId,
              factoryStateRoot: options.factoryStore.factoryStateRoot,
              factoryRunsDir: options.factoryStore.factoryRunsDir,
              reviewRunsDir: options.factoryStore.reviewRunsDir,
            }
          : {}),
      });
    }
    if (options.implementationInput.mode === "planned") {
      writeJson(join(runDir, "context/plan-ref.json"), {
        approvedPlanPath: options.implementationInput.approvedPlanPath,
        planPath: options.implementationInput.planPath,
        approvedPlanCommit: options.implementationInput.approvedPlanCommit,
        ...(options.implementationInput.metadata.tracker
          ? { tracker: options.implementationInput.metadata.tracker }
          : {}),
      });
    } else {
      writeJson(
        join(runDir, "context/source-material.json"),
        options.implementationInput.sourceMaterial,
      );
    }
  } catch (error) {
    cleanupOrphanedFactoryImplementationRunDir(runDir);
    throw asFactoryImplementationRunError(error);
  }

  const eventSink = options.dryRun
    ? noopEventSink
    : options.eventSink
      ? createCompositeEventSink(createFileEventSink(runDir), options.eventSink)
      : createFileEventSink(runDir);

  return {
    runId,
    runDir,
    workspace,
    startedAt,
    workItem: options.workItem,
    factoryStore: options.factoryStore,
    implementationInput: options.implementationInput,
    implementerAgent,
    implementerRole: options.implementerRole,
    dryRun: options.dryRun,
    maxRuntimeMs: options.maxRuntimeMs ?? 0,
    linearApplyRequested: Boolean(options.linearApplyRequested),
    signal: options.signal,
    eventSink,
    ...(options.writerLease ? { writerLease: options.writerLease } : {}),
    writeDryRunArtifacts(input): void {
      writeFileSync(join(runDir, "implementation/prompt.md"), input.prompt, "utf8");
      writeFileSync(
        join(runDir, "implementation/change-review-handoff.md"),
        input.changeReviewHandoff,
        "utf8",
      );
    },
    writePromptArtifact(input): void {
      writeFileSync(join(runDir, "implementation/prompt.md"), input.prompt, "utf8");
    },
    writeLiveArtifacts(input): void {
      writeJson(join(runDir, "implementation/implementer.raw.json"), input.raw);
      writeJson(join(runDir, "implementation/workspace-status.json"), input.workspaceStatus);
      writeFileSync(join(runDir, "implementation/diff.patch"), input.diff, "utf8");
      writeFileSync(
        join(runDir, "implementation/change-review-handoff.md"),
        input.changeReviewHandoff,
        "utf8",
      );
      liveArtifactsWritten = true;
    },
    writeImplementationArtifacts(input): void {
      this.writeDryRunArtifacts(input);
    },
    implementerProvider(): Agent {
      if (!implementerProvider && !options.dryRun) {
        if (!options.agentProviderFactory) {
          throw new FactoryImplementationRunError(
            "Live factory implementation requires agentProviderFactory",
          );
        }
        implementerProvider = options.agentProviderFactory({
          provider: options.implementerRole.agent,
          codexPathOverride: options.implementerRole.codexPathOverride,
        });
      }
      if (!implementerProvider) {
        throw new FactoryImplementationRunError(
          "Implementer provider is unavailable during dry-run",
        );
      }
      return implementerProvider;
    },
    export(input): FactoryImplementationRunMeta {
      // Only advertise live artifact paths when they were actually written.
      const includeLiveArtifacts = input.includeLiveArtifacts ?? liveArtifactsWritten;
      const meta = buildMeta({
        status: input.status,
        startedAt,
        runId,
        runDir,
        workspace,
        workItem: options.workItem,
        mode: options.implementationInput.mode,
        implementerAgent,
        factoryMetadata: options.implementationInput.metadata,
        factoryStore: options.factoryStore,
        includeEventsFile: !options.dryRun && !input.preProviderFailure,
        includeLiveArtifacts: options.dryRun ? false : includeLiveArtifacts,
        preProviderFailure: Boolean(input.preProviderFailure),
        error: input.error,
        implementerSession: input.implementerSession,
        reviewBase: input.reviewBase,
        reviewHead: input.reviewHead,
        reviewCommitSha: input.reviewCommitSha,
        reviewTree: input.reviewTree,
        streamLogExists: existsSync(join(runDir, "implementation/implementer.stream.jsonl")),
      });
      writeFileSync(
        join(runDir, "summary.md"),
        renderSummary(meta, options.implementationInput, Boolean(options.linearApplyRequested)),
        "utf8",
      );
      writeJson(join(runDir, "meta.json"), meta);
      return meta;
    },
  };
}

function buildMeta(input: {
  status: FactoryImplementationRunStatus;
  startedAt: Date;
  runId: string;
  runDir: string;
  workspace: string;
  workItem: FactoryWorkItem;
  mode: FactoryImplementationInput["mode"];
  implementerAgent: FactoryImplementationAgentMeta;
  factoryMetadata: FactoryWorkItemMetadata;
  factoryStore?: FactoryStoreMeta;
  includeEventsFile: boolean;
  includeLiveArtifacts: boolean;
  preProviderFailure: boolean;
  error?: string;
  implementerSession?: AgentSessionRef;
  reviewBase?: string;
  reviewHead?: string;
  reviewCommitSha?: string;
  reviewTree?: string;
  streamLogExists: boolean;
}): FactoryImplementationRunMeta {
  const baseArtifacts: FactoryImplementationBaseArtifacts = {
    workItem: "context/work-item.json",
    implementationInput: "context/implementation-input.json",
    ...(input.mode === "planned"
      ? { planRef: "context/plan-ref.json" }
      : { sourceMaterial: "context/source-material.json" }),
    summary: "summary.md",
    meta: "meta.json",
  };
  const common = {
    runId: input.runId,
    workflow: FACTORY_IMPLEMENTATION_WORKFLOW,
    status: input.status,
    mode: input.mode,
    workspace: input.workspace,
    runDir: input.runDir,
    workItem: {
      id: input.workItem.id,
      source: input.workItem.source,
      title: input.workItem.title,
    },
    implementerAgent: input.implementerAgent,
    factoryMetadata: input.factoryMetadata,
    summaryPath: join(input.runDir, "summary.md"),
    metaPath: join(input.runDir, "meta.json"),
    startedAt: input.startedAt.toISOString(),
    durationMs: Date.now() - input.startedAt.getTime(),
    ...(input.error ? { error: input.error } : {}),
    ...(input.implementerSession ? { implementerSession: input.implementerSession } : {}),
    ...(input.reviewBase ? { reviewBase: input.reviewBase } : {}),
    ...(input.reviewHead ? { reviewHead: input.reviewHead } : {}),
    ...(input.reviewCommitSha ? { reviewCommitSha: input.reviewCommitSha } : {}),
    ...(input.reviewTree ? { reviewTree: input.reviewTree } : {}),
    ...(input.factoryStore ? { factoryStore: input.factoryStore } : {}),
    execution: factoryExecutionProvenance(input.workspace, input.runDir),
  };
  if (input.preProviderFailure) {
    return {
      ...common,
      status: "implementation-failed",
      artifacts: baseArtifacts,
    };
  }
  const artifacts: FactoryImplementationArtifacts = {
    ...baseArtifacts,
    prompt: "implementation/prompt.md",
    changeReviewHandoff: "implementation/change-review-handoff.md",
    ...(input.includeLiveArtifacts
      ? {
          rawOutput: "implementation/implementer.raw.json" as const,
          workspaceStatus: "implementation/workspace-status.json" as const,
          diff: "implementation/diff.patch" as const,
          ...(input.streamLogExists
            ? { streamLog: "implementation/implementer.stream.jsonl" as const }
            : {}),
        }
      : {}),
  };
  return {
    ...common,
    artifacts,
    ...(input.includeEventsFile ? { eventsFile: WORKFLOW_EVENTS_FILE } : {}),
  };
}

function renderSummary(
  meta: FactoryImplementationRunMeta,
  implementationInput: FactoryImplementationInput,
  linearApplyRequested: boolean,
): string {
  const modeDetails =
    implementationInput.mode === "planned"
      ? [
          "## Planned Input",
          "",
          `- Approved plan path: ${implementationInput.approvedPlanPath}`,
          `- Plan path: ${implementationInput.planPath}`,
          `- Approved plan commit: ${implementationInput.approvedPlanCommit}`,
        ]
      : [
          "## Direct Input",
          "",
          `- Source title: ${implementationInput.sourceMaterial.title}`,
          ...(implementationInput.sourceMaterial.url
            ? [`- Source URL: ${implementationInput.sourceMaterial.url}`]
            : []),
          ...(implementationInput.sourceMaterial.tracker
            ? [`- Tracker: ${JSON.stringify(implementationInput.sourceMaterial.tracker)}`]
            : []),
        ];

  const liveActions =
    meta.status === "dry_run"
      ? [
          "- Provider invocation: not run.",
          "- Reviewer invocation: not run.",
          "- Lifecycle events: not written.",
        ]
      : isPreProviderFailureMeta(meta)
        ? [
            "- Provider invocation: not run.",
            "- Reviewer invocation: not run.",
            "- Lifecycle events: imported/started/failed terminal evidence written.",
          ]
        : [
            `- Provider run status: ${meta.status}`,
            ...(meta.implementerSession
              ? [
                  `- Implementer session: ${meta.implementerSession.provider} ${meta.implementerSession.id}`,
                ]
              : []),
            ...(meta.reviewBase ? [`- Review base: ${meta.reviewBase}`] : []),
            ...(meta.reviewHead ? [`- Review head: ${meta.reviewHead}`] : []),
            ...(meta.reviewCommitSha ? [`- Review commit: ${meta.reviewCommitSha}`] : []),
            ...(meta.artifacts.diff ? [`- Diff path: ${meta.artifacts.diff}`] : []),
            ...(meta.artifacts.changeReviewHandoff
              ? [`- Handoff path: ${meta.artifacts.changeReviewHandoff}`]
              : []),
            "- Reviewer invocation: not run.",
            "- Lifecycle events: written by harness command.",
          ];

  return [
    "# Factory Implementation",
    "",
    `- Run: ${meta.runId}`,
    `- Status: ${meta.status}`,
    `- Mode: ${meta.mode}`,
    `- Work item: ${meta.workItem.id} - ${meta.workItem.title}`,
    `- Implementer: ${meta.implementerAgent.name} ${meta.implementerAgent.model}`,
    ...(meta.error ? [`- Error: ${meta.error}`] : []),
    "",
    "## Artifacts",
    "",
    ...Object.entries(meta.artifacts).map(([key, path]) => `- ${key}: ${path}`),
    "",
    ...modeDetails,
    "",
    "## Actions",
    "",
    ...liveActions,
    linearApplyRequested
      ? "- Linear apply: requested; Harness command owns start and terminal projection."
      : "- Linear mutation: not run.",
    "- GitHub/PR mutation: not run.",
    "- Branch/worktree orchestration: not run.",
    "",
  ].join("\n");
}

function isPreProviderFailureMeta(
  meta: FactoryImplementationRunMeta,
): meta is FactoryImplementationRunMeta & {
  status: "implementation-failed";
  artifacts: FactoryImplementationPreProviderFailureArtifacts;
} {
  return meta.status === "implementation-failed" && meta.artifacts.prompt === undefined;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

function cleanupOrphanedFactoryImplementationRunDir(runDir: string): boolean {
  if (existsSync(join(runDir, "meta.json"))) {
    return false;
  }
  rmSync(runDir, { recursive: true, force: true });
  return true;
}

function asFactoryImplementationRunError(error: unknown): FactoryImplementationRunError {
  if (error instanceof FactoryImplementationRunError) return error;
  return new FactoryImplementationRunError(errorMessage(error), { cause: error });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
