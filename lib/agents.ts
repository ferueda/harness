export const AGENT_PROVIDERS = ["cursor", "codex"] as const;
export const CURSOR_RUNTIMES = ["cli", "sdk"] as const;
export const AGENT_SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;
export const AGENT_APPROVAL_POLICIES = ["never", "on-request", "on-failure", "untrusted"] as const;
export const AGENT_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;
export const CURSOR_SDK_MODEL_MODES = ["composer-2.5", "claude-opus-4-8", "gpt-5.5"] as const;

export type AgentProviderName = (typeof AGENT_PROVIDERS)[number];
export type CursorRuntime = (typeof CURSOR_RUNTIMES)[number];
export type AgentSandboxMode = (typeof AGENT_SANDBOX_MODES)[number];
export type AgentApprovalPolicy = (typeof AGENT_APPROVAL_POLICIES)[number];
export type AgentReasoningEffort = (typeof AGENT_REASONING_EFFORTS)[number];
export type CursorSdkModelMode = (typeof CURSOR_SDK_MODEL_MODES)[number];

const DEFAULT_CURSOR_MODEL = CURSOR_SDK_MODEL_MODES[0] satisfies CursorSdkModelMode;

export const DEFAULT_AGENT_MODELS = {
  cursor: DEFAULT_CURSOR_MODEL,
  codex: "gpt-5.5",
} as const satisfies Record<AgentProviderName, string>;

export const DEFAULT_CURSOR_RUNTIME = "sdk" satisfies CursorRuntime;
export const DEFAULT_CODEX_REASONING_EFFORT = "high" satisfies AgentReasoningEffort;

export function effectiveCursorRuntime(runtime?: CursorRuntime): CursorRuntime {
  return runtime ?? DEFAULT_CURSOR_RUNTIME;
}

export function isCursorSdkRuntime(
  providerName: AgentProviderName,
  runtime?: CursorRuntime,
): boolean {
  return providerName === "cursor" && effectiveCursorRuntime(runtime) === "sdk";
}

export const AGENT_MODEL_CATALOG = {
  cursor: {
    defaultModel: DEFAULT_AGENT_MODELS.cursor,
    models: CURSOR_SDK_MODEL_MODES,
    modelsRuntime: "sdk",
    modelsNote: "Fixed Cursor SDK review modes; --runtime cli passes model IDs to Cursor CLI.",
  },
  codex: {
    defaultModel: DEFAULT_AGENT_MODELS.codex,
    defaultReasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
    models: ["gpt-5.5", "gpt-5.4", "gpt-5.3-codex", "gpt-5.2", "gpt-5.1-codex-max"],
    reasoningEfforts: AGENT_REASONING_EFFORTS,
    liveListCommand: "codex --help; see Codex config docs for model availability",
  },
} as const;

export type AgentRunInput = {
  workspace: string;
  prompt: string;
  schemaPath?: string;
  model?: string;
  sandboxMode?: AgentSandboxMode;
  approvalPolicy?: AgentApprovalPolicy;
  modelReasoningEffort?: AgentReasoningEffort;
  maxRuntimeMs: number;
  logPath?: string;
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
  name: AgentProviderName;
  run(input: AgentRunInput): Promise<AgentRunResult>;
};
