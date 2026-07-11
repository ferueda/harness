import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { loadFactoryLifecycleState, readFactoryLifecycleEvents } from "../lib/factory-lifecycle.ts";
import { inspectFactoryWorkspaceWriterLease } from "../lib/factory-locks.ts";
import { run as runImplementationReview } from "../workflows/factory-implementation-review.workflow.ts";
import {
  createReviewContext,
  createReviewFixture,
  decisionsForCurrentFindings,
  NEEDS_CHANGES_REVIEW,
  PASS_REVIEW,
  scriptedProvider,
} from "./factory-implementation-review-test-helpers.ts";
import type { ReviewOutput } from "../lib/schemas.ts";

const NON_BLOCKING_REVIEW = {
  verdict: "needs_changes",
  summary: "One advisory finding.",
  findings: [
    {
      title: "Document the behavior",
      severity: "Low",
      location: "tracked.txt",
      issue: "The behavior needs a small documentation note.",
      recommendation: "Record the decision in the handoff.",
      rationale: "The implementation is otherwise complete.",
      must_fix: false,
    },
  ],
} satisfies ReviewOutput;

const MIXED_REVIEW = {
  verdict: "needs_changes",
  summary: "One blocking and one advisory finding.",
  findings: [
    {
      title: "Document the behavior",
      severity: "Low",
      location: "tracked.txt",
      issue: "The behavior needs a small documentation note.",
      recommendation: "Record the decision in the handoff.",
      rationale: "The implementation is otherwise complete.",
      must_fix: false,
    },
    {
      title: "Fix the implementation",
      severity: "High",
      location: "tracked.txt",
      issue: "The implementation still needs a correction.",
      recommendation: "Apply the correction before completion.",
      rationale: "The candidate is incomplete.",
      must_fix: true,
    },
  ],
} satisfies ReviewOutput;

test("passes after one complete three-role review and writes a PR-ready handoff", async () => {
  const fixture = createReviewFixture();
  const provider = scriptedProvider({ workspace: fixture.workspace, reviews: [PASS_REVIEW] });

  const result = await runImplementationReview(createReviewContext(fixture, provider));

  expect(result.status).toBe("review-complete");
  expect(result.completedReviewCount).toBe(1);
  expect(provider.calls).toHaveLength(3);
  expect(result.handoffPath).toBeDefined();
  expect(result.handoffPath!).toContain("pr-ready-handoff.md");
  const state = loadFactoryLifecycleState({
    factoryStateRoot: fixture.store.factoryStateRoot,
    workItemKey: "linear:ENG-123",
    workspace: fixture.workspace,
  });
  expect(state?.factoryStage).toBe("review-complete");
  expect(
    inspectFactoryWorkspaceWriterLease({ workspace: fixture.workspace })?.owner,
  ).toBeUndefined();
});

test("remediation creates cumulative candidate lineage and forces a full re-review", async () => {
  const fixture = createReviewFixture();
  const provider = scriptedProvider({
    workspace: fixture.workspace,
    reviews: [NEEDS_CHANGES_REVIEW, NEEDS_CHANGES_REVIEW, NEEDS_CHANGES_REVIEW, PASS_REVIEW],
    remediation: {
      edit: "remediated\n",
      output: decisionsForCurrentFindings(),
    },
  });

  const result = await runImplementationReview(createReviewContext(fixture, provider));

  expect(result.status).toBe("review-complete");
  expect(result.completedReviewCount).toBe(2);
  expect(result.candidateVersion).toBe(1);
  expect(provider.calls).toHaveLength(7);
  const parent = git(fixture.workspace, [
    "rev-parse",
    `${result.approvedCandidate.commit}^`,
  ]).trim();
  expect(parent).toBe(fixture.candidate.commit);
});

test("provider failure after edits persists a partial tuple and resume restores findings for remediation", async () => {
  const fixture = createReviewFixture();
  const failedProvider = scriptedProvider({
    workspace: fixture.workspace,
    reviews: [NEEDS_CHANGES_REVIEW],
    remediation: { edit: "partial\n", fail: true },
  });

  const first = await runImplementationReview(createReviewContext(fixture, failedProvider));

  expect(first.status).toBe("review-failed");
  expect(failedProvider.calls).toHaveLength(4);
  const failedState = loadFactoryLifecycleState({
    factoryStateRoot: fixture.store.factoryStateRoot,
    workItemKey: "linear:ENG-123",
    workspace: fixture.workspace,
  });
  const partial = failedState?.implementationReviewCheckpoint?.partialRecovery;
  expect(partial).toMatchObject({ reviewIndex: 1, attemptId: first.runId });
  expect(
    readFileSync(join(first.runDir, "iterations/1/writer-boundary-before.json"), "utf8"),
  ).toContain('"refs"');
  expect(
    readFactoryLifecycleEvents({
      factoryStateRoot: fixture.store.factoryStateRoot,
      workItemKey: "linear:ENG-123",
    }).at(-1),
  ).toMatchObject({
    type: "implementation.review.failed",
    data: {
      writerBoundaryBefore: {
        runId: first.runId,
        path: "iterations/1/writer-boundary-before.json",
      },
      writerBoundaryAfter: {
        runId: first.runId,
        path: "iterations/1/writer-boundary-after.json",
      },
    },
  });

  const resumedProvider = scriptedProvider({
    workspace: fixture.workspace,
    reviews: [PASS_REVIEW],
    remediation: {
      edit: "resumed\n",
      output: decisionsForCurrentFindings(),
    },
  });
  const resumedCheckpoint = failedState?.implementationReviewCheckpoint;
  if (!resumedCheckpoint) throw new Error("Expected failed review checkpoint");
  const second = await runImplementationReview(
    createReviewContext({ ...fixture, checkpoint: resumedCheckpoint }, resumedProvider),
  );

  expect(second.status).toBe("review-complete");
  expect(second.completedReviewCount).toBe(2);
  expect(second.candidateVersion).toBe(1);
  expect(resumedProvider.calls).toHaveLength(4);
  expect(
    inspectFactoryWorkspaceWriterLease({ workspace: fixture.workspace })?.owner,
  ).toBeUndefined();
});

test("resumed partial remediation reconstructs accepted debt from its source review", async () => {
  const fixture = createReviewFixture();
  const firstProvider = scriptedProvider({
    workspace: fixture.workspace,
    reviews: [MIXED_REVIEW],
    remediation: {
      edit: "partial mixed remediation\n",
      output: {
        summary: "Declined the advisory finding and blocking fix.",
        findingDecisions: ["implementation", "quality", "simplify"].flatMap((role) => [
          {
            findingId: `${role}-001`,
            decision: "decline" as const,
            rationale: "Track the documentation note separately.",
          },
          {
            findingId: `${role}-002`,
            decision: "decline" as const,
            rationale: "The blocking fix needs another attempt.",
          },
        ]),
      },
    },
  });

  const first = await runImplementationReview(createReviewContext(fixture, firstProvider));
  expect(first.status).toBe("ready-for-human");

  const failedState = loadFactoryLifecycleState({
    factoryStateRoot: fixture.store.factoryStateRoot,
    workItemKey: "linear:ENG-123",
    workspace: fixture.workspace,
  });
  const resumedCheckpoint = failedState?.implementationReviewCheckpoint;
  if (!resumedCheckpoint) throw new Error("Expected partial remediation checkpoint");

  const resumedProvider = scriptedProvider({
    workspace: fixture.workspace,
    reviews: [PASS_REVIEW],
    remediation: {
      edit: "completed mixed remediation\n",
      output: {
        summary: "Applied the blocking fix and retained the advisory debt.",
        findingDecisions: ["implementation", "quality", "simplify"].flatMap((role) => [
          {
            findingId: `${role}-001`,
            decision: "decline" as const,
            rationale: "Track the documentation note separately.",
          },
          {
            findingId: `${role}-002`,
            decision: "implement" as const,
            rationale: "Applied the blocking correction.",
          },
        ]),
      },
    },
  });
  const second = await runImplementationReview(
    createReviewContext({ ...fixture, checkpoint: resumedCheckpoint }, resumedProvider),
  );

  expect(second.status).toBe("review-complete");
  expect(second.handoffPath && readFile(second.handoffPath)).toContain(
    "implementation-001: Track the documentation note separately.",
  );
});

test("mixed non-blocking declines remain accepted debt", async () => {
  const fixture = createReviewFixture();
  const provider = scriptedProvider({
    workspace: fixture.workspace,
    reviews: [NON_BLOCKING_REVIEW],
    remediation: {
      edit: "implementation candidate\n",
      output: {
        summary: "Accepted the advisory debt.",
        findingDecisions: ["implementation", "quality", "simplify"].map((role) => ({
          findingId: `${role}-001`,
          decision: "decline" as const,
          rationale: "The advisory documentation can follow in a later change.",
        })),
      },
    },
  });

  const result = await runImplementationReview(createReviewContext(fixture, provider));

  expect(result.status).toBe("review-complete");
  expect(result.handoffPath).toBeDefined();
  expect(result.handoffPath && readFile(result.handoffPath)).toContain(
    "implementation-001: The advisory documentation can follow in a later change.",
  );
});

test("incompatible implementer sessions become ready-for-human without invocation", async () => {
  const fixture = createReviewFixture();
  const provider = scriptedProvider({
    workspace: fixture.workspace,
    reviews: [NEEDS_CHANGES_REVIEW],
  });
  const result = await runImplementationReview(
    createReviewContext(
      {
        ...fixture,
        checkpoint: {
          ...fixture.checkpoint,
          implementerSession: { provider: "cursor", id: "cursor-session" },
        },
      },
      provider,
    ),
  );

  expect(result.status).toBe("ready-for-human");
  expect(provider.calls).toHaveLength(3);
});

function git(workspace: string, args: string[]): string {
  // Kept local so the test asserts the actual Git parent rather than coordinator metadata.
  return execFileSync("git", args, { cwd: workspace, encoding: "utf8" });
}

function readFile(path: string): string {
  return readFileSync(path, "utf8");
}
