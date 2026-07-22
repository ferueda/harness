import type { AgentProviderName, AgentRunResult, AgentSessionRef } from "./contract.ts";

type AgentSessionValidationError = Extract<AgentRunResult, { ok: false }>;
type AgentSessionRawKind = "codex-thread" | "cursor-agent";

export type AgentSessionValidationResult =
  | { ok: true; session?: AgentSessionRef }
  | { ok: false; error: AgentSessionValidationError };

const SESSION_RAW_KINDS = {
  codex: "codex-thread",
  cursor: "cursor-agent",
} as const satisfies Record<AgentProviderName, AgentSessionRawKind>;

function normalizeSessionId(id: string | null | undefined): string | undefined {
  const normalizedId = id?.trim();
  return normalizedId ? normalizedId : undefined;
}

export function createAgentSessionRef(
  provider: AgentProviderName,
  id: string | null | undefined,
): AgentSessionRef | undefined {
  const normalizedId = normalizeSessionId(id);
  if (!normalizedId) return undefined;
  return {
    provider,
    id: normalizedId,
    raw: { kind: SESSION_RAW_KINDS[provider] },
  };
}

export function normalizeAgentSessionForProvider(
  expectedProvider: AgentProviderName,
  session: AgentSessionRef | undefined,
): AgentSessionValidationResult {
  if (!session) return { ok: true };
  if (session.provider !== expectedProvider) {
    return {
      ok: false,
      error: {
        ok: false,
        error: `Cannot resume ${expectedProvider} agent from ${session.provider} session`,
        exitCode: 1,
      },
    };
  }
  const normalizedId = normalizeSessionId(session.id);
  if (!normalizedId) {
    return {
      ok: false,
      error: {
        ok: false,
        error: `Cannot resume ${expectedProvider} agent with blank session id`,
        exitCode: 1,
      },
    };
  }
  return {
    ok: true,
    session: {
      ...session,
      id: normalizedId,
    },
  };
}
