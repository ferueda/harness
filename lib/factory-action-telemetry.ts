import { DEFAULT_WORKFLOW_HEARTBEAT_MS, type WorkflowEventSink } from "./workflow-events.ts";

export function startFactoryActionTelemetry(input: {
  eventSink: WorkflowEventSink;
  runId: string;
  runDir: string;
  workspace: string;
  stepId: string;
}) {
  const started = Date.now();
  const common = {
    runId: input.runId,
    runDir: input.runDir,
    workspace: input.workspace,
    stepId: input.stepId,
    cliStep: input.stepId,
  };
  input.eventSink({ type: "run:start", ...common, startedAt: new Date(started).toISOString() });
  input.eventSink({ type: "step:start", ...common, status: "running" });
  const timer = setInterval(() => {
    input.eventSink({ type: "step:heartbeat", ...common, elapsedMs: Date.now() - started });
  }, DEFAULT_WORKFLOW_HEARTBEAT_MS);
  timer.unref();
  return (status: "completed" | "failed", error?: string) => {
    clearInterval(timer);
    const durationMs = Date.now() - started;
    input.eventSink({
      type: "step:end",
      ...common,
      status,
      durationMs,
      ...(error ? { error } : {}),
    });
    input.eventSink({
      type: "run:end",
      ...common,
      status,
      durationMs,
      ...(error ? { error } : {}),
    });
  };
}
