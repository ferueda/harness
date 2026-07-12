import type { LinearPlanningUpdatePlan } from "../lib/factory-linear-planning-apply.ts";
import type { FactoryLifecycleWarning } from "../lib/factory-lifecycle.ts";
import type { FactoryPlanningRunMeta } from "../lib/factory-planning-run-context.ts";
import { formatFactoryActionOutput } from "./factory-action-output.ts";
import type { FactoryReaction } from "../lib/factory-state-machine.ts";

export function factoryPlanningActionOutput(input: {
  phaseRunId?: string;
  action?: { handler: string; attempt: number; eventId: string };
  next: FactoryReaction;
  linearApplied: boolean;
}) {
  return formatFactoryActionOutput({ phase: "planning", ...input });
}

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
  warnings?: FactoryLifecycleWarning[];
};

export function factoryPlanningCliOutput(
  meta: FactoryPlanningRunMeta,
  options: {
    linearApplied?: boolean;
    linearUpdate?: FactoryPlanningLinearUpdate;
    warnings?: FactoryLifecycleWarning[];
  } = {},
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
    ...(options.warnings && options.warnings.length > 0 ? { warnings: options.warnings } : {}),
  };
}
