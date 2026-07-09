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
  };
}
