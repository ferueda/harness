import type { FactoryRunMeta } from "../lib/factory-run-context.ts";

export type FactoryTriageCliOutput = {
  runId: FactoryRunMeta["runId"];
  workflow: FactoryRunMeta["workflow"];
  status: FactoryRunMeta["status"];
  workspace: FactoryRunMeta["workspace"];
  runDir: FactoryRunMeta["runDir"];
  workItem: FactoryRunMeta["workItem"];
  route?: FactoryRunMeta["route"];
  nextAction?: FactoryRunMeta["nextAction"];
  summaryPath?: string;
  triagePath?: string;
  routePath?: string;
  routeSummaryPath?: string;
  linearApplied?: false;
};

export function factoryTriageCliOutput(
  meta: FactoryRunMeta,
  options: { linearApplied?: false } = {},
): FactoryTriageCliOutput {
  return {
    runId: meta.runId,
    workflow: meta.workflow,
    status: meta.status,
    workspace: meta.workspace,
    runDir: meta.runDir,
    workItem: meta.workItem,
    route: meta.route,
    nextAction: meta.nextAction,
    summaryPath: meta.artifacts?.summary,
    triagePath: meta.artifacts?.triage,
    routePath: meta.artifacts?.route,
    routeSummaryPath: meta.artifacts?.routeSummary,
    ...(options.linearApplied !== undefined ? { linearApplied: options.linearApplied } : {}),
  };
}
