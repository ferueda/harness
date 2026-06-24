import { expect, test } from "vitest";
import type { ReviewSection, ReviewVerdict } from "../lib/aggregate.ts";
import type { ReviewOutput } from "../lib/schemas.ts";
import type { ReviewAgentName } from "../lib/workflow-context.ts";
import { runReviewSteps, type WorkflowContext } from "../workflows/review-steps.ts";

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

function createContext(deferred: Record<ReviewAgentName, DeferredReview>) {
  const started: ReviewAgentName[] = [];
  let exportedReviews: ReviewSection[] | undefined;
  let exportedFailures: unknown[] | undefined;
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
        simplify: { key: "simplify", title: "Simplify review", stage: "simplify" },
      } satisfies Record<ReviewAgentName, { key: string; title: string; stage: string }>;
      return info[name];
    },
    export({ reviews, verdict }) {
      exportedReviews = reviews;
      return { status: "completed", verdict };
    },
    exportFailed({ reviews, failedReviews }) {
      exportedReviews = reviews;
      exportedFailures = failedReviews;
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
  };
}

test("runReviewSteps starts review agents before any review resolves", async () => {
  const deferred = {
    "review-implementation": createDeferredReview(),
    "code-quality-review": createDeferredReview(),
    simplify: createDeferredReview(),
  };
  const harness = createContext(deferred);
  const run = runReviewSteps(harness.ctx, "Review Summary", [
    "review-implementation",
    "code-quality-review",
  ]);

  expect(harness.started).toEqual(["review-implementation", "code-quality-review"]);
  deferred["code-quality-review"].resolve(PASS_REVIEW);
  deferred["review-implementation"].resolve(PASS_REVIEW);
  await expect(run).resolves.toMatchObject({ status: "completed", verdict: "pass" });
  expect(harness.exportedReviews?.map((review) => review.key)).toEqual([
    "implementation",
    "codeQuality",
  ]);
});

test("runReviewSteps starts review-full agents before any review resolves", async () => {
  const deferred = {
    "review-implementation": createDeferredReview(),
    "code-quality-review": createDeferredReview(),
    simplify: createDeferredReview(),
  };
  const harness = createContext(deferred);
  const run = runReviewSteps(harness.ctx, "Full Review Summary", [
    "review-implementation",
    "code-quality-review",
    "simplify",
  ]);

  expect(harness.started).toEqual(["review-implementation", "code-quality-review", "simplify"]);
  deferred.simplify.resolve(PASS_REVIEW);
  deferred["code-quality-review"].resolve(PASS_REVIEW);
  deferred["review-implementation"].resolve(PASS_REVIEW);
  await run;
  expect(harness.exportedReviews?.map((review) => review.key)).toEqual([
    "implementation",
    "codeQuality",
    "simplify",
  ]);
});

test("runReviewSteps exports failed reviews after all reviewers settle", async () => {
  const deferred = {
    "review-implementation": createDeferredReview(),
    "code-quality-review": createDeferredReview(),
    simplify: createDeferredReview(),
  };
  const harness = createContext(deferred);
  const run = runReviewSteps(harness.ctx, "Review Summary", [
    "review-implementation",
    "code-quality-review",
  ]);

  deferred["code-quality-review"].reject(new Error("quality broke"));
  expect(harness.exportedFailures).toBeUndefined();
  deferred["review-implementation"].resolve(PASS_REVIEW);

  await expect(run).resolves.toMatchObject({ status: "failed" });
  expect(harness.exportedReviews?.map((review) => review.key)).toEqual(["implementation"]);
  expect(harness.exportedFailures).toEqual([
    { key: "codeQuality", stage: "quality", error: "quality broke" },
  ]);
});

test("runReviewSteps preserves successful later reviews when an earlier reviewer fails", async () => {
  const deferred = {
    "review-implementation": createDeferredReview(),
    "code-quality-review": createDeferredReview(),
    simplify: createDeferredReview(),
  };
  const harness = createContext(deferred);
  const run = runReviewSteps(harness.ctx, "Review Summary", [
    "review-implementation",
    "code-quality-review",
  ]);

  deferred["review-implementation"].reject(new Error("implementation broke"));
  deferred["code-quality-review"].resolve(PASS_REVIEW);

  await expect(run).resolves.toMatchObject({ status: "failed" });
  expect(harness.exportedReviews?.map((review) => review.key)).toEqual(["codeQuality"]);
  expect(harness.exportedFailures).toEqual([
    { key: "implementation", stage: "implementation", error: "implementation broke" },
  ]);
});

test("runReviewSteps supports all reviewers failing", async () => {
  const deferred = {
    "review-implementation": createDeferredReview(),
    "code-quality-review": createDeferredReview(),
    simplify: createDeferredReview(),
  };
  const harness = createContext(deferred);
  const run = runReviewSteps(harness.ctx, "Review Summary", [
    "review-implementation",
    "code-quality-review",
  ]);

  deferred["review-implementation"].reject(new Error("implementation broke"));
  deferred["code-quality-review"].reject(new Error("quality broke"));

  await expect(run).resolves.toMatchObject({ status: "failed" });
  expect(harness.exportedReviews).toEqual([]);
  expect(harness.exportedFailures).toEqual([
    { key: "implementation", stage: "implementation", error: "implementation broke" },
    { key: "codeQuality", stage: "quality", error: "quality broke" },
  ]);
});
