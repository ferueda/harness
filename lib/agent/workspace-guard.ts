import { execFileSync } from "node:child_process";
import type { AgentRunResult, AgentWorkspaceGuardMode } from "./contract.ts";
import { errorArtifact, errorMessage } from "./invocation.ts";

export type WorkspaceStatusMeta = {
  before: string;
  after?: string;
  guard?: "unverified";
};

type WorkspaceStatusResult =
  | { ok: true; value: string }
  | { ok: false; error: Extract<AgentRunResult, { ok: false }> };

// Tracked porcelain only (:!.harness); gitignored changes are not detected.
export function readWorkspaceStatus(workspace: string): WorkspaceStatusResult {
  try {
    return {
      ok: true,
      value: execFileSync("git", ["status", "--porcelain=v1", "-z", "--", ".", ":!.harness"], {
        cwd: workspace,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        ok: false,
        error: `Failed to inspect workspace status: ${errorMessage(error)}`,
        raw: errorArtifact(error),
        exitCode: 1,
      },
    };
  }
}

export function withWorkspaceGuard(
  result: AgentRunResult,
  workspace: string,
  beforeStatus: string,
  workspaceGuard: AgentWorkspaceGuardMode = "enforce",
): AgentRunResult {
  return applyWorkspaceGuard(result, beforeStatus, readWorkspaceStatus(workspace), workspaceGuard);
}

export function applyWorkspaceGuard(
  result: AgentRunResult,
  beforeStatus: string,
  afterStatus: WorkspaceStatusResult,
  workspaceGuard: AgentWorkspaceGuardMode = "enforce",
): AgentRunResult {
  if (!afterStatus.ok) {
    const workspaceStatus: WorkspaceStatusMeta = { before: beforeStatus, guard: "unverified" };
    return {
      ...result,
      raw: addWorkspaceStatus(result.raw, workspaceStatus),
    };
  }

  const guardedResult = {
    ...result,
    raw: addWorkspaceStatus(result.raw, {
      before: beforeStatus,
      after: afterStatus.value,
    }),
  };

  if (afterStatus.value === beforeStatus) return guardedResult;
  // Record mode captures mutations but leaves validation to the caller.
  if (workspaceGuard === "record") return guardedResult;
  if (!result.ok && (result.aborted || result.exitCode === 124)) return guardedResult;

  return {
    ok: false,
    error: "Agent runtime modified the workspace during a review run",
    raw: addUnderlyingFailure(guardedResult.raw, result),
    exitCode: result.ok ? 1 : result.exitCode,
    failureKind: "workspace-guard",
  };
}

function addWorkspaceStatus(raw: unknown, workspaceStatus: WorkspaceStatusMeta): unknown {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return {
      ...raw,
      workspaceStatus,
    };
  }
  return { raw, workspaceStatus };
}

function addUnderlyingFailure(raw: unknown, result: AgentRunResult): unknown {
  if (result.ok) return raw;
  const underlying = {
    error: result.error,
    exitCode: result.exitCode,
  };
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return {
      ...raw,
      underlyingFailure: underlying,
    };
  }
  return { raw, underlyingFailure: underlying };
}
