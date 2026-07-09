import type {
  AgentApprovalPolicy,
  AgentProviderName,
  AgentReasoningEffort,
  AgentSandboxMode,
} from "./agents.ts";
import { DEFAULT_AGENT_MODELS } from "./agents.ts";
import type { FactoryRoleAgent } from "./config.ts";

export type FactoryStationAgentMeta = {
  name: AgentProviderName;
  model: string;
  sandboxMode?: AgentSandboxMode;
  approvalPolicy?: AgentApprovalPolicy;
  modelReasoningEffort?: AgentReasoningEffort;
};

export function factoryRoleAgentMeta(role: FactoryRoleAgent): FactoryStationAgentMeta {
  return {
    name: role.agent,
    model: role.model ?? DEFAULT_AGENT_MODELS[role.agent],
    ...(role.agent === "codex"
      ? {
          sandboxMode: role.sandboxMode,
          approvalPolicy: role.approvalPolicy,
          modelReasoningEffort: role.modelReasoningEffort,
        }
      : {}),
  };
}
