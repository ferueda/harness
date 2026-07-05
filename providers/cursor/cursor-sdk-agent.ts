import { Agent as CursorSdkAgent } from "@cursor/sdk";
import type {
  AgentOptions as CursorSdkAgentOptions,
  ModelSelection as CursorSdkModelSelection,
  Run as CursorSdkRun,
  RunResult as CursorSdkRunResult,
  SDKAgent as CursorSdkAgentInstance,
} from "@cursor/sdk";
import { CURSOR_SDK_MODEL_MODES, DEFAULT_AGENT_MODELS } from "../../lib/agents.ts";
import {
  createAgentSessionRef,
  normalizeAgentSessionForProvider,
} from "../../lib/agent-session.ts";
import type {
  Agent,
  AgentRunInput,
  AgentRunResult,
  AgentSessionRef,
  CursorSdkModelMode,
} from "../../lib/agents.ts";
import { createAgentStreamWriter, type AgentStreamLogSummary } from "../../lib/agent-stream-log.ts";
import {
  createAbortedAgentResult,
  createAgentAbortRace,
  createAgentSignalState,
} from "../../lib/agent-signals.ts";
import { errorArtifact, errorMessage, STREAM_SETTLE_TIMEOUT_MS } from "../../lib/agent-invoke.ts";
import { readWorkspaceStatus, withWorkspaceGuard } from "../../lib/review-guard.ts";
import { loadSchema, parseStructuredOutput, wrapPrompt } from "./lib/schema.ts";

type CreateCursorSdkAgent = (options: CursorSdkAgentOptions) => Promise<CursorSdkAgentInstance>;
type ResumeCursorSdkAgent = (
  agentId: string,
  options: CursorSdkAgentOptions,
) => Promise<CursorSdkAgentInstance>;
type CursorStreamPump = {
  settle(fallback: AgentStreamLogSummary | undefined): Promise<AgentStreamLogSummary | undefined>;
};

export type CursorSdkAgentFactoryOptions = {
  apiKey?: string;
  createSdkAgent?: CreateCursorSdkAgent;
  resumeSdkAgent?: ResumeCursorSdkAgent;
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
  const resumeSdkAgent = options.resumeSdkAgent ?? CursorSdkAgent.resume;

  return {
    name: "cursor",
    run(input) {
      return invokeCursorSdkAgent({
        input,
        apiKey: options.apiKey ?? process.env.CURSOR_API_KEY,
        createSdkAgent,
        resumeSdkAgent,
      });
    },
  };
}

async function invokeCursorSdkAgent({
  input,
  apiKey,
  createSdkAgent,
  resumeSdkAgent,
}: {
  input: AgentRunInput;
  apiKey: string | undefined;
  createSdkAgent: CreateCursorSdkAgent;
  resumeSdkAgent: ResumeCursorSdkAgent;
}): Promise<AgentRunResult> {
  const sessionResult = normalizeAgentSessionForProvider("cursor", input.session);
  if (!sessionResult.ok) return sessionResult.error;

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

  if (input.signal?.aborted) {
    return createAbortedAgentResult();
  }

  const beforeStatus = readWorkspaceStatus(input.workspace);
  if (!beforeStatus.ok) {
    return beforeStatus.error;
  }

  const signalState = createAgentSignalState(input.signal, input.maxRuntimeMs);
  if (signalState.isExternallyAborted()) {
    signalState.cleanup();
    return createAbortedAgentResult();
  }

  let sdkAgent: CursorSdkAgentInstance | undefined;
  let run: CursorSdkRun | undefined;
  let streamLog: AgentStreamLogSummary | undefined;
  let streamPump: CursorStreamPump | undefined;
  const startedAt = Date.now();
  // maxRuntimeMs is a total budget across create, send, and wait.
  const abortRace = createAgentAbortRace(signalState.signal);
  const withDeadline = <T>(promise: Promise<T>, onLateResolve?: (value: T) => void): Promise<T> =>
    Promise.race([
      promise.then(
        (value) => {
          if (!signalState.signal.aborted) return value;
          onLateResolve?.(value);
          // Keep abandoned SDK work from surfacing after the caller has received an abort result.
          return new Promise<T>(() => {});
        },
        (error) => {
          if (signalState.signal.aborted) return new Promise<T>(() => {});
          throw error;
        },
      ),
      abortRace.promise,
    ]);

  try {
    const agentOptions = buildCursorAgentOptions(input, apiKey, modelResult.value);
    sdkAgent = await withDeadline(
      openCursorSdkAgent(sessionResult.session, createSdkAgent, resumeSdkAgent, agentOptions),
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
    if (input.logPath) {
      streamPump = startCursorStream(run, input.logPath);
    }
    const result = await withDeadline(run.wait());
    streamLog = await streamPump?.settle(streamLog);

    const raw = buildRawArtifact({
      agentId: sdkAgent.agentId,
      run,
      result,
      durationMs: Date.now() - startedAt,
      streamLog,
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
        session: createAgentSessionRef("cursor", sdkAgent.agentId),
      },
      input.workspace,
      beforeStatus.value,
    );
  } catch (error) {
    if (signalState.signal.aborted && run) {
      await cancelRun(run);
    }
    streamLog = await streamPump?.settle(streamLog);
    const externallyAborted = signalState.isExternallyAborted();
    const timedOut = signalState.isTimedOut();
    return withWorkspaceGuard(
      {
        ok: false,
        error: externallyAborted
          ? "Agent was aborted"
          : timedOut
            ? `Cursor SDK agent timed out after ${input.maxRuntimeMs}ms`
            : `Cursor SDK agent failed: ${errorMessage(error)}`,
        raw: {
          agentId: sdkAgent?.agentId,
          runId: run?.id,
          requestId: run?.requestId,
          streamLog,
          error: errorArtifact(error),
          durationMs: Date.now() - startedAt,
        },
        exitCode: externallyAborted ? 130 : timedOut ? 124 : 1,
        ...(externallyAborted ? { aborted: true } : {}),
      },
      input.workspace,
      beforeStatus.value,
    );
  } finally {
    if (sdkAgent) await safeDisposeAgent(sdkAgent);
    abortRace.cleanup();
    signalState.cleanup();
  }
}

function buildCursorAgentOptions(
  input: AgentRunInput,
  apiKey: string,
  model: CursorSdkModelSelection,
) {
  return {
    apiKey,
    model,
    mode: "agent",
    local: {
      cwd: input.workspace,
      settingSources: [],
      autoReview: true,
    },
  } satisfies CursorSdkAgentOptions;
}

function openCursorSdkAgent(
  session: AgentSessionRef | undefined,
  createSdkAgent: CreateCursorSdkAgent,
  resumeSdkAgent: ResumeCursorSdkAgent,
  agentOptions: CursorSdkAgentOptions,
): Promise<CursorSdkAgentInstance> {
  if (!session) return createSdkAgent(agentOptions);
  return resumeSdkAgent(session.id, agentOptions);
}

function cursorSdkModelSelection(
  model: string = DEFAULT_AGENT_MODELS.cursor,
): { ok: true; value: CursorSdkModelSelection } | { ok: false; error: AgentRunResult } {
  if (!isCursorSdkModelMode(model)) {
    return {
      ok: false,
      error: {
        ok: false,
        error: `Unsupported Cursor SDK model: ${model}. Use one of: ${CURSOR_SDK_MODEL_MODES.join(", ")}.`,
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

function buildRawArtifact({
  agentId,
  run,
  result,
  durationMs,
  streamLog,
}: {
  agentId: string;
  run: CursorSdkRun;
  result: CursorSdkRunResult;
  durationMs: number;
  streamLog?: AgentStreamLogSummary;
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
    streamLog,
  };
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

function startCursorStream(run: CursorSdkRun, logPath: string): CursorStreamPump {
  const provider = "cursor";
  const format = "cursor-sdk-message";
  if (!run.supports("stream")) {
    const unsupported = {
      path: logPath,
      provider,
      format,
      status: "unsupported",
      error: run.unsupportedReason("stream"),
    } satisfies AgentStreamLogSummary;
    return { settle: async () => unsupported };
  }

  const writer = createAgentStreamWriter(logPath, { provider, format });
  let stopped = false;
  let closePromise: Promise<AgentStreamLogSummary> | undefined;
  let events: AsyncGenerator<unknown, void> | undefined;
  const closeWriter = async (
    override?: Partial<Pick<AgentStreamLogSummary, "status" | "error">>,
  ): Promise<AgentStreamLogSummary> => {
    closePromise ??= writer.close();
    return {
      ...(await closePromise),
      ...override,
    };
  };
  const done = (async () => {
    try {
      events = run.stream();
      for await (const event of events) {
        if (stopped) break;
        writer.write(event);
      }
    } catch (error) {
      if (stopped) return closeWriter();
      const summaryError = errorMessage(error);
      writer.write({
        type: "stream.error",
        error: errorArtifact(error),
      });
      return closeWriter({
        status: "error",
        error: summaryError,
      });
    }
    return closeWriter();
  })();

  return {
    settle(fallback) {
      return settleCursorStreamTask(done, fallback, logPath, async () => {
        stopped = true;
        void events?.return(undefined).catch(() => {});
        const summary = await closeWriter();
        return {
          ...summary,
          status: summary.status === "written" ? "written" : "error",
          error: `Cursor SDK stream did not settle within ${STREAM_SETTLE_TIMEOUT_MS}ms`,
        };
      });
    },
  };
}

async function settleCursorStreamTask(
  streamTask: Promise<AgentStreamLogSummary>,
  fallback: AgentStreamLogSummary | undefined,
  logPath: string,
  onTimeout: () => Promise<AgentStreamLogSummary>,
): Promise<AgentStreamLogSummary | undefined> {
  if (fallback) return fallback;

  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      streamTask.catch(
        (error) =>
          ({
            path: logPath,
            provider: "cursor",
            format: "cursor-sdk-message",
            status: "error",
            error: errorMessage(error),
          }) satisfies AgentStreamLogSummary,
      ),
      new Promise<AgentStreamLogSummary>((resolve) => {
        timeout = setTimeout(() => {
          void onTimeout().then(resolve);
        }, STREAM_SETTLE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
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
