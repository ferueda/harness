import { existsSync } from "node:fs";
import { join, relative } from "node:path";
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

export type FactoryLifecycleWriteOptions = {
  factoryStateRoot?: string;
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
  const tracker = parsedMetadata.success ? parsedMetadata.data.tracker : undefined;
  return appendFactoryLifecycleEvent({
    factoryStateRoot: resolveFactoryStateRoot(input),
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
    factoryStateRoot: resolveFactoryStateRoot(input),
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
    questions?: string[];
    reconsiderWhen?: string;
  };
  factoryStateRoot?: string;
}): FactoryLifecycleEvent {
  const workItemKey = deriveFactoryWorkItemKey(input.workItem);
  const factoryStateRoot = resolveFactoryStateRoot(input);
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
          routeArtifactPath: required(
            input.meta.artifacts?.routeSummary ?? input.meta.artifacts?.route,
            "route artifact path",
          ),
          triageArtifactPath: required(input.meta.artifacts?.triage, "triage artifact path"),
          ...(input.triage?.questions?.length ? { questions: input.triage.questions } : {}),
          ...(input.triage?.reconsiderWhen ? { reconsiderWhen: input.triage.reconsiderWhen } : {}),
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
        summaryPath: input.meta.artifacts?.summary ?? "summary.md",
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
    factoryStateRoot: resolveFactoryStateRoot(input),
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
  error?: string;
}): FactoryLifecycleEvent | undefined {
  if (input.meta.status === "dry_run") return undefined;
  const workItem = planningMetaWorkItem(input.meta);
  const workItemKey = deriveFactoryWorkItemKey(workItem);
  const factoryStateRoot = resolveFactoryStateRoot({
    workspace: input.meta.workspace,
    factoryStateRoot: input.factoryStateRoot,
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
          summaryPath: relative(input.meta.workspace, input.meta.summaryPath),
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

export function appendPlanPrOpenedEvent(input: {
  meta: FactoryPlanningRunMeta;
  factoryStateRoot?: string;
}): FactoryLifecycleEvent {
  const metadata = requireOpenedPublicationMetadata(input.meta);
  return appendFactoryLifecycleEvent({
    factoryStateRoot: resolveFactoryStateRoot({
      workspace: input.meta.workspace,
      factoryStateRoot: input.factoryStateRoot,
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
}): FactoryLifecycleEvent {
  const metadata = requireMergedPublicationMetadata(input.meta);
  return appendFactoryLifecycleEvent({
    factoryStateRoot: resolveFactoryStateRoot({
      workspace: input.meta.workspace,
      factoryStateRoot: input.factoryStateRoot,
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
  return {
    workspace: meta.workspace,
    runDir: meta.runDir,
  };
}

function executionFromMeta(meta: FactoryRunMeta): FactoryLifecycleExecution {
  return {
    workspace: meta.workspace,
    runDir: meta.runDir,
  };
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
      ? { reviewFindingsPath: relative(meta.workspace, reviewFindingsPath) }
      : {}),
    planReviewRefPath: relative(meta.workspace, join(iterationDir, "plan-review-ref.json")),
  };
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

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing ${label} for lifecycle event.`);
  return value;
}
