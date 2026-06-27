export type AgentSignalState = {
  signal: AbortSignal;
  isTimedOut(): boolean;
  isExternallyAborted(): boolean;
  cleanup(): void;
};

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
