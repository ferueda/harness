import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Agent, AgentProviderOptions, AgentSessionRef } from "./agents.ts";
import type { FactoryRoleAgent } from "./config.ts";
import type { FactoryWorkItem } from "./factory-schemas.ts";
import type { WorkflowEventSink } from "./workflow-events.ts";
import { deriveFactoryWorkItemKey } from "./factory-lifecycle.ts";
import type { FactoryStoreMeta } from "./factory-store.ts";
import type {
  CandidateTuple,
  EffectiveReviewLimit,
  ImplementationReviewCheckpoint,
} from "./factory-implementation-review-schemas.ts";
import type { FactoryRunAllocation } from "./factory-run-allocation.ts";

export const FACTORY_IMPLEMENTATION_REVIEW_WORKFLOW = "factory-implementation-review" as const;

export type FactoryImplementationReviewRunStatus =
  | "review-running"
  | "review-complete"
  | "ready-for-human"
  | "review-failed"
  | "rejected"
  | "already-complete";

export type FactoryImplementationReviewRunMeta = {
  runId: string;
  workflow: typeof FACTORY_IMPLEMENTATION_REVIEW_WORKFLOW;
  status: FactoryImplementationReviewRunStatus;
  workspace: string;
  runDir: string;
  workItem: { id: string; source: FactoryWorkItem["source"]; title: string };
  implementationRunId: string;
  originalReviewBase: string;
  approvedCandidate: CandidateTuple;
  effectiveReviewLimit: EffectiveReviewLimit;
  completedReviewCount: number;
  candidateVersion: number;
  reviewerAgent: FactoryRoleAgent;
  implementerSession?: AgentSessionRef;
  factoryStore: FactoryStoreMeta;
  approvedPlanPath?: string;
  summaryPath: string;
  metaPath: string;
  handoffPath?: string;
  error?: string;
  artifacts: Record<string, string>;
};

export type FactoryImplementationReviewLegacyRunMeta = Omit<
  FactoryImplementationReviewRunMeta,
  | "originalReviewBase"
  | "approvedCandidate"
  | "effectiveReviewLimit"
  | "completedReviewCount"
  | "candidateVersion"
> & {
  status: "ready-for-human";
  legacyIncomplete: true;
  missing: string[];
};

export type FactoryImplementationReviewRunContextOptions = {
  allocation: FactoryRunAllocation;
  workspace: string;
  workItem: FactoryWorkItem;
  implementationRunId: string;
  originalReviewBase: string;
  approvedCandidate: CandidateTuple;
  checkpoint: ImplementationReviewCheckpoint;
  factoryStore: FactoryStoreMeta;
  reviewerRole: FactoryRoleAgent;
  implementerRole: FactoryRoleAgent;
  approvedPlanPath?: string;
  agentProviderFactory?: (options: AgentProviderOptions) => Agent;
  maxRuntimeMs: number;
  eventSink?: WorkflowEventSink;
  signal?: AbortSignal;
};

export type FactoryImplementationReviewRunContext = {
  runId: string;
  runDir: string;
  workspace: string;
  workItem: FactoryWorkItem;
  implementationRunId: string;
  originalReviewBase: string;
  approvedCandidate: CandidateTuple;
  checkpoint: ImplementationReviewCheckpoint;
  factoryStore: FactoryStoreMeta;
  reviewerRole: FactoryRoleAgent;
  implementerRole: FactoryRoleAgent;
  approvedPlanPath?: string;
  maxRuntimeMs: number;
  eventSink?: WorkflowEventSink;
  signal?: AbortSignal;
  writeReservation(): void;
  writeIdentityContext(): void;
  writeArtifact(relativePath: string, value: unknown): string;
  writeText(relativePath: string, value: string): string;
  writePrompt(prompt: string, relativePath?: string): string;
  writeSummary(summary: string): string;
  writeHandoff(handoff: string): string;
  export(input: {
    status: FactoryImplementationReviewRunStatus;
    completedReviewCount?: number;
    candidateVersion?: number;
    approvedCandidate?: CandidateTuple;
    error?: string;
    handoffPath?: string;
  }): FactoryImplementationReviewRunMeta;
  implementerProvider(): Agent;
  reviewerProvider(): Agent;
};

export function createFactoryImplementationReviewRunContext(
  options: FactoryImplementationReviewRunContextOptions,
): FactoryImplementationReviewRunContext {
  return createFactoryImplementationReviewRunContextInternal(options);
}

export function createFactoryImplementationReviewRunContextForTest(
  options: FactoryImplementationReviewRunContextOptions,
): FactoryImplementationReviewRunContext {
  return createFactoryImplementationReviewRunContextInternal(options);
}

function createFactoryImplementationReviewRunContextInternal(
  options: FactoryImplementationReviewRunContextOptions,
): FactoryImplementationReviewRunContext {
  const workspace = resolve(options.workspace);
  if (!existsSync(workspace)) throw new Error(`Workspace does not exist: ${workspace}`);
  const runDir = resolve(options.allocation.runDir);
  const artifacts = new Map<string, string>();
  let provider: Agent | undefined;
  let reviewer: Agent | undefined;
  if (!existsSync(runDir)) throw new Error(`Allocated Factory review run is missing: ${runDir}`);

  const writeText = (relativePath: string, value: string): string => {
    const path = safeRunPath(runDir, relativePath);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, value, "utf8");
    artifacts.set(relativePath, relativePath);
    return path;
  };
  const writeArtifact = (relativePath: string, value: unknown): string =>
    writeText(relativePath, `${JSON.stringify(value, null, 2)}\n`);
  const writeReservation = (): void => {
    const reservation = {
      station: "implementation-review",
      workItemKey: deriveFactoryWorkItemKey(options.workItem),
      runId: options.allocation.runId,
      reservationToken: options.allocation.reservationToken,
      workspace: workspace,
      physicalWorkspace: options.checkpoint.workspace.physicalGitRoot,
      storeRoot: options.factoryStore.storeRoot,
      factoryProjectId: options.factoryStore.projectId,
      factoryStateRoot: options.factoryStore.factoryStateRoot,
      factoryRunsDir: options.factoryStore.factoryRunsDir,
      reviewRunsDir: options.factoryStore.reviewRunsDir,
      attempt: "review",
    };
    writeArtifact("attempt-reservation.json", reservation);
    writeArtifact("implementation-review-reservation.json", reservation);
  };
  const writeIdentityContext = (): void => {
    writeArtifact("context/work-item.json", options.workItem);
    writeArtifact("context/implementation-ref.json", {
      implementationRunId: options.implementationRunId,
      originalReviewBase: options.originalReviewBase,
      approvedCandidate: options.approvedCandidate,
      approvedPlanPath: options.approvedPlanPath,
    });
  };
  const writePrompt = (
    prompt: string,
    relativePath = "iterations/1/remediation.prompt.md",
  ): string => writeText(relativePath, prompt);
  const writeSummary = (summary: string): string => writeText("summary.md", summary);
  const writeHandoff = (handoff: string): string =>
    writeText("implementation-review/pr-ready-handoff.md", handoff);
  const exportRun = (input: {
    status: FactoryImplementationReviewRunStatus;
    completedReviewCount?: number;
    candidateVersion?: number;
    approvedCandidate?: CandidateTuple;
    error?: string;
    handoffPath?: string;
  }): FactoryImplementationReviewRunMeta => {
    const summaryPath = join(runDir, "summary.md");
    const metaPath = join(runDir, "meta.json");
    const meta: FactoryImplementationReviewRunMeta = {
      runId: options.allocation.runId,
      workflow: FACTORY_IMPLEMENTATION_REVIEW_WORKFLOW,
      status: input.status,
      workspace,
      runDir,
      workItem: {
        id: options.workItem.id,
        source: options.workItem.source,
        title: options.workItem.title,
      },
      implementationRunId: options.implementationRunId,
      originalReviewBase: options.originalReviewBase,
      approvedCandidate: input.approvedCandidate ?? options.approvedCandidate,
      effectiveReviewLimit: options.checkpoint.effectiveReviewLimit,
      completedReviewCount: input.completedReviewCount ?? options.checkpoint.completedReviewCount,
      candidateVersion: input.candidateVersion ?? options.checkpoint.candidateVersion,
      reviewerAgent: options.reviewerRole,
      ...(options.checkpoint.implementerSession
        ? { implementerSession: options.checkpoint.implementerSession }
        : {}),
      factoryStore: options.factoryStore,
      ...(options.approvedPlanPath ? { approvedPlanPath: options.approvedPlanPath } : {}),
      summaryPath,
      metaPath,
      ...(input.handoffPath ? { handoffPath: input.handoffPath } : {}),
      ...(input.error ? { error: input.error } : {}),
      artifacts: Object.fromEntries(artifacts),
    };
    writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
    return meta;
  };

  return {
    runId: options.allocation.runId,
    runDir,
    workspace,
    workItem: options.workItem,
    implementationRunId: options.implementationRunId,
    originalReviewBase: options.originalReviewBase,
    approvedCandidate: options.approvedCandidate,
    checkpoint: options.checkpoint,
    factoryStore: options.factoryStore,
    reviewerRole: options.reviewerRole,
    implementerRole: options.implementerRole,
    ...(options.approvedPlanPath ? { approvedPlanPath: options.approvedPlanPath } : {}),
    maxRuntimeMs: options.maxRuntimeMs,
    ...(options.eventSink ? { eventSink: options.eventSink } : {}),
    signal: options.signal,
    writeReservation,
    writeIdentityContext,
    writeArtifact,
    writeText,
    writePrompt,
    writeSummary,
    writeHandoff,
    export: exportRun,
    implementerProvider(): Agent {
      provider ??= options.agentProviderFactory?.({
        provider: options.implementerRole.agent,
        codexPathOverride: options.implementerRole.codexPathOverride,
      });
      if (!provider)
        throw new Error("Factory implementation reviewer context has no implementer provider");
      return provider;
    },
    reviewerProvider(): Agent {
      reviewer ??= options.agentProviderFactory?.({
        provider: options.reviewerRole.agent,
        codexPathOverride: options.reviewerRole.codexPathOverride,
      });
      if (!reviewer)
        throw new Error("Factory implementation reviewer context has no reviewer provider");
      return reviewer;
    },
  };
}

function safeRunPath(runDir: string, relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`Factory review artifact path escapes run directory: ${relativePath}`);
  }
  if (lstatSync(runDir).isSymbolicLink()) {
    throw new Error(`Factory review run directory is symlinked: ${runDir}`);
  }
  let current = join(runDir, normalized);
  while (current !== runDir) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(`Factory review artifact ancestor is symlinked: ${current}`);
    }
    current = join(current, "..");
  }
  return join(runDir, normalized);
}
