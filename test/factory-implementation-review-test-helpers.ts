import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, AgentRunInput, AgentRunResult, AgentSessionRef } from "../lib/agents.ts";
import {
  appendFactoryLifecycleEvent,
  deriveFactoryWorkItemKey,
  loadFactoryLifecycleState,
} from "../lib/factory-lifecycle.ts";
import { allocateFactoryRun, type FactoryRunAllocation } from "../lib/factory-run-allocation.ts";
import {
  createFactoryImplementationReviewRunContextForTest,
  type FactoryImplementationReviewRunContext,
} from "../lib/factory-implementation-review-run-context.ts";
import { createFactoryReviewHead, type FactoryCandidateTuple } from "../lib/factory-review-head.ts";
import { canonicalizeFactoryWorkspace } from "../lib/factory-locks.ts";
import {
  factoryLifecycleExecutionProvenance,
  factoryStoreMetadata,
  resolveFactoryStore,
  type FactoryStoreResolution,
} from "../lib/factory-store.ts";
import type { FactoryWorkItem } from "../lib/factory-schemas.ts";
import type { ReviewOutput } from "../lib/schemas.ts";
import type { FactoryRoleAgent } from "../lib/config.ts";
import type { ImplementationReviewCheckpoint } from "../lib/factory-implementation-review-schemas.ts";

export const REVIEW_WORK_ITEM = {
  id: "linear:ENG-123",
  source: "linear",
  title: "Automate factory implementation review and remediation",
  body: "Run the implementation review and remediation loop.",
  url: "https://linear.app/example/issue/ENG-123",
  labels: ["factory"],
  metadata: {
    tracker: {
      source: "linear",
      id: "ENG-123",
      url: "https://linear.app/example/issue/ENG-123",
    },
    factoryStage: "ready-to-implement",
    factoryRoute: "ready-to-implement",
    factoryNextAction: "implement-directly",
  },
} satisfies FactoryWorkItem;

export const IMPLEMENTER_SESSION = {
  provider: "codex",
  id: "implementation-session-1",
} satisfies AgentSessionRef;

export const PASS_REVIEW = {
  verdict: "pass",
  summary: "No findings.",
  findings: [],
} satisfies ReviewOutput;

export const NEEDS_CHANGES_REVIEW = {
  verdict: "needs_changes",
  summary: "One finding.",
  findings: [
    {
      title: "Update the implementation",
      severity: "High",
      location: "tracked.txt",
      issue: "The implementation needs one more correction.",
      recommendation: "Apply the correction and rerun review.",
      rationale: "The current candidate is incomplete.",
      must_fix: true,
    },
  ],
} satisfies ReviewOutput;

export const MIXED_REVIEW = {
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

export type ReviewFixture = {
  workspace: string;
  store: FactoryStoreResolution;
  workItem: FactoryWorkItem;
  implementationRunId: string;
  candidate: FactoryCandidateTuple;
  checkpoint: ImplementationReviewCheckpoint;
  leaseDataHome: string;
};

export function createReviewFixture(
  input: { implementerSession?: AgentSessionRef } = {},
): ReviewFixture {
  const workspace = createGitWorkspace();
  const leaseDataHome = mkdtempSync(join(tmpdir(), "harness-factory-review-data-"));
  const store = resolveFactoryStore({
    workspace,
    factoryStoreRoot: mkdtempSync(join(tmpdir(), "harness-factory-review-store-")),
    env: { ...process.env, XDG_DATA_HOME: leaseDataHome },
  });
  const workItem = REVIEW_WORK_ITEM;
  const implementerSession = input.implementerSession ?? IMPLEMENTER_SESSION;
  const workItemKey = deriveFactoryWorkItemKey(workItem);
  const implementationRunId = "implementation-run-1";
  const implementationRunDir = join(store.factoryRunsDir, implementationRunId);
  mkdirSync(join(implementationRunDir, "context"), { recursive: true });
  mkdirSync(join(implementationRunDir, "implementation"), { recursive: true });
  writeFileSync(
    join(implementationRunDir, "context/work-item.json"),
    `${JSON.stringify(workItem)}\n`,
  );
  writeFileSync(
    join(implementationRunDir, "implementation/change-review-handoff.md"),
    "# Implementation handoff\n",
  );

  appendFactoryLifecycleEvent({
    factoryStateRoot: store.factoryStateRoot,
    event: {
      version: 1,
      id: `work_item.imported:${workItemKey}`,
      type: "work_item.imported",
      workItemKey,
      occurredAt: "2026-07-10T00:00:00.000Z",
      source: "harness",
      data: { source: "linear", title: workItem.title },
      execution: factoryLifecycleExecutionProvenance(
        { workspace, runDir: implementationRunDir },
        factoryStoreMetadata(store),
      ),
    },
  });
  appendFactoryLifecycleEvent({
    factoryStateRoot: store.factoryStateRoot,
    event: {
      version: 1,
      id: "triage.completed:implementation-review-test",
      type: "triage.completed",
      workItemKey,
      occurredAt: "2026-07-10T00:00:01.000Z",
      runId: "triage-run-1",
      source: "harness",
      data: {
        route: "ready-to-implement",
        nextAction: "implement-directly",
        rationale: "Test fixture is ready.",
        routeArtifactPath: "route.md",
        triageArtifactPath: "triage.json",
      },
    },
  });
  appendFactoryLifecycleEvent({
    factoryStateRoot: store.factoryStateRoot,
    event: {
      version: 1,
      id: `implementation.started:${implementationRunId}`,
      type: "implementation.started",
      workItemKey,
      occurredAt: "2026-07-10T00:00:02.000Z",
      runId: implementationRunId,
      source: "harness",
      data: {
        linearIssue: "ENG-123",
        owner: {
          pid: process.pid,
          hostname: "test-host",
          runDir: implementationRunDir,
          startedAt: "2026-07-10T00:00:02.000Z",
        },
      },
    },
  });

  writeFileSync(join(workspace, "tracked.txt"), "implementation candidate\n");
  const reviewHead = createFactoryReviewHead({
    workspace,
    runDir: implementationRunDir,
    runId: implementationRunId,
    reviewBase: git(workspace, ["rev-parse", "HEAD"]).trim(),
  });
  const factoryStore = factoryStoreMetadata(store);
  writeFileSync(join(implementationRunDir, "implementation/summary.md"), "# Complete\n", "utf8");
  writeFileSync(join(implementationRunDir, "implementation/diff.patch"), "diff\n", "utf8");
  writeFileSync(
    join(implementationRunDir, "context/implementation-input.json"),
    `${JSON.stringify({ mode: "direct", workItem })}\n`,
    "utf8",
  );
  writeFileSync(
    join(implementationRunDir, "meta.json"),
    `${JSON.stringify({
      runId: implementationRunId,
      runDir: implementationRunDir,
      workspace,
      status: "implementation-complete",
      reviewBase: reviewHead.reviewBase,
      reviewHead: reviewHead.ref,
      reviewCommitSha: reviewHead.commit,
      reviewTree: reviewHead.tree,
      implementerSession,
      factoryStore,
      artifacts: {
        summary: "implementation/summary.md",
        implementationInput: "context/implementation-input.json",
        diff: "implementation/diff.patch",
        changeReviewHandoff: "implementation/change-review-handoff.md",
      },
    })}\n`,
    "utf8",
  );
  const workspaceProvenance = {
    ...canonicalizeFactoryWorkspace(workspace),
    factoryProjectId: store.projectId,
  };
  const runRoots = {
    factoryRunsDir: store.factoryRunsDir,
    reviewRunsDir: store.reviewRunsDir,
  };
  appendFactoryLifecycleEvent({
    factoryStateRoot: store.factoryStateRoot,
    event: {
      version: 1,
      id: `implementation.completed:${implementationRunId}`,
      type: "implementation.completed",
      workItemKey,
      occurredAt: "2026-07-10T00:00:03.000Z",
      runId: implementationRunId,
      source: "harness",
      data: {
        diffPath: "implementation/diff.patch",
        changeReviewHandoffPath: "implementation/change-review-handoff.md",
        reviewBase: reviewHead.reviewBase,
        reviewHead: reviewHead.reviewHead,
        reviewCommitSha: reviewHead.reviewCommitSha,
        candidateTree: reviewHead.treeSha,
        session: implementerSession,
        workspace: workspaceProvenance,
        runRoots,
      },
      execution: factoryLifecycleExecutionProvenance(
        { workspace, runDir: implementationRunDir },
        factoryStore,
      ),
    },
  });
  const state = loadFactoryLifecycleState({
    factoryStateRoot: store.factoryStateRoot,
    workItemKey,
    workspace,
  });
  if (!state?.implementationReviewCheckpoint) throw new Error("Fixture checkpoint was not created");
  return {
    workspace,
    store,
    workItem,
    implementationRunId,
    candidate: { ref: reviewHead.ref, commit: reviewHead.commit, tree: reviewHead.tree },
    checkpoint: state.implementationReviewCheckpoint,
    leaseDataHome,
  };
}

export function createReviewContext(
  fixture: ReviewFixture,
  provider: Agent,
  allocation?: FactoryRunAllocation,
): FactoryImplementationReviewRunContext {
  const runAllocation =
    allocation ??
    allocateFactoryRun({
      factoryRunsDir: fixture.store.reviewRunsDir,
      idPrefix: "implementation-review-test",
    });
  const factoryStore = factoryStoreMetadata(fixture.store);
  const reviewerRole: FactoryRoleAgent = {
    agent: "codex",
    model: "gpt-review",
    sandboxMode: "read-only",
    approvalPolicy: "never",
    modelReasoningEffort: "high",
  };
  const implementerRole: FactoryRoleAgent = {
    agent: "codex",
    model: "gpt-implementation",
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    modelReasoningEffort: "high",
  };
  const workspaceLeaseEnv = {
    ...process.env,
    XDG_DATA_HOME: fixture.leaseDataHome,
  };
  return createFactoryImplementationReviewRunContextForTest({
    allocation: runAllocation,
    workspace: fixture.workspace,
    workItem: fixture.workItem,
    implementationRunId: fixture.implementationRunId,
    originalReviewBase: fixture.checkpoint.originalReviewBase,
    approvedCandidate: fixture.checkpoint.approvedCandidate,
    checkpoint: fixture.checkpoint,
    factoryStore,
    reviewerRole,
    implementerRole,
    maxRuntimeMs: 10_000,
    workspaceLeaseEnv,
    agentProviderFactory: () => provider,
  });
}

export function scriptedProvider(input: {
  workspace: string;
  reviews: ReviewOutput[];
  remediation?: {
    output?: unknown;
    edit: string;
    fail?: boolean;
  };
}): Agent & { calls: AgentRunInput[] } {
  const calls: AgentRunInput[] = [];
  let reviewIndex = 0;
  return {
    name: "codex",
    calls,
    async run(runInput): Promise<AgentRunResult> {
      calls.push(runInput);
      if (runInput.schemaPath?.endsWith("review-output.schema.json")) {
        return {
          ok: true,
          structuredOutput: input.reviews[Math.min(reviewIndex++, input.reviews.length - 1)],
          raw: { kind: "review" },
          session: { provider: "codex", id: "reviewer-session" },
        };
      }
      const remediation = input.remediation;
      if (!remediation) throw new Error("Unexpected remediation invocation");
      writeFileSync(join(input.workspace, "tracked.txt"), remediation.edit);
      if (remediation.fail) {
        return { ok: false, error: "provider stopped after editing", exitCode: 1, raw: {} };
      }
      return {
        ok: true,
        structuredOutput: remediation.output,
        raw: { kind: "remediation" },
        session: IMPLEMENTER_SESSION,
      };
    },
  };
}

export function decisionsForCurrentFindings(output: "implement" | "decline" = "implement") {
  const roles = ["implementation", "quality", "simplify"] as const;
  return {
    summary: "Applied the current review decision.",
    findingDecisions: roles.map((role) => ({
      findingId: `${role}-001`,
      decision: output,
      rationale: "The finding is addressed in the workspace.",
    })),
  };
}

function createGitWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "harness-factory-implementation-review-workspace-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: workspace,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "Harness Test"], {
    cwd: workspace,
    stdio: "ignore",
  });
  writeFileSync(join(workspace, ".gitignore"), ".harness/\n");
  writeFileSync(
    join(workspace, "harness.json"),
    `${JSON.stringify({
      defaultAgent: "codex",
      agents: { codex: { model: "gpt-review" } },
      factory: {
        implementation: {
          roles: { implementer: { agent: "codex", model: "gpt-implementation" } },
        },
      },
    })}\n`,
    "utf8",
  );
  writeFileSync(join(workspace, "tracked.txt"), "initial\n");
  execFileSync("git", ["add", "."], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace, stdio: "ignore" });
  return workspace;
}

function git(workspace: string, args: string[]): string {
  return execFileSync("git", args, { cwd: workspace, encoding: "utf8" });
}
