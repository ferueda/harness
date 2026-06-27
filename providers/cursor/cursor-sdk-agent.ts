import { execFileSync } from "node:child_process";
import { Agent as CursorSdkAgent } from "@cursor/sdk";
import type {
  AgentOptions as CursorSdkAgentOptions,
  ModelSelection as CursorSdkModelSelection,
  Run as CursorSdkRun,
  RunResult as CursorSdkRunResult,
  SDKAgent as CursorSdkAgentInstance,
} from "@cursor/sdk";
import { CURSOR_SDK_MODEL_MODES, DEFAULT_AGENT_MODELS } from "../../lib/agents.ts";
import type { Agent, AgentRunInput, AgentRunResult, CursorSdkModelMode } from "../../lib/agents.ts";
import { loadSchema, parseStructuredOutput, wrapPrompt } from "./lib/schema.ts";

type CreateCursorSdkAgent = (options: CursorSdkAgentOptions) => Promise<CursorSdkAgentInstance>;

export type CursorSdkAgentFactoryOptions = {
  apiKey?: string;
  createSdkAgent?: CreateCursorSdkAgent;
};

const CURSOR_SDK_MODEL_PARAMS = {
  "composer-2.5": [{ id: "fast", value: "false" }],
  "claude-opus-4-8": [
    { id: "thinking", value: "true" },
    { id: "effort", value: "high" },
    { id: "fast", value: "false" },
  ],
  "gpt-5.5": [
    { id: "context", value: "272k" },
    { id: "reasoning", value: "high" },
    { id: "fast", value: "false" },
  ],
} satisfies Record<CursorSdkModelMode, CursorSdkModelSelection["params"]>;

export function createCursorSdkAgent(options: CursorSdkAgentFactoryOptions = {}): Agent {
  const createSdkAgent = options.createSdkAgent ?? CursorSdkAgent.create;

  return {
    name: "cursor",
    run(input) {
      return invokeCursorSdkAgent({
        input,
        apiKey: options.apiKey ?? process.env.CURSOR_API_KEY,
        createSdkAgent,
      });
    },
  };
}

async function invokeCursorSdkAgent({
  input,
  apiKey,
  createSdkAgent,
}: {
  input: AgentRunInput;
  apiKey: string | undefined;
  createSdkAgent: CreateCursorSdkAgent;
}): Promise<AgentRunResult> {
  if (!apiKey) {
    return {
      ok: false,
      error: "CURSOR_API_KEY required for Cursor SDK runtime",
      exitCode: 1,
    };
  }

  const modelResult = cursorSdkModelSelection(input.model);
  if (!modelResult.ok) return modelResult.error;

  const schemaResult = readOutputSchema(input);
  if (!schemaResult.ok) return schemaResult.error;

  const beforeStatus = readWorkspaceStatus(input.workspace);
  if (!beforeStatus.ok) return beforeStatus.error;

  let sdkAgent: CursorSdkAgentInstance | undefined;
  let run: CursorSdkRun | undefined;
  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;
  const startedAt = Date.now();
  // maxRuntimeMs is a total budget across create, send, and wait.
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      reject(new Error("timeout"));
    }, input.maxRuntimeMs);
  });
  const withDeadline = <T>(promise: Promise<T>, onLateResolve?: (value: T) => void): Promise<T> =>
    Promise.race([
      promise.then(
        (value) => {
          if (!timedOut) return value;
          onLateResolve?.(value);
          // Keep abandoned SDK work from surfacing after the caller has received a timeout.
          return new Promise<T>(() => {});
        },
        (error) => {
          if (timedOut) return new Promise<T>(() => {});
          throw error;
        },
      ),
      timeoutPromise,
    ]);

  try {
    sdkAgent = await withDeadline(
      createSdkAgent({
        apiKey,
        model: modelResult.value,
        mode: "agent",
        local: {
          cwd: input.workspace,
          settingSources: [],
          autoReview: true,
        },
      }),
      (lateAgent) => {
        void safeDisposeAgent(lateAgent);
      },
    );
    run = await withDeadline(
      sdkAgent.send(wrapPrompt(input.prompt, schemaResult.schema)),
      (lateRun) => {
        void cancelRun(lateRun);
      },
    );
    const result = await withDeadline(run.wait());

    const raw = buildRawArtifact({
      agentId: sdkAgent.agentId,
      run,
      result,
      durationMs: Date.now() - startedAt,
    });

    if (result.status === "error") {
      return withWorkspaceGuard(
        {
          ok: false,
          error: cursorSdkErrorStatusMessage(result),
          raw,
          exitCode: 1,
        },
        input.workspace,
        beforeStatus.value,
      );
    }
    if (result.status === "cancelled") {
      return withWorkspaceGuard(
        {
          ok: false,
          error: "Cursor SDK run was cancelled",
          raw,
          exitCode: 130,
        },
        input.workspace,
        beforeStatus.value,
      );
    }

    const structuredOutput = parseStructuredOutput(result.result, schemaResult.schema);
    if (structuredOutput.error) {
      return withWorkspaceGuard(
        {
          ok: false,
          error: structuredOutput.error,
          raw,
          exitCode: 1,
        },
        input.workspace,
        beforeStatus.value,
      );
    }

    return withWorkspaceGuard(
      {
        ok: true,
        structuredOutput: structuredOutput.value,
        raw,
        sessionId: sdkAgent.agentId,
      },
      input.workspace,
      beforeStatus.value,
    );
  } catch (error) {
    if (timedOut && run) {
      await cancelRun(run);
    }
    return withWorkspaceGuard(
      {
        ok: false,
        error: timedOut
          ? `Cursor SDK agent timed out after ${input.maxRuntimeMs}ms`
          : `Cursor SDK agent failed: ${errorMessage(error)}`,
        raw: {
          agentId: sdkAgent?.agentId,
          runId: run?.id,
          requestId: run?.requestId,
          error: errorArtifact(error),
          durationMs: Date.now() - startedAt,
        },
        exitCode: timedOut ? 124 : 1,
      },
      input.workspace,
      beforeStatus.value,
    );
  } finally {
    if (timeout) clearTimeout(timeout);
    if (sdkAgent) await safeDisposeAgent(sdkAgent);
  }
}

function cursorSdkModelSelection(
  model: string = DEFAULT_AGENT_MODELS.cursor,
): { ok: true; value: CursorSdkModelSelection } | { ok: false; error: AgentRunResult } {
  if (!isCursorSdkModelMode(model)) {
    return {
      ok: false,
      error: {
        ok: false,
        error: `Unsupported Cursor SDK model: ${model}. Use one of: ${CURSOR_SDK_MODEL_MODES.join(
          ", ",
        )}. For Cursor CLI model IDs, use --runtime cli.`,
        exitCode: 1,
      },
    };
  }

  return {
    ok: true,
    value: {
      id: model,
      params: CURSOR_SDK_MODEL_PARAMS[model],
    },
  };
}

function isCursorSdkModelMode(model: string): model is CursorSdkModelMode {
  return CURSOR_SDK_MODEL_MODES.includes(model as CursorSdkModelMode);
}

function readOutputSchema(
  input: AgentRunInput,
): { ok: true; schema: ReturnType<typeof loadSchema> } | { ok: false; error: AgentRunResult } {
  try {
    return { ok: true, schema: loadSchema({ schemaPath: input.schemaPath }) };
  } catch (error) {
    return {
      ok: false,
      error: {
        ok: false,
        error: `Invalid Cursor SDK output schema: ${errorMessage(error)}`,
        exitCode: 1,
      },
    };
  }
}

function readWorkspaceStatus(
  workspace: string,
): { ok: true; value: string } | { ok: false; error: AgentRunResult } {
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

function buildRawArtifact({
  agentId,
  run,
  result,
  durationMs,
}: {
  agentId: string;
  run: CursorSdkRun;
  result: CursorSdkRunResult;
  durationMs: number;
}) {
  return {
    agentId,
    runId: run.id,
    requestId: result.requestId ?? run.requestId,
    status: result.status,
    durationMs: result.durationMs ?? durationMs,
    model: result.model,
    result: result.result,
    git: result.git,
  };
}

function withWorkspaceGuard(
  result: AgentRunResult,
  workspace: string,
  beforeStatus: string,
): AgentRunResult {
  const afterStatus = readWorkspaceStatus(workspace);
  if (!afterStatus.ok) {
    return {
      ...afterStatus.error,
      raw: addWorkspaceStatus(afterStatus.error.raw, { before: beforeStatus }),
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

  return {
    ok: false,
    error: "Cursor SDK runtime modified the workspace during a review run",
    raw: addUnderlyingFailure(guardedResult.raw, result),
    exitCode: result.ok ? 1 : result.exitCode,
  };
}

function addWorkspaceStatus(
  raw: unknown,
  workspaceStatus: { before: string; after?: string },
): unknown {
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

function cursorSdkErrorStatusMessage(result: CursorSdkRunResult): string {
  const details = [
    `status=${result.status}`,
    result.requestId ? `requestId=${result.requestId}` : null,
    result.model ? `model=${result.model}` : null,
    typeof result.result === "string" && result.result.trim()
      ? `result=${truncate(result.result.trim(), 240)}`
      : null,
  ].filter((detail): detail is string => Boolean(detail));
  return `Cursor SDK run finished with error status (${details.join(", ")})`;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

async function cancelRun(run: CursorSdkRun): Promise<void> {
  try {
    await run.cancel();
  } catch {
    // Timeout handling should report the original timeout even if cancellation fails.
  }
}

async function safeDisposeAgent(agent: CursorSdkAgentInstance): Promise<void> {
  try {
    await disposeAgent(agent);
  } catch {
    // Cleanup must not replace the primary AgentRunResult.
  }
}

async function disposeAgent(agent: CursorSdkAgentInstance): Promise<void> {
  const disposable = agent as {
    close?: () => void;
    [Symbol.asyncDispose]?: () => Promise<void>;
  };
  const asyncDispose = disposable[Symbol.asyncDispose];
  if (typeof asyncDispose === "function") {
    await asyncDispose.call(disposable);
    return;
  }
  disposable.close?.();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorArtifact(error: unknown): unknown {
  if (!(error instanceof Error)) return { error };
  const sdkError = error as Error & {
    code?: unknown;
    status?: unknown;
    requestId?: unknown;
    isRetryable?: unknown;
    helpUrl?: unknown;
    operation?: unknown;
    endpoint?: unknown;
  };
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    code: sdkError.code,
    status: sdkError.status,
    requestId: sdkError.requestId,
    isRetryable: sdkError.isRetryable,
    helpUrl: sdkError.helpUrl,
    operation: sdkError.operation,
    endpoint: sdkError.endpoint,
  };
}
