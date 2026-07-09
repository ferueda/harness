import type { AgentSessionRef } from "../lib/agents.ts";
import type { FactoryImplementationRunMeta } from "../lib/factory-implementation-run-context.ts";

export type FactoryImplementationCliOutput = {
  runId: FactoryImplementationRunMeta["runId"];
  workflow: FactoryImplementationRunMeta["workflow"];
  status: FactoryImplementationRunMeta["status"];
  mode: FactoryImplementationRunMeta["mode"];
  workspace: FactoryImplementationRunMeta["workspace"];
  runDir: FactoryImplementationRunMeta["runDir"];
  workItem: FactoryImplementationRunMeta["workItem"];
  implementerAgent: FactoryImplementationRunMeta["implementerAgent"];
  artifacts: FactoryImplementationRunMeta["artifacts"];
  summaryPath: string;
  metaPath: string;
  error?: string;
  implementerSession?: AgentSessionRef;
  reviewBase?: string;
  reviewHead?: string;
  reviewCommitSha?: string;
};

export function factoryImplementationCliOutput(
  meta: FactoryImplementationRunMeta,
): FactoryImplementationCliOutput {
  return {
    runId: meta.runId,
    workflow: meta.workflow,
    status: meta.status,
    mode: meta.mode,
    workspace: meta.workspace,
    runDir: meta.runDir,
    workItem: meta.workItem,
    implementerAgent: meta.implementerAgent,
    artifacts: meta.artifacts,
    summaryPath: meta.summaryPath,
    metaPath: meta.metaPath,
    ...(meta.error ? { error: meta.error } : {}),
    ...(meta.implementerSession ? { implementerSession: meta.implementerSession } : {}),
    ...(meta.reviewBase ? { reviewBase: meta.reviewBase } : {}),
    ...(meta.reviewHead ? { reviewHead: meta.reviewHead } : {}),
    ...(meta.reviewCommitSha ? { reviewCommitSha: meta.reviewCommitSha } : {}),
  };
}
