import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { expect, test, vi } from "vitest";
import { runOneFactoryImplementationAction } from "../bin/factory-implementation-cli.ts";
import type { Agent, AgentRunInput } from "../lib/agents.ts";
import { createFactoryArtifactRef, verifyFactoryArtifactRef } from "../lib/factory-artifact-ref.ts";
import { factoryActionKey } from "../lib/factory-action-contract.ts";
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
import { readFactoryPhaseRunIdentity } from "../lib/factory-phase-run.ts";
import { FactoryReviewHeadError } from "../lib/factory-review-head.ts";
import type { FactoryWorkItem } from "../lib/factory-schemas.ts";
import { decideNextFactoryAction } from "../lib/factory-state-machine.ts";
import type { reduceFactoryLifecycleEvents } from "../lib/factory-state-machine.ts";
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
  expect(second.next).toEqual({ kind: "wait", reason: "complete" });
  expect(reviewRunner).toHaveBeenCalledTimes(1);
  const events = readFactoryActionEvents(fixture.factoryStateRoot, fixture.key);
  const candidate = events.find((event) => event.type === "implementation.candidate.produced");
  if (!candidate || candidate.type !== "implementation.candidate.produced")
    throw new Error("candidate missing");
  expect(git(fixture.workspace, ["rev-parse", "HEAD"]).trim()).toBe(candidate.data.commit);
  expect(git(fixture.workspace, ["status", "--porcelain=v1"]).trim()).toBe("");
  expect(git(fixture.workspace, ["diff", "--cached", "--name-only"]).trim()).toBe("");
});

test("revision resumes the effective session with complete blockers and promotes only its new candidate", async () => {
  const fixture = directFixture();
  const firstProvider = vi.fn<Agent["run"]>(async () => {
    writeFileSync(join(fixture.workspace, "tracked.txt"), "first\n");
    return { ok: true, raw: {}, session: { provider: "cursor", id: "session-1" } };
  });
  const first = await runOneFactoryImplementationAction({
    ...coordinatorInput(fixture),
    reviewCeiling: 3,
    agentProviderFactory: () => ({ name: "cursor", run: firstProvider }),
  });
  expect(first.action).toMatchObject({ handler: "produceImplementationCandidate", attempt: 1 });

  const needsChanges = await runOneFactoryImplementationAction({
    ...coordinatorInput(fixture),
    reviewCeiling: 99,
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
  expect(needsChanges.next).toMatchObject({
    kind: "invoke",
    handler: "produceImplementationCandidate",
    attempt: 2,
    reason: "review-needs-changes",
  });
  expect(firstProvider).toHaveBeenCalledTimes(1);
  git(fixture.workspace, ["tag", "unrelated-operator-tag"]);

  const revisionProvider = vi.fn<Agent["run"]>(async (input) => {
    expect(input.session).toMatchObject({ provider: "cursor", id: "session-1" });
    expect(input.prompt).toContain("Revision authority");
    expect(input.prompt).toContain("Correctness");
    expect(input.prompt).toContain("Clarity");
    writeFileSync(join(fixture.workspace, "tracked.txt"), "second\n");
    return { ok: true, raw: {} };
  });
  const revision = await runOneFactoryImplementationAction({
    ...coordinatorInput(fixture),
    reviewCeiling: 1,
    agentProviderFactory: () => ({ name: "cursor", run: revisionProvider }),
  });
  expect(revision.action).toMatchObject({ handler: "produceImplementationCandidate", attempt: 2 });
  expect(revision.next).toMatchObject({ handler: "reviewImplementationCandidate", attempt: 2 });

  const pass = await runOneFactoryImplementationAction({
    ...coordinatorInput(fixture),
    reviewCeiling: 1,
    agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
    reviewRunner: (async (ctx: { runDir?: string }) => {
      writePassReviews(ctx.runDir!);
      return fullReviewMeta("pass");
    }) as never,
  });
  expect(pass.next).toEqual({ kind: "wait", reason: "complete" });
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

test("tampered revision blockers are terminal before a second provider call", async () => {
  const fixture = directFixture();
  const first = await runOneFactoryImplementationAction({
    ...coordinatorInput(fixture),
    reviewCeiling: 3,
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
    reviewCeiling: 3,
    agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
    reviewRunner: (async (ctx: { runDir?: string }) => {
      writeBlockingReviews(ctx.runDir!);
      return fullReviewMeta("needs_changes");
    }) as never,
  });
  const review = readFactoryActionEvents(fixture.factoryStateRoot, fixture.key).at(-1)!;
  if (review.type !== "implementation.review.completed" || !review.data.blockingFindings)
    throw new Error("review blockers missing");
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
    reviewCeiling: 3,
    agentProviderFactory: () => ({ name: "cursor", run: providerRun }),
  });
  expect(providerRun).not.toHaveBeenCalled();
  expect(result.action).toMatchObject({ handler: "produceImplementationCandidate", attempt: 2 });
  expect(result.next).toEqual({ kind: "wait", reason: "failed" });
});

test("revision workspace drift waits for a human before resuming the provider", async () => {
  const fixture = directFixture();
  await runOneFactoryImplementationAction({
    ...coordinatorInput(fixture),
    reviewCeiling: 3,
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
    reviewCeiling: 3,
    agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
    reviewRunner: (async (ctx: { runDir?: string }) => {
      writeBlockingReviews(ctx.runDir!);
      return fullReviewMeta("needs_changes");
    }) as never,
  });
  writeFileSync(join(fixture.workspace, "tracked.txt"), "drift\n");
  const providerRun = vi.fn<Agent["run"]>();
  const result = await runOneFactoryImplementationAction({
    ...coordinatorInput(fixture),
    reviewCeiling: 3,
    agentProviderFactory: () => ({ name: "cursor", run: providerRun }),
  });
  expect(providerRun).not.toHaveBeenCalled();
  expect(result.next).toEqual({ kind: "wait", reason: "human" });
});

test("retryable revision failure retries the same attempt with its original session and blockers", async () => {
  const fixture = directFixture();
  await runOneFactoryImplementationAction({
    ...coordinatorInput(fixture),
    reviewCeiling: 3,
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
    reviewCeiling: 3,
    agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
    reviewRunner: (async (ctx: { runDir?: string }) => {
      writeBlockingReviews(ctx.runDir!);
      return fullReviewMeta("needs_changes");
    }) as never,
  });
  const failedProvider = vi.fn<Agent["run"]>(async (input) => {
    expect(input.session).toMatchObject({ id: "session-1" });
    expect(input.prompt).toContain("Correctness");
    return { ok: false, error: "temporary", exitCode: 1 };
  });
  const failed = await runOneFactoryImplementationAction({
    ...coordinatorInput(fixture),
    reviewCeiling: 3,
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
    reviewCeiling: 3,
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
  mkdirSync(join(actionDir, "action-result.json"), { recursive: true });
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
  };
  await expect(produceImplementationCandidate(action)).rejects.toThrow();
  rmSync(join(actionDir, "action-result.json"), { recursive: true });
  const recovered = await produceImplementationCandidate(action);
  expect(providerRun).toHaveBeenCalledTimes(1);
  expect(recovered.event.type).toBe("implementation.candidate.produced");
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

test("implementer ref mutation becomes human-required", async () => {
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
  expect(result.event).toMatchObject({
    type: "factory.action.failed",
    data: { failureKind: "human-required" },
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
  expect(recovered.state).toMatchObject({ status: "complete" });
});

test("phase creation rejects dirty and detached workspaces before provider work", () => {
  const dirty = directFixture();
  writeFileSync(join(dirty.workspace, "tracked.txt"), "dirty\n");
  expect(() => createPhase(dirty)).toThrow(/clean workspace/);

  const detached = directFixture();
  git(detached.workspace, ["checkout", "--detach"]);
  expect(() => createPhase(detached)).toThrow(/attached branch/);
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
      reviewCeiling: 1,
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

test("needs_changes at the persisted ceiling waits for a human and preserves all blockers", async () => {
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
  expect(reviewed.state).toMatchObject({ status: "needs-human" });
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
  expect(reviewed.state).toMatchObject({ status: "needs-human" });
  expect(decideNextFactoryAction(reviewed.state, reviewed.event)).toEqual({
    kind: "wait",
    reason: "human",
  });
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
    meta: { ...fullReviewMeta("pass"), status: "failed" },
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
      writePassReviews(reviewCtx.runDir!);
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
      data: { failureKind: timing === "during" ? "human-required" : "terminal" },
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

test("reviewer ref mutation becomes human-required", async () => {
  const fixture = directFixture();
  const { ctx, candidate } = await produceCandidate(fixture);
  const reviewed = await reviewImplementationCandidate({
    ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction: invoke(candidate),
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
    reviewRunner: (async (reviewCtx: { runDir?: string }) => {
      writePassReviews(reviewCtx.runDir!);
      git(fixture.workspace, ["tag", "reviewer-mutated-ref"]);
      return fullReviewMeta("pass");
    }) as never,
  });
  expect(reviewed.event).toMatchObject({
    type: "factory.action.failed",
    data: { failureKind: "human-required" },
  });
});

test("retryable reviewer failure runs the same review action again", async () => {
  const fixture = directFixture();
  const { ctx, candidate } = await produceCandidate(fixture);
  const reviewRunner = vi
    .fn(async (reviewCtx: { runDir?: string }) => {
      writePassReviews(reviewCtx.runDir!);
      return fullReviewMeta("pass");
    })
    .mockImplementationOnce(async (reviewCtx: { runDir?: string }) => {
      writePassReviews(reviewCtx.runDir!);
      return { ...fullReviewMeta("pass"), status: "failed" };
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
  expect(reviewRunner).toHaveBeenCalledTimes(2);
  expect(second.state).toMatchObject({ status: "complete" });
});

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
  expect(recovered.state).toMatchObject({ status: "complete" });
});

test("--rerun creates a fresh attempt-one phase and fresh profile after a human wait", async () => {
  const fixture = directFixture();
  const { ctx, candidate } = await produceCandidate(fixture);
  await reviewImplementationCandidate({
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
  git(fixture.workspace, ["restore", "--staged", "--worktree", "."]);
  const providerRun = vi.fn<Agent["run"]>(async (runInput) => {
    expect(runInput.session).toBeUndefined();
    writeFileSync(join(fixture.workspace, "tracked.txt"), "fresh rerun\n");
    return { ok: true, raw: {}, session: { provider: "cursor", id: "fresh-session" } };
  });
  const rerun = await runOneFactoryImplementationAction({
    ...coordinatorInput(fixture),
    rerun: true,
    implementerRole: { agent: "cursor", model: "fresh-implementer" },
    reviewerRole: { agent: "cursor", model: "fresh-reviewer" },
    agentProviderFactory: () => ({ name: "cursor", run: providerRun }),
  });
  expect(rerun.phaseRunId).not.toBe(ctx.runId);
  expect(rerun.action).toMatchObject({ handler: "produceImplementationCandidate", attempt: 1 });
  const identity = readFactoryPhaseRunIdentity(
    join(fixture.store.factoryRunsDir, rerun.phaseRunId!),
  );
  expect(identity).toMatchObject({
    phase: "implementation",
    actions: {
      produceImplementationCandidate: { model: "fresh-implementer" },
      reviewImplementationCandidate: { model: "fresh-reviewer" },
    },
  });
  const requests = readFactoryActionEvents(fixture.factoryStateRoot, fixture.key).filter(
    (event) => event.type === "implementation.requested",
  );
  expect(requests).toHaveLength(2);
  expect(requests[1]).toMatchObject({ data: { intent: "restart" } });
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
  expect(repaired.next).toMatchObject({ command: expect.stringContaining("'--apply'") });
  expect(
    readFactoryActionEvents(fixture.factoryStateRoot, fixture.key).filter(
      (event) => event.type === "implementation.requested",
    ),
  ).toHaveLength(1);
});

test("Linear terminal repair invokes no handler and appends no duplicate event", async () => {
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
  const completed = vi.fn(async () => ({
    issueIdentifier: "ENG-123",
    runId: ctx.runId,
    runDir: ctx.runDir,
    stage: "completed" as const,
    targetStatus: "Implementing",
  }));
  const result = await runOneFactoryImplementationAction({
    ...coordinatorInput(fixture),
    linearIssue: "ENG-123",
    issueRef: "ENG-123",
    linearStatuses: LINEAR_SETTINGS.statuses,
    applyAdapter: fakeLinearAdapter({ applyImplementationCompleted: completed }),
    agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
  });
  expect(result.action).toBeUndefined();
  expect(result.linearApplied).toBe(true);
  expect(completed).toHaveBeenCalledTimes(1);
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
    expect.objectContaining({ verdict: "human_required" }),
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
    expect.objectContaining({ verdict: "human_required" }),
  );
  expect(providerRun).toHaveBeenCalledTimes(1);
  expect(readFactoryActionEvents(fixture.factoryStateRoot, fixture.key)).toHaveLength(before);
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

function removeLastLifecycleEvent(fixture: ReturnType<typeof directFixture>): void {
  const path = actionLifecycleEventPath(fixture.factoryStateRoot, fixture.key);
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  writeFileSync(path, `${lines.slice(0, -1).join("\n")}\n`);
}

function createPhase(fixture: ReturnType<typeof directFixture>) {
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
    reviewCeiling: 1,
    implementerRole: { agent: "cursor", model: "implementer" },
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
      reviewCeiling: 1,
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
    reviewCeiling: 1,
    implementerRole: { agent: "cursor" as const, model: "implementer" },
    reviewerRole: { agent: "cursor" as const, model: "reviewer" },
  };
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
  mkdirSync(runDir, { recursive: true });
  const review = { verdict: "pass", summary: "ok", findings: [] };
  writeFileSync(join(runDir, "implementation-review.json"), JSON.stringify(review));
  writeFileSync(join(runDir, "quality-review.json"), JSON.stringify(review));
}

function writeBlockingReviews(runDir: string) {
  mkdirSync(runDir, { recursive: true });
  for (const [name, title] of [
    ["implementation", "Correctness"],
    ["quality", "Clarity"],
  ]) {
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
  writeFileSync(join(runDir, "implementation-review.json"), JSON.stringify(review));
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
  };
}

function git(workspace: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
