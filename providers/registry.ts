import { createCodexAgent } from "./codex/codex-agent.ts";
import type { Agent, AgentProviderOptions, AgentRunInput } from "../lib/agents.ts";

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
      const { createCursorSdkAgent } = await import("./cursor/cursor-sdk-agent.ts");
      providerAgent ??= createCursorSdkAgent();
      return providerAgent.run(input);
    },
  };
}
