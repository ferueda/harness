import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  implementationFixture,
  lifecycleSnapshot,
  requiredNext,
} from "../test/factory-hosted-operation-test-fixtures.ts";
import { runHostedFactoryOperation } from "./factory-hosted-operation.ts";
import { actionLifecycleEventPath, readFactoryActionEvents } from "./factory-lifecycle-kernel.ts";

test("recovers a completed implementation candidate after Grove without rerunning its provider", async () => {
  const value = implementationFixture({ successfulProvider: true });
  const restoreLifecycle = lifecycleSnapshot(value.factoryStateRoot, value.workItemKey);
  const first = await runHostedFactoryOperation({ request: value.request, runtime: value.runtime });
  expect(first).toMatchObject({ outcome: "executed" });
  restoreLifecycle();

  const recovered = await runHostedFactoryOperation({
    request: value.request,
    runtime: value.runtime,
  });

  expect(recovered).toMatchObject({ outcome: "recovered" });
  expect(value.ensureWorkspace).toHaveBeenCalledTimes(2);
  expect(value.providerRun).toHaveBeenCalledOnce();
  expect(
    readFactoryActionEvents(value.factoryStateRoot, value.workItemKey).filter(
      (event) => event.type === "implementation.candidate.produced",
    ),
  ).toHaveLength(1);
});

test("redelivers an appended implementation candidate as recovered", async () => {
  const value = implementationFixture({ successfulProvider: true });
  const first = await runHostedFactoryOperation({ request: value.request, runtime: value.runtime });
  expect(first).toMatchObject({ outcome: "executed" });
  if (first.outcome !== "executed") throw new Error("Expected executed candidate receipt");

  const recovered = await runHostedFactoryOperation({
    request: value.request,
    runtime: value.runtime,
  });

  expect(recovered).toMatchObject({
    outcome: "recovered",
    resultEventId: first.resultEventId,
  });
  expect(value.ensureWorkspace).toHaveBeenCalledOnce();
  expect(value.providerRun).toHaveBeenCalledOnce();
  expect(
    readFactoryActionEvents(value.factoryStateRoot, value.workItemKey).filter(
      (event) => event.type === "implementation.candidate.produced",
    ),
  ).toHaveLength(1);
});

test.each(["staged", "live"] as const)(
  "rejects invalid %s implementation candidate recovery only after Grove",
  async (invalid) => {
    const value = implementationFixture({ successfulProvider: true });
    const restoreLifecycle = lifecycleSnapshot(value.factoryStateRoot, value.workItemKey);
    await runHostedFactoryOperation({ request: value.request, runtime: value.runtime });
    restoreLifecycle();
    const eventsBefore = readFileSync(
      actionLifecycleEventPath(value.factoryStateRoot, value.workItemKey),
      "utf8",
    );
    if (invalid === "staged") {
      writeFileSync(
        join(
          value.runDir,
          "actions/1/produceImplementationCandidate",
          value.request.operation.actionKey,
          "provider-result.json",
        ),
        "{}\n",
      );
    } else {
      writeFileSync(join(value.workspace, "README.md"), "unexpected live change\n");
    }

    await expect(
      runHostedFactoryOperation({ request: value.request, runtime: value.runtime }),
    ).rejects.toThrow(
      invalid === "staged"
        ? /successful staged provider result/
        : /Git authority|workspace changed/,
    );
    expect(value.ensureWorkspace).toHaveBeenCalledTimes(2);
    expect(value.providerRun).toHaveBeenCalledOnce();
    expect(
      readFileSync(actionLifecycleEventPath(value.factoryStateRoot, value.workItemKey), "utf8"),
    ).toBe(eventsBefore);
  },
);

test("recovers a completed implementation review after Grove without rerunning reviewers", async () => {
  const value = implementationFixture({ successfulProvider: true });
  const candidate = await runHostedFactoryOperation({
    request: value.request,
    runtime: value.runtime,
  });
  const reviewRequest = requiredNext(candidate);
  const restoreLifecycle = lifecycleSnapshot(value.factoryStateRoot, value.workItemKey);
  const firstReview = await runHostedFactoryOperation({
    request: reviewRequest,
    runtime: value.runtime,
  });
  expect(firstReview).toMatchObject({ outcome: "executed" });
  restoreLifecycle();

  const recovered = await runHostedFactoryOperation({
    request: reviewRequest,
    runtime: value.runtime,
  });

  expect(recovered).toMatchObject({ outcome: "recovered" });
  expect(value.ensureWorkspace).toHaveBeenCalledTimes(3);
  expect(value.providerRun).toHaveBeenCalledOnce();
  expect(value.implementationReviewRunner).toHaveBeenCalledOnce();
  expect(
    readFactoryActionEvents(value.factoryStateRoot, value.workItemKey).filter(
      (event) => event.type === "implementation.review.completed",
    ),
  ).toHaveLength(1);
});

test("redelivers an older candidate after its review without reopening Grove", async () => {
  const value = implementationFixture({ successfulProvider: true });
  const candidate = await runHostedFactoryOperation({
    request: value.request,
    runtime: value.runtime,
  });
  if (candidate.outcome !== "executed") throw new Error("Expected executed candidate receipt");
  const reviewRequest = requiredNext(candidate);
  await runHostedFactoryOperation({ request: reviewRequest, runtime: value.runtime });

  const recovered = await runHostedFactoryOperation({
    request: value.request,
    runtime: value.runtime,
  });

  expect(recovered).toMatchObject({
    outcome: "recovered",
    resultEventId: candidate.resultEventId,
  });
  expect(value.ensureWorkspace).toHaveBeenCalledTimes(2);
  expect(value.providerRun).toHaveBeenCalledOnce();
  expect(value.implementationReviewRunner).toHaveBeenCalledOnce();
});

test("redelivers an appended implementation review as recovered", async () => {
  const value = implementationFixture({ successfulProvider: true });
  const candidate = await runHostedFactoryOperation({
    request: value.request,
    runtime: value.runtime,
  });
  const reviewRequest = requiredNext(candidate);
  const firstReview = await runHostedFactoryOperation({
    request: reviewRequest,
    runtime: value.runtime,
  });
  expect(firstReview).toMatchObject({ outcome: "executed" });
  if (firstReview.outcome !== "executed") throw new Error("Expected executed review receipt");

  const recovered = await runHostedFactoryOperation({
    request: reviewRequest,
    runtime: value.runtime,
  });

  expect(recovered).toMatchObject({
    outcome: "recovered",
    resultEventId: firstReview.resultEventId,
  });
  expect(value.ensureWorkspace).toHaveBeenCalledTimes(2);
  expect(value.providerRun).toHaveBeenCalledOnce();
  expect(value.implementationReviewRunner).toHaveBeenCalledOnce();
  expect(
    readFactoryActionEvents(value.factoryStateRoot, value.workItemKey).filter(
      (event) => event.type === "implementation.review.completed",
    ),
  ).toHaveLength(1);
});

test.each(["staged", "live"] as const)(
  "rejects invalid %s implementation review recovery only after Grove",
  async (invalid) => {
    const value = implementationFixture({ successfulProvider: true });
    const candidate = await runHostedFactoryOperation({
      request: value.request,
      runtime: value.runtime,
    });
    const reviewRequest = requiredNext(candidate);
    const restoreLifecycle = lifecycleSnapshot(value.factoryStateRoot, value.workItemKey);
    await runHostedFactoryOperation({ request: reviewRequest, runtime: value.runtime });
    restoreLifecycle();
    const eventsBefore = readFileSync(
      actionLifecycleEventPath(value.factoryStateRoot, value.workItemKey),
      "utf8",
    );
    if (invalid === "staged") {
      writeFileSync(
        join(
          value.runDir,
          "actions/1/reviewImplementationCandidate",
          reviewRequest.operation.actionKey,
          "review-result.json",
        ),
        "{}\n",
      );
    } else {
      writeFileSync(join(value.workspace, "README.md"), "unexpected live change\n");
    }

    await expect(
      runHostedFactoryOperation({ request: reviewRequest, runtime: value.runtime }),
    ).rejects.toThrow(
      invalid === "staged"
        ? /valid staged reviewer result/
        : /Git authority changed|workspace tree does not match/,
    );
    expect(value.ensureWorkspace).toHaveBeenCalledTimes(3);
    expect(value.providerRun).toHaveBeenCalledOnce();
    expect(value.implementationReviewRunner).toHaveBeenCalledOnce();
    expect(
      readFileSync(actionLifecycleEventPath(value.factoryStateRoot, value.workItemKey), "utf8"),
    ).toBe(eventsBefore);
  },
);
