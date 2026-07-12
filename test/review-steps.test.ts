import { expect, test } from "vitest";
import type { ReviewSection, ReviewVerdict, WorkflowStepMetadata } from "../lib/aggregate.ts";
import type { ReviewOutput } from "../lib/schemas.ts";
import type { ReviewAgentName } from "../lib/workflow-context.ts";
import {
  normalizeChangeReviewSteps,
  run as runChangeReview,
} from "../workflows/change-review.workflow.ts";
import { run as runPlanReview } from "../workflows/plan-review.workflow.ts";
import type { WorkflowContext } from "../workflows/review-steps.ts";

type DeferredReview = {
  promise: Promise<ReviewOutput>;
  resolve(review: ReviewOutput): void;
  reject(error: Error): void;
};

const PASS_REVIEW = {
  verdict: "pass",
  summary: "ok",
  findings: [],
} satisfies ReviewOutput;

function createDeferredReview(): DeferredReview {
  let resolve!: (review: ReviewOutput) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ReviewOutput>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createDeferredReviews(): Record<ReviewAgentName, DeferredReview> {
  return {
    "review-implementation": createDeferredReview(),
    "code-quality-review": createDeferredReview(),
    "review-spec": createDeferredReview(),
  };
}

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function createContext(
  deferred: Record<ReviewAgentName, DeferredReview>,
  options: { reviewConcurrency?: WorkflowContext["reviewConcurrency"] } = {},
) {
  const started: ReviewAgentName[] = [];
  let exportedReviews: ReviewSection[] | undefined;
  let exportedFailures: unknown[] | undefined;
  let exportedSteps: WorkflowStepMetadata | undefined;
  const ctx: WorkflowContext = {
    agent(name) {
      started.push(name);
      return deferred[name].promise;
    },
    aggregate(...reviews: ReviewOutput[]): ReviewVerdict {
      return reviews.every((review) => review.verdict === "pass") ? "pass" : "needs_changes";
    },
    reviewInfo(name) {
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
        "review-spec": { key: "spec", title: "Spec review", stage: "spec" },
      } satisfies Record<ReviewAgentName, { key: string; title: string; stage: string }>;
      return info[name];
    },
    reviewConcurrency: options.reviewConcurrency,
    export({ reviews, verdict, steps }) {
      exportedReviews = reviews;
      exportedSteps = steps;
      return { status: "completed", verdict };
    },
    exportFailed({ reviews, failedReviews, steps }) {
      exportedReviews = reviews;
      exportedFailures = failedReviews;
      exportedSteps = steps;
      return { status: "failed" };
    },
  };
  return {
    ctx,
    started,
    get exportedReviews() {
      return exportedReviews;
    },
    get exportedFailures() {
      return exportedFailures;
    },
    get exportedSteps() {
      return exportedSteps;
    },
  };
}

test("change-review starts all review steps by default before any review resolves", async () => {
  const deferred = createDeferredReviews();
  const harness = createContext(deferred);
  const run = runChangeReview(harness.ctx);

  expect(harness.started).toEqual(["review-implementation", "code-quality-review"]);
  deferred["code-quality-review"].resolve(PASS_REVIEW);
  deferred["review-implementation"].resolve(PASS_REVIEW);
  await expect(run).resolves.toMatchObject({ status: "completed", verdict: "pass" });
  expect(harness.exportedReviews?.map((review) => review.key)).toEqual([
    "implementation",
    "codeQuality",
  ]);
  expect(harness.exportedSteps).toEqual({
    workflow: "change-review",
    availableSteps: ["implementation", "quality"],
    requestedSteps: ["implementation", "quality"],
    executedSteps: ["implementation", "quality"],
    omittedSteps: [],
    partial: false,
  });
});

test("plan-review starts only the spec review step", async () => {
  const deferred = createDeferredReviews();
  const harness = createContext(deferred);
  const run = runPlanReview(harness.ctx);

  expect(harness.started).toEqual(["review-spec"]);
  deferred["review-spec"].resolve(PASS_REVIEW);
  await expect(run).resolves.toMatchObject({ status: "completed", verdict: "pass" });
  expect(harness.exportedReviews?.map((review) => review.key)).toEqual(["spec"]);
  expect(harness.exportedSteps).toEqual({
    workflow: "plan-review",
    availableSteps: ["spec"],
    requestedSteps: ["spec"],
    executedSteps: ["spec"],
    omittedSteps: [],
    partial: false,
  });
});

test("change-review can run selected reviews serially", async () => {
  const deferred = createDeferredReviews();
  const harness = createContext(deferred, { reviewConcurrency: "serial" });
  const run = runChangeReview(harness.ctx);

  expect(harness.started).toEqual(["review-implementation"]);
  deferred["review-implementation"].resolve(PASS_REVIEW);
  await flushAsyncWork();
  expect(harness.started).toEqual(["review-implementation", "code-quality-review"]);
  deferred["code-quality-review"].resolve(PASS_REVIEW);

  await expect(run).resolves.toMatchObject({ status: "completed", verdict: "pass" });
  expect(harness.exportedReviews?.map((review) => review.key)).toEqual([
    "implementation",
    "codeQuality",
  ]);
});

test("change-review serial mode stops after the first failed reviewer", async () => {
  const deferred = createDeferredReviews();
  const harness = createContext(deferred, { reviewConcurrency: "serial" });
  const run = runChangeReview(harness.ctx);

  expect(harness.started).toEqual(["review-implementation"]);
  deferred["review-implementation"].reject(
    new Error("Agent runtime modified the workspace during a review run"),
  );

  await expect(run).resolves.toMatchObject({ status: "failed" });
  expect(harness.started).toEqual(["review-implementation"]);
  expect(harness.exportedReviews).toEqual([]);
  expect(harness.exportedFailures).toEqual([
    {
      key: "implementation",
      stage: "implementation",
      error: "Agent runtime modified the workspace during a review run",
    },
  ]);
  expect(harness.exportedSteps).toEqual({
    workflow: "change-review",
    availableSteps: ["implementation", "quality"],
    requestedSteps: ["implementation", "quality"],
    executedSteps: ["implementation"],
    omittedSteps: ["quality"],
    partial: true,
  });
});

test("change-review starts only selected steps in workflow order", async () => {
  const deferred = createDeferredReviews();
  const harness = createContext(deferred);
  const run = runChangeReview(harness.ctx, { steps: ["quality", "implementation"] });

  expect(harness.started).toEqual(["review-implementation", "code-quality-review"]);
  deferred["code-quality-review"].resolve(PASS_REVIEW);
  deferred["review-implementation"].resolve(PASS_REVIEW);
  await expect(run).resolves.toMatchObject({ status: "completed", verdict: "pass" });
  expect(harness.exportedReviews?.map((review) => review.key)).toEqual([
    "implementation",
    "codeQuality",
  ]);
  expect(harness.exportedSteps).toMatchObject({
    requestedSteps: ["implementation", "quality"],
    executedSteps: ["implementation", "quality"],
    omittedSteps: [],
    partial: false,
  });
});

test("change-review normalizes duplicate selected steps", async () => {
  const deferred = createDeferredReviews();
  const harness = createContext(deferred);
  const run = runChangeReview(harness.ctx, { steps: ["implementation", "implementation"] });

  expect(harness.started).toEqual(["review-implementation"]);
  deferred["review-implementation"].resolve(PASS_REVIEW);
  await expect(run).resolves.toMatchObject({ status: "completed", verdict: "pass" });
  expect(harness.exportedReviews?.map((review) => review.key)).toEqual(["implementation"]);
  expect(harness.exportedSteps).toMatchObject({
    requestedSteps: ["implementation"],
    executedSteps: ["implementation"],
    omittedSteps: ["quality"],
    partial: true,
  });
});

test("change-review rejects unknown selected steps", () => {
  expect(() => normalizeChangeReviewSteps(["missing"])).toThrow(
    /Unknown change-review step: missing\. Valid steps: implementation, quality/,
  );
});

test("change-review exports failed selected reviews after all selected reviewers settle", async () => {
  const deferred = createDeferredReviews();
  const harness = createContext(deferred);
  const run = runChangeReview(harness.ctx, { steps: ["implementation", "quality"] });

  deferred["code-quality-review"].reject(new Error("quality broke"));
  expect(harness.exportedFailures).toBeUndefined();
  deferred["review-implementation"].resolve(PASS_REVIEW);

  await expect(run).resolves.toMatchObject({ status: "failed" });
  expect(harness.exportedReviews?.map((review) => review.key)).toEqual(["implementation"]);
  expect(harness.exportedFailures).toEqual([
    { key: "codeQuality", stage: "quality", error: "quality broke" },
  ]);
  expect(harness.exportedSteps).toMatchObject({
    requestedSteps: ["implementation", "quality"],
    omittedSteps: [],
    partial: false,
  });
});

test("change-review preserves successful later reviews when an earlier selected reviewer fails", async () => {
  const deferred = createDeferredReviews();
  const harness = createContext(deferred);
  const run = runChangeReview(harness.ctx, { steps: ["implementation", "quality"] });

  deferred["review-implementation"].reject(new Error("implementation broke"));
  deferred["code-quality-review"].resolve(PASS_REVIEW);

  await expect(run).resolves.toMatchObject({ status: "failed" });
  expect(harness.exportedReviews?.map((review) => review.key)).toEqual(["codeQuality"]);
  expect(harness.exportedFailures).toEqual([
    { key: "implementation", stage: "implementation", error: "implementation broke" },
  ]);
});

test("change-review supports all selected reviewers failing", async () => {
  const deferred = createDeferredReviews();
  const harness = createContext(deferred);
  const run = runChangeReview(harness.ctx, { steps: ["implementation", "quality"] });

  deferred["review-implementation"].reject(new Error("implementation broke"));
  deferred["code-quality-review"].reject(new Error("quality broke"));

  await expect(run).resolves.toMatchObject({ status: "failed" });
  expect(harness.exportedReviews).toEqual([]);
  expect(harness.exportedFailures).toEqual([
    { key: "implementation", stage: "implementation", error: "implementation broke" },
    { key: "codeQuality", stage: "quality", error: "quality broke" },
  ]);
});
