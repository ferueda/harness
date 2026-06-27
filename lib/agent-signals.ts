import type { AgentRunResult } from "./agents.ts";

export type AgentSignalState = {
  signal: AbortSignal;
  isTimedOut(): boolean;
  isExternallyAborted(): boolean;
  cleanup(): void;
};

export type AgentAbortRace = {
  promise: Promise<never>;
  cleanup(): void;
};

export function createAbortedAgentResult(): AgentRunResult {
  return {
    ok: false,
    error: "Agent was aborted",
    exitCode: 130,
    aborted: true,
  };
}

export function createAgentSignalState(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): AgentSignalState {
  const controller = new AbortController();
  let timedOut = false;
  let externallyAborted = false;

  const abortFromExternal = () => {
    if (controller.signal.aborted) return;
    externallyAborted = true;
    controller.abort(externalSignal?.reason);
  };
  const timeout = setTimeout(() => {
    if (controller.signal.aborted) return;
    timedOut = true;
    controller.abort(new Error("timeout"));
  }, timeoutMs);

  if (externalSignal?.aborted) {
    abortFromExternal();
  } else {
    externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  }

  return {
    signal: controller.signal,
    isTimedOut: () => timedOut,
    isExternallyAborted: () => externallyAborted,
    cleanup() {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abortFromExternal);
    },
  };
}

export function createAgentAbortRace(signal: AbortSignal): AgentAbortRace {
  let cleanup = () => {};
  const promise = new Promise<never>((_, reject) => {
    const onAbort = () => reject(new Error("abort"));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    cleanup = () => signal.removeEventListener("abort", onAbort);
  });

  return { promise, cleanup };
}
