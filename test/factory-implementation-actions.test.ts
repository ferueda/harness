import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { expect, test, vi } from "vitest";
import {
  assertLiveImplementationStatus,
  runOneFactoryImplementationAction,
} from "../bin/factory-implementation-cli.ts";
import type { Agent, AgentRunInput } from "../lib/agents.ts";
import { createFactoryArtifactRef, verifyFactoryArtifactRef } from "../lib/factory-artifact-ref.ts";
import { factoryActionKey } from "../lib/factory-action-contract.ts";
import {
  observeFactoryContinuation,
  recordFactoryContinuation,
} from "../lib/factory-continuation.ts";
import { produceImplementationCandidate } from "../lib/factory-implementation-candidate-action.ts";
import { reviewImplementationCandidate } from "../lib/factory-implementation-review-action.ts";
import {
  createFactoryImplementationRunContext,
  openFactoryImplementationRunContext,
} from "../lib/factory-implementation-run-context.ts";
import {
  actionLifecycleEventPath,
  appendFactoryActionEvent,
  readFactoryActionEvents,
} from "../lib/factory-lifecycle-kernel.ts";
import type { FactoryLifecycleEvent } from "../lib/factory-lifecycle-events.ts";
import { deriveFactoryWorkItemKey } from "../lib/factory-lifecycle.ts";
import { createFactoryReviewHead, FactoryReviewHeadError } from "../lib/factory-review-head.ts";
import type { FactoryWorkItem } from "../lib/factory-schemas.ts";
import {
  decideNextFactoryAction,
  reduceFactoryLifecycleEvents,
} from "../lib/factory-state-machine.ts";
import { ensureFactoryStoreFormat } from "../lib/factory-store-format.ts";
import type { FactoryStoreMeta } from "../lib/factory-store.ts";
import { fakeLinearAdapter, LINEAR_SETTINGS } from "./factory-linear-test-helpers.ts";

test("candidate and pass review run in separate commands and promote the exact reviewed commit", async () => {
  const fixture = directFixture();
  const providerRun = vi.fn<Agent["run"]>(async (input: AgentRunInput) => {
    expect(input.maxRuntimeMs).toBe(0);
    writeFileSync(join(fixture.workspace, "tracked.txt"), "implemented\n");
    return {
      ok: true,
      raw: { workspaceStatus: { before: "clean", after: "changed" } },
      session: { provider: "cursor", id: "implementer-session" },
    };
  });
  const first = await runOneFactoryImplementationAction({
    ...coordinatorInput(fixture),
    agentProviderFactory: () => ({ name: "cursor", run: providerRun }),
  });
  expect(first.action?.handler).toBe("produceImplementationCandidate");
  expect(first.next).toMatchObject({ kind: "invoke", handler: "reviewImplementationCandidate" });
  expect(providerRun).toHaveBeenCalledTimes(1);
  expect(git(fixture.workspace, ["rev-parse", "HEAD"]).trim()).toBe(fixture.baseSha);

  const reviewRunner = vi.fn(async (ctx: { runDir?: string }) => {
    writePassReviews(ctx.runDir!);
    return fullReviewMeta("pass");
  });
  const second = await runOneFactoryImplementationAction({
    ...coordinatorInput(fixture),
    agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
    reviewRunner: reviewRunner as never,
  });
  expect(second.action?.handler).toBe("reviewImplementationCandidate");
  expect(second.next).toEqual({ kind: "wait", reason: "pr-publication" });
  expect(reviewRunner).toHaveBeenCalledTimes(1);
  const events = readFactoryActionEvents(fixture.factoryStateRoot, fixture.key);
  const candidate = events.find((event) => event.type === "implementation.candidate.produced");
  if (!candidate || candidate.type !== "implementation.candidate.produced")
    throw new Error("candidate missing");
  expect(git(fixture.workspace, ["rev-parse", "HEAD"]).trim()).toBe(candidate.data.commit);
  expect(git(fixture.workspace, ["status", "--porcelain=v1"]).trim()).toBe("");
  expect(git(fixture.workspace, ["diff", "--cached", "--name-only"]).trim()).toBe("");
});

test("implementation starts from immutable input after live tracker comments change", async () => {
  const fixture = directFixture();
  fixture.workItem.body += "\n\n## Linear Comments\n\n- Factory routed the issue.";
  const providerRun = vi.fn<Agent["run"]>(async () => {
    writeFileSync(join(fixture.workspace, "tracked.txt"), "implemented\n");
    return {
      ok: true,
      raw: {},
      session: { provider: "cursor", id: "implementer-session" },
    };
  });

  const result = await runOneFactoryImplementationAction({
    ...coordinatorInput(fixture),
    agentProviderFactory: () => ({ name: "cursor", run: providerRun }),
  });

  expect(result.action?.handler).toBe("produceImplementationCandidate");
  expect(providerRun).toHaveBeenCalledOnce();
  const request = readFactoryActionEvents(fixture.factoryStateRoot, fixture.key).find(
    (event) => event.type === "implementation.requested",
  );
  if (!request?.phaseRunId) throw new Error("implementation request missing");
  const persisted = JSON.parse(
    readFileSync(
      join(fixture.store.factoryRunsDir, request.phaseRunId, "context/work-item.json"),
      "utf8",
    ),
  ) as FactoryWorkItem;
  expect(persisted.body).toBe("Change tracked.txt");
});

test("revision resumes the effective session with complete blockers and promotes only its new candidate", async () => {
  const fixture = directFixture();
  const firstProvider = vi.fn<Agent["run"]>(async () => {
    writeFileSync(join(fixture.workspace, "tracked.txt"), "first\n");
    return { ok: true, raw: {}, session: { provider: "cursor", id: "session-1" } };
  });
  const first = await runOneFactoryImplementationAction({
    ...coordinatorInput(fixture),
    agentProviderFactory: () => ({ name: "cursor", run: firstProvider }),
  });
  expect(first.action).toMatchObject({ handler: "produceImplementationCandidate", attempt: 1 });

  const needsChanges = await runOneFactoryImplementationAction({
    ...coordinatorInput(fixture),
    agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
    reviewRunner: (async (ctx: { runDir?: string }) => {
      writeBlockingReviews(ctx.runDir!);
      return fullReviewMeta("needs_changes");
    }) as never,
  });
  expect(needsChanges.action).toMatchObject({
    handler: "reviewImplementationCandidate",
    attempt: 1,
  });
  expect(needsChanges.next).toEqual({ kind: "wait", reason: "human" });
  expect(firstProvider).toHaveBeenCalledTimes(1);
  const continued = recordFactoryContinuation({
    phase: "implementation",
    decision: "revise",
    response: "Apply both accepted blockers without replacing valid prior work.",
    factoryStateRoot: fixture.factoryStateRoot,
    factoryStore: fixture.store,
    workItemKey: deriveFactoryWorkItemKey(fixture.workItem),
    observed: observeFactoryContinuation(
      readFactoryActionEvents(fixture.factoryStateRoot, deriveFactoryWorkItemKey(fixture.workItem)),
      "implementation",
    ),
  });
  expect(continued.next).toMatchObject({
    kind: "invoke",
    handler: "produceImplementationCandidate",
    attempt: 2,
    reason: "operator-revise",
  });
  git(fixture.workspace, ["tag", "unrelated-operator-tag"]);

  const revisionProvider = vi.fn<Agent["run"]>(async (input) => {
    expect(input.session).toMatchObject({ provider: "cursor", id: "session-1" });
    expect(input.prompt).toContain("Revision authority");
    expect(input.prompt).toContain("Correctness");
    expect(input.prompt).toContain("Clarity");
    expect(input.prompt).toContain("Apply both accepted blockers");
    writeFileSync(join(fixture.workspace, "tracked.txt"), "second\n");
    return { ok: true, raw: {} };
  });
  const revision = await runOneFactoryImplementationAction({
    ...coordinatorInput(fixture),
    agentProviderFactory: () => ({ name: "cursor", run: revisionProvider }),
  });
  expect(revision.action).toMatchObject({ handler: "produceImplementationCandidate", attempt: 2 });
  expect(revision.next).toMatchObject({ handler: "reviewImplementationCandidate", attempt: 2 });

  const pass = await runOneFactoryImplementationAction({
    ...coordinatorInput(fixture),
    agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
    reviewRunner: (async (ctx: { runDir?: string }) => {
      const handoff = readFileSync(join(ctx.runDir!, "context/handoff.md"), "utf8");
      expect(handoff).toContain("selected revise");
      expect(handoff).toContain("Apply both accepted blockers");
      expect(handoff).toContain("Prior implementation review");
      expect(handoff).toContain("Prior quality review");
      writePassReviews(ctx.runDir!);
      return fullReviewMeta("pass");
    }) as never,
  });
  expect(pass.next).toEqual({ kind: "wait", reason: "pr-publication" });
  const candidates = readFactoryActionEvents(fixture.factoryStateRoot, fixture.key).filter(
    (
      event,
    ): event is Extract<FactoryLifecycleEvent, { type: "implementation.candidate.produced" }> =>
      event.type === "implementation.candidate.produced",
  );
  expect(candidates).toHaveLength(2);
  expect(candidates[0]!.data.commit).not.toBe(candidates[1]!.data.commit);
  expect(git(fixture.workspace, ["rev-parse", `${candidates[1]!.data.commit}^`]).trim()).toBe(
    fixture.baseSha,
  );
  expect(git(fixture.workspace, ["rev-parse", "HEAD"]).trim()).toBe(candidates[1]!.data.commit);
  expect(candidates[1]!.data.effectiveSession).toMatchObject({ id: "session-1" });
});

test("accepted evidence re-reviews the exact candidate without invoking the producer", async () => {
  const fixture = directFixture();
  const providerRun = vi.fn<Agent["run"]>(async () => {
    writeFileSync(join(fixture.workspace, "tracked.txt"), "candidate\n");
    return { ok: true, raw: {}, session: { provider: "cursor", id: "session-1" } };
  });
  await runOneFactoryImplementationAction({
    ...coordinatorInput(fixture),
    agentProviderFactory: () => ({ name: "cursor", run: providerRun }),
  });
  await runOneFactoryImplementationAction({
    ...coordinatorInput(fixture),
    agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
    reviewRunner: (async (ctx: { runDir?: string }) => {
      writeBlockingReviews(ctx.runDir!);
      return fullReviewMeta("needs_changes");
    }) as never,
  });
  const before = readFactoryActionEvents(fixture.factoryStateRoot, fixture.key);
  const candidate = before.find(
    (
      event,
    ): event is Extract<FactoryLifecycleEvent, { type: "implementation.candidate.produced" }> =>
      event.type === "implementation.candidate.produced",
  );
  if (!candidate) throw new Error("candidate missing");
  const continued = continueImplementation(
    fixture,
    "re-review",
    "The required live Desktop routing smoke passed; use the attached result as evidence.",
  );
  expect(continued.next).toMatchObject({
    handler: "reviewImplementationCandidate",
    attempt: 2,
    reason: "operator-re-review",
  });
  expect(() =>
    continueImplementation(fixture, "re-review", "Duplicate continuation must not be recorded."),
  ).toThrow(/no candidate awaiting continuation/);
  expect(
    readFactoryActionEvents(fixture.factoryStateRoot, fixture.key).filter(
      (event) => event.type === "factory.continuation.recorded",
    ),
  ).toHaveLength(1);
  const unexpectedProducer = vi.fn<Agent["run"]>();
  const reviewRunner = vi.fn(async (ctx: { runDir?: string }) => {
    const handoff = readFileSync(join(ctx.runDir!, "context/handoff.md"), "utf8");
    expect(handoff).toContain(candidate.data.commit);
    expect(handoff).toContain("live Desktop routing smoke passed");
    expect(handoff).toContain("Correctness");
    expect(handoff).toContain("Clarity");
    writePassReviews(ctx.runDir!);
    return fullReviewMeta("pass");
  });
  const result = await runOneFactoryImplementationAction({
    ...coordinatorInput(fixture),
    agentProviderFactory: () => ({ name: "cursor", run: unexpectedProducer }),
    reviewRunner: reviewRunner as never,
  });
  expect(result.action).toMatchObject({ handler: "reviewImplementationCandidate", attempt: 2 });
  expect(result.next).toEqual({ kind: "wait", reason: "pr-publication" });
  expect(unexpectedProducer).not.toHaveBeenCalled();
  expect(providerRun).toHaveBeenCalledTimes(1);
  const after = readFactoryActionEvents(fixture.factoryStateRoot, fixture.key);
  expect(after.filter((event) => event.type === "implementation.candidate.produced")).toHaveLength(
    1,
  );
  expect(after.filter((event) => event.type === "implementation.review.completed")).toHaveLength(2);
  expect(git(fixture.workspace, ["rev-parse", "HEAD"]).trim()).toBe(candidate.data.commit);
});

test("rerun rejects an active phase that already has a reusable candidate", async () => {
  const fixture = directFixture();
  const providerRun = vi.fn<Agent["run"]>(async () => {
    writeFileSync(join(fixture.workspace, "tracked.txt"), "candidate\n");
    return { ok: true, raw: {}, session: { provider: "cursor", id: "session-1" } };
  });
  await runOneFactoryImplementationAction({
    ...coordinatorInput(fixture),
    agentProviderFactory: () => ({ name: "cursor", run: providerRun }),
  });

  await expect(
    runOneFactoryImplementationAction({
      ...coordinatorInput(fixture),
      rerun: true,
      agentProviderFactory: () => ({ name: "cursor", run: providerRun }),
    }),
  ).rejects.toThrow(/without a reusable candidate/);
  expect(providerRun).toHaveBeenCalledTimes(1);
  expect(
    readFactoryActionEvents(fixture.factoryStateRoot, fixture.key).filter(
      (event) => event.type === "implementation.requested",
    ),
  ).toHaveLength(1);
});

test("rerun starts a fresh phase only after failure without a candidate", async () => {
  const fixture = directFixture();
  let calls = 0;
  const providerRun = vi.fn<Agent["run"]>(async () => {
    calls += 1;
    if (calls === 1) return { ok: false, error: "operator canceled", exitCode: 130, aborted: true };
    writeFileSync(join(fixture.workspace, "tracked.txt"), "candidate\n");
    return { ok: true, raw: {}, session: { provider: "cursor", id: "session-2" } };
  });
  const failed = await runOneFactoryImplementationAction({
    ...coordinatorInput(fixture),
    agentProviderFactory: () => ({ name: "cursor", run: providerRun }),
  });
  expect(failed.next).toEqual({ kind: "wait", reason: "human" });

  const restarted = await runOneFactoryImplementationAction({
    ...coordinatorInput(fixture),
    rerun: true,
    agentProviderFactory: () => ({ name: "cursor", run: providerRun }),
  });

  expect(restarted.phaseRunId).not.toBe(failed.phaseRunId);
  expect(restarted.action).toMatchObject({ handler: "produceImplementationCandidate", attempt: 1 });
  expect(providerRun).toHaveBeenCalledTimes(2);
  const requests = readFactoryActionEvents(fixture.factoryStateRoot, fixture.key).filter(
    (event) => event.type === "implementation.requested",
  );
  expect(requests).toHaveLength(2);
  expect(requests.at(-1)?.data.intent).toBe("restart");
});

test("Linear needs_changes attention retries before one scheduled revision producer", async () => {
  const fixture = directFixture();
  fixture.workItem.metadata = { linearStatus: "Ready to Implement" };
  const firstProvider = vi.fn<Agent["run"]>(async () => {
    writeFileSync(join(fixture.workspace, "tracked.txt"), "first\n");
    return { ok: true, raw: {}, session: { provider: "cursor", id: "session-1" } };
  });
  const started = vi.fn(async () => ({
    issueIdentifier: "ENG-123",
    runId: "run",
    runDir: "run",
    stage: "started" as const,
    targetStatus: "Implementing",
  }));
  await runOneFactoryImplementationAction({
    ...coordinatorInput(fixture),
    linearIssue: "ENG-123",
    issueRef: "ENG-123",
    linearStatuses: LINEAR_SETTINGS.statuses,
    applyAdapter: fakeLinearAdapter({ applyImplementationStarted: started }),
    agentProviderFactory: () => ({ name: "cursor", run: firstProvider }),
  });
  fixture.workItem.metadata = { linearStatus: "Implementing" };
  const attentionFailure = vi.fn(async () => {
    throw new Error("attention projection unavailable");
  });
  await expect(
    runOneFactoryImplementationAction({
      ...coordinatorInput(fixture),
      linearIssue: "ENG-123",
      issueRef: "ENG-123",
      linearStatuses: LINEAR_SETTINGS.statuses,
      applyAdapter: fakeLinearAdapter({ applyImplementationAttention: attentionFailure }),
      agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
      reviewRunner: (async (ctx: { runDir?: string }) => {
        writeBlockingReviews(ctx.runDir!);
        return fullReviewMeta("needs_changes");
      }) as never,
    }),
  ).rejects.toThrow("attention projection unavailable");
  const before = readFactoryActionEvents(fixture.factoryStateRoot, fixture.key);
  expect(before.filter((event) => event.type === "implementation.review.completed")).toHaveLength(
    1,
  );

  const retryProvider = vi.fn<Agent["run"]>();
  await expect(
    runOneFactoryImplementationAction({
      ...coordinatorInput(fixture),
      linearIssue: "ENG-123",
      issueRef: "ENG-123",
      linearStatuses: LINEAR_SETTINGS.statuses,
      applyAdapter: fakeLinearAdapter({ applyImplementationAttention: attentionFailure }),
      agentProviderFactory: () => ({ name: "cursor", run: retryProvider }),
    }),
  ).rejects.toThrow("attention projection unavailable");
  expect(retryProvider).not.toHaveBeenCalled();
  expect(attentionFailure).toHaveBeenCalledTimes(2);
  recordFactoryContinuation({
    phase: "implementation",
    decision: "revise",
    response: "Apply the two accepted blocking findings.",
    factoryStateRoot: fixture.factoryStateRoot,
    factoryStore: fixture.store,
    workItemKey: deriveFactoryWorkItemKey(fixture.workItem),
    observed: observeFactoryContinuation(
      readFactoryActionEvents(fixture.factoryStateRoot, deriveFactoryWorkItemKey(fixture.workItem)),
      "implementation",
    ),
  });

  const repairedAttention = vi.fn(async () => ({
    issueIdentifier: "ENG-123",
    runId: "run",
    runDir: "run",
    stage: "completed" as const,
    targetStatus: "Implementing",
  }));
  const revisionProvider = vi.fn<Agent["run"]>(async (input) => {
    expect(input.session).toMatchObject({ provider: "cursor", id: "session-1" });
    expect(input.prompt).toContain("Correctness");
    expect(input.prompt).toContain("Clarity");
    writeFileSync(join(fixture.workspace, "tracked.txt"), "second\n");
    return { ok: true, raw: {} };
  });
  const repaired = await runOneFactoryImplementationAction({
    ...coordinatorInput(fixture),
    linearIssue: "ENG-123",
    issueRef: "ENG-123",
    linearStatuses: LINEAR_SETTINGS.statuses,
    applyAdapter: fakeLinearAdapter({ applyImplementationAttention: repairedAttention }),
    agentProviderFactory: () => ({ name: "cursor", run: revisionProvider }),
  });
  expect(repaired.action).toMatchObject({ handler: "produceImplementationCandidate", attempt: 2 });
  expect(repaired.linearApplied).toBe(true);
  expect(repairedAttention).toHaveBeenCalledWith(
    expect.objectContaining({ verdict: "needs_changes" }),
  );
  expect(firstProvider).toHaveBeenCalledTimes(1);
  expect(revisionProvider).toHaveBeenCalledTimes(1);
  expect(readFactoryActionEvents(fixture.factoryStateRoot, fixture.key)).toHaveLength(
    before.length + 2,
  );
  expect(
    readFactoryActionEvents(fixture.factoryStateRoot, fixture.key).filter(
      (event) => event.type === "implementation.requested",
    ),
  ).toHaveLength(1);
  expect(
    readFactoryActionEvents(fixture.factoryStateRoot, fixture.key).filter(
      (event) => event.type === "implementation.review.completed",
    ),
  ).toHaveLength(1);
});

test("Linear attention is repaired before a selected same-candidate re-review", async () => {
  const fixture = directFixture();
  fixture.workItem.metadata = { linearStatus: "Ready to Implement" };
  const producer = vi.fn<Agent["run"]>(async () => {
    writeFileSync(join(fixture.workspace, "tracked.txt"), "candidate\n");
    return { ok: true, raw: {}, session: { provider: "cursor", id: "session-1" } };
  });
  await runOneFactoryImplementationAction({
    ...coordinatorInput(fixture),
    linearIssue: "ENG-123",
    issueRef: "ENG-123",
    linearStatuses: LINEAR_SETTINGS.statuses,
    applyAdapter: fakeLinearAdapter({
      applyImplementationStarted: async () => ({
        issueIdentifier: "ENG-123",
        runId: "run",
        runDir: "run",
        stage: "started",
        targetStatus: "Implementing",
      }),
    }),
    agentProviderFactory: () => ({ name: "cursor", run: producer }),
  });
  fixture.workItem.metadata = { linearStatus: "Implementing" };
  await runOneFactoryImplementationAction({
    ...coordinatorInput(fixture),
    linearIssue: "ENG-123",
    issueRef: "ENG-123",
    linearStatuses: LINEAR_SETTINGS.statuses,
    agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
    reviewRunner: (async (ctx: { runDir?: string }) => {
      writeBlockingReviews(ctx.runDir!);
      return fullReviewMeta("needs_changes");
    }) as never,
  });
  continueImplementation(fixture, "re-review", "The accepted live proof is now available.");
  const ordering: string[] = [];
  const reviewer = vi.fn(async (ctx: { runDir?: string }) => {
    ordering.push("review");
    writePassReviews(ctx.runDir!);
    return fullReviewMeta("pass");
  });
  const unexpectedProducer = vi.fn<Agent["run"]>();

  const completed = await runOneFactoryImplementationAction({
    ...coordinatorInput(fixture),
    linearIssue: "ENG-123",
    issueRef: "ENG-123",
    linearStatuses: LINEAR_SETTINGS.statuses,
    applyAdapter: fakeLinearAdapter({
      applyImplementationAttention: async () => {
        ordering.push("projection");
        return {
          issueIdentifier: "ENG-123",
          runId: "run",
          runDir: "run",
          stage: "completed",
          targetStatus: "Implementing",
        };
      },
    }),
    agentProviderFactory: () => ({ name: "cursor", run: unexpectedProducer }),
    reviewRunner: reviewer as never,
  });

  expect(ordering).toEqual(["projection", "review"]);
  expect(completed.action).toMatchObject({ handler: "reviewImplementationCandidate", attempt: 2 });
  expect(completed.next).toEqual({ kind: "wait", reason: "pr-publication" });
  expect(unexpectedProducer).not.toHaveBeenCalled();
  expect(producer).toHaveBeenCalledTimes(1);
});

test("tampered revision blockers are terminal before a second provider call", async () => {
  const fixture = directFixture();
  const first = await runOneFactoryImplementationAction({
    ...coordinatorInput(fixture),
    agentProviderFactory: () => ({
      name: "cursor",
      run: async () => {
        writeFileSync(join(fixture.workspace, "tracked.txt"), "first\n");
        return { ok: true, raw: {}, session: { provider: "cursor", id: "session-1" } };
      },
    }),
  });
  expect(first.action?.attempt).toBe(1);
  await runOneFactoryImplementationAction({
    ...coordinatorInput(fixture),
    agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
    reviewRunner: (async (ctx: { runDir?: string }) => {
      writeBlockingReviews(ctx.runDir!);
      return fullReviewMeta("needs_changes");
    }) as never,
  });
  const review = readFactoryActionEvents(fixture.factoryStateRoot, fixture.key).at(-1)!;
  if (review.type !== "implementation.review.completed" || !review.data.blockingFindings)
    throw new Error("review blockers missing");
  continueImplementation(fixture, "revise", "Apply the accepted blocking findings.");
  writeFileSync(
    verifyFactoryArtifactRef(review.data.blockingFindings, {
      "factory-store": fixture.store.projectRoot,
      repository: fixture.workspace,
    }),
    "[]\n",
  );
  const providerRun = vi.fn<Agent["run"]>();
  const result = await runOneFactoryImplementationAction({
    ...coordinatorInput(fixture),
    agentProviderFactory: () => ({ name: "cursor", run: providerRun }),
  });
  expect(providerRun).not.toHaveBeenCalled();
  expect(result.action).toMatchObject({ handler: "produceImplementationCandidate", attempt: 2 });
  expect(result.next).toEqual({ kind: "wait", reason: "human" });
  expect(readFactoryActionEvents(fixture.factoryStateRoot, fixture.key).at(-1)).toMatchObject({
    type: "factory.action.failed",
    data: { retainedCandidateEventId: expect.any(String) },
  });
});

test("tampered revision response retains a valid implementation candidate", async () => {
  const fixture = directFixture();
  const { ctx, candidate } = await produceCandidate(fixture);
  if (candidate.event.type !== "implementation.candidate.produced") throw new Error("candidate");
  const continued = continueImplementation(
    fixture,
    "revise",
    "Correct the implementation without abandoning the candidate.",
  );
  if (continued.event.type !== "factory.continuation.recorded") throw new Error("continuation");
  const responsePath = verifyFactoryArtifactRef(continued.event.data.response, {
    "factory-store": fixture.store.projectRoot,
    repository: fixture.workspace,
  });
  writeFileSync(responsePath, "Tampered response.\n");
  const provider = vi.fn<Agent["run"]>();

  const failed = await produceImplementationCandidate({
    ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction: invoke(continued),
    maxRuntimeMs: 0,
    agentProviderFactory: () => ({ name: "cursor", run: provider }),
  });

  expect(failed.event).toMatchObject({
    type: "factory.action.failed",
    data: { failureKind: "terminal", retainedCandidateEventId: candidate.event.id },
  });
  expect(failed.state).toMatchObject({
    status: "awaiting-continuation",
    candidateEventId: candidate.event.id,
  });
  expect(provider).not.toHaveBeenCalled();
});

test("tampered revision evidence clears reusable implementation identity", async () => {
  const fixture = directFixture();
  const { ctx, candidate } = await produceCandidate(fixture);
  if (candidate.event.type !== "implementation.candidate.produced") throw new Error("candidate");
  const continued = continueImplementation(fixture, "revise", "Correct the implementation.");
  const candidatePath = verifyFactoryArtifactRef(candidate.event.data.candidate, {
    "factory-store": fixture.store.projectRoot,
    repository: fixture.workspace,
  });
  writeFileSync(candidatePath, "{}\n");
  const provider = vi.fn<Agent["run"]>();

  const failed = await produceImplementationCandidate({
    ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction: invoke(continued),
    maxRuntimeMs: 0,
    agentProviderFactory: () => ({ name: "cursor", run: provider }),
  });

  expect(failed.event).toMatchObject({
    type: "factory.action.failed",
    data: { failureKind: "terminal" },
  });
  expect(failed.event.data).not.toHaveProperty("retainedCandidateEventId");
  expect(failed.state).toMatchObject({ status: "failed" });
  expect(failed.state).not.toHaveProperty("candidateEventId");
  expect(provider).not.toHaveBeenCalled();
});

test("implementation continuation accepts only the active Linear status", async () => {
  const fixture = directFixture();
  await produceCandidate(fixture);
  const events = readFactoryActionEvents(fixture.factoryStateRoot, fixture.key);
  const state = reduceFactoryLifecycleEvents(events);
  const latest = events.at(-1);

  expect(() =>
    assertLiveImplementationStatus(
      { ...fixture.workItem, metadata: { linearStatus: "Implementing" } },
      state,
      latest,
      false,
      LINEAR_SETTINGS.statuses,
    ),
  ).not.toThrow();
  expect(() =>
    assertLiveImplementationStatus(
      { ...fixture.workItem, metadata: { linearStatus: "Ready for Review" } },
      state,
      latest,
      false,
      LINEAR_SETTINGS.statuses,
    ),
  ).toThrow(/not valid for Factory implementation/);
});

test("revision workspace drift waits for a human before resuming the provider", async () => {
  const fixture = directFixture();
  await runOneFactoryImplementationAction({
    ...coordinatorInput(fixture),
    agentProviderFactory: () => ({
      name: "cursor",
      run: async () => {
        writeFileSync(join(fixture.workspace, "tracked.txt"), "candidate\n");
        return { ok: true, raw: {}, session: { provider: "cursor", id: "session-1" } };
      },
    }),
  });
  await runOneFactoryImplementationAction({
    ...coordinatorInput(fixture),
    agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
    reviewRunner: (async (ctx: { runDir?: string }) => {
      writeBlockingReviews(ctx.runDir!);
      return fullReviewMeta("needs_changes");
    }) as never,
  });
  continueImplementation(fixture, "revise", "Apply the accepted blocking findings.");
  writeFileSync(join(fixture.workspace, "tracked.txt"), "drift\n");
  const providerRun = vi.fn<Agent["run"]>();
  const result = await runOneFactoryImplementationAction({
    ...coordinatorInput(fixture),
    agentProviderFactory: () => ({ name: "cursor", run: providerRun }),
  });
  expect(providerRun).not.toHaveBeenCalled();
  expect(result.next).toEqual({ kind: "wait", reason: "human" });
});

test("retryable revision failure retries the same attempt with its original session and blockers", async () => {
  const fixture = directFixture();
  await runOneFactoryImplementationAction({
    ...coordinatorInput(fixture),
    agentProviderFactory: () => ({
      name: "cursor",
      run: async () => {
        writeFileSync(join(fixture.workspace, "tracked.txt"), "first\n");
        return { ok: true, raw: {}, session: { provider: "cursor", id: "session-1" } };
      },
    }),
  });
  await runOneFactoryImplementationAction({
    ...coordinatorInput(fixture),
    agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
    reviewRunner: (async (ctx: { runDir?: string }) => {
      writeBlockingReviews(ctx.runDir!);
      return fullReviewMeta("needs_changes");
    }) as never,
  });
  continueImplementation(fixture, "revise", "Apply the accepted blocking findings.");
  const failedProvider = vi.fn<Agent["run"]>(async (input) => {
    expect(input.session).toMatchObject({ id: "session-1" });
    expect(input.prompt).toContain("Correctness");
    return { ok: false, error: "temporary", exitCode: 1 };
  });
  const failed = await runOneFactoryImplementationAction({
    ...coordinatorInput(fixture),
    agentProviderFactory: () => ({ name: "cursor", run: failedProvider }),
  });
  expect(failed.action).toMatchObject({ handler: "produceImplementationCandidate", attempt: 2 });
  expect(failed.next).toMatchObject({
    kind: "invoke",
    handler: "produceImplementationCandidate",
    attempt: 2,
    scheduling: "retry",
  });

  const retriedProvider = vi.fn<Agent["run"]>(async (input) => {
    expect(input.session).toMatchObject({ id: "session-1" });
    expect(input.prompt).toContain("Clarity");
    writeFileSync(join(fixture.workspace, "tracked.txt"), "second\n");
    return { ok: true, raw: {} };
  });
  const retried = await runOneFactoryImplementationAction({
    ...coordinatorInput(fixture),
    agentProviderFactory: () => ({ name: "cursor", run: retriedProvider }),
  });
  expect(failedProvider).toHaveBeenCalledTimes(1);
  expect(retriedProvider).toHaveBeenCalledTimes(1);
  expect(retried.action).toMatchObject({ handler: "produceImplementationCandidate", attempt: 2 });
  expect(retried.next).toMatchObject({ handler: "reviewImplementationCandidate", attempt: 2 });
});

test("provider completion and candidate ref recover without a second provider call", async () => {
  const fixture = directFixture();
  const ctx = createPhase(fixture);
  const requested = appendRequest(fixture, ctx);
  const reaction = invoke(requested);
  const actionDir = actionPath(ctx, reaction);
  const providerRun = vi.fn<Agent["run"]>(async () => {
    writeFileSync(join(fixture.workspace, "tracked.txt"), "recovered\n");
    return {
      ok: true,
      raw: {},
      session: { provider: "cursor", id: "session-1" },
    };
  });
  const action = {
    ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction,
    maxRuntimeMs: 0,
    agentProviderFactory: () => ({ name: "cursor" as const, run: providerRun }),
    reviewHeadFactory: (input: Parameters<typeof createFactoryReviewHead>[0]) => {
      const head = createFactoryReviewHead(input);
      mkdirSync(join(actionDir, "action-result.json"), { recursive: true });
      return head;
    },
  };
  await expect(produceImplementationCandidate(action)).rejects.toThrow();
  expect(providerRun).toHaveBeenCalledTimes(1);
  rmSync(join(actionDir, "action-result.json"), { recursive: true });
  const recovered = await produceImplementationCandidate({
    ...action,
    reviewHeadFactory: undefined,
  });
  expect(providerRun).toHaveBeenCalledTimes(1);
  expect(recovered.event.type).toBe("implementation.candidate.produced");
});

test("successful candidate action-result recovers unchanged without rerunning the provider", async () => {
  const fixture = directFixture();
  const ctx = createPhase(fixture);
  const requested = appendRequest(fixture, ctx);
  const reaction = invoke(requested);
  const providerRun = vi.fn<Agent["run"]>(async () => {
    writeFileSync(join(fixture.workspace, "tracked.txt"), "candidate\n");
    return { ok: true, raw: {}, session: { provider: "cursor", id: "session-1" } };
  });
  await produceImplementationCandidate({
    ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction,
    maxRuntimeMs: 0,
    agentProviderFactory: () => ({ name: "cursor", run: providerRun }),
  });
  removeLastLifecycleEvent(fixture);
  const recovered = await produceImplementationCandidate({
    ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction,
    maxRuntimeMs: 0,
    agentProviderFactory: () => ({ name: "cursor", run: providerRun }),
  });
  expect(recovered.event.type).toBe("implementation.candidate.produced");
  expect(providerRun).toHaveBeenCalledTimes(1);
});

test.each(["current branch", "other current phase ref"] as const)(
  "successful candidate action-result recovery rejects %s drift without rerunning the provider",
  async (kind) => {
    const fixture = directFixture();
    const sibling = sharedWorktree(fixture.workspace);
    const ctx = createPhase(fixture);
    const requested = appendRequest(fixture, ctx);
    const reaction = invoke(requested);
    const providerRun = vi.fn<Agent["run"]>(async () => {
      writeFileSync(join(fixture.workspace, "tracked.txt"), "candidate\n");
      return { ok: true, raw: {}, session: { provider: "cursor", id: "session-1" } };
    });
    await produceImplementationCandidate({
      ctx,
      factoryStateRoot: fixture.factoryStateRoot,
      reaction,
      maxRuntimeMs: 0,
      agentProviderFactory: () => ({ name: "cursor", run: providerRun }),
    });
    removeLastLifecycleEvent(fixture);
    if (kind === "current branch") {
      git(sibling, ["commit", "--allow-empty", "-m", "recovery branch drift"]);
      git(sibling, [
        "update-ref",
        ctx.identity.branchRef,
        git(sibling, ["rev-parse", "HEAD"]).trim(),
        fixture.baseSha,
      ]);
    } else {
      git(sibling, ["update-ref", `refs/harness/factory/${ctx.runId}/other`, fixture.baseSha]);
    }
    await expect(
      produceImplementationCandidate({
        ctx,
        factoryStateRoot: fixture.factoryStateRoot,
        reaction,
        maxRuntimeMs: 0,
        agentProviderFactory: () => ({ name: "cursor", run: providerRun }),
      }),
    ).rejects.toThrow(/authority or workspace changed/);
    expect(providerRun).toHaveBeenCalledTimes(1);
  },
);

test("staged candidate recovery rejects same-status workspace drift without rerunning the provider", async () => {
  const fixture = directFixture();
  const ctx = createPhase(fixture);
  const requested = appendRequest(fixture, ctx);
  const reaction = invoke(requested);
  const actionDir = actionPath(ctx, reaction);
  const providerRun = vi.fn<Agent["run"]>(async () => {
    writeFileSync(join(fixture.workspace, "tracked.txt"), "first candidate\n");
    return { ok: true, raw: {}, session: { provider: "cursor", id: "session-1" } };
  });
  const action = {
    ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction,
    maxRuntimeMs: 0,
    agentProviderFactory: () => ({ name: "cursor" as const, run: providerRun }),
    reviewHeadFactory: (input: Parameters<typeof createFactoryReviewHead>[0]) => {
      const head = createFactoryReviewHead(input);
      mkdirSync(join(actionDir, "action-result.json"), { recursive: true });
      return head;
    },
  };
  await expect(produceImplementationCandidate(action)).rejects.toThrow();
  expect(providerRun).toHaveBeenCalledTimes(1);
  rmSync(join(actionDir, "action-result.json"), { recursive: true });
  rmSync(join(actionDir, "failure.json"), { force: true });
  writeFileSync(join(fixture.workspace, "tracked.txt"), "drifted candidate\n");

  const recovered = await produceImplementationCandidate({
    ...action,
    reviewHeadFactory: undefined,
  });
  expect(providerRun).toHaveBeenCalledTimes(1);
  expect(recovered.event).toMatchObject({
    type: "factory.action.failed",
    data: { failureKind: "human-required" },
  });
});

test("candidate recovery rejects a divergent create-only attempt ref", async () => {
  const fixture = directFixture();
  const ctx = createPhase(fixture);
  const requested = appendRequest(fixture, ctx);
  const reaction = invoke(requested);
  const candidate = await produceImplementationCandidate({
    ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction,
    maxRuntimeMs: 0,
    agentProviderFactory: () => ({
      name: "cursor",
      run: async () => {
        writeFileSync(join(fixture.workspace, "tracked.txt"), "candidate\n");
        return { ok: true, raw: {}, session: { provider: "cursor", id: "session-1" } };
      },
    }),
  });
  if (candidate.event.type !== "implementation.candidate.produced") throw new Error("candidate");
  removeLastLifecycleEvent(fixture);
  git(fixture.workspace, [
    "update-ref",
    `refs/harness/factory/${ctx.runId}/1`,
    fixture.baseSha,
    candidate.event.data.commit,
  ]);
  await expect(
    produceImplementationCandidate({
      ctx,
      factoryStateRoot: fixture.factoryStateRoot,
      reaction,
      maxRuntimeMs: 0,
      agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
    }),
  ).rejects.toThrow(/candidate ref conflicts/);
});

test("malformed staged provider evidence becomes a human-required action failure", async () => {
  const fixture = directFixture();
  const ctx = createPhase(fixture);
  const requested = appendRequest(fixture, ctx);
  const reaction = invoke(requested);
  const actionDir = actionPath(ctx, reaction);
  mkdirSync(actionDir, { recursive: true });
  writeFileSync(join(actionDir, "provider-result.json"), "{not-json\n");
  const providerRun = vi.fn<Agent["run"]>();
  const result = await produceImplementationCandidate({
    ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction,
    maxRuntimeMs: 0,
    agentProviderFactory: () => ({ name: "cursor", run: providerRun }),
  });
  expect(providerRun).not.toHaveBeenCalled();
  expect(result.event).toMatchObject({
    type: "factory.action.failed",
    data: { failureKind: "human-required" },
  });
});

test("post-provider Git probe failure records human-required without rerunning provider", async () => {
  const fixture = directFixture();
  const ctx = createPhase(fixture);
  const requested = appendRequest(fixture, ctx);
  const providerRun = vi.fn<Agent["run"]>(async () => {
    writeFileSync(join(fixture.workspace, "tracked.txt"), "implemented\n");
    git(fixture.workspace, ["checkout", "--detach"]);
    return { ok: true, raw: {}, session: { provider: "cursor", id: "session-1" } };
  });
  const result = await produceImplementationCandidate({
    ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction: invoke(requested),
    maxRuntimeMs: 0,
    agentProviderFactory: () => ({ name: "cursor", run: providerRun }),
  });
  expect(providerRun).toHaveBeenCalledTimes(1);
  expect(result.event).toMatchObject({
    type: "factory.action.failed",
    data: { failureKind: "human-required" },
  });
});

test("unrelated tag movement remains diagnostic during implementation", async () => {
  const fixture = directFixture();
  const ctx = createPhase(fixture);
  const requested = appendRequest(fixture, ctx);
  const result = await produceImplementationCandidate({
    ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction: invoke(requested),
    maxRuntimeMs: 0,
    agentProviderFactory: () => ({
      name: "cursor",
      run: async () => {
        writeFileSync(join(fixture.workspace, "tracked.txt"), "implemented\n");
        git(fixture.workspace, ["tag", "implementer-mutated-ref"]);
        return { ok: true, raw: {}, session: { provider: "cursor", id: "session-1" } };
      },
    }),
  });
  expect(result.event.type).toBe("implementation.candidate.produced");
});

test("shared-repository ambient refs preserve a valid implementation candidate and raw evidence", async () => {
  const fixture = directFixture();
  const sibling = sharedWorktree(fixture.workspace);
  const ctx = createPhase(fixture);
  const requested = appendRequest(fixture, ctx);
  const reaction = invoke(requested);
  const result = await produceImplementationCandidate({
    ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction,
    maxRuntimeMs: 0,
    agentProviderFactory: () => ({
      name: "cursor",
      run: async () => {
        writeFileSync(join(fixture.workspace, "tracked.txt"), "implemented\n");
        git(sibling, ["commit", "--allow-empty", "-m", "ambient branch movement"]);
        git(sibling, ["update-ref", "refs/private/ambient", fixture.baseSha]);
        return { ok: true, raw: {}, session: { provider: "cursor", id: "session-1" } };
      },
    }),
  });
  expect(result.event.type).toBe("implementation.candidate.produced");
  const staged = JSON.parse(
    readFileSync(join(actionPath(ctx, reaction), "provider-result.json"), "utf8"),
  ) as { before: { refs: string }; after: { refs: string } };
  expect(staged.before.refs).not.toContain("refs/private/ambient");
  expect(staged.after.refs).toContain("refs/private/ambient");
  expect(staged.before.refs).not.toBe(staged.after.refs);
});

test("implementer current phase ref movement becomes human-required", async () => {
  const fixture = directFixture();
  const sibling = sharedWorktree(fixture.workspace);
  const ctx = createPhase(fixture);
  const phaseRef = `refs/harness/factory/${ctx.runId}/prior`;
  git(sibling, ["update-ref", phaseRef, fixture.baseSha]);
  const requested = appendRequest(fixture, ctx);
  const result = await produceImplementationCandidate({
    ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction: invoke(requested),
    maxRuntimeMs: 0,
    agentProviderFactory: () => ({
      name: "cursor",
      run: async () => {
        writeFileSync(join(fixture.workspace, "tracked.txt"), "implemented\n");
        git(sibling, ["commit", "--allow-empty", "-m", "phase ref target"]);
        git(sibling, ["update-ref", phaseRef, git(sibling, ["rev-parse", "HEAD"]).trim()]);
        return { ok: true, raw: {}, session: { provider: "cursor", id: "session-1" } };
      },
    }),
  });
  expect(result.event).toMatchObject({
    type: "factory.action.failed",
    data: { failureKind: "human-required" },
  });
});

test("implementer current branch movement becomes human-required", async () => {
  const fixture = directFixture();
  const sibling = sharedWorktree(fixture.workspace);
  const ctx = createPhase(fixture);
  const requested = appendRequest(fixture, ctx);
  const result = await produceImplementationCandidate({
    ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction: invoke(requested),
    maxRuntimeMs: 0,
    agentProviderFactory: () => ({
      name: "cursor",
      run: async () => {
        writeFileSync(join(fixture.workspace, "tracked.txt"), "implemented\n");
        git(sibling, ["commit", "--allow-empty", "-m", "branch ref target"]);
        git(sibling, [
          "update-ref",
          ctx.identity.branchRef,
          git(sibling, ["rev-parse", "HEAD"]).trim(),
          fixture.baseSha,
        ]);
        return { ok: true, raw: {}, session: { provider: "cursor", id: "session-1" } };
      },
    }),
  });
  expect(result.event).toMatchObject({
    type: "factory.action.failed",
    data: { failureKind: "human-required" },
  });
});

test("ambient private ref churn keeps an otherwise unchanged provider failure retryable", async () => {
  const fixture = directFixture();
  const sibling = sharedWorktree(fixture.workspace);
  const ctx = createPhase(fixture);
  const requested = appendRequest(fixture, ctx);
  const result = await produceImplementationCandidate({
    ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction: invoke(requested),
    maxRuntimeMs: 0,
    agentProviderFactory: () => ({
      name: "cursor",
      run: async () => {
        git(sibling, ["update-ref", "refs/private/failure", fixture.baseSha]);
        return { ok: false, error: "temporary", exitCode: 1 };
      },
    }),
  });
  expect(result.event).toMatchObject({
    type: "factory.action.failed",
    data: { failureKind: "retryable" },
  });
});

test("implementation candidate retry ceiling stops after the third execution", async () => {
  const fixture = directFixture();
  const ctx = createPhase(fixture);
  let current = appendRequest(fixture, ctx);
  const providerRun = vi.fn<Agent["run"]>(async () => ({
    ok: false,
    error: "temporary",
    exitCode: 1,
  }));

  for (let execution = 1; execution <= 3; execution += 1) {
    const result = await produceImplementationCandidate({
      ctx,
      factoryStateRoot: fixture.factoryStateRoot,
      reaction: invoke(current),
      maxRuntimeMs: 0,
      agentProviderFactory: () => ({ name: "cursor", run: providerRun }),
    });
    expect(result.event).toMatchObject({
      type: "factory.action.failed",
      data: {
        failureKind: execution < 3 ? "retryable" : "human-required",
        ...(execution === 3 ? { message: expect.stringContaining("limit 3") } : {}),
      },
    });
    current = result;
  }

  expect(providerRun).toHaveBeenCalledTimes(3);
  expect(decideNextFactoryAction(current.state, current.event)).toEqual({
    kind: "wait",
    reason: "human",
  });
});

test("staged passing review recovers after branch promotion without rerunning reviewers", async () => {
  const fixture = directFixture();
  const ctx = createPhase(fixture);
  const requested = appendRequest(fixture, ctx);
  const candidate = await produceImplementationCandidate({
    ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction: invoke(requested),
    maxRuntimeMs: 0,
    agentProviderFactory: () => ({
      name: "cursor",
      run: async () => {
        writeFileSync(join(fixture.workspace, "tracked.txt"), "candidate\n");
        return { ok: true, raw: {}, session: { provider: "cursor", id: "session-1" } };
      },
    }),
  });
  const reaction = invoke(candidate);
  const actionDir = actionPath(ctx, reaction);
  const reviewRunner = vi.fn(async (reviewCtx: { runDir?: string }) => {
    writePassReviews(reviewCtx.runDir!);
    mkdirSync(join(actionDir, "action-result.json"), { recursive: true });
    return fullReviewMeta("pass");
  });
  const action = {
    ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction,
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({ name: "cursor" as const, run: vi.fn<Agent["run"]>() }),
    reviewRunner: reviewRunner as never,
  };
  await expect(reviewImplementationCandidate(action)).rejects.toThrow();
  if (candidate.event.type !== "implementation.candidate.produced") throw new Error("candidate");
  expect(git(fixture.workspace, ["rev-parse", "HEAD"]).trim()).toBe(candidate.event.data.commit);
  rmSync(join(actionDir, "action-result.json"), { recursive: true });
  const recovered = await reviewImplementationCandidate(action);
  expect(reviewRunner).toHaveBeenCalledTimes(1);
  expect(recovered.state).toMatchObject({ status: "awaiting-pr-publication" });
});

test("successful review action-result recovers unchanged without rerunning reviewers", async () => {
  const fixture = directFixture();
  const { ctx, candidate } = await produceCandidate(fixture);
  const reaction = invoke(candidate);
  const reviewRunner = vi.fn(async (reviewCtx: { runDir?: string }) => {
    writePassReviews(reviewCtx.runDir!);
    return fullReviewMeta("pass");
  });
  await reviewImplementationCandidate({
    ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction,
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
    reviewRunner: reviewRunner as never,
  });
  removeLastLifecycleEvent(fixture);
  const recovered = await reviewImplementationCandidate({
    ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction,
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
    reviewRunner: reviewRunner as never,
  });
  expect(recovered.event.type).toBe("implementation.review.completed");
  expect(reviewRunner).toHaveBeenCalledTimes(1);
});

test("successful needs_changes action-result recovers unchanged without rerunning reviewers", async () => {
  const fixture = directFixture();
  const { ctx, candidate } = await produceCandidate(fixture);
  const reaction = invoke(candidate);
  const reviewRunner = vi.fn(async (reviewCtx: { runDir?: string }) => {
    writeBlockingReviews(reviewCtx.runDir!);
    return fullReviewMeta("needs_changes");
  });
  await reviewImplementationCandidate({
    ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction,
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
    reviewRunner: reviewRunner as never,
  });
  removeLastLifecycleEvent(fixture);
  const recovered = await reviewImplementationCandidate({
    ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction,
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
    reviewRunner: reviewRunner as never,
  });
  expect(recovered.event).toMatchObject({
    type: "implementation.review.completed",
    data: { verdict: "needs_changes" },
  });
  expect(reviewRunner).toHaveBeenCalledTimes(1);
});

test("needs_changes action-result recovery rejects an externally promoted candidate", async () => {
  const fixture = directFixture();
  const sibling = sharedWorktree(fixture.workspace);
  const { ctx, candidate } = await produceCandidate(fixture);
  if (candidate.event.type !== "implementation.candidate.produced") throw new Error("candidate");
  const reaction = invoke(candidate);
  const reviewRunner = vi.fn(async (reviewCtx: { runDir?: string }) => {
    writeBlockingReviews(reviewCtx.runDir!);
    return fullReviewMeta("needs_changes");
  });
  await reviewImplementationCandidate({
    ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction,
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
    reviewRunner: reviewRunner as never,
  });
  removeLastLifecycleEvent(fixture);
  git(sibling, [
    "update-ref",
    ctx.identity.branchRef,
    candidate.event.data.commit,
    fixture.baseSha,
  ]);
  await expect(
    reviewImplementationCandidate({
      ctx,
      factoryStateRoot: fixture.factoryStateRoot,
      reaction,
      maxRuntimeMs: 1_000,
      agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
      reviewRunner: reviewRunner as never,
    }),
  ).rejects.toThrow(/authority changed/);
  expect(reviewRunner).toHaveBeenCalledTimes(1);
});

test.each(["current branch", "other current phase ref"] as const)(
  "successful review action-result recovery rejects %s drift without rerunning reviewers",
  async (kind) => {
    const fixture = directFixture();
    const sibling = sharedWorktree(fixture.workspace);
    const { ctx, candidate } = await produceCandidate(fixture);
    if (candidate.event.type !== "implementation.candidate.produced") throw new Error("candidate");
    const reaction = invoke(candidate);
    const reviewRunner = vi.fn(async (reviewCtx: { runDir?: string }) => {
      writePassReviews(reviewCtx.runDir!);
      return fullReviewMeta("pass");
    });
    await reviewImplementationCandidate({
      ctx,
      factoryStateRoot: fixture.factoryStateRoot,
      reaction,
      maxRuntimeMs: 1_000,
      agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
      reviewRunner: reviewRunner as never,
    });
    removeLastLifecycleEvent(fixture);
    if (kind === "current branch") {
      git(sibling, ["commit", "--allow-empty", "-m", "review recovery branch drift"]);
      git(sibling, [
        "update-ref",
        ctx.identity.branchRef,
        git(sibling, ["rev-parse", "HEAD"]).trim(),
        candidate.event.data.commit,
      ]);
    } else {
      git(sibling, ["update-ref", `refs/harness/factory/${ctx.runId}/other`, fixture.baseSha]);
    }
    await expect(
      reviewImplementationCandidate({
        ctx,
        factoryStateRoot: fixture.factoryStateRoot,
        reaction,
        maxRuntimeMs: 1_000,
        agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
        reviewRunner: reviewRunner as never,
      }),
    ).rejects.toThrow(/branch base changed|authority changed/);
    expect(reviewRunner).toHaveBeenCalledTimes(1);
  },
);

test("phase creation rejects dirty and detached workspaces before provider work", () => {
  const dirty = directFixture();
  writeFileSync(join(dirty.workspace, "tracked.txt"), "dirty\n");
  expect(() => createPhase(dirty)).toThrow(/clean workspace/);

  const detached = directFixture();
  git(detached.workspace, ["checkout", "--detach"]);
  expect(() => createPhase(detached)).toThrow(/attached branch/);
});

test("phase start snapshots workspace HEAD independently of the configured base ref", () => {
  const fixture = directFixture();
  git(fixture.workspace, ["switch", "-c", "codex/implementation"]);
  git(fixture.workspace, ["commit", "--allow-empty", "-m", "accepted baseline"]);
  const acceptedBase = git(fixture.workspace, ["rev-parse", "HEAD"]).trim();

  const ctx = createPhase(fixture);

  expect(ctx.identity).toMatchObject({
    baseRef: "main",
    baseSha: acceptedBase,
    branchRef: "refs/heads/codex/implementation",
  });
  expect(git(fixture.workspace, ["rev-parse", "main"]).trim()).toBe(fixture.baseSha);
});

test("planned input requires reviewed plan bytes committed at the implementation base", () => {
  const fixture = directFixture();
  mkdirSync(join(fixture.workspace, "dev/plans"), { recursive: true });
  writeFileSync(join(fixture.workspace, "dev/plans/item.md"), "# Reviewed\n");
  git(fixture.workspace, ["add", "dev/plans/item.md"]);
  git(fixture.workspace, ["commit", "-m", "Add reviewed plan"]);
  const candidatePath = join(fixture.store.projectRoot, "input", "candidate.md");
  writeFileSync(candidatePath, "# Reviewed\n");
  const planCandidate = createFactoryArtifactRef({
    base: "factory-store",
    root: fixture.store.projectRoot,
    path: relative(fixture.store.projectRoot, candidatePath),
  });
  const create = () =>
    createFactoryImplementationRunContext({
      workspace: fixture.workspace,
      runsDir: fixture.store.factoryRunsDir,
      workItem: fixture.workItem,
      factoryStore: fixture.store,
      implementationInput: {
        mode: "planned",
        importedEventId: "import:item-1",
        workItem: fixture.workItemRef,
        candidateEventId: "planning.candidate:1",
        reviewEventId: "planning.review:1",
        planCandidate,
        outputPlan: "dev/plans/item.md",
        publicationMode: "local",
      },
      implementerRole: { agent: "cursor", model: "implementer" },
      reviewerRole: { agent: "cursor", model: "reviewer" },
    });
  expect(create().identity.input).toMatchObject({
    mode: "planned",
    outputPlan: "dev/plans/item.md",
  });
  writeFileSync(candidatePath, "# Tampered\n");
  expect(create).toThrow(/hash mismatch/);
});

test("phase snapshots the immutable requested work item instead of changed same-key input", () => {
  const fixture = directFixture();
  fixture.workItem.body = "Changed after triage";
  const ctx = createPhase(fixture);
  expect(ctx.workItem.body).toBe("Change tracked.txt");
  expect(ctx.identity.input.workItem).toEqual(fixture.workItemRef);
});

test("phase reopen ignores same-key tampering of its audit work-item copy", () => {
  const fixture = directFixture();
  const ctx = createPhase(fixture);
  writeFileSync(
    join(ctx.runDir, "context/work-item.json"),
    `${JSON.stringify({ ...fixture.workItem, title: "Tampered", body: "Different task" })}\n`,
  );
  const reopened = openFactoryImplementationRunContext({
    workspace: fixture.workspace,
    runsDir: fixture.store.factoryRunsDir,
    phaseRunId: ctx.runId,
    workItem: fixture.workItem,
    factoryStore: fixture.store,
  });
  expect(reopened.workItem).toMatchObject({ title: "Implement item", body: "Change tracked.txt" });
});

test("phase rejects an implementation identity missing baseRef", () => {
  const fixture = directFixture();
  const ctx = createPhase(fixture);
  const identityPath = join(ctx.runDir, "context/phase-run.json");
  const current = JSON.parse(readFileSync(identityPath, "utf8")) as Record<string, unknown>;
  const { baseRef, ...missingBaseRef } = current;
  expect(baseRef).toBe("main");
  writeFileSync(identityPath, `${JSON.stringify(missingBaseRef, null, 2)}\n`);

  expect(() =>
    openFactoryImplementationRunContext({
      workspace: fixture.workspace,
      runsDir: fixture.store.factoryRunsDir,
      phaseRunId: ctx.runId,
      workItem: fixture.workItem,
      factoryStore: fixture.store,
    }),
  ).toThrow();
});

test("uncertain candidate materialization failure becomes human-required", async () => {
  const fixture = directFixture();
  const ctx = createPhase(fixture);
  const requested = appendRequest(fixture, ctx);
  const result = await produceImplementationCandidate({
    ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction: invoke(requested),
    maxRuntimeMs: 0,
    agentProviderFactory: () => ({
      name: "cursor",
      run: async () => {
        writeFileSync(join(fixture.workspace, "tracked.txt"), "implemented\n");
        return { ok: true, raw: {}, session: { provider: "cursor", id: "session-1" } };
      },
    }),
    reviewHeadFactory: () => {
      throw new FactoryReviewHeadError("injected Git probe failure", { kind: "git" });
    },
  });
  expect(result.event).toMatchObject({
    type: "factory.action.failed",
    data: { failureKind: "human-required" },
  });
});

test("blank provider session becomes human-required without candidate success", async () => {
  const fixture = directFixture();
  const ctx = createPhase(fixture);
  const requested = appendRequest(fixture, ctx);
  const result = await produceImplementationCandidate({
    ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction: invoke(requested),
    maxRuntimeMs: 0,
    agentProviderFactory: () => ({
      name: "cursor",
      run: async () => {
        writeFileSync(join(fixture.workspace, "tracked.txt"), "implemented\n");
        return { ok: true, raw: {}, session: { provider: "cursor", id: "   " } };
      },
    }),
  });
  expect(result.event).toMatchObject({
    type: "factory.action.failed",
    data: { failureKind: "human-required" },
  });
  expect(git(fixture.workspace, ["for-each-ref", "refs/harness"]).trim()).toBe("");
});

test("wrong-provider implementer session becomes human-required without candidate success", async () => {
  const fixture = directFixture();
  const ctx = createPhase(fixture);
  const requested = appendRequest(fixture, ctx);
  const result = await produceImplementationCandidate({
    ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction: invoke(requested),
    maxRuntimeMs: 0,
    agentProviderFactory: () => ({
      name: "cursor",
      run: async () => {
        writeFileSync(join(fixture.workspace, "tracked.txt"), "implemented\n");
        return { ok: true, raw: {}, session: { provider: "codex", id: "wrong-provider" } };
      },
    }),
  });
  expect(result.event).toMatchObject({
    type: "factory.action.failed",
    data: { failureKind: "human-required" },
  });
  expect(git(fixture.workspace, ["for-each-ref", "refs/harness"]).trim()).toBe("");
});

test("needs_changes waits for an explicit continuation and preserves all blockers", async () => {
  const fixture = directFixture();
  const ctx = createPhase(fixture);
  const requested = appendRequest(fixture, ctx);
  const candidate = await produceImplementationCandidate({
    ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction: invoke(requested),
    maxRuntimeMs: 0,
    agentProviderFactory: () => ({
      name: "cursor",
      run: async () => {
        writeFileSync(join(fixture.workspace, "tracked.txt"), "candidate\n");
        return { ok: true, raw: {}, session: { provider: "cursor", id: "session-1" } };
      },
    }),
  });
  const reviewed = await reviewImplementationCandidate({
    ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction: invoke(candidate),
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
    reviewRunner: (async (reviewCtx: { runDir?: string }) => {
      writeBlockingReviews(reviewCtx.runDir!);
      return fullReviewMeta("needs_changes");
    }) as never,
  });
  expect(reviewed.state).toMatchObject({ status: "awaiting-continuation" });
  expect(git(fixture.workspace, ["rev-parse", "HEAD"]).trim()).toBe(fixture.baseSha);
  if (reviewed.event.type !== "implementation.review.completed") throw new Error("review");
  const blockingPath = verifyFactoryArtifactRef(reviewed.event.data.blockingFindings!, {
    "factory-store": fixture.store.projectRoot,
    repository: fixture.workspace,
  });
  const blocking = JSON.parse(readFileSync(blockingPath, "utf8"));
  expect(blocking.map((finding: { id: string }) => finding.id)).toEqual([
    "implementation-1",
    "quality-1",
  ]);
});

test("blocked implementation review waits for a human", async () => {
  const fixture = directFixture();
  const { ctx, candidate } = await produceCandidate(fixture);
  const reviewed = await reviewImplementationCandidate({
    ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction: invoke(candidate),
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
    reviewRunner: (async (reviewCtx: { runDir?: string }) => {
      writeBlockedReviews(reviewCtx.runDir!);
      return fullReviewMeta("blocked");
    }) as never,
  });
  expect(reviewed.state).toMatchObject({ status: "awaiting-continuation" });
  expect(decideNextFactoryAction(reviewed.state, reviewed.event)).toEqual({
    kind: "wait",
    reason: "human",
  });
  const continued = continueImplementation(
    fixture,
    "re-review",
    "The blocked reviewer dependency is now available.",
  );
  const secondReview = vi.fn(async (reviewCtx: { runDir?: string }) => {
    const handoff = readFileSync(join(reviewCtx.runDir!, "context/handoff.md"), "utf8");
    expect(handoff).toContain("Prior implementation review");
    expect(handoff).toContain('"verdict": "blocked"');
    expect(handoff).toContain("The blocked reviewer dependency is now available.");
    writePassReviews(reviewCtx.runDir!);
    return fullReviewMeta("pass");
  });
  const passed = await reviewImplementationCandidate({
    ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction: invoke(continued),
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
    reviewRunner: secondReview as never,
  });
  expect(secondReview).toHaveBeenCalledOnce();
  expect(passed.state).toMatchObject({ status: "awaiting-pr-publication" });
});

test("review recovery rejects tampered blocking findings", async () => {
  const fixture = directFixture();
  const { ctx, candidate } = await produceCandidate(fixture);
  const reaction = invoke(candidate);
  const reviewed = await reviewImplementationCandidate({
    ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction,
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
    reviewRunner: (async (reviewCtx: { runDir?: string }) => {
      writeBlockingReviews(reviewCtx.runDir!);
      return fullReviewMeta("needs_changes");
    }) as never,
  });
  if (reviewed.event.type !== "implementation.review.completed") throw new Error("review");
  const blocking = verifyFactoryArtifactRef(reviewed.event.data.blockingFindings!, {
    "factory-store": fixture.store.projectRoot,
    repository: fixture.workspace,
  });
  removeLastLifecycleEvent(fixture);
  writeFileSync(blocking, "[]\n");
  await expect(
    reviewImplementationCandidate({
      ctx,
      factoryStateRoot: fixture.factoryStateRoot,
      reaction,
      maxRuntimeMs: 1_000,
      agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
      reviewRunner: vi.fn() as never,
    }),
  ).rejects.toThrow(/hash mismatch/);
});

test.each(["symbolic-ref", "base-sha"] as const)(
  "review rejects %s branch drift without running reviewers",
  async (kind) => {
    const fixture = directFixture();
    const { ctx, candidate } = await produceCandidate(fixture);
    if (kind === "symbolic-ref") git(fixture.workspace, ["switch", "-c", "other"]);
    else {
      git(fixture.workspace, ["commit", "--allow-empty", "-m", "branch drift"]);
    }
    const reviewRunner = vi.fn();
    const reviewed = await reviewImplementationCandidate({
      ctx,
      factoryStateRoot: fixture.factoryStateRoot,
      reaction: invoke(candidate),
      maxRuntimeMs: 1_000,
      agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
      reviewRunner: reviewRunner as never,
    });
    expect(reviewRunner).not.toHaveBeenCalled();
    expect(reviewed.event).toMatchObject({
      type: "factory.action.failed",
      data: { failureKind: "human-required" },
    });
  },
);

test.each([
  { name: "partial set", meta: { ...fullReviewMeta("pass"), partial: true }, kind: "terminal" },
  {
    name: "failed reviewer",
    meta: failedReviewMeta("implementation", "pass"),
    kind: "retryable",
  },
] as const)("$name review result becomes an action failure", async ({ meta, kind }) => {
  const fixture = directFixture();
  const { ctx, candidate } = await produceCandidate(fixture);
  const reviewed = await reviewImplementationCandidate({
    ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction: invoke(candidate),
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
    reviewRunner: (async (reviewCtx: { runDir?: string }) => {
      if (meta.status === "failed")
        writeReviewRole(reviewCtx.runDir!, "implementation", passReview());
      else writePassReviews(reviewCtx.runDir!);
      return meta;
    }) as never,
  });
  expect(reviewed.event).toMatchObject({
    type: "factory.action.failed",
    data: { failureKind: kind },
  });
});

test("malformed staged review evidence becomes a terminal action failure", async () => {
  const fixture = directFixture();
  const { ctx, candidate } = await produceCandidate(fixture);
  const reaction = invoke(candidate);
  const actionDir = actionPath(ctx, reaction);
  mkdirSync(actionDir, { recursive: true });
  writeFileSync(join(actionDir, "review-result.json"), "{not-json\n");
  const reviewRunner = vi.fn();
  const reviewed = await reviewImplementationCandidate({
    ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction,
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
    reviewRunner: reviewRunner as never,
  });
  expect(reviewRunner).not.toHaveBeenCalled();
  expect(reviewed.event).toMatchObject({
    type: "factory.action.failed",
    data: { failureKind: "terminal" },
  });
});

test.each(["before", "during"] as const)(
  "review rejects workspace mutation $name review",
  async (timing) => {
    const fixture = directFixture();
    const { ctx, candidate } = await produceCandidate(fixture);
    if (timing === "before") writeFileSync(join(fixture.workspace, "tracked.txt"), "tampered\n");
    const reviewed = await reviewImplementationCandidate({
      ctx,
      factoryStateRoot: fixture.factoryStateRoot,
      reaction: invoke(candidate),
      maxRuntimeMs: 1_000,
      agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
      reviewRunner: (async (reviewCtx: { runDir?: string }) => {
        writePassReviews(reviewCtx.runDir!);
        if (timing === "during")
          writeFileSync(join(fixture.workspace, "tracked.txt"), "reviewer mutation\n");
        return fullReviewMeta("pass");
      }) as never,
    });
    expect(reviewed.event).toMatchObject({
      type: "factory.action.failed",
      data: {
        failureKind: "human-required",
        retainedCandidateEventId: expect.any(String),
      },
    });
  },
);

test("review rejects staged-only index drift before invoking reviewers", async () => {
  const fixture = directFixture();
  const { ctx, candidate } = await produceCandidate(fixture);
  git(fixture.workspace, ["add", "tracked.txt"]);
  const reviewRunner = vi.fn();
  const reviewed = await reviewImplementationCandidate({
    ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction: invoke(candidate),
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
    reviewRunner: reviewRunner as never,
  });
  expect(reviewRunner).not.toHaveBeenCalled();
  expect(reviewed.event.type).toBe("factory.action.failed");
});

test("shared-repository ambient refs remain diagnostic during review", async () => {
  const fixture = directFixture();
  const sibling = sharedWorktree(fixture.workspace);
  const { ctx, candidate } = await produceCandidate(fixture);
  const reaction = invoke(candidate);
  const reviewed = await reviewImplementationCandidate({
    ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction,
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
    reviewRunner: (async (reviewCtx: { runDir?: string }) => {
      writePassReviews(reviewCtx.runDir!);
      git(sibling, ["commit", "--allow-empty", "-m", "ambient review movement"]);
      git(sibling, ["update-ref", "refs/private/reviewer", fixture.baseSha]);
      return fullReviewMeta("pass");
    }) as never,
  });
  expect(reviewed.event.type).toBe("implementation.review.completed");
  const staged = JSON.parse(
    readFileSync(join(actionPath(ctx, reaction), "review-result.json"), "utf8"),
  ) as { refsBefore: string; refsAfter: string };
  expect(staged.refsBefore).not.toContain("refs/private/reviewer");
  expect(staged.refsAfter).toContain("refs/private/reviewer");
  expect(staged.refsBefore).not.toBe(staged.refsAfter);
});

test.each(["current branch", "current phase ref"] as const)(
  "reviewer %s movement becomes human-required",
  async (kind) => {
    const fixture = directFixture();
    const sibling = sharedWorktree(fixture.workspace);
    const { ctx, candidate } = await produceCandidate(fixture);
    if (candidate.event.type !== "implementation.candidate.produced") throw new Error("candidate");
    const candidateCommit = candidate.event.data.commit;
    const reviewed = await reviewImplementationCandidate({
      ctx,
      factoryStateRoot: fixture.factoryStateRoot,
      reaction: invoke(candidate),
      maxRuntimeMs: 1_000,
      agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
      reviewRunner: (async (reviewCtx: { runDir?: string }) => {
        writePassReviews(reviewCtx.runDir!);
        if (kind === "current branch") {
          git(sibling, ["commit", "--allow-empty", "-m", "review branch target"]);
          git(sibling, [
            "update-ref",
            ctx.identity.branchRef,
            git(sibling, ["rev-parse", "HEAD"]).trim(),
            fixture.baseSha,
          ]);
        } else {
          git(sibling, [
            "update-ref",
            `refs/harness/factory/${ctx.runId}/1`,
            fixture.baseSha,
            candidateCommit,
          ]);
        }
        return fullReviewMeta("pass");
      }) as never,
    });
    expect(reviewed.event).toMatchObject({
      type: "factory.action.failed",
      data: { failureKind: "human-required" },
    });
  },
);

test.each(["implementation", "quality"] as const)(
  "retryable %s counterpart failure resumes only the missing role after restart",
  async (successfulRole) => {
    const fixture = directFixture();
    const { ctx, candidate } = await produceCandidate(fixture);
    const missingRole = successfulRole === "implementation" ? "quality" : "implementation";
    const reviewRunner = vi.fn<
      (
        reviewCtx: { runDir?: string },
        options: { steps?: Array<"implementation" | "quality"> },
      ) => Promise<unknown>
    >(
      async (
        reviewCtx: { runDir?: string },
        options: { steps?: Array<"implementation" | "quality"> },
      ) => {
        expect(options.steps).toEqual([missingRole]);
        writeReviewRole(reviewCtx.runDir!, missingRole, passReview());
        return subsetReviewMeta(missingRole, "pass");
      },
    );
    reviewRunner.mockImplementationOnce(
      async (
        reviewCtx: { runDir?: string },
        options: { steps?: Array<"implementation" | "quality"> },
      ) => {
        expect(options.steps).toEqual(["implementation", "quality"]);
        writeReviewRole(reviewCtx.runDir!, successfulRole, passReview());
        return failedReviewMeta(successfulRole, "pass");
      },
    );
    const first = await reviewImplementationCandidate({
      ctx,
      factoryStateRoot: fixture.factoryStateRoot,
      reaction: invoke(candidate),
      maxRuntimeMs: 1_000,
      agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
      reviewRunner: reviewRunner as never,
    });
    expect(() =>
      continueImplementation(fixture, "revise", "Do not bypass the pending review retry."),
    ).toThrow(/no candidate awaiting continuation/);
    expect(decideNextFactoryAction(first.state, first.event)).toMatchObject({
      handler: "reviewImplementationCandidate",
      attempt: 1,
      scheduling: "retry",
    });
    if (first.event.type !== "factory.action.failed") throw new Error("retry failure missing");
    expect(first.event.data.evidence).toHaveLength(2);
    const reopened = openFactoryImplementationRunContext({
      workspace: fixture.workspace,
      runsDir: fixture.store.factoryRunsDir,
      phaseRunId: ctx.runId,
      workItem: fixture.workItem,
      factoryStore: fixture.store,
    });
    const second = await reviewImplementationCandidate({
      ctx: reopened,
      factoryStateRoot: fixture.factoryStateRoot,
      reaction: invoke(first),
      maxRuntimeMs: 1_000,
      agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
      reviewRunner: reviewRunner as never,
    });
    expect(reviewRunner).toHaveBeenCalledTimes(2);
    expect(second.event).toMatchObject({ type: "implementation.review.completed" });
    expect(second.state).toMatchObject({
      status: "awaiting-pr-publication",
      reviewedHead:
        candidate.event.type === "implementation.candidate.produced"
          ? candidate.event.data.commit
          : undefined,
    });
  },
);

test("implementation review retry ceiling retains the candidate and requires a human", async () => {
  const fixture = directFixture();
  const { ctx, candidate } = await produceCandidate(fixture);
  const reviewRunner = vi.fn<
    (
      reviewCtx: { runDir?: string },
      options: { steps?: Array<"implementation" | "quality"> },
    ) => Promise<unknown>
  >(async (_reviewCtx, options) => ({
    status: "failed",
    workflow: "change-review",
    availableSteps: ["implementation", "quality"],
    requestedSteps: options.steps,
    executedSteps: [],
    omittedSteps: [],
    partial: false,
    reviews: {},
  }));
  const actionInput = {
    ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({ name: "cursor" as const, run: vi.fn<Agent["run"]>() }),
    reviewRunner: reviewRunner as never,
  };

  const first = await reviewImplementationCandidate({
    ...actionInput,
    reaction: invoke(candidate),
  });
  const second = await reviewImplementationCandidate({
    ...actionInput,
    reaction: invoke(first),
  });
  const third = await reviewImplementationCandidate({
    ...actionInput,
    reaction: invoke(second),
  });

  expect(first.event).toMatchObject({
    type: "factory.action.failed",
    data: { failureKind: "retryable", retainedCandidateEventId: candidate.event.id },
  });
  expect(second.event).toMatchObject({
    type: "factory.action.failed",
    data: { failureKind: "retryable", retainedCandidateEventId: candidate.event.id },
  });
  expect(third.event).toMatchObject({
    type: "factory.action.failed",
    data: {
      failureKind: "human-required",
      message: expect.stringContaining("limit 3"),
      retainedCandidateEventId: candidate.event.id,
    },
  });
  if (third.event.type !== "factory.action.failed") throw new Error("failure event missing");
  const failurePath = verifyFactoryArtifactRef(third.event.data.evidence[0]!, {
    "factory-store": fixture.store.projectRoot,
    repository: fixture.workspace,
  });
  expect(JSON.parse(readFileSync(failurePath, "utf8"))).toMatchObject({
    error: expect.stringContaining("limit 3"),
    failureKind: "human-required",
  });
  expect(third.state).toMatchObject({
    status: "awaiting-continuation",
    candidateEventId: candidate.event.id,
  });
  expect(decideNextFactoryAction(third.state, third.event)).toEqual({
    kind: "wait",
    reason: "human",
  });
  expect(reviewRunner).toHaveBeenCalledTimes(3);
});

test("retry rejects tampered retained role output before reviewer invocation", async () => {
  const fixture = directFixture();
  const { ctx, candidate } = await produceCandidate(fixture);
  const reviewRunner = vi.fn(async (reviewCtx: { runDir?: string }) => {
    writeReviewRole(reviewCtx.runDir!, "implementation", passReview());
    return failedReviewMeta("implementation", "pass");
  });
  const first = await reviewImplementationCandidate({
    ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction: invoke(candidate),
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
    reviewRunner: reviewRunner as never,
  });
  if (first.event.type !== "factory.action.failed") throw new Error("retry failure missing");
  const checkpointRef = first.event.data.evidence[1]!;
  const checkpointPath = verifyFactoryArtifactRef(checkpointRef, {
    "factory-store": fixture.store.projectRoot,
    repository: fixture.workspace,
  });
  const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8")) as {
    roles: { implementation: { output: ReturnType<typeof createFactoryArtifactRef> } };
  };
  const outputPath = verifyFactoryArtifactRef(checkpoint.roles.implementation.output, {
    "factory-store": fixture.store.projectRoot,
    repository: fixture.workspace,
  });
  writeFileSync(outputPath, `${JSON.stringify(passReview())}\nchanged`);
  const second = await reviewImplementationCandidate({
    ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction: invoke(first),
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
    reviewRunner: reviewRunner as never,
  });
  expect(reviewRunner).toHaveBeenCalledOnce();
  expect(second.event).toMatchObject({
    type: "factory.action.failed",
    data: { failureKind: "terminal", message: expect.stringMatching(/hash mismatch/) },
  });
});

test.each(["needs_changes", "blocked"] as const)(
  "cumulative retry publishes the final %s aggregate",
  async (verdict) => {
    const fixture = directFixture();
    const { ctx, candidate } = await produceCandidate(fixture);
    const reviewRunner = vi
      .fn<
        (
          reviewCtx: { runDir?: string },
          options: { steps?: Array<"implementation" | "quality"> },
        ) => Promise<unknown>
      >(
        async (
          reviewCtx: { runDir?: string },
          _options: { steps?: Array<"implementation" | "quality"> },
        ) => {
          writeReviewRole(reviewCtx.runDir!, "quality", reviewFor(verdict));
          return subsetReviewMeta("quality", verdict);
        },
      )
      .mockImplementationOnce(async (reviewCtx: { runDir?: string }) => {
        writeReviewRole(reviewCtx.runDir!, "implementation", passReview());
        return failedReviewMeta("implementation", "pass");
      });
    const first = await reviewImplementationCandidate({
      ctx,
      factoryStateRoot: fixture.factoryStateRoot,
      reaction: invoke(candidate),
      maxRuntimeMs: 1_000,
      agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
      reviewRunner: reviewRunner as never,
    });
    const second = await reviewImplementationCandidate({
      ctx,
      factoryStateRoot: fixture.factoryStateRoot,
      reaction: invoke(first),
      maxRuntimeMs: 1_000,
      agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
      reviewRunner: reviewRunner as never,
    });
    expect(second.event).toMatchObject({
      type: "implementation.review.completed",
      data: { verdict },
    });
    expect(git(fixture.workspace, ["rev-parse", "HEAD"]).trim()).toBe(fixture.baseSha);
  },
);

test("candidate evidence digest tampering fails before reviewer invocation", async () => {
  const fixture = directFixture();
  const { ctx, candidate } = await produceCandidate(fixture);
  if (candidate.event.type !== "implementation.candidate.produced") throw new Error("candidate");
  const manifest = join(fixture.store.projectRoot, candidate.event.data.candidate.path);
  writeFileSync(manifest, "{}\n");
  const reviewRunner = vi.fn();
  const reviewed = await reviewImplementationCandidate({
    ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction: invoke(candidate),
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
    reviewRunner: reviewRunner as never,
  });
  expect(reviewRunner).not.toHaveBeenCalled();
  expect(reviewed.event).toMatchObject({
    type: "factory.action.failed",
    data: { failureKind: "terminal" },
  });
  expect(reviewed.state).not.toHaveProperty("candidateEventId");
});

test("staged pass recovers while branch is still at base without rerunning reviewers", async () => {
  const fixture = directFixture();
  const { ctx, candidate } = await produceCandidate(fixture);
  const reaction = invoke(candidate);
  const actionDir = actionPath(ctx, reaction);
  const manifestPath = join(actionDir, "review-evidence.json");
  const reviewRunner = vi.fn(async (reviewCtx: { runDir?: string }) => {
    writePassReviews(reviewCtx.runDir!);
    mkdirSync(manifestPath, { recursive: true });
    return fullReviewMeta("pass");
  });
  const action = {
    ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction,
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({ name: "cursor" as const, run: vi.fn<Agent["run"]>() }),
    reviewRunner: reviewRunner as never,
  };
  await expect(reviewImplementationCandidate(action)).rejects.toThrow();
  expect(git(fixture.workspace, ["rev-parse", "HEAD"]).trim()).toBe(fixture.baseSha);
  rmSync(manifestPath, { recursive: true });
  const recovered = await reviewImplementationCandidate(action);
  expect(reviewRunner).toHaveBeenCalledTimes(1);
  expect(recovered.state).toMatchObject({ status: "awaiting-pr-publication" });
});

test("Linear start repair reuses one request and invokes the producer only after projection", async () => {
  const fixture = directFixture();
  fixture.workItem.metadata = { linearStatus: "Ready to Implement" };
  const providerRun = vi.fn<Agent["run"]>(async () => {
    writeFileSync(join(fixture.workspace, "tracked.txt"), "implemented\n");
    return { ok: true, raw: {}, session: { provider: "cursor", id: "session" } };
  });
  const base = {
    ...coordinatorInput(fixture),
    linearIssue: "ENG-123",
    issueRef: "ENG-123",
    linearStatuses: LINEAR_SETTINGS.statuses,
    agentProviderFactory: () => ({ name: "cursor" as const, run: providerRun }),
  };
  await expect(
    runOneFactoryImplementationAction({
      ...base,
      applyAdapter: fakeLinearAdapter({
        applyImplementationStarted: async () => {
          throw new Error("projection unavailable");
        },
      }),
    }),
  ).rejects.toThrow("projection unavailable");
  expect(providerRun).not.toHaveBeenCalled();
  fixture.workItem.metadata = { linearStatus: "Implementing" };
  const repaired = await runOneFactoryImplementationAction({
    ...base,
    workItem: fixture.workItem,
    applyAdapter: fakeLinearAdapter({
      applyImplementationStarted: vi.fn(async () => ({
        issueIdentifier: "ENG-123",
        runId: "run",
        runDir: "run",
        stage: "started" as const,
        targetStatus: "Implementing",
      })),
    }),
  });
  expect(providerRun).toHaveBeenCalledTimes(1);
  expect(repaired.next).toMatchObject({ command: expect.stringContaining("--apply") });
  expect(
    readFactoryActionEvents(fixture.factoryStateRoot, fixture.key).filter(
      (event) => event.type === "implementation.requested",
    ),
  ).toHaveLength(1);
});

test("passing review waits for PR publication without terminal projection", async () => {
  const fixture = directFixture();
  const { ctx, candidate } = await produceCandidate(fixture);
  await reviewImplementationCandidate({
    ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction: invoke(candidate),
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
    reviewRunner: (async (reviewCtx: { runDir?: string }) => {
      writePassReviews(reviewCtx.runDir!);
      return fullReviewMeta("pass");
    }) as never,
  });
  fixture.workItem.metadata = { linearStatus: "Implementing" };
  const before = readFactoryActionEvents(fixture.factoryStateRoot, fixture.key).length;
  const result = await runOneFactoryImplementationAction({
    ...coordinatorInput(fixture),
    linearIssue: "ENG-123",
    issueRef: "ENG-123",
    linearStatuses: LINEAR_SETTINGS.statuses,
    applyAdapter: fakeLinearAdapter(),
    agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
  });
  expect(result.action).toBeUndefined();
  expect(result.linearApplied).toBe(false);
  expect(readFactoryActionEvents(fixture.factoryStateRoot, fixture.key)).toHaveLength(before);
});

test("Linear human-required failure projects and repairs attention without another handler", async () => {
  const fixture = directFixture();
  fixture.workItem.metadata = { linearStatus: "Ready to Implement" };
  const providerRun = vi.fn<Agent["run"]>(async () => ({
    ok: false,
    error: "operator canceled",
    exitCode: 130,
    aborted: true,
  }));
  const attentionFailure = vi.fn(async () => {
    throw new Error("attention projection unavailable");
  });
  await expect(
    runOneFactoryImplementationAction({
      ...coordinatorInput(fixture),
      linearIssue: "ENG-123",
      issueRef: "ENG-123",
      linearStatuses: LINEAR_SETTINGS.statuses,
      applyAdapter: fakeLinearAdapter({
        applyImplementationStarted: async () => ({
          issueIdentifier: "ENG-123",
          runId: "run",
          runDir: "run",
          stage: "started",
          targetStatus: "Implementing",
        }),
        applyImplementationAttention: attentionFailure,
      }),
      agentProviderFactory: () => ({ name: "cursor", run: providerRun }),
    }),
  ).rejects.toThrow("attention projection unavailable");
  expect(attentionFailure).toHaveBeenCalledWith(
    expect.objectContaining({
      verdict: "human_required",
      message: expect.stringContaining("operator canceled"),
    }),
  );
  const before = readFactoryActionEvents(fixture.factoryStateRoot, fixture.key).length;
  fixture.workItem.metadata = { linearStatus: "Implementing" };
  const repairedAttention = vi.fn(async () => ({
    issueIdentifier: "ENG-123",
    runId: "run",
    runDir: "run",
    stage: "completed" as const,
    targetStatus: "Implementing",
  }));
  const repaired = await runOneFactoryImplementationAction({
    ...coordinatorInput(fixture),
    workItem: fixture.workItem,
    linearIssue: "ENG-123",
    issueRef: "ENG-123",
    linearStatuses: LINEAR_SETTINGS.statuses,
    applyAdapter: fakeLinearAdapter({ applyImplementationAttention: repairedAttention }),
    agentProviderFactory: () => ({ name: "cursor", run: providerRun }),
  });
  expect(repaired.action).toBeUndefined();
  expect(repaired.linearApplied).toBe(true);
  expect(repairedAttention).toHaveBeenCalledWith(
    expect.objectContaining({
      verdict: "human_required",
      message: expect.stringContaining("operator canceled"),
    }),
  );
  expect(providerRun).toHaveBeenCalledTimes(1);
  expect(readFactoryActionEvents(fixture.factoryStateRoot, fixture.key)).toHaveLength(before);
});

test("Linear retained-candidate terminal failure repairs attention before re-review", async () => {
  const fixture = directFixture();
  fixture.workItem.metadata = { linearStatus: "Ready to Implement" };
  const producer = vi.fn<Agent["run"]>(async () => {
    writeFileSync(join(fixture.workspace, "tracked.txt"), "candidate\n");
    return { ok: true, raw: {}, session: { provider: "cursor", id: "session-1" } };
  });
  await runOneFactoryImplementationAction({
    ...coordinatorInput(fixture),
    linearIssue: "ENG-123",
    issueRef: "ENG-123",
    linearStatuses: LINEAR_SETTINGS.statuses,
    applyAdapter: fakeLinearAdapter({
      applyImplementationStarted: async () => ({
        issueIdentifier: "ENG-123",
        runId: "run",
        runDir: "run",
        stage: "started",
        targetStatus: "Implementing",
      }),
    }),
    agentProviderFactory: () => ({ name: "cursor", run: producer }),
  });
  fixture.workItem.metadata = { linearStatus: "Implementing" };
  const projectionFailure = vi.fn(async () => {
    throw new Error("attention projection unavailable");
  });
  const invalidReview = vi.fn(async (reviewCtx: { runDir?: string }) => {
    mkdirSync(reviewCtx.runDir!, { recursive: true });
    writeFileSync(join(reviewCtx.runDir!, "implementation-review.json"), "{}\n");
    writeFileSync(join(reviewCtx.runDir!, "quality-review.json"), "{}\n");
    return fullReviewMeta("pass");
  });
  await expect(
    runOneFactoryImplementationAction({
      ...coordinatorInput(fixture),
      linearIssue: "ENG-123",
      issueRef: "ENG-123",
      linearStatuses: LINEAR_SETTINGS.statuses,
      applyAdapter: fakeLinearAdapter({ applyImplementationAttention: projectionFailure }),
      agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
      reviewRunner: invalidReview as never,
    }),
  ).rejects.toThrow("attention projection unavailable");
  const failure = readFactoryActionEvents(fixture.factoryStateRoot, fixture.key).at(-1);
  expect(failure).toMatchObject({
    type: "factory.action.failed",
    data: { failureKind: "terminal", retainedCandidateEventId: expect.any(String) },
  });
  if (failure?.type !== "factory.action.failed") throw new Error("Expected retained failure");
  const persistedReason = failure.data.message;

  const repairedAttention = vi.fn(async (_input: unknown) => ({
    issueIdentifier: "ENG-123",
    runId: "run",
    runDir: "run",
    stage: "completed" as const,
    targetStatus: "Implementing",
  }));
  continueImplementation(fixture, "re-review", "The review output failure has been resolved.");

  const ordering: string[] = [];
  const passReview = vi.fn(async (reviewCtx: { runDir?: string }) => {
    ordering.push("review");
    writePassReviews(reviewCtx.runDir!);
    return fullReviewMeta("pass");
  });
  const passed = await runOneFactoryImplementationAction({
    ...coordinatorInput(fixture),
    linearIssue: "ENG-123",
    issueRef: "ENG-123",
    linearStatuses: LINEAR_SETTINGS.statuses,
    applyAdapter: fakeLinearAdapter({
      applyImplementationAttention: async (attention) => {
        ordering.push("projection");
        return repairedAttention(attention);
      },
    }),
    agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
    reviewRunner: passReview as never,
  });
  expect(ordering).toEqual(["projection", "review"]);
  expect(repairedAttention).toHaveBeenCalledWith(
    expect.objectContaining({ message: persistedReason }),
  );
  expect(passed.linearApplied).toBe(true);
  expect(passed.next).toEqual({ kind: "wait", reason: "pr-publication" });
  expect(producer).toHaveBeenCalledOnce();
  expect(invalidReview).toHaveBeenCalledOnce();
  expect(passReview).toHaveBeenCalledOnce();
});

function directFixture() {
  const workspace = mkdtempSync(join(tmpdir(), "factory-implementation-workspace-"));
  git(workspace, ["init", "-b", "main"]);
  git(workspace, ["config", "user.email", "test@example.com"]);
  git(workspace, ["config", "user.name", "Test"]);
  writeFileSync(join(workspace, ".gitignore"), ".harness/\n");
  writeFileSync(join(workspace, "tracked.txt"), "base\n");
  git(workspace, ["add", "."]);
  git(workspace, ["commit", "-m", "base"]);
  const projectRoot = mkdtempSync(join(tmpdir(), "factory-implementation-store-"));
  const factoryStateRoot = join(projectRoot, "factory");
  ensureFactoryStoreFormat(factoryStateRoot);
  const store: FactoryStoreMeta = {
    storeRoot: projectRoot,
    projectId: "repo",
    projectRoot,
    factoryStateRoot,
    factoryRunsDir: join(projectRoot, "runs/factory"),
    reviewRunsDir: join(projectRoot, "runs/reviews"),
    repo: { name: "repo", id: "repo", idSource: "config" },
    overrides: {},
    warnings: [],
  };
  const workItem: FactoryWorkItem = {
    id: "item-1",
    source: "file",
    title: "Implement item",
    body: "Change tracked.txt",
    labels: [],
  };
  const key = deriveFactoryWorkItemKey(workItem);
  const evidencePath = join(projectRoot, "input", "readiness.json");
  mkdirSync(join(projectRoot, "input"), { recursive: true });
  const workItemPath = join(projectRoot, "input", "work-item.json");
  writeFileSync(workItemPath, `${JSON.stringify(workItem, null, 2)}\n`);
  const workItemRef = createFactoryArtifactRef({
    base: "factory-store",
    root: projectRoot,
    path: relative(projectRoot, workItemPath),
  });
  writeFileSync(evidencePath, '{"route":"ready-to-implement"}\n');
  const evidence = createFactoryArtifactRef({
    base: "factory-store",
    root: projectRoot,
    path: relative(projectRoot, evidencePath),
  });
  const imported: FactoryLifecycleEvent = {
    version: 1,
    id: "import:item-1",
    type: "work_item.imported",
    workItemKey: key,
    occurredAt: new Date().toISOString(),
    data: { source: "file" },
  };
  appendFactoryActionEvent({ factoryStateRoot, event: imported, expectedLastEventId: null });
  const triageRequested: FactoryLifecycleEvent = {
    version: 1,
    id: "triage.requested:run-1",
    type: "triage.requested",
    workItemKey: key,
    occurredAt: new Date().toISOString(),
    phaseRunId: "run-1",
    data: { expectedPredecessor: imported.id, inputRefs: [workItemRef], intent: "start" },
  };
  appendFactoryActionEvent({
    factoryStateRoot,
    event: triageRequested,
    expectedLastEventId: imported.id,
  });
  const triageComplete: FactoryLifecycleEvent = {
    version: 1,
    id: `triage.work_item.completed:${factoryActionKey({
      phaseRunId: "run-1",
      handler: "triageWorkItem",
      attempt: 1,
      causationEventId: triageRequested.id,
    })}`,
    type: "triage.work_item.completed",
    workItemKey: key,
    occurredAt: new Date().toISOString(),
    phaseRunId: "run-1",
    data: {
      handler: "triageWorkItem",
      handlerVersion: 1,
      attempt: 1,
      causationEventId: triageRequested.id,
      execution: { workspaceRef: "repo", runRef: evidence },
      evidence: [evidence],
      route: "ready-to-implement",
      rationale: "direct",
    },
  };
  appendFactoryActionEvent({
    factoryStateRoot,
    event: triageComplete,
    expectedLastEventId: triageRequested.id,
  });
  return {
    workspace,
    store,
    factoryStateRoot,
    workItem,
    workItemRef,
    key,
    baseSha: git(workspace, ["rev-parse", "HEAD"]).trim(),
  };
}

function sharedWorktree(workspace: string): string {
  const root = mkdtempSync(join(tmpdir(), "factory-implementation-sibling-"));
  const sibling = join(root, "worktree");
  git(workspace, ["worktree", "add", "-b", "ambient", sibling, "HEAD"]);
  const commonDir = (target: string) =>
    realpathSync(resolve(target, git(target, ["rev-parse", "--git-common-dir"]).trim()));
  expect(commonDir(sibling)).toBe(commonDir(workspace));
  return sibling;
}

function removeLastLifecycleEvent(fixture: ReturnType<typeof directFixture>): void {
  const path = actionLifecycleEventPath(fixture.factoryStateRoot, fixture.key);
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  writeFileSync(path, `${lines.slice(0, -1).join("\n")}\n`);
}

function createPhase(
  fixture: ReturnType<typeof directFixture>,
  implementerAgent: "cursor" | "codex" = "cursor",
) {
  const events = readFactoryActionEvents(fixture.factoryStateRoot, fixture.key);
  return createFactoryImplementationRunContext({
    workspace: fixture.workspace,
    runsDir: fixture.store.factoryRunsDir,
    workItem: fixture.workItem,
    factoryStore: fixture.store,
    implementationInput: {
      mode: "direct",
      importedEventId: events[0]!.id,
      workItem: fixture.workItemRef,
      readinessEventId: events.at(-1)!.id,
      readiness: (
        events.at(-1) as Extract<FactoryLifecycleEvent, { type: "triage.work_item.completed" }>
      ).data.evidence[0]!,
    },
    implementerRole: { agent: implementerAgent, model: "implementer" },
    reviewerRole: { agent: "cursor", model: "reviewer" },
  });
}

function appendRequest(
  fixture: ReturnType<typeof directFixture>,
  ctx: ReturnType<typeof createPhase>,
) {
  const current = readFactoryActionEvents(fixture.factoryStateRoot, fixture.key).at(-1)!;
  const identity = ctx.identity;
  if (identity.phase !== "implementation") throw new Error("identity");
  if (identity.input.mode !== "direct") throw new Error("direct input");
  const event: FactoryLifecycleEvent = {
    version: 1,
    id: `implementation.requested:${ctx.runId}`,
    type: "implementation.requested",
    workItemKey: fixture.key,
    occurredAt: new Date().toISOString(),
    phaseRunId: ctx.runId,
    data: {
      expectedPredecessor: current.id,
      inputRefs: [identity.input.workItem, identity.input.readiness],
      intent: "start",
    },
  };
  return appendFactoryActionEvent({
    factoryStateRoot: fixture.factoryStateRoot,
    event,
    expectedLastEventId: current.id,
  });
}

function coordinatorInput(fixture: ReturnType<typeof directFixture>) {
  return {
    factoryStateRoot: fixture.factoryStateRoot,
    factoryStore: fixture.store,
    workspace: fixture.workspace,
    workItem: fixture.workItem,
    itemFile: "item.json",
    rerun: false,
    implementerRole: { agent: "cursor" as const, model: "implementer" },
    reviewerRole: { agent: "cursor" as const, model: "reviewer" },
  };
}

function continueImplementation(
  fixture: ReturnType<typeof directFixture>,
  decision: "revise" | "re-review",
  response: string,
) {
  return recordFactoryContinuation({
    phase: "implementation",
    decision,
    response,
    factoryStateRoot: fixture.factoryStateRoot,
    factoryStore: fixture.store,
    workItemKey: deriveFactoryWorkItemKey(fixture.workItem),
    observed: observeFactoryContinuation(
      readFactoryActionEvents(fixture.factoryStateRoot, deriveFactoryWorkItemKey(fixture.workItem)),
      "implementation",
    ),
  });
}

async function produceCandidate(fixture: ReturnType<typeof directFixture>) {
  const ctx = createPhase(fixture);
  const requested = appendRequest(fixture, ctx);
  const candidate = await produceImplementationCandidate({
    ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction: invoke(requested),
    maxRuntimeMs: 0,
    agentProviderFactory: () => ({
      name: "cursor",
      run: async () => {
        writeFileSync(join(fixture.workspace, "tracked.txt"), "candidate\n");
        return { ok: true, raw: {}, session: { provider: "cursor", id: "session-1" } };
      },
    }),
  });
  return { ctx, candidate };
}

function actionPath(
  ctx: ReturnType<typeof createPhase>,
  reaction: Extract<ReturnType<typeof decideNextFactoryAction>, { kind: "invoke" }>,
) {
  return join(
    ctx.runDir,
    "actions",
    String(reaction.attempt),
    reaction.handler,
    factoryActionKey({ ...reaction, phaseRunId: ctx.runId }),
  );
}

function invoke(result: {
  event: FactoryLifecycleEvent;
  state: ReturnType<typeof reduceFactoryLifecycleEvents>;
}) {
  if (!result.state) throw new Error("state");
  const reaction = decideNextFactoryAction(result.state, result.event);
  if (reaction.kind !== "invoke") throw new Error("invoke");
  return reaction;
}

function writePassReviews(runDir: string) {
  writeReviewRole(runDir, "implementation", passReview());
  writeReviewRole(runDir, "quality", passReview());
}

function passReview() {
  return { verdict: "pass" as const, summary: "ok", findings: [] };
}

function reviewFor(verdict: "pass" | "needs_changes" | "blocked") {
  return verdict === "needs_changes"
    ? {
        verdict,
        summary: "fix",
        findings: [
          {
            title: "Fix",
            severity: "High" as const,
            location: "tracked.txt",
            issue: "issue",
            recommendation: "fix",
            rationale: "required",
            must_fix: true,
          },
        ],
      }
    : { verdict, summary: verdict, findings: [] };
}

function writeReviewRole(runDir: string, role: "implementation" | "quality", review: unknown) {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, `${role}-review.prompt.md`), `${role} prompt\n`);
  writeFileSync(join(runDir, `${role}-review.json`), JSON.stringify(review));
}

function writeBlockingReviews(runDir: string) {
  mkdirSync(runDir, { recursive: true });
  for (const [name, title] of [
    ["implementation", "Correctness"],
    ["quality", "Clarity"],
  ]) {
    writeFileSync(join(runDir, `${name}-review.prompt.md`), `${name} prompt\n`);
    writeFileSync(
      join(runDir, `${name}-review.json`),
      JSON.stringify({
        verdict: "needs_changes",
        summary: "fix",
        findings: [
          {
            title,
            severity: "High",
            location: "tracked.txt",
            issue: "issue",
            recommendation: "fix",
            rationale: "required",
            must_fix: true,
          },
        ],
      }),
    );
  }
}

function writeBlockedReviews(runDir: string) {
  mkdirSync(runDir, { recursive: true });
  const review = { verdict: "blocked", summary: "blocked", findings: [] };
  writeFileSync(join(runDir, "implementation-review.prompt.md"), "implementation prompt\n");
  writeFileSync(join(runDir, "implementation-review.json"), JSON.stringify(review));
  writeFileSync(join(runDir, "quality-review.prompt.md"), "quality prompt\n");
  writeFileSync(join(runDir, "quality-review.json"), JSON.stringify(review));
}

function fullReviewMeta(verdict: "pass" | "needs_changes" | "blocked") {
  return {
    status: "completed",
    verdict,
    workflow: "change-review",
    availableSteps: ["implementation", "quality"],
    requestedSteps: ["implementation", "quality"],
    executedSteps: ["implementation", "quality"],
    omittedSteps: [],
    partial: false,
    reviews: {
      implementation: { verdict, findingCount: verdict === "needs_changes" ? 1 : 0 },
      codeQuality: { verdict, findingCount: verdict === "needs_changes" ? 1 : 0 },
    },
  };
}

function failedReviewMeta(
  successfulRole: "implementation" | "quality",
  verdict: "pass" | "needs_changes" | "blocked",
) {
  const summaryKey = successfulRole === "implementation" ? "implementation" : "codeQuality";
  return {
    ...fullReviewMeta(verdict),
    status: "failed",
    reviews: { [summaryKey]: { verdict, findingCount: 0 } },
  };
}

function subsetReviewMeta(
  role: "implementation" | "quality",
  verdict: "pass" | "needs_changes" | "blocked",
) {
  const omitted = role === "implementation" ? "quality" : "implementation";
  const summaryKey = role === "implementation" ? "implementation" : "codeQuality";
  return {
    status: "completed",
    verdict,
    workflow: "change-review",
    availableSteps: ["implementation", "quality"],
    requestedSteps: [role],
    executedSteps: [role],
    omittedSteps: [omitted],
    partial: true,
    reviews: { [summaryKey]: { verdict, findingCount: 0 } },
  };
}

function git(workspace: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
