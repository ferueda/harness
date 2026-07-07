import type { FactoryRunMeta } from "../lib/factory-run-context.ts";
import type { LinearTriageUpdatePlan } from "../lib/factory-linear-adapter.ts";

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
  linearApplied?: boolean;
  linearUpdate?: FactoryTriageLinearUpdate;
};

export type FactoryTriageLinearUpdate = {
  started?: LinearTriageUpdatePlan;
  terminal?: LinearTriageUpdatePlan;
};

export function factoryTriageCliOutput(
  meta: FactoryRunMeta,
  options: { linearApplied?: boolean; linearUpdate?: FactoryTriageLinearUpdate } = {},
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
    ...(options.linearUpdate ? { linearUpdate: options.linearUpdate } : {}),
  };
}
