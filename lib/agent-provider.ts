import { createCodexAgent } from "../providers/codex/codex-agent.ts";
import type { Agent, AgentProviderName, AgentRunInput } from "./agents.ts";

export type AgentProviderOptions = {
  provider: AgentProviderName;
  codexPathOverride?: string;
};

export function createAgentProvider(options: AgentProviderOptions): Agent {
  if (options.provider === "codex") {
    return createCodexAgent({ codexPathOverride: options.codexPathOverride });
  }

  return createLazyCursorSdkAgent();
}

function createLazyCursorSdkAgent(): Agent {
  let providerAgent: Agent | undefined;
  return {
    name: "cursor",
    async run(input: AgentRunInput) {
      const { createCursorSdkAgent } = await import("../providers/cursor/cursor-sdk-agent.ts");
      providerAgent ??= createCursorSdkAgent();
      return providerAgent.run(input);
    },
  };
}
