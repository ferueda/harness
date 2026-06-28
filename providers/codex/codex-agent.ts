import {
  Codex,
  type CodexOptions,
  type RunResult,
  type RunStreamedResult,
  type ThreadEvent,
  type ThreadItem,
  type ThreadOptions,
  type TurnOptions,
  type Usage,
} from "@openai/codex-sdk";
import type { Agent, AgentRunInput, AgentRunResult } from "../../lib/agents.ts";
import { createAgentStreamWriter, type AgentStreamLogSummary } from "../../lib/agent-stream-log.ts";
import {
  createAbortedAgentResult,
  createAgentAbortRace,
  createAgentSignalState,
} from "../../lib/agent-signals.ts";
import { errorArtifact, errorMessage, raceWithTimeout } from "../../lib/agent-invoke.ts";
import { readWorkspaceStatus, withWorkspaceGuard } from "../../lib/review-guard.ts";
import { parseStructuredOutput } from "../../lib/structured-output.ts";
import { loadSchema } from "../../lib/schema-validation.ts";

type CodexThread = {
  id: string | null;
  run(prompt: string, turnOptions: TurnOptions): Promise<RunResult>;
  runStreamed?(prompt: string, turnOptions: TurnOptions): Promise<RunStreamedResult>;
};
type CodexClient = {
  startThread(options: ThreadOptions): CodexThread;
};
type CodexFactory = (options: CodexOptions) => CodexClient;
type CodexTurn = RunResult & { streamLog?: AgentStreamLogSummary };

export type CodexAgentOptions = {
  codexPathOverride?: string;
  codexFactory?: CodexFactory;
};

export function createCodexAgent(options: CodexAgentOptions = {}): Agent {
  const createCodex =
    options.codexFactory ?? ((codexOptions: CodexOptions) => new Codex(codexOptions));
  const codexPathOverride = options.codexPathOverride;

  return {
    name: "codex",
    run(input) {
      return invokeCodexAgent(createCodex, codexPathOverride, input);
    },
  };
}

async function invokeCodexAgent(
  createCodex: CodexFactory,
  codexPathOverride: string | undefined,
  input: AgentRunInput,
): Promise<AgentRunResult> {
  let outputSchema;
  try {
    outputSchema = input.schemaPath ? loadSchema({ schemaPath: input.schemaPath }) : undefined;
  } catch (error) {
    return {
      ok: false,
      error: `Invalid Codex output schema: ${errorMessage(error)}`,
      exitCode: 1,
    };
  }

  const signalState = createAgentSignalState(input.signal, input.maxRuntimeMs);
  if (signalState.isExternallyAborted()) {
    signalState.cleanup();
    return createAbortedAgentResult();
  }

  const beforeStatus = readWorkspaceStatus(input.workspace);
  if (!beforeStatus.ok) {
    return beforeStatus.error;
  }

  const abortRace = createAgentAbortRace(signalState.signal);
  let streamLog: AgentStreamLogSummary | undefined = input.logPath
    ? {
        path: input.logPath,
        provider: "codex",
        format: "codex-thread-event",
        status: "missing",
      }
    : undefined;
  let streamedTurnPromise: Promise<CodexTurn> | undefined;

  try {
    const codex = createCodex({
      codexPathOverride: codexPathOverride ?? process.env.CODEX_EXECUTABLE,
    });
    const thread = codex.startThread(buildThreadOptions(input));
    const turnOptions = {
      outputSchema,
      signal: signalState.signal,
    } satisfies TurnOptions;
    const turnPromise: Promise<CodexTurn> = input.logPath
      ? (streamedTurnPromise = runCodexTurnStreamed(
          thread,
          input.prompt,
          turnOptions,
          input.logPath,
          (summary) => {
            streamLog = summary;
          },
        ))
      : thread.run(input.prompt, turnOptions);
    const observedTurnPromise = turnPromise.then(
      (turn) => {
        if (signalState.signal.aborted) return new Promise<never>(() => {});
        return turn;
      },
      (error) => {
        if (signalState.signal.aborted) return new Promise<never>(() => {});
        throw error;
      },
    );
    const turn = await Promise.race([observedTurnPromise, abortRace.promise]);
    const parsed = parseStructuredOutput(turn.finalResponse, outputSchema);
    if (parsed.error) {
      return withWorkspaceGuard(
        {
          ok: false,
          error: parsed.error,
          raw: turn,
          exitCode: 1,
        },
        input.workspace,
        beforeStatus.value,
      );
    }

    return withWorkspaceGuard(
      {
        ok: true,
        structuredOutput: parsed.value,
        raw: turn,
        sessionId: thread.id ?? undefined,
        usage: turn.usage ?? undefined,
      },
      input.workspace,
      beforeStatus.value,
    );
  } catch (error) {
    if (signalState.signal.aborted) {
      streamLog = await settleCodexStreamTask(streamedTurnPromise, () => streamLog);
    }
    const externallyAborted = signalState.isExternallyAborted();
    const timedOut = signalState.isTimedOut();
    return withWorkspaceGuard(
      {
        ok: false,
        error: externallyAborted
          ? "Agent was aborted"
          : timedOut
            ? `Codex agent timed out after ${input.maxRuntimeMs}ms`
            : `Codex agent failed: ${errorMessage(error)}`,
        raw: addStreamLog(errorArtifact(error), streamLog),
        exitCode: externallyAborted ? 130 : timedOut ? 124 : 1,
        ...(externallyAborted ? { aborted: true } : {}),
      },
      input.workspace,
      beforeStatus.value,
    );
  } finally {
    abortRace.cleanup();
    signalState.cleanup();
  }
}

function buildThreadOptions(input: AgentRunInput): ThreadOptions {
  return {
    workingDirectory: input.workspace,
    model: input.model,
    sandboxMode: input.sandboxMode,
    approvalPolicy: input.approvalPolicy,
    modelReasoningEffort: input.modelReasoningEffort,
  };
}

async function runCodexTurnStreamed(
  thread: CodexThread,
  prompt: string,
  turnOptions: TurnOptions,
  logPath: string,
  onStreamLog: (summary: AgentStreamLogSummary) => void,
): Promise<CodexTurn> {
  const writer = createAgentStreamWriter(logPath, {
    provider: "codex",
    format: "codex-thread-event",
  });
  const items: ThreadItem[] = [];
  let finalResponse = "";
  let usage: Usage | null = null;

  try {
    if (!thread.runStreamed) {
      throw new Error("Codex SDK runStreamed unavailable");
    }
    const streamed = await thread.runStreamed(prompt, turnOptions);
    for await (const event of streamed.events) {
      writer.write(event);
      updateCodexTurnFromEvent(
        event,
        items,
        (text) => {
          finalResponse = text;
        },
        (turnUsage) => {
          usage = turnUsage;
        },
      );
    }
  } catch (error) {
    writer.write({
      type: "stream.error",
      error: errorArtifact(error),
    });
    const streamLog = {
      ...(await writer.close()),
      status: "error",
      error: errorMessage(error),
    } satisfies AgentStreamLogSummary;
    onStreamLog(streamLog);
    throw error;
  }

  const streamLog = await writer.close();
  onStreamLog(streamLog);
  return { items, finalResponse, usage, streamLog };
}

function updateCodexTurnFromEvent(
  event: ThreadEvent,
  items: ThreadItem[],
  setFinalResponse: (text: string) => void,
  setUsage: (usage: Usage) => void,
): void {
  switch (event.type) {
    case "item.completed":
      items.push(event.item);
      if (event.item.type === "agent_message") {
        setFinalResponse(event.item.text);
      }
      return;
    case "turn.completed":
      setUsage(event.usage);
      return;
    case "turn.failed":
      throw new Error(`Codex turn failed: ${event.error.message}`);
    case "error":
      throw new Error(`Codex stream failed: ${event.message}`);
    default:
      return;
  }
}

async function settleCodexStreamTask(
  streamTask: Promise<CodexTurn> | undefined,
  fallback: () => AgentStreamLogSummary | undefined,
): Promise<AgentStreamLogSummary | undefined> {
  if (!streamTask) return fallback();

  return raceWithTimeout(
    streamTask.then(
      (turn) => turn.streamLog ?? fallback(),
      () => fallback(),
    ),
    fallback,
  );
}

function addStreamLog(raw: unknown, streamLog: AgentStreamLogSummary | undefined): unknown {
  if (!streamLog) return raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return { ...raw, streamLog };
  }
  return { raw, streamLog };
}
