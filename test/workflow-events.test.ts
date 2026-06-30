import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  WORKFLOW_EVENTS_FILE,
  STEP_ID_BY_AGENT,
  type WorkflowEvent,
} from "../lib/workflow-events.ts";
import { createWorkflowContextForTest } from "../lib/workflow-context.ts";
import type { ReviewAgentName } from "../lib/workflow-context.ts";
import {
  CHANGE_REVIEW_STEPS,
  run as runChangeReview,
} from "../workflows/change-review.workflow.ts";
import { runReviewSteps } from "../workflows/review-steps.ts";
import type { WorkflowContext } from "../workflows/review-steps.ts";
import type { ReviewOutput } from "../lib/schemas.ts";

const PASS_REVIEW = {
  verdict: "pass",
  summary: "ok",
  findings: [],
} satisfies ReviewOutput;

type DeferredReview = {
  promise: Promise<ReviewOutput>;
  resolve(review: ReviewOutput): void;
  reject(error: Error): void;
};

afterEach(() => {
  vi.useRealTimers();
});

function readJsonLines(path: string): WorkflowEvent[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "harness-workflow-events-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "harness@example.com"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "Harness Test"], { cwd: workspace });
  writeFileSync(join(workspace, "README.md"), "# Test\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: workspace });
  execFileSync("git", ["commit", "-m", "init"], { cwd: workspace, stdio: "ignore" });
  return workspace;
}

function createDeferredReview(): DeferredReview {
  let resolve!: (review: ReviewOutput) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ReviewOutput>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function reviewInfo(name: ReviewAgentName) {
  const info = {
    "review-implementation": {
      key: "implementation",
      title: "Implementation review",
      stage: "implementation",
    },
    "code-quality-review": {
      key: "codeQuality",
      title: "Code quality review",
      stage: "quality",
    },
    simplify: { key: "simplify", title: "Simplify review", stage: "simplify" },
    "review-spec": { key: "spec", title: "Spec review", stage: "spec" },
  } satisfies Record<ReviewAgentName, { key: string; title: string; stage: string }>;
  return info[name];
}

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("STEP_ID_BY_AGENT covers change-review step order", () => {
  expect(CHANGE_REVIEW_STEPS).toEqual(["implementation", "quality", "simplify"]);
  expect(STEP_ID_BY_AGENT).toEqual({
    "review-implementation": "review-implementation",
    "code-quality-review": "code-quality-review",
    simplify: "simplify-review",
    "review-spec": "review-spec",
  });
});

test("file event sink writes events.jsonl and meta eventsFile", () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-runs-"));
  const ctx = createWorkflowContextForTest({
    workspace,
    baseRef: "HEAD",
    headRef: "HEAD",
    runsDir,
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run() {
          throw new Error("not used");
        },
      };
    },
    maxRuntimeMs: 1_000,
  });

  ctx.eventSink({
    type: "run:start",
    runId: ctx.runId,
    runDir: ctx.runDir,
    workspace,
    status: "running",
  });
  const meta = ctx.export({ title: "Change Review Summary", reviews: [], verdict: "pass" });

  expect((meta as { eventsFile?: unknown }).eventsFile).toBe(WORKFLOW_EVENTS_FILE);
  const events = readJsonLines(join(ctx.runDir, WORKFLOW_EVENTS_FILE));
  expect(events).toEqual([
    {
      type: "run:start",
      runId: ctx.runId,
      runDir: ctx.runDir,
      workspace,
      status: "running",
    },
  ]);
});

test("dry-run omits events.jsonl and eventsFile", () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-runs-"));
  const ctx = createWorkflowContextForTest({
    workspace,
    baseRef: "HEAD",
    headRef: "HEAD",
    runsDir,
    dryRun: true,
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run() {
          throw new Error("not used");
        },
      };
    },
    maxRuntimeMs: 1_000,
  });

  ctx.eventSink({
    type: "run:start",
    runId: ctx.runId,
    runDir: ctx.runDir,
    workspace,
    status: "running",
  });
  const meta = ctx.export({ title: "Change Review Summary", reviews: [], verdict: "pass" });

  expect("eventsFile" in meta).toBe(false);
  expect(existsSync(join(ctx.runDir, WORKFLOW_EVENTS_FILE))).toBe(false);
});

test("runReviewSteps emits start, heartbeat, and end events", async () => {
  vi.useFakeTimers();
  const events: WorkflowEvent[] = [];
  let resolveReview!: (review: ReviewOutput) => void;
  const reviewPromise = new Promise<ReviewOutput>((resolve) => {
    resolveReview = resolve;
  });
  const ctx: WorkflowContext = {
    runId: "run-123",
    runDir: "/tmp/run-123",
    workspace: "/tmp/workspace",
    heartbeatMs: 10,
    eventSink(event) {
      events.push(event);
    },
    agent() {
      return reviewPromise;
    },
    aggregate() {
      return "pass";
    },
    reviewInfo() {
      return { key: "implementation", title: "Implementation review", stage: "implementation" };
    },
    export({ verdict }) {
      return { status: "completed", verdict };
    },
    exportFailed() {
      return { status: "failed" };
    },
  };

  const run = runReviewSteps(ctx, "Change Review Summary", [
    { agentName: "review-implementation" },
  ]);
  await vi.advanceTimersByTimeAsync(25);
  resolveReview(PASS_REVIEW);
  await vi.runOnlyPendingTimersAsync();

  await expect(run).resolves.toMatchObject({ status: "completed", verdict: "pass" });
  expect(events.map((event) => event.type)).toEqual([
    "step:start",
    "step:heartbeat",
    "step:heartbeat",
    "step:end",
  ]);
  expect(events[0]).toMatchObject({
    runId: "run-123",
    stepId: "review-implementation",
    cliStep: "implementation",
    status: "running",
  });
  expect(events.at(-1)).toMatchObject({
    type: "step:end",
    status: "completed",
    outputs: [
      "implementation-review.prompt.md",
      "implementation-review.raw.json",
      "implementation-review.json",
      "implementation-review.stream.jsonl",
    ],
  });
});

test("runReviewSteps emits failed step events", async () => {
  const events: WorkflowEvent[] = [];
  const ctx: WorkflowContext = {
    runId: "run-123",
    eventSink(event) {
      events.push(event);
    },
    async agent() {
      throw new Error("review failed");
    },
    aggregate() {
      return "pass";
    },
    reviewInfo() {
      return { key: "implementation", title: "Implementation review", stage: "implementation" };
    },
    export() {
      return { status: "completed", verdict: "pass" };
    },
    exportFailed() {
      return { status: "failed" };
    },
  };

  await expect(
    runReviewSteps(ctx, "Change Review Summary", [{ agentName: "review-implementation" }]),
  ).resolves.toMatchObject({ status: "failed" });
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "step:end",
      status: "failed",
      error: "review failed",
    }),
  );
});

test("spec review steps emit review-spec events and outputs", async () => {
  const events: WorkflowEvent[] = [];
  const ctx: WorkflowContext = {
    runId: "run-123",
    eventSink(event) {
      events.push(event);
    },
    async agent() {
      return PASS_REVIEW;
    },
    aggregate() {
      return "pass";
    },
    reviewInfo,
    export({ verdict }) {
      return { status: "completed", verdict };
    },
    exportFailed() {
      return { status: "failed" };
    },
  };

  await expect(
    runReviewSteps(ctx, "Plan Review Summary", [{ agentName: "review-spec" }]),
  ).resolves.toMatchObject({ status: "completed", verdict: "pass" });
  expect(events).toEqual([
    expect.objectContaining({
      type: "step:start",
      stepId: "review-spec",
      cliStep: "spec",
    }),
    expect.objectContaining({
      type: "step:end",
      stepId: "review-spec",
      cliStep: "spec",
      outputs: [
        "spec-review.prompt.md",
        "spec-review.raw.json",
        "spec-review.json",
        "spec-review.stream.jsonl",
      ],
    }),
  ]);
});

test("selected change-review steps emit events only for executed reviewers", async () => {
  const events: WorkflowEvent[] = [];
  const ctx: WorkflowContext = {
    runId: "run-123",
    eventSink(event) {
      events.push(event);
    },
    async agent() {
      return PASS_REVIEW;
    },
    aggregate() {
      return "pass";
    },
    reviewInfo,
    export({ verdict }) {
      return { status: "completed", verdict };
    },
    exportFailed() {
      return { status: "failed" };
    },
  };

  await expect(runChangeReview(ctx, { steps: ["implementation"] })).resolves.toMatchObject({
    status: "completed",
  });

  const stepEvents = events.filter((event) => event.type.startsWith("step:"));
  expect(stepEvents.map((event) => event.stepId)).toEqual([
    "review-implementation",
    "review-implementation",
  ]);
  expect(stepEvents.map((event) => event.cliStep)).toEqual(["implementation", "implementation"]);
  expect(stepEvents.some((event) => event.stepId === "code-quality-review")).toBe(false);
  expect(stepEvents.some((event) => event.stepId === "simplify-review")).toBe(false);
});

test("parallel review steps emit start and end events for mixed outcomes", async () => {
  const events: WorkflowEvent[] = [];
  const implementation = createDeferredReview();
  const quality = createDeferredReview();
  const ctx: WorkflowContext = {
    runId: "run-123",
    eventSink(event) {
      events.push(event);
    },
    agent(name) {
      if (name === "review-implementation") return implementation.promise;
      if (name === "code-quality-review") return quality.promise;
      return Promise.resolve(PASS_REVIEW);
    },
    aggregate() {
      return "pass";
    },
    reviewInfo,
    export({ verdict }) {
      return { status: "completed", verdict };
    },
    exportFailed() {
      return { status: "failed" };
    },
  };

  const run = runChangeReview(ctx, { steps: ["implementation", "quality"] });
  await flushAsyncWork();
  expect(
    events.filter((event) => event.type === "step:start").map((event) => event.stepId),
  ).toEqual(["review-implementation", "code-quality-review"]);

  implementation.resolve(PASS_REVIEW);
  quality.reject(new Error("quality failed"));

  await expect(run).resolves.toMatchObject({ status: "failed" });
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "step:end",
      stepId: "review-implementation",
      status: "completed",
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "step:end",
      stepId: "code-quality-review",
      status: "failed",
      error: "quality failed",
    }),
  );
});
