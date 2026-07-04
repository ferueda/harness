import type {
  AgentApprovalPolicy,
  AgentProviderName,
  AgentReasoningEffort,
  AgentSandboxMode,
} from "../lib/agents.ts";

export function assertCodexOnlyAgentOptions(
  agentProvider: AgentProviderName,
  options: {
    codexExecutable?: string;
    sandbox?: AgentSandboxMode;
    approvalPolicy?: AgentApprovalPolicy;
    reasoningEffort?: AgentReasoningEffort;
  },
): void {
  if (
    agentProvider !== "codex" &&
    (options.sandbox || options.approvalPolicy || options.reasoningEffort)
  ) {
    throw new Error(
      "--sandbox, --approval-policy, and --reasoning-effort apply only when --agent codex is active",
    );
  }
  if (agentProvider !== "codex" && options.codexExecutable) {
    throw new Error("--codex-executable applies only when --agent codex is active");
  }
}
