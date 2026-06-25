export type AgentRunInput = {
  workspace: string;
  prompt: string;
  schemaPath?: string;
  model?: string;
  maxRuntimeMs: number;
};

export type AgentRunResult =
  | {
      ok: true;
      structuredOutput?: unknown;
      raw: unknown;
      sessionId?: string;
      usage?: unknown;
    }
  | {
      ok: false;
      error: string;
      raw?: unknown;
      exitCode: number;
      stderr?: string;
    };

export type Agent = {
  name: string;
  run(input: AgentRunInput): Promise<AgentRunResult>;
};
