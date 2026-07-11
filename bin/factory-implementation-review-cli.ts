import type {
  FactoryImplementationReviewLegacyRunMeta,
  FactoryImplementationReviewRunMeta,
} from "../lib/factory-implementation-review-run-context.ts";

type FactoryImplementationReviewCommandMeta =
  | FactoryImplementationReviewRunMeta
  | FactoryImplementationReviewLegacyRunMeta;

type FactoryImplementationReviewCliOutputBase = {
  workflow: string;
  status: FactoryImplementationReviewRunMeta["status"];
  runId: string;
  implementationRunId: string;
  workspace: string;
  runDir: string;
  workItem: FactoryImplementationReviewRunMeta["workItem"];
  artifacts: FactoryImplementationReviewRunMeta["artifacts"];
  summaryPath: string;
  metaPath: string;
  handoffPath?: string;
  error?: string;
};

export type FactoryImplementationReviewCliOutput =
  | (FactoryImplementationReviewCliOutputBase & {
      legacyIncomplete: true;
      missing: string[];
    })
  | (FactoryImplementationReviewCliOutputBase & {
      legacyIncomplete?: never;
      missing?: never;
      originalReviewBase: string;
      approvedCandidate: FactoryImplementationReviewRunMeta["approvedCandidate"];
      completedReviewCount: number;
      candidateVersion: number;
    });

export function factoryImplementationReviewCliOutput(
  meta: FactoryImplementationReviewCommandMeta,
): FactoryImplementationReviewCliOutput {
  if ("legacyIncomplete" in meta) {
    return {
      workflow: meta.workflow,
      status: meta.status,
      runId: meta.runId,
      implementationRunId: meta.implementationRunId,
      workspace: meta.workspace,
      runDir: meta.runDir,
      workItem: meta.workItem,
      artifacts: meta.artifacts,
      summaryPath: meta.summaryPath,
      metaPath: meta.metaPath,
      ...(meta.error ? { error: meta.error } : {}),
      legacyIncomplete: true,
      missing: meta.missing,
    };
  }
  return {
    workflow: meta.workflow,
    status: meta.status,
    runId: meta.runId,
    implementationRunId: meta.implementationRunId,
    workspace: meta.workspace,
    runDir: meta.runDir,
    workItem: meta.workItem,
    originalReviewBase: meta.originalReviewBase,
    approvedCandidate: meta.approvedCandidate,
    completedReviewCount: meta.completedReviewCount,
    candidateVersion: meta.candidateVersion,
    artifacts: meta.artifacts,
    summaryPath: meta.summaryPath,
    metaPath: meta.metaPath,
    ...(meta.handoffPath ? { handoffPath: meta.handoffPath } : {}),
    ...(meta.error ? { error: meta.error } : {}),
  };
}
