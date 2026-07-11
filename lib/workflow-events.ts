import { appendFactoryRunFile } from "./factory-run-files.ts";

export const WORKFLOW_EVENTS_FILE = "events.jsonl";
export const DEFAULT_WORKFLOW_HEARTBEAT_MS = 30_000;
export type WorkflowReviewAgentName =
  | "review-implementation"
  | "code-quality-review"
  | "simplify"
  | "review-spec";

export type WorkflowStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "cancelled";

export type WorkflowEvent = {
  type: "run:start" | "run:end" | "step:start" | "step:heartbeat" | "step:end";
  runId: string;
  runDir?: string;
  workspace?: string;
  stepId?: string;
  cliStep?: string;
  status?: WorkflowStepStatus;
  startedAt?: string;
  durationMs?: number;
  elapsedMs?: number;
  error?: string;
  outputs?: string[];
};

export type WorkflowEventSink = (event: WorkflowEvent) => void;

export const STEP_ID_BY_AGENT = {
  "review-implementation": "review-implementation",
  "code-quality-review": "code-quality-review",
  simplify: "simplify-review",
  "review-spec": "review-spec",
} satisfies Record<WorkflowReviewAgentName, string>;

export function createFileEventSink(runDir: string): WorkflowEventSink {
  return (event) => {
    appendFactoryRunFile({
      runDir,
      relativePath: WORKFLOW_EVENTS_FILE,
      value: `${JSON.stringify(event)}\n`,
    });
  };
}

export function createCompositeEventSink(...sinks: WorkflowEventSink[]): WorkflowEventSink {
  return (event) => {
    for (const sink of sinks) {
      sink(event);
    }
  };
}

export const noopEventSink: WorkflowEventSink = () => {};
