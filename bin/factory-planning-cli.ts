import type { LinearPlanningUpdatePlan } from "../lib/factory-linear-planning-apply.ts";
import type { FactoryPlanningRunMeta } from "../lib/factory-planning-run-context.ts";

export type FactoryPlanningLinearUpdate = {
  started?: LinearPlanningUpdatePlan;
  terminal?: LinearPlanningUpdatePlan;
};

export type FactoryPlanningCliOutput = {
  runId: FactoryPlanningRunMeta["runId"];
  workflow: FactoryPlanningRunMeta["workflow"];
  status: FactoryPlanningRunMeta["status"];
  workspace: FactoryPlanningRunMeta["workspace"];
  runDir: FactoryPlanningRunMeta["runDir"];
  workItem: FactoryPlanningRunMeta["workItem"];
  outputPlan?: string;
  iterations: number;
  factoryMetadata?: FactoryPlanningRunMeta["factoryMetadata"];
  summaryPath: string;
  metaPath: string;
  linearApplied?: boolean;
  linearUpdate?: FactoryPlanningLinearUpdate;
};

export function factoryPlanningCliOutput(
  meta: FactoryPlanningRunMeta,
  options: { linearApplied?: boolean; linearUpdate?: FactoryPlanningLinearUpdate } = {},
): FactoryPlanningCliOutput {
  return {
    runId: meta.runId,
    workflow: meta.workflow,
    status: meta.status,
    workspace: meta.workspace,
    runDir: meta.runDir,
    workItem: meta.workItem,
    outputPlan: meta.outputPlan,
    iterations: meta.iterations.length,
    factoryMetadata: meta.factoryMetadata,
    summaryPath: meta.summaryPath,
    metaPath: meta.metaPath,
    ...(options.linearApplied !== undefined ? { linearApplied: options.linearApplied } : {}),
    ...(options.linearUpdate ? { linearUpdate: options.linearUpdate } : {}),
  };
}
