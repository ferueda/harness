import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { FactoryImplementationRunMeta } from "./factory-implementation-run-context.ts";
import type { FactoryRunMeta } from "./factory-run-context.ts";
import {
  appendFactoryLifecycleEvent,
  deriveFactoryWorkItemKey,
  resolveFactoryStateRoot,
  type FactoryLifecycleEvent,
  type FactoryLifecycleExecution,
} from "./factory-lifecycle.ts";
import type { FactoryPlanningRunMeta } from "./factory-planning-run-context.ts";
import { FactoryWorkItemMetadataSchema, type FactoryWorkItem } from "./factory-schemas.ts";
import { factoryLifecycleExecutionProvenance } from "./factory-store.ts";
import { canonicalizeFactoryWorkspace } from "./factory-locks.ts";

export type FactoryLifecycleWriteOptions = {
  factoryStateRoot?: string;
  /** Low-level/test-only workspace-local escape hatch. Never use from factory commands. */
  allowWorkspaceLocalStateRoot?: boolean;
  occurredAt?: string;
};

export function appendWorkItemImportedEvent(
  input: {
    workspace: string;
    workItem: FactoryWorkItem;
    execution?: FactoryLifecycleExecution;
  } & FactoryLifecycleWriteOptions,
): FactoryLifecycleEvent {
  const workItemKey = deriveFactoryWorkItemKey(input.workItem);
  const parsedMetadata = FactoryWorkItemMetadataSchema.safeParse(input.workItem.metadata ?? {});
  const metadata = parsedMetadata.success ? parsedMetadata.data : undefined;
  const tracker = metadata?.tracker;
  return appendFactoryLifecycleEvent({
    factoryStateRoot: requireFactoryStateRoot(input),
    event: {
      version: 1,
      id: `work_item.imported:${workItemKey}`,
      type: "work_item.imported",
      workItemKey,
      occurredAt: occurredAt(input),
      source: "harness",
      ...(input.execution ? { execution: input.execution } : {}),
      data: {
        source: input.workItem.source,
        title: input.workItem.title,
        ...(tracker ? { tracker } : {}),
        ...(input.workItem.url ? { url: input.workItem.url } : {}),
        ...(input.workItem.labels.length > 0 ? { labels: input.workItem.labels } : {}),
        ...(metadata?.approvedPlanPath ? { approvedPlanPath: metadata.approvedPlanPath } : {}),
        ...(metadata?.approvedPlanPrUrl ? { approvedPlanPrUrl: metadata.approvedPlanPrUrl } : {}),
        ...(metadata?.approvedPlanCommit
          ? { approvedPlanCommit: metadata.approvedPlanCommit }
          : {}),
      },
    },
  });
}

export function appendTriageStartedEvent(
  input: {
    workspace: string;
    workItem: FactoryWorkItem;
    runId: string;
    execution: FactoryLifecycleExecution;
    linearIssue?: string;
    itemFile?: string;
  } & FactoryLifecycleWriteOptions,
): FactoryLifecycleEvent {
  const workItemKey = deriveFactoryWorkItemKey(input.workItem);
  return appendFactoryLifecycleEvent({
    factoryStateRoot: requireFactoryStateRoot(input),
    event: {
      version: 1,
      id: `triage.started:${input.runId}`,
      type: "triage.started",
      workItemKey,
      occurredAt: occurredAt(input),
      runId: input.runId,
      source: "harness",
      execution: input.execution,
      data: {
        ...(input.linearIssue ? { linearIssue: input.linearIssue } : {}),
        ...(input.itemFile ? { itemFile: input.itemFile } : {}),
      },
    },
  });
}

export function appendTriageTerminalEvent(input: {
  workspace: string;
  workItem: FactoryWorkItem;
  meta: FactoryRunMeta;
  triage?: {
    rationale: string;
    questions: string[];
    reconsiderWhen: string | null;
  };
  factoryStateRoot?: string;
  allowWorkspaceLocalStateRoot?: boolean;
}): FactoryLifecycleEvent {
  const workItemKey = deriveFactoryWorkItemKey(input.workItem);
  const factoryStateRoot = requireFactoryStateRoot(input);
  const execution = executionFromMeta(input.meta);
  if (input.meta.status === "completed") {
    return appendFactoryLifecycleEvent({
      factoryStateRoot,
      event: {
        version: 1,
        id: `triage.completed:${input.meta.runId}`,
        type: "triage.completed",
        workItemKey,
        occurredAt: new Date().toISOString(),
        runId: input.meta.runId,
        source: "harness",
        execution,
        data: {
          route: required(input.meta.route, "triage route"),
          nextAction: required(input.meta.nextAction, "triage nextAction"),
          rationale: required(input.triage?.rationale, "triage rationale"),
          routeArtifactPath: formatMetaArtifactPath(
            input.meta,
            required(
              input.meta.artifacts?.routeSummary ?? input.meta.artifacts?.route,
              "route artifact path",
            ),
          ),
          triageArtifactPath: formatMetaArtifactPath(
            input.meta,
            required(input.meta.artifacts?.triage, "triage artifact path"),
          ),
          ...(input.triage && input.triage.questions.length
            ? { questions: input.triage.questions }
            : {}),
          ...(input.triage && input.triage.reconsiderWhen !== null
            ? { reconsiderWhen: input.triage.reconsiderWhen }
            : {}),
        },
      },
    });
  }
  return appendFactoryLifecycleEvent({
    factoryStateRoot,
    event: {
      version: 1,
      id: `triage.failed:${input.meta.runId}`,
      type: "triage.failed",
      workItemKey,
      occurredAt: new Date().toISOString(),
      runId: input.meta.runId,
      source: "harness",
      execution,
      data: {
        error: input.meta.error ?? "Factory triage failed.",
        summaryPath: formatMetaArtifactPath(
          input.meta,
          input.meta.artifacts?.summary ?? "summary.md",
        ),
      },
    },
  });
}

export function appendPlanningStartedEvent(
  input: {
    workspace: string;
    workItem: FactoryWorkItem;
    runId: string;
    execution: FactoryLifecycleExecution;
    linearIssue?: string;
    itemFile?: string;
  } & FactoryLifecycleWriteOptions,
): FactoryLifecycleEvent {
  const workItemKey = deriveFactoryWorkItemKey(input.workItem);
  return appendFactoryLifecycleEvent({
    factoryStateRoot: requireFactoryStateRoot(input),
    event: {
      version: 1,
      id: `planning.started:${input.runId}`,
      type: "planning.started",
      workItemKey,
      occurredAt: occurredAt(input),
      runId: input.runId,
      source: "harness",
      execution: input.execution,
      data: {
        ...(input.linearIssue ? { linearIssue: input.linearIssue } : {}),
        ...(input.itemFile ? { itemFile: input.itemFile } : {}),
      },
    },
  });
}

export function appendPlanningTerminalEvent(input: {
  meta: FactoryPlanningRunMeta;
  factoryStateRoot?: string;
  allowWorkspaceLocalStateRoot?: boolean;
  error?: string;
}): FactoryLifecycleEvent | undefined {
  if (input.meta.status === "dry_run") return undefined;
  const workItem = planningMetaWorkItem(input.meta);
  const workItemKey = deriveFactoryWorkItemKey(workItem);
  const factoryStateRoot = requireFactoryStateRoot({
    workspace: input.meta.workspace,
    factoryStateRoot: input.factoryStateRoot,
    allowWorkspaceLocalStateRoot: input.allowWorkspaceLocalStateRoot,
  });
  if (input.meta.status === "planning-failed") {
    return appendFactoryLifecycleEvent({
      factoryStateRoot,
      event: {
        version: 1,
        id: `planning.failed:${input.meta.runId}`,
        type: "planning.failed",
        workItemKey,
        occurredAt: new Date().toISOString(),
        runId: input.meta.runId,
        source: "harness",
        execution: planningExecution(input.meta),
        data: {
          error: input.error ?? input.meta.error ?? "Factory planning failed.",
          summaryPath: formatMetaArtifactPath(input.meta, input.meta.summaryPath),
        },
      },
    });
  }
  return appendFactoryLifecycleEvent({
    factoryStateRoot,
    event: {
      version: 1,
      id: `planning.completed:${input.meta.runId}`,
      type: "planning.completed",
      workItemKey,
      occurredAt: new Date().toISOString(),
      runId: input.meta.runId,
      source: "harness",
      execution: planningExecution(input.meta),
      data: {
        status: input.meta.status,
        ...(input.meta.factoryMetadata?.approvedPlanPath
          ? { approvedPlanPath: input.meta.factoryMetadata.approvedPlanPath }
          : {}),
        ...(input.meta.humanQuestions?.length ? { humanQuestions: input.meta.humanQuestions } : {}),
        ...latestReviewPaths(input.meta),
        iterationCount: input.meta.iterations.length,
      },
    },
  });
}

export function appendImplementationStartedEvent(
  input: {
    workspace: string;
    workItem: FactoryWorkItem;
    runId: string;
    execution: FactoryLifecycleExecution;
    linearIssue?: string;
    itemFile?: string;
  } & FactoryLifecycleWriteOptions,
): FactoryLifecycleEvent {
  const workItemKey = deriveFactoryWorkItemKey(input.workItem);
  const metadata = FactoryWorkItemMetadataSchema.safeParse(input.workItem.metadata ?? {});
  const retry = metadata.success && metadata.data.factoryStage === "implementation-failed";
  return appendFactoryLifecycleEvent({
    factoryStateRoot: requireFactoryStateRoot(input),
    event: {
      version: 1,
      id: `implementation.started:${input.runId}`,
      type: "implementation.started",
      workItemKey,
      occurredAt: occurredAt(input),
      runId: input.runId,
      source: "harness",
      execution: input.execution,
      data: {
        ...(input.linearIssue ? { linearIssue: input.linearIssue } : {}),
        ...(input.itemFile ? { itemFile: input.itemFile } : {}),
      },
    },
    precondition: {
      allowedStages: [undefined, "ready-to-implement", "implementation-failed"],
      ...(retry && metadata.data.factoryRunId
        ? { expectedFactoryRunId: metadata.data.factoryRunId }
        : {}),
    },
  });
}

export function appendImplementationTerminalEvent(input: {
  meta: FactoryImplementationRunMeta;
  factoryStateRoot?: string;
  allowWorkspaceLocalStateRoot?: boolean;
  error?: string;
}): FactoryLifecycleEvent | undefined {
  if (input.meta.status === "dry_run") return undefined;
  const workItem = implementationMetaWorkItem(input.meta);
  const workItemKey = deriveFactoryWorkItemKey(workItem);
  const factoryStateRoot = requireFactoryStateRoot({
    workspace: input.meta.workspace,
    factoryStateRoot: input.factoryStateRoot,
    allowWorkspaceLocalStateRoot: input.allowWorkspaceLocalStateRoot,
  });
  const execution = implementationExecution(input.meta);
  if (input.meta.status === "implementation-failed") {
    return appendFactoryLifecycleEvent({
      factoryStateRoot,
      event: {
        version: 1,
        id: `implementation.failed:${input.meta.runId}`,
        type: "implementation.failed",
        workItemKey,
        occurredAt: new Date().toISOString(),
        runId: input.meta.runId,
        source: "harness",
        execution,
        data: {
          error: input.error ?? input.meta.error ?? "Factory implementation failed.",
          summaryPath: formatMetaArtifactPath(input.meta, input.meta.summaryPath),
          ...(input.meta.artifacts.rawOutput
            ? {
                rawOutputPath: formatMetaArtifactPath(input.meta, input.meta.artifacts.rawOutput),
              }
            : {}),
          ...(input.meta.artifacts.streamLog
            ? {
                streamLogPath: formatMetaArtifactPath(input.meta, input.meta.artifacts.streamLog),
              }
            : {}),
          ...(input.meta.artifacts.workspaceStatus
            ? {
                workspaceStatusPath: formatMetaArtifactPath(
                  input.meta,
                  input.meta.artifacts.workspaceStatus,
                ),
              }
            : {}),
          ...(input.meta.reviewBase ? { reviewBase: input.meta.reviewBase } : {}),
        },
      },
      precondition: {
        allowedStages: [undefined, "implementation-started"],
        expectedFactoryRunId: input.meta.runId,
      },
    });
  }
  return appendFactoryLifecycleEvent({
    factoryStateRoot,
    event: {
      version: 1,
      id: `implementation.completed:${input.meta.runId}`,
      type: "implementation.completed",
      workItemKey,
      occurredAt: new Date().toISOString(),
      runId: input.meta.runId,
      source: "harness",
      execution,
      data: {
        diffPath: formatMetaArtifactPath(
          input.meta,
          required(input.meta.artifacts.diff, "diff artifact"),
        ),
        changeReviewHandoffPath: formatMetaArtifactPath(
          input.meta,
          input.meta.artifacts.changeReviewHandoff,
        ),
        reviewBase: required(input.meta.reviewBase, "reviewBase"),
        reviewHead: required(input.meta.reviewHead, "reviewHead"),
        reviewCommitSha: required(input.meta.reviewCommitSha, "reviewCommitSha"),
        ...(input.meta.artifacts.rawOutput
          ? {
              rawOutputPath: formatMetaArtifactPath(input.meta, input.meta.artifacts.rawOutput),
            }
          : {}),
        ...(input.meta.artifacts.streamLog
          ? {
              streamLogPath: formatMetaArtifactPath(input.meta, input.meta.artifacts.streamLog),
            }
          : {}),
        ...(input.meta.artifacts.workspaceStatus
          ? {
              workspaceStatusPath: formatMetaArtifactPath(
                input.meta,
                input.meta.artifacts.workspaceStatus,
              ),
            }
          : {}),
        ...(input.meta.implementerSession
          ? {
              session: {
                provider: input.meta.implementerSession.provider,
                id: input.meta.implementerSession.id,
              },
            }
          : {}),
        ...(input.meta.reviewTree && input.meta.factoryStore
          ? {
              candidateTree: input.meta.reviewTree,
              workspace: {
                ...canonicalizeFactoryWorkspace(input.meta.workspace),
                factoryProjectId: input.meta.factoryStore.projectId,
              },
              runRoots: {
                factoryRunsDir: input.meta.factoryStore.factoryRunsDir,
                reviewRunsDir: input.meta.factoryStore.reviewRunsDir,
              },
            }
          : {}),
      },
    },
    precondition: {
      allowedStages: [undefined, "implementation-started"],
      expectedFactoryRunId: input.meta.runId,
    },
  });
}

export function appendPlanPrOpenedEvent(input: {
  meta: FactoryPlanningRunMeta;
  factoryStateRoot?: string;
  allowWorkspaceLocalStateRoot?: boolean;
}): FactoryLifecycleEvent {
  const metadata = requireOpenedPublicationMetadata(input.meta);
  return appendFactoryLifecycleEvent({
    factoryStateRoot: requireFactoryStateRoot({
      workspace: input.meta.workspace,
      factoryStateRoot: input.factoryStateRoot,
      allowWorkspaceLocalStateRoot: input.allowWorkspaceLocalStateRoot,
    }),
    event: {
      version: 1,
      id: `plan_pr.opened:${input.meta.runId}:${metadata.approvedPlanPrUrl}`,
      type: "plan_pr.opened",
      workItemKey: deriveFactoryWorkItemKey(planningMetaWorkItem(input.meta)),
      occurredAt: new Date().toISOString(),
      runId: input.meta.runId,
      source: "harness",
      execution: planningExecution(input.meta),
      data: {
        approvedPlanPath: metadata.approvedPlanPath,
        approvedPlanPrUrl: metadata.approvedPlanPrUrl,
      },
    },
  });
}

export function appendPlanPrMergedEvent(input: {
  meta: FactoryPlanningRunMeta;
  factoryStateRoot?: string;
  allowWorkspaceLocalStateRoot?: boolean;
}): FactoryLifecycleEvent {
  const metadata = requireMergedPublicationMetadata(input.meta);
  return appendFactoryLifecycleEvent({
    factoryStateRoot: requireFactoryStateRoot({
      workspace: input.meta.workspace,
      factoryStateRoot: input.factoryStateRoot,
      allowWorkspaceLocalStateRoot: input.allowWorkspaceLocalStateRoot,
    }),
    event: {
      version: 1,
      id: `plan_pr.merged:${input.meta.runId}:${metadata.approvedPlanCommit}`,
      type: "plan_pr.merged",
      workItemKey: deriveFactoryWorkItemKey(planningMetaWorkItem(input.meta)),
      occurredAt: new Date().toISOString(),
      runId: input.meta.runId,
      source: "harness",
      execution: planningExecution(input.meta),
      data: {
        approvedPlanPath: metadata.approvedPlanPath,
        approvedPlanPrUrl: metadata.approvedPlanPrUrl,
        approvedPlanCommit: metadata.approvedPlanCommit,
      },
    },
  });
}

function planningMetaWorkItem(meta: FactoryPlanningRunMeta): FactoryWorkItem {
  return {
    id: meta.workItem.id,
    source: meta.workItem.source,
    title: meta.workItem.title,
    body: "",
    labels: [],
    metadata: meta.factoryMetadata,
  };
}

function planningExecution(meta: FactoryPlanningRunMeta): FactoryLifecycleExecution {
  return executionWithStore(meta);
}

function implementationMetaWorkItem(meta: FactoryImplementationRunMeta): FactoryWorkItem {
  return {
    id: meta.workItem.id,
    source: meta.workItem.source,
    title: meta.workItem.title,
    body: "",
    labels: [],
    metadata: meta.factoryMetadata,
  };
}

function implementationExecution(meta: FactoryImplementationRunMeta): FactoryLifecycleExecution {
  return executionWithStore(meta);
}

function executionFromMeta(meta: FactoryRunMeta): FactoryLifecycleExecution {
  return executionWithStore(meta);
}

function executionWithStore(meta: {
  workspace: string;
  runDir: string;
  execution?: FactoryLifecycleExecution;
  factoryStore?: FactoryRunMeta["factoryStore"];
}): FactoryLifecycleExecution {
  const execution = {
    workspace: meta.execution?.workspace ?? meta.workspace,
    runDir: meta.execution?.runDir ?? meta.runDir,
    ...(meta.execution?.branch ? { branch: meta.execution.branch } : {}),
    ...(meta.execution?.head ? { head: meta.execution.head } : {}),
  };
  return factoryLifecycleExecutionProvenance(execution, meta.factoryStore);
}

function latestReviewPaths(meta: FactoryPlanningRunMeta): {
  reviewFindingsPath?: string;
  planReviewRefPath?: string;
} {
  const latest = meta.iterations.at(-1);
  if (!latest?.review) return {};
  const iterationDir = join(meta.runDir, "iterations", String(latest.index));
  const reviewFindingsPath = join(iterationDir, "review-findings.json");
  return {
    ...(existsSync(reviewFindingsPath)
      ? { reviewFindingsPath: formatMetaArtifactPath(meta, reviewFindingsPath) }
      : {}),
    planReviewRefPath: formatMetaArtifactPath(meta, join(iterationDir, "plan-review-ref.json")),
  };
}

export function formatLifecycleArtifactPath(input: {
  runDir: string;
  projectRoot?: string;
  path: string;
}): string {
  const absolutePath = isAbsolute(input.path)
    ? resolve(input.path)
    : resolve(input.runDir, input.path);
  const runRelative = relative(resolve(input.runDir), absolutePath);
  if (isInside(runRelative)) return runRelative;
  if (input.projectRoot) {
    const storeRelative = relative(resolve(input.projectRoot), absolutePath);
    if (isInside(storeRelative)) return storeRelative;
  }
  return absolutePath;
}

function formatMetaArtifactPath(
  meta: Pick<FactoryRunMeta, "workspace" | "runDir" | "factoryStore">,
  path: string,
): string {
  return formatLifecycleArtifactPath({
    runDir: meta.runDir,
    projectRoot: meta.factoryStore?.projectRoot,
    path,
  });
}

function isInside(path: string): boolean {
  return (
    path !== "" &&
    path !== ".." &&
    !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(path)
  );
}

function requireOpenedPublicationMetadata(meta: FactoryPlanningRunMeta): {
  approvedPlanPath: string;
  approvedPlanPrUrl: string;
} {
  const metadata = meta.factoryMetadata;
  if (!metadata) throw new Error("Planning run is missing factory metadata.");
  if (!metadata.approvedPlanPath) throw new Error("Planning run is missing approvedPlanPath.");
  if (!metadata.approvedPlanPrUrl) throw new Error("Planning run is missing approvedPlanPrUrl.");
  return {
    approvedPlanPath: metadata.approvedPlanPath,
    approvedPlanPrUrl: metadata.approvedPlanPrUrl,
  };
}

function requireMergedPublicationMetadata(meta: FactoryPlanningRunMeta): {
  approvedPlanPath: string;
  approvedPlanPrUrl: string;
  approvedPlanCommit: string;
} {
  const opened = requireOpenedPublicationMetadata(meta);
  const commit = meta.factoryMetadata?.approvedPlanCommit;
  if (!commit) throw new Error("Planning run is missing approvedPlanCommit.");
  return {
    ...opened,
    approvedPlanCommit: commit,
  };
}

function occurredAt(input: { occurredAt?: string }): string {
  return input.occurredAt ?? new Date().toISOString();
}

function requireFactoryStateRoot(input: {
  workspace: string;
  factoryStateRoot?: string;
  allowWorkspaceLocalStateRoot?: boolean;
}): string {
  if (input.factoryStateRoot) {
    return resolveFactoryStateRoot({
      workspace: input.workspace,
      factoryStateRoot: input.factoryStateRoot,
    });
  }
  if (input.allowWorkspaceLocalStateRoot) {
    return resolveFactoryStateRoot({ workspace: input.workspace });
  }
  throw new Error(
    "factoryStateRoot is required for factory lifecycle writes; pass allowWorkspaceLocalStateRoot only for low-level workspace-local tests.",
  );
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing ${label} for lifecycle event.`);
  return value;
}
