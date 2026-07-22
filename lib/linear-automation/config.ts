import {
  DEFAULT_AGENT_MODELS,
  DEFAULT_CODEX_REASONING_EFFORT,
  type AgentProviderName,
  type AgentReasoningEffort,
} from "../agent/contract.ts";
import { loadHarnessConfigSnapshot, type HarnessConfigSnapshot } from "../config/harness.ts";
import type { LinearAutomationConfig } from "./config-schema.ts";
import type { LinearReadinessMapping } from "./readiness.ts";

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
  });
}

function freezeLinearAutomationSettings(input: {
  workspace: string;
  automation: LinearAutomationConfig;
  model: string;
  modelReasoningEffort: AgentReasoningEffort;
  codexPathOverride?: string;
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
  return Object.freeze({
    workspace: input.workspace,
    readiness,
    triage,
  });
}
