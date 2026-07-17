import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, expect, vi } from "vitest";
import type { Agent } from "../lib/agents.ts";
import { createFactoryArtifactRef } from "../lib/factory-artifact-ref.ts";
import type { runHostedFactoryOperation } from "../lib/factory-hosted-operation.ts";
import { deriveFactoryGroveWorkspaceIntent } from "../lib/factory-grove-workspace.ts";
import {
  actionLifecycleEventPath,
  actionLifecycleStatePath,
  appendFactoryActionEvent,
} from "../lib/factory-lifecycle-kernel.ts";
import type { FactoryLifecycleEvent } from "../lib/factory-lifecycle-events.ts";
import { createFactoryOperationRef } from "../lib/factory-operation.ts";
import { writeFactoryPhaseRunIdentity } from "../lib/factory-phase-run.ts";
import { deriveFactoryRepoIdentity } from "../lib/factory-store.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

export function registerHostedFixtureRoot(root: string): void {
  roots.push(root);
}

export function fixture(options: { projectId?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "factory-hosted-operation-"));
  roots.push(root);
  const workspace = join(root, "repository");
  mkdirSync(workspace);
  git(workspace, ["init", "--initial-branch=main"]);
  git(workspace, ["config", "user.name", "Factory Test"]);
  git(workspace, ["config", "user.email", "factory@example.test"]);
  writeFileSync(join(workspace, "README.md"), "fixture\n");
  git(workspace, ["add", "README.md"]);
  git(workspace, ["commit", "-m", "fixture"]);
  const baseSha = git(workspace, ["rev-parse", "HEAD"]);
  git(workspace, ["checkout", "--detach", baseSha]);
  const repositoryId = deriveFactoryRepoIdentity(workspace).id;
  const projectId = options.projectId ?? "project-1";
  const workItemKey = "linear:ITEM-1";
  const phaseRunId = "triage-run";
  const projectRoot = join(root, "store", "projects", projectId);
  const factoryStateRoot = join(projectRoot, "factory");
  const runDir = join(projectRoot, "runs", "factory", phaseRunId);
  mkdirSync(join(runDir, "context"), { recursive: true });
  const workItem = {
    id: "linear:ITEM-1",
    source: "linear" as const,
    title: "Hosted",
    body: "Run",
    labels: [],
  };
  writeFileSync(join(runDir, "context/work-item.json"), JSON.stringify(workItem));
  writeFileSync(join(runDir, "factory-triage.prompt.md"), "prompt");
  const inputRef = createFactoryArtifactRef({
    base: "factory-store",
    root: projectRoot,
    path: `runs/factory/${phaseRunId}/context/work-item.json`,
  });
  writeFactoryPhaseRunIdentity(runDir, {
    version: 2,
    phaseRunId,
    phase: "triage",
    workItemKey,
    workspace,
    projectId,
    factoryStateRoot,
    git: { repositoryId, baseSha, target: { mode: "detached" } },
    actions: { triageWorkItem: { provider: "cursor", model: "test" } },
  });
  const imported: FactoryLifecycleEvent = {
    version: 1,
    id: "imported",
    type: "work_item.imported",
    workItemKey,
    occurredAt: "2026-07-15T00:00:00.000Z",
    data: { source: "linear" },
  };
  const requested: FactoryLifecycleEvent = {
    version: 1,
    id: "requested",
    type: "triage.requested",
    workItemKey,
    occurredAt: "2026-07-15T00:01:00.000Z",
    phaseRunId,
    data: { expectedPredecessor: imported.id, inputRefs: [inputRef], intent: "start" },
  };
  appendFactoryActionEvent({ factoryStateRoot, event: imported, expectedLastEventId: null });
  appendFactoryActionEvent({
    factoryStateRoot,
    event: requested,
    expectedLastEventId: imported.id,
  });
  const operation = createFactoryOperationRef({
    phaseRunId,
    handler: "triageWorkItem",
    attempt: 1,
    causationEventId: requested.id,
  });
  const request = { projectId, workItemKey, operation };
  const factoryStore = {
    storeRoot: join(root, "store"),
    projectId,
    projectRoot,
    factoryStateRoot,
    factoryRunsDir: join(projectRoot, "runs/factory"),
    reviewRunsDir: join(projectRoot, "runs/reviews"),
    repo: { name: "repo", id: projectId, idSource: "config" as const },
    overrides: {},
    warnings: [],
  };
  const ensureWorkspace = vi.fn(async ({ intent }) => ({
    leaseId: intent.leaseId,
    workspace,
    intent,
  }));
  const providerRun = vi.fn<Agent["run"]>();
  const runProvider = vi.fn(async () => ({
    runId: phaseRunId,
    workflow: "factory-triage" as const,
    status: "failed" as const,
    workspace,
    runDir,
    workItem: { id: workItem.id, source: workItem.source, title: workItem.title },
    agent: { name: "cursor" as const, model: "test" },
    startedAt: "2026-07-15T00:02:00.000Z",
    durationMs: 1,
    error: "retry",
    failureKind: "retryable" as const,
    factoryStore,
  }));
  const agentProviderFactory = vi.fn(() => ({ name: "cursor" as const, run: providerRun }));
  const runtime = {
    projectId,
    repositoryId,
    factoryStore,
    grove: {
      controllerRepository: workspace,
      poolDirectory: join(root, "pool"),
      poolCapacity: 1,
      setupCommand: "true",
    },
    maxRuntimeMs: 1000,
    agentProviderFactory,
    triage: { nextLiveRunRequiresRerun: true, runProvider },
    ensureWorkspace,
  };
  const resultDir = join(runDir, "actions/1/triageWorkItem", operation.actionKey);
  const resultRef = (path: string) =>
    createFactoryArtifactRef({
      base: "factory-store",
      root: projectRoot,
      path: relative(projectRoot, join(resultDir, path)),
    });
  const completed = (): Extract<FactoryLifecycleEvent, { type: "triage.work_item.completed" }> => {
    mkdirSync(join(resultDir, "evidence"), { recursive: true });
    writeFileSync(join(resultDir, "evidence/summary.md"), "summary\n");
    writeFileSync(
      join(resultDir, "evidence/factory-triage.json"),
      JSON.stringify({
        route: "ready-to-plan",
        confidence: "high",
        rationale: "ready",
        evidence: [{ kind: "code", path: "README.md", summary: "Checked" }],
        questions: [],
        reconsiderWhen: null,
      }),
    );
    const runRef = resultRef("evidence/summary.md");
    const triageRef = resultRef("evidence/factory-triage.json");
    return {
      version: 1,
      id: `triage.work_item.completed:${operation.actionKey}`,
      type: "triage.work_item.completed",
      workItemKey,
      occurredAt: "2026-07-15T00:02:00.000Z",
      phaseRunId,
      data: {
        handler: "triageWorkItem",
        handlerVersion: 1,
        attempt: 1,
        causationEventId: requested.id,
        execution: { workspaceRef: projectId, runRef },
        evidence: [runRef, triageRef],
        route: "ready-to-plan",
        rationale: "ready",
      },
    };
  };
  const failed = (): Extract<FactoryLifecycleEvent, { type: "factory.action.failed" }> => {
    mkdirSync(join(resultDir, "evidence"), { recursive: true });
    writeFileSync(
      join(resultDir, "evidence/failure.json"),
      JSON.stringify({
        runId: phaseRunId,
        workflow: "factory-triage",
        status: "failed",
        workspace,
        runDir,
        workItem: { id: workItem.id, source: workItem.source, title: workItem.title },
        agent: { name: "cursor", model: "test" },
        startedAt: "2026-07-15T00:02:00.000Z",
        durationMs: 1,
        error: "retry",
        failureKind: "retryable",
        factoryStore,
      }),
    );
    const failure = resultRef("evidence/failure.json");
    return {
      version: 1,
      id: `factory.action.failed:${operation.actionKey}`,
      type: "factory.action.failed",
      workItemKey,
      occurredAt: "2026-07-15T00:02:00.000Z",
      phaseRunId,
      data: {
        handler: "triageWorkItem",
        handlerVersion: 1,
        attempt: 1,
        causationEventId: requested.id,
        execution: { workspaceRef: projectId, runRef: failure },
        evidence: [failure],
        phase: "triage",
        failureKind: "retryable",
        message: "retry",
      },
    };
  };
  return {
    request,
    runtime,
    ensureWorkspace,
    runProvider,
    providerRun,
    agentProviderFactory,
    completed,
    failed,
    runDir,
    operation,
    factoryStateRoot,
    projectId,
    workItemKey,
    phaseRunId,
    imported,
    requested,
    inputRef,
    baseSha,
    repositoryId,
    workspace,
  };
}

export function implementationFixture(options: { successfulProvider?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "factory-hosted-implementation-"));
  roots.push(root);
  const workspace = join(root, "repository");
  mkdirSync(workspace);
  git(workspace, ["init", "--initial-branch=main"]);
  git(workspace, ["config", "user.name", "Factory Test"]);
  git(workspace, ["config", "user.email", "factory@example.test"]);
  git(workspace, ["remote", "add", "origin", "https://example.test/repo.git"]);
  writeFileSync(join(workspace, "README.md"), "fixture\n");
  git(workspace, ["add", "README.md"]);
  git(workspace, ["commit", "-m", "fixture"]);
  const baseSha = git(workspace, ["rev-parse", "HEAD"]);
  const repositoryId = deriveFactoryRepoIdentity(workspace).id;
  const projectId = "implementation-project";
  const workItemKey = "linear:IMPL-1";
  const phaseRunId = "implementation-run";
  const projectRoot = join(root, "store", "projects", projectId);
  const factoryStateRoot = join(projectRoot, "factory");
  const runDir = join(projectRoot, "runs", "factory", phaseRunId);
  mkdirSync(join(runDir, "context"), { recursive: true });
  const workItem = {
    id: workItemKey,
    source: "linear" as const,
    title: "Hosted implementation",
    body: "Implement it",
    labels: [],
  };
  writeFileSync(join(runDir, "context/work-item.json"), JSON.stringify(workItem));
  mkdirSync(join(projectRoot, "inputs"), { recursive: true });
  writeFileSync(join(projectRoot, "inputs/readiness.json"), '{"ready":true}\n');
  const workItemRef = createFactoryArtifactRef({
    base: "factory-store",
    root: projectRoot,
    path: `runs/factory/${phaseRunId}/context/work-item.json`,
  });
  const readinessRef = createFactoryArtifactRef({
    base: "factory-store",
    root: projectRoot,
    path: "inputs/readiness.json",
  });
  const imported: FactoryLifecycleEvent = {
    version: 1,
    id: "implementation-imported",
    type: "work_item.imported",
    workItemKey,
    occurredAt: "2026-07-15T00:00:00.000Z",
    data: { source: "linear" },
  };
  const triageRequested: FactoryLifecycleEvent = {
    version: 1,
    id: "implementation-triage-requested",
    type: "triage.requested",
    workItemKey,
    occurredAt: "2026-07-15T00:01:00.000Z",
    phaseRunId: "implementation-triage-run",
    data: { expectedPredecessor: imported.id, inputRefs: [workItemRef], intent: "start" },
  };
  const triageOperation = createFactoryOperationRef({
    phaseRunId: triageRequested.phaseRunId,
    handler: "triageWorkItem",
    attempt: 1,
    causationEventId: triageRequested.id,
  });
  const ready: FactoryLifecycleEvent = {
    version: 1,
    id: `triage.work_item.completed:${triageOperation.actionKey}`,
    type: "triage.work_item.completed",
    workItemKey,
    occurredAt: "2026-07-15T00:02:00.000Z",
    phaseRunId: triageRequested.phaseRunId,
    data: {
      handler: "triageWorkItem",
      handlerVersion: 1,
      attempt: 1,
      causationEventId: triageRequested.id,
      execution: { workspaceRef: projectId, runRef: readinessRef },
      evidence: [readinessRef],
      route: "ready-to-implement",
      rationale: "ready",
    },
  };
  const requested: FactoryLifecycleEvent = {
    version: 1,
    id: "implementation-requested",
    type: "implementation.requested",
    workItemKey,
    occurredAt: "2026-07-15T00:03:00.000Z",
    phaseRunId,
    data: {
      expectedPredecessor: ready.id,
      inputRefs: [workItemRef, readinessRef],
      intent: "start",
    },
  };
  const intent = deriveFactoryGroveWorkspaceIntent({
    controllerRepository: workspace,
    workItemKey,
    phase: "implementation",
    phaseGeneration: ready.id,
    baseSha,
  });
  if (intent.target.mode !== "branch") throw new Error("implementation must use a branch");
  git(workspace, ["switch", "-c", intent.target.branch]);
  const branchRef = `refs/heads/${intent.target.branch}`;
  writeFactoryPhaseRunIdentity(runDir, {
    version: 2,
    phaseRunId,
    phase: "implementation",
    workItemKey,
    workspace,
    projectId,
    factoryStateRoot,
    baseRef: "refs/heads/main",
    git: { repositoryId, baseSha, target: { mode: "branch", branchRef } },
    input: {
      mode: "direct",
      importedEventId: imported.id,
      readinessEventId: ready.id,
      workItem: workItemRef,
      readiness: readinessRef,
    },
    actions: {
      produceImplementationCandidate: { provider: "cursor", model: "implementer" },
      reviewImplementationCandidate: { provider: "cursor", model: "reviewer" },
    },
  });
  appendFactoryActionEvent({ factoryStateRoot, event: imported, expectedLastEventId: null });
  appendFactoryActionEvent({
    factoryStateRoot,
    event: triageRequested,
    expectedLastEventId: imported.id,
  });
  appendFactoryActionEvent({
    factoryStateRoot,
    event: ready,
    expectedLastEventId: triageRequested.id,
  });
  appendFactoryActionEvent({
    factoryStateRoot,
    event: requested,
    expectedLastEventId: ready.id,
  });
  const operation = createFactoryOperationRef({
    phaseRunId,
    handler: "produceImplementationCandidate",
    attempt: 1,
    causationEventId: requested.id,
  });
  const factoryStore = {
    storeRoot: join(root, "store"),
    projectId,
    projectRoot,
    factoryStateRoot,
    factoryRunsDir: join(projectRoot, "runs/factory"),
    reviewRunsDir: join(projectRoot, "runs/reviews"),
    repo: { name: "repo", id: projectId, idSource: "config" as const },
    overrides: {},
    warnings: [],
  };
  const ensureWorkspace = vi.fn(async ({ intent: requestedIntent }) => ({
    leaseId: requestedIntent.leaseId,
    workspace,
    intent: requestedIntent,
  }));
  const providerRun = vi.fn<Agent["run"]>(async () => {
    if (options.successfulProvider) {
      writeFileSync(join(workspace, "README.md"), "implemented\n");
      return {
        ok: true,
        raw: { workspaceStatus: { before: "clean", after: "changed" } },
        session: { provider: "cursor", id: "implementation-session" },
      };
    }
    return {
      ok: false,
      error: "retry",
      exitCode: 1,
      raw: { workspaceStatus: { before: "clean", after: "clean" } },
    };
  });
  const implementationReviewRunner = vi.fn<
    (ctx: { runDir?: string }) => Promise<ReturnType<typeof fullReviewMeta>>
  >(async (ctx) => {
    writePassReviews(ctx.runDir!);
    return fullReviewMeta("pass");
  });
  return {
    request: { projectId, workItemKey, operation },
    runtime: {
      projectId,
      repositoryId,
      factoryStore,
      grove: {
        controllerRepository: workspace,
        poolDirectory: join(root, "pool"),
        poolCapacity: 1,
        setupCommand: "true",
      },
      maxRuntimeMs: 1_000,
      agentProviderFactory: () => ({ name: "cursor" as const, run: providerRun }),
      implementationReviewRunner: implementationReviewRunner as never,
      ensureWorkspace,
    },
    ensureWorkspace,
    providerRun,
    implementationReviewRunner,
    workspace,
    branchRef,
    runDir,
    factoryStateRoot,
    workItemKey,
  };
}

export function lifecycleSnapshot(factoryStateRoot: string, workItemKey: string) {
  const eventPath = actionLifecycleEventPath(factoryStateRoot, workItemKey);
  const statePath = actionLifecycleStatePath(factoryStateRoot, workItemKey);
  const events = readFileSync(eventPath, "utf8");
  const state = readFileSync(statePath, "utf8");
  return () => {
    writeFileSync(eventPath, events);
    writeFileSync(statePath, state);
  };
}

function writePassReviews(runDir: string): void {
  mkdirSync(runDir, { recursive: true });
  for (const role of ["implementation", "quality"]) {
    writeFileSync(join(runDir, `${role}-review.prompt.md`), `${role} prompt\n`);
    writeFileSync(
      join(runDir, `${role}-review.json`),
      JSON.stringify({ verdict: "pass", summary: "ok", findings: [] }),
    );
  }
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
      implementation: { verdict, findingCount: 0 },
      codeQuality: { verdict, findingCount: 0 },
    },
  };
}

export function requiredNext(receipt: Awaited<ReturnType<typeof runHostedFactoryOperation>>) {
  if (!("next" in receipt) || !receipt.next) throw new Error("next operation missing");
  return receipt.next;
}

export function expectNoProviderOrGroveCalls(value: ReturnType<typeof fixture>): void {
  expect(value.ensureWorkspace).not.toHaveBeenCalled();
  expect(value.agentProviderFactory).not.toHaveBeenCalled();
  expect(value.runProvider).not.toHaveBeenCalled();
  expect(value.providerRun).not.toHaveBeenCalled();
}

export function git(workspace: string, args: string[]): string {
  return execFileSync("git", args, { cwd: workspace, encoding: "utf8" }).trim();
}
