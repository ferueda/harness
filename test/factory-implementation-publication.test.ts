import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { factoryActionKey } from "../lib/factory-action-contract.ts";
import {
  markImplementationPullRequestMerged,
  publishImplementationPullRequest,
} from "../lib/factory-implementation-publication.ts";
import {
  appendFactoryActionEvent,
  readFactoryActionEvents,
} from "../lib/factory-lifecycle-kernel.ts";
import type { FactoryLifecycleEvent } from "../lib/factory-lifecycle-events.ts";
import { writeFactoryPhaseRunIdentity } from "../lib/factory-phase-run.ts";
import type { FactoryCommandRunner } from "../lib/factory-pull-request-publisher.ts";
import { ensureFactoryStoreFormat } from "../lib/factory-store-format.ts";

test("publishes the exact reviewed implementation once and closes only with a containing commit", async () => {
  const fixture = implementationFixture();
  let pullRequests: unknown[] = [];
  const creates = vi.fn<() => void>();
  const runner: FactoryCommandRunner = (command, args, options) => {
    if (command === "git" && args[0] === "remote" && args[1] === "get-url")
      return "git@github.com:owner/repo.git\n";
    if (command === "git") {
      const localArgs = [...args];
      if (localArgs[0] === "ls-remote") localArgs[2] = "origin";
      if (localArgs[0] === "push") localArgs[1] = "origin";
      return execFileSync("git", localArgs, { cwd: options.cwd, encoding: "utf8" });
    }
    if (args[1] === "list") return JSON.stringify(pullRequests);
    if (args[1] === "create") {
      creates();
      pullRequests = [
        {
          url: "https://example.test/repo/pull/7",
          baseRefName: "main",
          headRefName: "feature",
          headRefOid: fixture.reviewedHead,
        },
      ];
      return "https://example.test/repo/pull/7\n";
    }
    throw new Error(`unexpected gh command ${args.join(" ")}`);
  };
  const publishedProjection = vi.fn<() => Promise<void>>(async () => undefined);
  const mergedProjection = vi.fn<() => Promise<void>>(async () => undefined);
  const common = {
    workspace: fixture.workspace,
    factoryStateRoot: fixture.factoryStateRoot,
    factoryStore: fixture.store,
    workItem: fixture.workItem,
    issueRef: "ENG-7",
    applyAdapter: {
      applyImplementationPublished: publishedProjection,
      applyImplementationMerged: mergedProjection,
    } as never,
  };

  const first = await publishImplementationPullRequest({ ...common, commandRunner: runner });
  const retry = await publishImplementationPullRequest({ ...common, commandRunner: runner });
  expect(first.state).toMatchObject({
    status: "awaiting-pr-merge",
    implementationPrUrl: "https://example.test/repo/pull/7",
    implementationPrHead: fixture.reviewedHead,
  });
  expect(retry.event.id).toBe(first.event.id);
  expect(creates).toHaveBeenCalledTimes(1);
  expect(publishedProjection).toHaveBeenCalledTimes(2);
  expect(
    readFactoryActionEvents(fixture.factoryStateRoot, fixture.key).filter(
      (event) => event.type === "implementation_pr.opened",
    ),
  ).toHaveLength(1);

  writeFileSync(join(fixture.workspace, "repair.txt"), "repair\n");
  git(fixture.workspace, ["add", "repair.txt"]);
  git(fixture.workspace, ["commit", "-m", "repair"]);
  const mergeCommit = git(fixture.workspace, ["rev-parse", "HEAD"]).trim();
  const merged = await markImplementationPullRequestMerged({
    ...common,
    url: "https://example.test/repo/pull/7",
    commit: mergeCommit,
  });
  expect(merged.state).toMatchObject({
    status: "complete",
    implementationMergeCommit: mergeCommit,
  });
  expect(mergedProjection).toHaveBeenCalledOnce();
  expect(publishedProjection).toHaveBeenCalledTimes(3);
});

test("merge acknowledgement rejects the wrong PR and unrelated commit", async () => {
  const fixture = implementationFixture();
  append(fixture.factoryStateRoot, {
    version: 1,
    id: `implementation_pr.opened:${fixture.runId}`,
    type: "implementation_pr.opened",
    workItemKey: fixture.key,
    occurredAt: at(6),
    phaseRunId: fixture.runId,
    data: { url: "https://example.test/repo/pull/7", head: fixture.reviewedHead },
  });
  await expect(
    markImplementationPullRequestMerged({
      workspace: fixture.workspace,
      factoryStateRoot: fixture.factoryStateRoot,
      factoryStore: fixture.store,
      workItem: fixture.workItem,
      url: "https://example.test/repo/pull/8",
      commit: fixture.reviewedHead,
    }),
  ).rejects.toThrow(/URL does not match/);
  const unrelated = git(fixture.workspace, [
    "commit-tree",
    "HEAD^{tree}",
    "-m",
    "unrelated",
  ]).trim();
  await expect(
    markImplementationPullRequestMerged({
      workspace: fixture.workspace,
      factoryStateRoot: fixture.factoryStateRoot,
      factoryStore: fixture.store,
      workItem: fixture.workItem,
      url: "https://example.test/repo/pull/7",
      commit: unrelated,
    }),
  ).rejects.toThrow(/does not contain reviewed head/);
});

function implementationFixture() {
  const root = mkdtempSync(join(tmpdir(), "factory-implementation-publication-"));
  const workspace = join(root, "workspace");
  const origin = join(root, "origin.git");
  execFileSync("git", ["init", "--bare", origin]);
  execFileSync("git", ["init", "-b", "main", workspace]);
  git(workspace, ["config", "user.name", "Test"]);
  git(workspace, ["config", "user.email", "test@example.com"]);
  writeFileSync(join(workspace, "base.txt"), "base\n");
  git(workspace, ["add", "base.txt"]);
  git(workspace, ["commit", "-m", "base"]);
  const baseSha = git(workspace, ["rev-parse", "HEAD"]).trim();
  git(workspace, ["remote", "add", "origin", origin]);
  git(workspace, ["push", "-u", "origin", "main"]);
  git(workspace, ["switch", "-c", "feature"]);
  writeFileSync(join(workspace, "feature.txt"), "feature\n");
  git(workspace, ["add", "feature.txt"]);
  git(workspace, ["commit", "-m", "feature"]);
  const reviewedHead = git(workspace, ["rev-parse", "HEAD"]).trim();

  const projectRoot = join(root, "store");
  const factoryStateRoot = join(projectRoot, "factory");
  ensureFactoryStoreFormat(factoryStateRoot);
  const runId = "implementation-run";
  const runDir = join(projectRoot, "runs/factory", runId);
  mkdirSync(join(runDir, "context"), { recursive: true });
  const key = "linear:ENG-7";
  writeFileSync(
    join(runDir, "context/work-item.json"),
    `${JSON.stringify({ id: key, source: "linear", title: "Feature", body: "", labels: [] })}\n`,
  );
  const ref = artifact("inputs/item");
  writeFactoryPhaseRunIdentity(runDir, {
    version: 1,
    phase: "implementation",
    phaseRunId: runId,
    workItemKey: key,
    workspace,
    projectId: "repo",
    factoryStateRoot,
    reviewCeiling: 2,
    baseRef: "main",
    branchRef: "refs/heads/feature",
    baseSha,
    input: {
      mode: "direct",
      importedEventId: "work_item.imported:linear:ENG-7",
      readinessEventId: "triage-complete",
      workItem: ref,
      readiness: artifact("inputs/readiness"),
    },
    actions: {
      produceImplementationCandidate: { provider: "cursor", model: "test" },
      reviewImplementationCandidate: { provider: "cursor", model: "test" },
    },
  });
  const events = lifecycle(key, runId, reviewedHead);
  for (const event of events) append(factoryStateRoot, event);
  return {
    workspace,
    factoryStateRoot,
    key,
    runId,
    reviewedHead,
    workItem: { id: key, source: "linear" as const, title: "Feature", body: "", labels: [] },
    store: {
      storeRoot: projectRoot,
      projectId: "repo",
      projectRoot,
      factoryStateRoot,
      factoryRunsDir: join(projectRoot, "runs/factory"),
      reviewRunsDir: join(projectRoot, "runs/reviews"),
      repo: { name: "repo", id: "repo", idSource: "config" as const },
      overrides: {},
      warnings: [],
    },
  };
}

function lifecycle(key: string, runId: string, head: string): FactoryLifecycleEvent[] {
  const ref = artifact("evidence/ref");
  const execution = { workspaceRef: "repo", runRef: ref };
  const triageId = `triage.work_item.completed:${factoryActionKey({
    phaseRunId: "triage-run",
    handler: "triageWorkItem",
    attempt: 1,
    causationEventId: "triage.requested:triage-run",
  })}`;
  const candidateId = `implementation.candidate.produced:${factoryActionKey({
    phaseRunId: runId,
    handler: "produceImplementationCandidate",
    attempt: 1,
    causationEventId: `implementation.requested:${runId}`,
  })}`;
  const reviewId = `implementation.review.completed:${factoryActionKey({
    phaseRunId: runId,
    handler: "reviewImplementationCandidate",
    attempt: 1,
    causationEventId: candidateId,
  })}`;
  return [
    {
      version: 1,
      id: `work_item.imported:${key}`,
      type: "work_item.imported",
      workItemKey: key,
      occurredAt: at(0),
      data: { source: "linear" },
    },
    {
      version: 1,
      id: "triage.requested:triage-run",
      type: "triage.requested",
      workItemKey: key,
      occurredAt: at(1),
      phaseRunId: "triage-run",
      data: { expectedPredecessor: `work_item.imported:${key}`, inputRefs: [ref], intent: "start" },
    },
    {
      version: 1,
      id: triageId,
      type: "triage.work_item.completed",
      workItemKey: key,
      occurredAt: at(2),
      phaseRunId: "triage-run",
      data: {
        handler: "triageWorkItem",
        handlerVersion: 1,
        attempt: 1,
        causationEventId: "triage.requested:triage-run",
        execution,
        evidence: [ref],
        route: "ready-to-implement",
        rationale: "ready",
      },
    },
    {
      version: 1,
      id: `implementation.requested:${runId}`,
      type: "implementation.requested",
      workItemKey: key,
      occurredAt: at(3),
      phaseRunId: runId,
      data: {
        expectedPredecessor: triageId,
        inputRefs: [ref],
        reviewCeiling: 2,
        intent: "start",
      },
    },
    {
      version: 1,
      id: candidateId,
      type: "implementation.candidate.produced",
      workItemKey: key,
      occurredAt: at(4),
      phaseRunId: runId,
      data: {
        handler: "produceImplementationCandidate",
        handlerVersion: 1,
        attempt: 1,
        causationEventId: `implementation.requested:${runId}`,
        execution,
        evidence: [ref],
        commit: head,
        tree: "tree",
        candidate: ref,
        effectiveSession: { provider: "cursor", id: "session" },
      },
    },
    {
      version: 1,
      id: reviewId,
      type: "implementation.review.completed",
      workItemKey: key,
      occurredAt: at(5),
      phaseRunId: runId,
      data: {
        handler: "reviewImplementationCandidate",
        handlerVersion: 1,
        attempt: 1,
        causationEventId: candidateId,
        execution,
        evidence: [ref],
        verdict: "pass",
        review: ref,
        reviewCeiling: 2,
      },
    },
  ];
}

function append(root: string, event: FactoryLifecycleEvent): void {
  const events = readFactoryActionEvents(root, event.workItemKey);
  appendFactoryActionEvent({
    factoryStateRoot: root,
    event,
    expectedLastEventId: events.at(-1)?.id ?? null,
  });
}

function artifact(path: string) {
  return { base: "factory-store" as const, path, sha256: "a".repeat(64) };
}

function at(second: number): string {
  return `2026-07-13T00:00:0${second}.000Z`;
}

function git(workspace: string, args: string[]): string {
  return execFileSync("git", args, { cwd: workspace, encoding: "utf8" });
}
