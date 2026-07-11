import type { FactoryImplementationReviewRunMeta } from "../lib/factory-implementation-review-run-context.ts";

export type FactoryImplementationReviewCliOutput = {
  workflow: string;
  status: FactoryImplementationReviewRunMeta["status"];
  runId: string;
  implementationRunId: string;
  workspace: string;
  runDir: string;
  workItem: FactoryImplementationReviewRunMeta["workItem"];
  originalReviewBase: string;
  approvedCandidate: FactoryImplementationReviewRunMeta["approvedCandidate"];
  completedReviewCount: number;
  candidateVersion: number;
  artifacts: FactoryImplementationReviewRunMeta["artifacts"];
  summaryPath: string;
  metaPath: string;
  handoffPath?: string;
  error?: string;
};

export function factoryImplementationReviewCliOutput(
  meta: FactoryImplementationReviewRunMeta,
): FactoryImplementationReviewCliOutput {
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
