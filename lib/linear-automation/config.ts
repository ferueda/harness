import {
  DEFAULT_AGENT_MODELS,
  DEFAULT_CODEX_REASONING_EFFORT,
  type AgentProviderName,
  type AgentReasoningEffort,
} from "../agent/contract.ts";
import { loadHarnessConfigSnapshot, type HarnessConfigSnapshot } from "../config/harness.ts";
import type { LinearAutomationConfig } from "./config-schema.ts";
import type { LinearReadinessMapping } from "./readiness.ts";
import type { RepositoryRunsConfig } from "../repository/config-schema.ts";

export type LinearAutomationSettings = Readonly<{
  workspace: string;
  readiness: LinearReadinessMapping;
  triage: Readonly<{
    agent: AgentProviderName;
    model: string;
    modelReasoningEffort: AgentReasoningEffort;
    maxRuntimeMs: number;
    codexPathOverride?: string;
  }>;
  spec?: Readonly<{
    agent: "codex";
    model: string;
    modelReasoningEffort: AgentReasoningEffort;
    maxRuntimeMs: number;
    baseRef: string;
    repositoryRuns: RepositoryRunsConfig;
  }>;
}>;

export function resolveLinearAutomationSettings(
  options: { workspace?: string },
  cwd = process.cwd(),
): LinearAutomationSettings {
  return resolveLinearAutomationSettingsFromSnapshot(
    loadHarnessConfigSnapshot(options.workspace, cwd),
  );
}

export function resolveLinearAutomationSettingsFromSnapshot(
  snapshot: HarnessConfigSnapshot,
): LinearAutomationSettings {
  const { workspace, config } = snapshot;
  const automation = config.linearAutomation;
  if (!automation) {
    throw new Error(
      "linearAutomation is required in harness.json for the Linear worker. Configure readiness IDs and triage.",
    );
  }
  if (automation.spec && !config.repositoryRuns) {
    throw new Error(
      "repositoryRuns is required when linearAutomation.spec enables the Spec consumer.",
    );
  }

  const agentConfig = config.agents?.codex ?? {};
  const model = automation.triage.model ?? agentConfig.model ?? DEFAULT_AGENT_MODELS.codex;
  const modelReasoningEffort =
    automation.triage.modelReasoningEffort ??
    agentConfig.modelReasoningEffort ??
    DEFAULT_CODEX_REASONING_EFFORT;

  return freezeLinearAutomationSettings({
    workspace,
    automation,
    model,
    modelReasoningEffort,
    codexPathOverride: agentConfig.executable,
    baseRef: config.base ?? "main",
    repositoryRuns: config.repositoryRuns,
  });
}

function freezeLinearAutomationSettings(input: {
  workspace: string;
  automation: LinearAutomationConfig;
  model: string;
  modelReasoningEffort: AgentReasoningEffort;
  codexPathOverride?: string;
  baseRef: string;
  repositoryRuns?: RepositoryRunsConfig;
}): LinearAutomationSettings {
  const readiness = Object.freeze({
    ...input.automation.readiness,
    stateIds: Object.freeze({ ...input.automation.readiness.stateIds }),
    agentActionLabelIds: Object.freeze({
      ...input.automation.readiness.agentActionLabelIds,
    }),
  });
  const triage = Object.freeze({
    ...input.automation.triage,
    model: input.model,
    modelReasoningEffort: input.modelReasoningEffort,
    ...(input.codexPathOverride ? { codexPathOverride: input.codexPathOverride } : {}),
  });
  const spec =
    input.automation.spec && input.repositoryRuns
      ? Object.freeze({
          ...input.automation.spec,
          baseRef: input.baseRef,
          repositoryRuns: Object.freeze({
            ...input.repositoryRuns,
            setup: Object.freeze({
              ...input.repositoryRuns.setup,
              command: [...input.repositoryRuns.setup.command],
            }),
          }),
        })
      : undefined;
  return Object.freeze({
    workspace: input.workspace,
    readiness,
    triage,
    ...(spec ? { spec } : {}),
  });
}
