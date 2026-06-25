import { readFileSync } from "node:fs";
import {
  Codex,
  type CodexOptions,
  type RunResult,
  type ThreadOptions,
  type TurnOptions,
} from "@openai/codex-sdk";
import type { Agent, AgentRunInput, AgentRunResult } from "./agents.ts";

type CodexThread = {
  id: string | null;
  run(prompt: string, turnOptions: TurnOptions): Promise<RunResult>;
};
type CodexClient = {
  startThread(options: ThreadOptions): CodexThread;
};
type CodexFactory = (options: CodexOptions) => CodexClient;

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
    outputSchema = input.schemaPath
      ? JSON.parse(readFileSync(input.schemaPath, "utf8"))
      : undefined;
  } catch (error) {
    return {
      ok: false,
      error: `Invalid Codex output schema: ${errorMessage(error)}`,
      exitCode: 1,
    };
  }

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
    timeoutReject?.(new Error("timeout"));
  }, input.maxRuntimeMs);
  let timeoutReject: ((error: Error) => void) | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutReject = reject;
  });

  try {
    const codex = createCodex({
      codexPathOverride: codexPathOverride ?? process.env.CODEX_EXECUTABLE,
    });
    const thread = codex.startThread(buildThreadOptions(input));
    const turnPromise = thread.run(input.prompt, {
      outputSchema,
      signal: controller.signal,
    });
    const observedTurnPromise = turnPromise.catch((error) => {
      if (timedOut) return new Promise<never>(() => {});
      throw error;
    });
    const turn = await Promise.race([observedTurnPromise, timeoutPromise]);
    const structuredOutput = parseStructuredOutput(turn.finalResponse);
    if (!structuredOutput.ok) {
      return {
        ok: false,
        error: structuredOutput.error,
        raw: turn,
        exitCode: 1,
      };
    }

    return {
      ok: true,
      structuredOutput: structuredOutput.value,
      raw: turn,
      sessionId: thread.id ?? undefined,
      usage: turn.usage ?? undefined,
    };
  } catch (error) {
    return {
      ok: false,
      error: timedOut
        ? `Codex agent timed out after ${input.maxRuntimeMs}ms`
        : `Codex agent failed: ${errorMessage(error)}`,
      raw: errorArtifact(error),
      exitCode: timedOut ? 124 : 1,
    };
  } finally {
    clearTimeout(timeout);
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

function parseStructuredOutput(text: RunResult["finalResponse"]):
  | { ok: true; value: unknown }
  | {
      ok: false;
      error: string;
    } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return {
      ok: false,
      error: `Codex final response was not valid JSON: ${errorMessage(error)}`,
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorArtifact(error: unknown): unknown {
  if (!(error instanceof Error)) return { error };
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
}
