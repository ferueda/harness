import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { Agent, AgentRunInput } from "../lib/agents.ts";
import { createFactoryArtifactRef, verifyFactoryArtifactRef } from "../lib/factory-artifact-ref.ts";
import { factoryActionKey } from "../lib/factory-action-contract.ts";
import {
  observeFactoryContinuation,
  recordFactoryContinuation,
} from "../lib/factory-continuation.ts";
import { producePlanCandidate } from "../lib/factory-plan-candidate-action.ts";
import { reviewPlanCandidate } from "../lib/factory-plan-review-action.ts";
import {
  appendFactoryActionEvent,
  readFactoryActionEvents,
} from "../lib/factory-lifecycle-kernel.ts";
import type { FactoryLifecycleEvent } from "../lib/factory-lifecycle-events.ts";
import {
  createFactoryPlanningRunContext,
  openFactoryPlanningRunContext,
} from "../lib/factory-planning-run-context.ts";
import type { FactoryWorkItem } from "../lib/factory-schemas.ts";
import { deriveFactoryWorkItemKey } from "../lib/factory-lifecycle.ts";
import { ensureFactoryStoreFormat } from "../lib/factory-store-format.ts";
import type { FactoryStoreMeta } from "../lib/factory-store.ts";
import { decideNextFactoryAction } from "../lib/factory-state-machine.ts";

const relocatedRoots: string[] = [];
afterEach(() => {
  for (const root of relocatedRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("relocated planning uses the validated Grove workspace for provider and scratch", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-planning-relocated-"));
  relocatedRoots.push(root);
  const controller = join(root, "controller");
  mkdirSync(controller);
  git(controller, ["init", "--initial-branch=main"]);
  git(controller, ["config", "user.name", "Factory Test"]);
  git(controller, ["config", "user.email", "factory@example.test"]);
  git(controller, ["remote", "add", "origin", "https://example.test/repo.git"]);
  writeFileSync(join(controller, "README.md"), "fixture\n");
  git(controller, ["add", "README.md"]);
  git(controller, ["commit", "-m", "fixture"]);

  const projectRoot = join(root, "store");
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
    id: "item-relocated",
    source: "file",
    title: "Relocated plan",
    body: "Ship it",
    labels: [],
  };
  const created = createFactoryPlanningRunContext({
    workspace: controller,
    runsDir: store.factoryRunsDir,
    workItem,
    plannerRole: { agent: "cursor", model: "planner" },
    reviewerRole: { agent: "cursor", model: "reviewer" },
    outputPlan: "dev/plans/relocated.md",
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
    factoryStore: store,
  });
  git(controller, ["checkout", "--detach"]);
  const groveWorkspace = join(root, "grove-workspace");
  git(controller, ["worktree", "add", groveWorkspace, "main"]);
  const ctx = openFactoryPlanningRunContext({
    workspace: groveWorkspace,
    runsDir: store.factoryRunsDir,
    phaseRunId: created.runId,
    workItem,
    factoryStore: store,
  });
  const workItemRef = createFactoryArtifactRef({
    base: "factory-store",
    root: projectRoot,
    path: `runs/factory/${created.runId}/context/work-item.json`,
  });
  const imported: FactoryLifecycleEvent = {
    version: 1,
    id: "import:relocated",
    type: "work_item.imported",
    workItemKey: deriveFactoryWorkItemKey(workItem),
    occurredAt: new Date().toISOString(),
    data: { source: "file" },
  };
  appendFactoryActionEvent({ factoryStateRoot, event: imported, expectedLastEventId: null });
  const requested: FactoryLifecycleEvent = {
    version: 1,
    id: `planning.requested:${created.runId}`,
    type: "planning.requested",
    workItemKey: deriveFactoryWorkItemKey(workItem),
    occurredAt: new Date().toISOString(),
    phaseRunId: created.runId,
    data: {
      expectedPredecessor: imported.id,
      inputRefs: [workItemRef],
      intent: "start",
      publicationMode: "local",
      outputPlan: "dev/plans/relocated.md",
    },
  };
  const start = appendFactoryActionEvent({
    factoryStateRoot,
    event: requested,
    expectedLastEventId: imported.id,
  });
  const providerWorkspaces: string[] = [];
  await producePlanCandidate({
    ctx,
    factoryStateRoot,
    reaction: invoke(start),
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({
      name: "cursor",
      async run(input) {
        providerWorkspaces.push(input.workspace);
        writeFileSync(plannerDraftPath(input), "# Relocated\n");
        return successfulPlannerResult();
      },
    }),
  });

  expect(ctx.workspace).toBe(realpathSync(groveWorkspace));
  expect(providerWorkspaces).toEqual([realpathSync(groveWorkspace)]);
  expect(existsSync(join(groveWorkspace, ".harness/factory-drafts", created.runId))).toBe(true);
  expect(existsSync(join(controller, ".harness/factory-drafts", created.runId))).toBe(false);
});

test("candidate and review actions step separately and revisions resume the planner session", async () => {
  const { ctx, factoryStateRoot, start } = planningActionFixture();
  const { workspace } = ctx;
  const providerCalls: AgentRunInput[] = [];
  const providerFactory = () => ({
    name: "cursor" as const,
    async run(input: AgentRunInput) {
      providerCalls.push(input);
      const draft = /Draft path:\s+```text\s+([^\n]+)/.exec(input.prompt)?.[1];
      if (!draft) throw new Error("missing draft path");
      writeFileSync(draft, providerCalls.length === 1 ? "# First\n" : "# Revised\n");
      return {
        ok: true as const,
        structuredOutput: {
          outcome: "draft-ready",
          summary: "ready",
          humanQuestions: [],
          findingDecisions:
            providerCalls.length === 1
              ? []
              : [{ findingId: "spec-001", decision: "implement", rationale: "fixed" }],
        },
        raw: unchangedWorkspace(),
        session: { provider: "cursor" as const, id: "planner-session", raw: { transient: true } },
      };
    },
  });
  const first = await producePlanCandidate({
    ctx,
    factoryStateRoot,
    reaction: invoke(start),
    maxRuntimeMs: 1_000,
    agentProviderFactory: providerFactory,
  });
  expect(providerCalls).toHaveLength(1);
  expect(first.event).toMatchObject({
    type: "planning.candidate.produced",
    data: { effectiveSession: { provider: "cursor", id: "planner-session" } },
  });
  if (first.event.type !== "planning.candidate.produced") throw new Error("expected candidate");
  expect(first.event.data.effectiveSession).not.toHaveProperty("raw");

  let reviewCount = 0;
  const reviewRunner = async (reviewCtx: { runDir?: string }) => {
    reviewCount += 1;
    mkdirSync(reviewCtx.runDir!, { recursive: true });
    if (reviewCount === 2) {
      const handoff = readFileSync(join(reviewCtx.runDir!, "context/handoff.md"), "utf8");
      expect(handoff).toContain("selected revise");
      expect(handoff).toContain("Apply the plan blocker.");
      expect(handoff).toContain("# Prior review result");
      expect(handoff).toContain('"title": "Blocker"');
    }
    writeFileSync(
      join(reviewCtx.runDir!, "spec-review.json"),
      JSON.stringify(
        reviewCount === 1
          ? {
              verdict: "needs_changes",
              summary: "fix",
              findings: [
                {
                  title: "Blocker",
                  severity: "High",
                  location: "plan",
                  issue: "missing",
                  recommendation: "add",
                  rationale: "required",
                  must_fix: true,
                },
                {
                  title: "Advisory context",
                  severity: "Low",
                  location: "verification",
                  issue: "optional detail",
                  recommendation: "consider it",
                  rationale: "non-blocking",
                  must_fix: false,
                },
              ],
            }
          : { verdict: "pass", summary: "ok", findings: [] },
      ),
    );
    return { status: "completed", verdict: reviewCount === 1 ? "needs_changes" : "pass" };
  };
  await reviewPlanCandidate({
    ctx,
    factoryStateRoot,
    reaction: invoke(first),
    maxRuntimeMs: 1_000,
    agentProviderFactory: providerFactory,
    reviewRunner: reviewRunner as never,
  });
  expect(reviewCount).toBe(1);
  const continued = continuePlanning(ctx, factoryStateRoot, "revise", "Apply the plan blocker.");
  const revised = await producePlanCandidate({
    ctx,
    factoryStateRoot,
    reaction: invoke(continued),
    maxRuntimeMs: 1_000,
    agentProviderFactory: providerFactory,
  });
  expect(providerCalls).toHaveLength(2);
  expect(providerCalls[1]?.session).toEqual({ provider: "cursor", id: "planner-session" });
  expect(providerCalls[1]?.prompt).toContain("spec-001");
  expect(providerCalls[1]?.prompt).toContain("Apply the plan blocker.");
  const approved = await reviewPlanCandidate({
    ctx,
    factoryStateRoot,
    reaction: invoke(revised),
    maxRuntimeMs: 1_000,
    agentProviderFactory: providerFactory,
    reviewRunner: reviewRunner as never,
  });
  expect(reviewCount).toBe(2);
  expect(approved.state).toMatchObject({ phase: "planning", status: "approved" });
  expect(readFileSync(join(workspace, "dev/plans/item-1.md"), "utf8")).toBe("# Revised\n");
  const telemetry = readFileSync(join(ctx.runDir, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string; stepId?: string });
  expect(
    telemetry.filter(
      (event) => event.type === "run:end" && event.stepId === "producePlanCandidate",
    ),
  ).toHaveLength(2);
  expect(
    telemetry.filter((event) => event.type === "run:end" && event.stepId === "reviewPlanCandidate"),
  ).toHaveLength(2);
});

test("accepted evidence re-reviews the exact plan candidate without invoking the planner", async () => {
  const fixture = planningActionFixture();
  const plannerRun = vi.fn<Agent["run"]>(async (input: AgentRunInput) => {
    writeFileSync(plannerDraftPath(input), "# Candidate\n");
    return successfulPlannerResult();
  });
  const candidate = await producePlanCandidate({
    ctx: fixture.ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction: invoke(fixture.start),
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({ name: "cursor", run: plannerRun }),
  });
  let reviewRound = 0;
  let reReviewHandoff = "";
  const reviewRunner = async (reviewCtx: { runDir?: string }) => {
    reviewRound += 1;
    mkdirSync(reviewCtx.runDir!, { recursive: true });
    if (reviewRound === 2)
      reReviewHandoff = readFileSync(join(reviewCtx.runDir!, "context/handoff.md"), "utf8");
    writeFileSync(
      join(reviewCtx.runDir!, "spec-review.json"),
      JSON.stringify(
        reviewRound === 1
          ? {
              verdict: "needs_changes",
              summary: "proof required",
              findings: [
                {
                  title: "External proof",
                  severity: "High",
                  location: "verification",
                  issue: "proof missing",
                  recommendation: "attach proof",
                  rationale: "required",
                  must_fix: true,
                },
                {
                  title: "Advisory context",
                  severity: "Low",
                  location: "verification",
                  issue: "optional detail",
                  recommendation: "consider it",
                  rationale: "non-blocking",
                  must_fix: false,
                },
              ],
            }
          : { verdict: "pass", summary: "proof accepted", findings: [] },
      ),
    );
    return { status: "completed", verdict: reviewRound === 1 ? "needs_changes" : "pass" };
  };
  const firstReview = await reviewPlanCandidate({
    ctx: fixture.ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction: invoke(candidate),
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
    reviewRunner: reviewRunner as never,
  });
  expect(firstReview.state).toMatchObject({ status: "awaiting-continuation" });
  const continued = continuePlanning(
    fixture.ctx,
    fixture.factoryStateRoot,
    "re-review",
    "The required external proof is attached and accepted.",
  );
  expect(continued.next).toMatchObject({
    handler: "reviewPlanCandidate",
    attempt: 2,
    reason: "operator-re-review",
  });

  const approved = await reviewPlanCandidate({
    ctx: fixture.ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction: invoke(continued),
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
    reviewRunner: reviewRunner as never,
  });

  expect(approved.state).toMatchObject({ status: "approved" });
  expect(plannerRun).toHaveBeenCalledTimes(1);
  expect(reviewRound).toBe(2);
  expect(reReviewHandoff).toContain("The required external proof is attached and accepted.");
  expect(reReviewHandoff).toContain("External proof");
  expect(reReviewHandoff).toContain("Advisory context");
  expect(candidateBytes(fixture.ctx, candidate.event)).toBe("# Candidate\n");
});

test("plan review receives the durable Factory work item as original-intent authority", async () => {
  const fixture = planningActionFixture();
  const candidate = await produceTestCandidate(fixture);
  const reviewerRun = vi.fn<Agent["run"]>(async () => ({
    ok: true,
    structuredOutput: { verdict: "pass", summary: "approved", findings: [] },
    raw: unchangedWorkspace(),
  }));

  const reviewed = await reviewPlanCandidate({
    ctx: fixture.ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction: invoke(candidate),
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({ name: "cursor", run: reviewerRun }),
  });

  expect(reviewerRun).toHaveBeenCalledTimes(1);
  const prompt = reviewerRun.mock.calls[0]?.[0].prompt;
  expect(prompt).toContain("# Factory work-item authority");
  expect(prompt).toContain('"id": "item-1"');
  expect(prompt).toContain('"body": "Ship it"');
  expect(reviewed.event).toMatchObject({
    type: "planning.review.completed",
    data: { verdict: "pass" },
  });
});

test("tampered continuation response cannot trigger a re-review", async () => {
  const fixture = planningActionFixture();
  const candidate = await produceTestCandidate(fixture);
  const firstReview = await reviewPlanCandidate({
    ctx: fixture.ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction: invoke(candidate),
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
    reviewRunner: (async (reviewCtx: { runDir?: string }) => {
      mkdirSync(reviewCtx.runDir!, { recursive: true });
      writeFileSync(
        join(reviewCtx.runDir!, "spec-review.json"),
        JSON.stringify({
          verdict: "needs_changes",
          summary: "proof required",
          findings: [
            {
              title: "External proof",
              severity: "High",
              location: "verification",
              issue: "proof missing",
              recommendation: "attach proof",
              rationale: "required",
              must_fix: true,
            },
          ],
        }),
      );
      return { status: "completed", verdict: "needs_changes" };
    }) as never,
  });
  expect(firstReview.state).toMatchObject({ status: "awaiting-continuation" });
  const continued = continuePlanning(
    fixture.ctx,
    fixture.factoryStateRoot,
    "re-review",
    "Accepted proof.",
  );
  if (continued.event.type !== "factory.continuation.recorded")
    throw new Error("expected continuation");
  const responsePath = verifyFactoryArtifactRef(continued.event.data.response, {
    "factory-store": fixture.ctx.factoryStore.projectRoot,
    repository: fixture.ctx.workspace,
  });
  writeFileSync(responsePath, "Tampered proof.\n");
  const reviewer = vi.fn<Agent["run"]>();

  await expect(
    reviewPlanCandidate({
      ctx: fixture.ctx,
      factoryStateRoot: fixture.factoryStateRoot,
      reaction: invoke(continued),
      maxRuntimeMs: 1_000,
      agentProviderFactory: () => ({ name: "cursor", run: reviewer }),
    }),
  ).rejects.toThrow(/artifact hash mismatch/);
  expect(reviewer).not.toHaveBeenCalled();
});

test("tampered revision response retains a valid plan candidate", async () => {
  const fixture = planningActionFixture();
  const candidate = await produceTestCandidate(fixture);
  if (candidate.event.type !== "planning.candidate.produced") throw new Error("candidate");
  const continued = continuePlanning(
    fixture.ctx,
    fixture.factoryStateRoot,
    "revise",
    "Correct the plan without abandoning the accepted candidate.",
  );
  if (continued.event.type !== "factory.continuation.recorded") throw new Error("continuation");
  const responsePath = verifyFactoryArtifactRef(continued.event.data.response, {
    "factory-store": fixture.ctx.factoryStore.projectRoot,
    repository: fixture.ctx.workspace,
  });
  writeFileSync(responsePath, "Tampered response.\n");
  const provider = vi.fn<Agent["run"]>();

  const failed = await producePlanCandidate({
    ctx: fixture.ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction: invoke(continued),
    maxRuntimeMs: 1_000,
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

test("tampered revision candidate clears reusable plan identity", async () => {
  const fixture = planningActionFixture();
  const candidate = await produceTestCandidate(fixture);
  if (candidate.event.type !== "planning.candidate.produced") throw new Error("candidate");
  const continued = continuePlanning(
    fixture.ctx,
    fixture.factoryStateRoot,
    "revise",
    "Correct the plan.",
  );
  const candidatePath = verifyFactoryArtifactRef(candidate.event.data.candidate, {
    "factory-store": fixture.ctx.factoryStore.projectRoot,
    repository: fixture.ctx.workspace,
  });
  writeFileSync(candidatePath, "# Tampered candidate\n");
  const provider = vi.fn<Agent["run"]>();

  const failed = await producePlanCandidate({
    ctx: fixture.ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction: invoke(continued),
    maxRuntimeMs: 1_000,
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

test("tampered plan candidate clears reusable identity for a clean rerun", async () => {
  const fixture = planningActionFixture();
  const candidate = await produceTestCandidate(fixture);
  if (candidate.event.type !== "planning.candidate.produced") throw new Error("candidate");
  const candidatePath = verifyFactoryArtifactRef(candidate.event.data.candidate, {
    "factory-store": fixture.ctx.factoryStore.projectRoot,
    repository: fixture.ctx.workspace,
  });
  writeFileSync(candidatePath, "# Tampered\n");
  const reviewer = vi.fn<Agent["run"]>();

  const failed = await reviewPlanCandidate({
    ctx: fixture.ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction: invoke(candidate),
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({ name: "cursor", run: reviewer }),
  });

  expect(failed.event).toMatchObject({
    type: "factory.action.failed",
    data: { failureKind: "terminal" },
  });
  expect(failed.state).toMatchObject({ status: "failed" });
  expect(failed.state).not.toHaveProperty("candidateEventId");
  expect(reviewer).not.toHaveBeenCalled();
});

test("first candidate recovery publishes staged draft bytes without rerunning the provider", async () => {
  const fixture = planningActionFixture();
  const reaction = invoke(fixture.start);
  const actionDir = planningActionDir(fixture.ctx, reaction);
  mkdirSync(join(actionDir, "planner.json"), { recursive: true });
  const providerRun = vi.fn<Agent["run"]>(async (input: AgentRunInput) => {
    const draft = plannerDraftPath(input);
    writeFileSync(draft, "# Produced first\n");
    return successfulPlannerResult();
  });
  const actionInput = {
    ctx: fixture.ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction,
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({ name: "cursor" as const, run: providerRun }),
  };

  await expect(producePlanCandidate(actionInput)).rejects.toThrow(/EISDIR|directory/i);
  rmSync(join(actionDir, "planner.json"), { recursive: true });
  writeFileSync(fixture.ctx.preparePlannerScratch().draftPath, "# Changed scratch\n");

  const recovered = await producePlanCandidate(actionInput);
  expect(providerRun).toHaveBeenCalledTimes(1);
  expect(candidateBytes(fixture.ctx, recovered.event)).toBe("# Produced first\n");
});

test("revision recovery publishes its staged draft instead of restoring the predecessor", async () => {
  const fixture = planningActionFixture();
  const first = await producePlanCandidate({
    ctx: fixture.ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction: invoke(fixture.start),
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({
      name: "cursor",
      async run(input) {
        writeFileSync(plannerDraftPath(input), "# Predecessor\n");
        return successfulPlannerResult();
      },
    }),
  });
  await reviewPlanCandidate({
    ctx: fixture.ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction: invoke(first),
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
    reviewRunner: (async (reviewCtx: { runDir?: string }) => {
      mkdirSync(reviewCtx.runDir!, { recursive: true });
      writeFileSync(
        join(reviewCtx.runDir!, "spec-review.json"),
        JSON.stringify({
          verdict: "needs_changes",
          summary: "revise",
          findings: [
            {
              title: "Blocker",
              severity: "High",
              location: "plan",
              issue: "missing",
              recommendation: "add",
              rationale: "required",
              must_fix: true,
            },
          ],
        }),
      );
      return { status: "completed", verdict: "needs_changes" };
    }) as never,
  });
  const continued = continuePlanning(
    fixture.ctx,
    fixture.factoryStateRoot,
    "revise",
    "Apply the plan blocker.",
  );
  const reaction = invoke(continued);
  const actionDir = planningActionDir(fixture.ctx, reaction);
  mkdirSync(join(actionDir, "planner.json"), { recursive: true });
  const providerRun = vi.fn<Agent["run"]>(async (input: AgentRunInput) => {
    expect(input.session).toEqual({ provider: "cursor", id: "planner-session" });
    writeFileSync(plannerDraftPath(input), "# Produced revision\n");
    return successfulPlannerResult([
      { findingId: "spec-001", decision: "implement", rationale: "fixed" },
    ]);
  });
  const actionInput = {
    ctx: fixture.ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction,
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({ name: "cursor" as const, run: providerRun }),
  };

  await expect(producePlanCandidate(actionInput)).rejects.toThrow(/EISDIR|directory/i);
  rmSync(join(actionDir, "planner.json"), { recursive: true });
  writeFileSync(fixture.ctx.preparePlannerScratch().draftPath, "# Predecessor\n");

  const recovered = await producePlanCandidate(actionInput);
  expect(providerRun).toHaveBeenCalledTimes(1);
  expect(candidateBytes(fixture.ctx, recovered.event)).toBe("# Produced revision\n");
});

test("candidate recovery records a terminal failure for a corrupt staged artifact", async () => {
  const fixture = planningActionFixture();
  const reaction = invoke(fixture.start);
  const actionDir = planningActionDir(fixture.ctx, reaction);
  mkdirSync(join(actionDir, "planner.json"), { recursive: true });
  const providerRun = vi.fn<Agent["run"]>(async (input: AgentRunInput) => {
    writeFileSync(plannerDraftPath(input), "# Produced first\n");
    return successfulPlannerResult();
  });
  const actionInput = {
    ctx: fixture.ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction,
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({ name: "cursor" as const, run: providerRun }),
  };

  await expect(producePlanCandidate(actionInput)).rejects.toThrow(/EISDIR|directory/i);
  rmSync(join(actionDir, "planner.json"), { recursive: true });
  writeFileSync(join(actionDir, "candidate.md"), "# Corrupt\n");

  const recovered = await producePlanCandidate(actionInput);
  expect(providerRun).toHaveBeenCalledTimes(1);
  expect(recovered.event).toMatchObject({
    type: "factory.action.failed",
    data: { failureKind: "terminal" },
  });
});

test("malformed staged candidate result fails terminally without invoking the provider", async () => {
  const fixture = planningActionFixture();
  const reaction = invoke(fixture.start);
  const actionDir = planningActionDir(fixture.ctx, reaction);
  mkdirSync(actionDir, { recursive: true });
  writeFileSync(join(actionDir, "provider-result.json"), "{}\n");
  const providerRun = vi.fn<Agent["run"]>();

  const completed = await producePlanCandidate({
    ctx: fixture.ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction,
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({ name: "cursor", run: providerRun }),
  });

  expect(providerRun).not.toHaveBeenCalled();
  expect(completed.event).toMatchObject({
    type: "factory.action.failed",
    data: { failureKind: "terminal" },
  });
});

test("invalid candidate draft becomes a terminal result", async () => {
  const fixture = planningActionFixture();
  const providerRun = vi.fn<Agent["run"]>(async () => successfulPlannerResult());

  const completed = await producePlanCandidate({
    ctx: fixture.ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction: invoke(fixture.start),
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({ name: "cursor", run: providerRun }),
  });

  expect(providerRun).toHaveBeenCalledTimes(1);
  expect(completed.event).toMatchObject({
    type: "factory.action.failed",
    data: { failureKind: "terminal" },
  });
});

test("candidate failure classification ignores misleading error text", async () => {
  const fixture = planningActionFixture();
  const completed = await producePlanCandidate({
    ctx: fixture.ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction: invoke(fixture.start),
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({
      name: "cursor",
      run: async () => ({
        ok: false,
        error: "aborted workspace changed timeout",
        exitCode: 1,
        raw: unchangedWorkspace(),
      }),
    }),
  });
  expect(completed.event).toMatchObject({
    type: "factory.action.failed",
    data: { failureKind: "retryable" },
  });
});

test("candidate retry ceiling publishes the third failure as human-required", async () => {
  const fixture = planningActionFixture();
  const providerRun = vi.fn<Agent["run"]>(async () => ({
    ok: false,
    error: "provider unavailable",
    exitCode: 1,
    raw: unchangedWorkspace(),
  }));
  let current = fixture.start;

  for (let execution = 1; execution <= 3; execution += 1) {
    const completed = await producePlanCandidate({
      ctx: fixture.ctx,
      factoryStateRoot: fixture.factoryStateRoot,
      reaction: invoke(current),
      maxRuntimeMs: 1_000,
      agentProviderFactory: () => ({ name: "cursor", run: providerRun }),
    });
    expect(completed.event).toMatchObject({
      type: "factory.action.failed",
      data: {
        failureKind: execution < 3 ? "retryable" : "human-required",
        ...(execution === 3 ? { message: expect.stringContaining("limit 3") } : {}),
      },
    });
    current = completed;
  }

  expect(providerRun).toHaveBeenCalledTimes(3);
  expect(decideNextFactoryAction(current.state, current.event)).toEqual({
    kind: "wait",
    reason: "human",
  });
});

test.each([
  {
    name: "workspace mutation",
    result: {
      ok: false as const,
      error: "Agent runtime modified the workspace during a review run",
      exitCode: 1,
      failureKind: "workspace-guard" as const,
    },
  },
  {
    name: "caller abort",
    throws: Object.assign(new Error("planning aborted"), { name: "AbortError" }),
  },
])("candidate records $name as human-required", async ({ result, throws }) => {
  const fixture = planningActionFixture();
  const completed = await producePlanCandidate({
    ctx: fixture.ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction: invoke(fixture.start),
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({
      name: "cursor",
      run: async () => {
        if (throws) throw throws;
        return result!;
      },
    }),
  });
  expect(completed.event).toMatchObject({
    type: "factory.action.failed",
    data: { failureKind: "human-required" },
  });
});

test.each([
  {
    name: "workspace guard",
    result: {
      ok: false as const,
      error: "review failed",
      exitCode: 1,
      failureKind: "workspace-guard" as const,
      raw: unchangedWorkspace(),
    },
  },
  {
    name: "provider abort",
    result: {
      ok: false as const,
      error: "review failed",
      exitCode: 1,
      aborted: true,
      raw: unchangedWorkspace(),
    },
  },
  {
    name: "workspace mutation",
    result: {
      ok: false as const,
      error: "review failed",
      exitCode: 1,
      raw: { workspaceStatus: { before: "clean", after: "changed" } },
    },
  },
  {
    name: "unknown workspace state",
    result: {
      ok: false as const,
      error: "review failed",
      exitCode: 1,
    },
  },
])("review records $name as human-required", async ({ result }) => {
  const fixture = planningActionFixture();
  const candidate = await produceTestCandidate(fixture);
  const reviewed = await reviewPlanCandidate({
    ctx: fixture.ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction: invoke(candidate),
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({ name: "cursor", run: async () => result }),
  });
  expect(reviewed.event).toMatchObject({
    type: "factory.action.failed",
    data: { failureKind: "human-required" },
  });
});

test("review failure text cannot override validated unchanged workspace evidence", async () => {
  const fixture = planningActionFixture();
  const candidate = await produceTestCandidate(fixture);
  const reviewerRun = vi.fn<Agent["run"]>(async () => ({
    ok: false,
    error: "aborted after workspace-guard modified the workspace",
    exitCode: 1,
    raw: unchangedWorkspace(),
  }));
  const reviewed = await reviewPlanCandidate({
    ctx: fixture.ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction: invoke(candidate),
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({ name: "cursor", run: reviewerRun }),
  });

  expect(reviewerRun).toHaveBeenCalledTimes(1);
  expect(reviewed.event).toMatchObject({
    type: "factory.action.failed",
    data: { failureKind: "retryable" },
  });
});

test("review retry ceiling retains the candidate and requires a human", async () => {
  const fixture = planningActionFixture();
  const candidate = await produceTestCandidate(fixture);
  const reviewerRun = vi.fn<Agent["run"]>(async () => ({
    ok: false,
    error: "reviewer unavailable",
    exitCode: 1,
    raw: unchangedWorkspace(),
  }));
  let current = candidate;

  for (let execution = 1; execution <= 3; execution += 1) {
    const reviewed = await reviewPlanCandidate({
      ctx: fixture.ctx,
      factoryStateRoot: fixture.factoryStateRoot,
      reaction: invoke(current),
      maxRuntimeMs: 1_000,
      agentProviderFactory: () => ({ name: "cursor", run: reviewerRun }),
    });
    expect(reviewed.event).toMatchObject({
      type: "factory.action.failed",
      data: {
        failureKind: execution < 3 ? "retryable" : "human-required",
        retainedCandidateEventId: candidate.event.id,
      },
    });
    current = reviewed;
  }

  expect(current.state).toMatchObject({ status: "awaiting-continuation" });
  expect(decideNextFactoryAction(current.state, current.event)).toEqual({
    kind: "wait",
    reason: "human",
  });
});

test("invalid production review output recovers terminally without rerunning the reviewer", async () => {
  const fixture = planningActionFixture();
  const candidate = await produceTestCandidate(fixture);
  const reaction = invoke(candidate);
  const actionDir = planningActionDir(fixture.ctx, reaction);
  mkdirSync(join(actionDir, "failure.json"), { recursive: true });
  const reviewerRun = vi.fn<Agent["run"]>(async () => ({
    ok: true,
    structuredOutput: { verdict: "pass" },
    raw: unchangedWorkspace(),
  }));
  const actionInput = {
    ctx: fixture.ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction,
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({ name: "cursor" as const, run: reviewerRun }),
  };

  await expect(reviewPlanCandidate(actionInput)).rejects.toThrow(/EISDIR|directory/i);
  rmSync(join(actionDir, "failure.json"), { recursive: true });
  const recovered = await reviewPlanCandidate(actionInput);

  expect(reviewerRun).toHaveBeenCalledTimes(1);
  expect(recovered.event).toMatchObject({
    type: "factory.action.failed",
    data: { failureKind: "terminal" },
  });
});

test("malformed staged review result fails terminally without invoking the reviewer", async () => {
  const fixture = planningActionFixture();
  const candidate = await produceTestCandidate(fixture);
  const reaction = invoke(candidate);
  const actionDir = planningActionDir(fixture.ctx, reaction);
  mkdirSync(actionDir, { recursive: true });
  writeFileSync(join(actionDir, "review-result.json"), "{}\n");
  const reviewRunner = vi.fn<() => never>();

  const reviewed = await reviewPlanCandidate({
    ctx: fixture.ctx,
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

test("each conflicting staged review identity field fails closed", async () => {
  const fixture = planningActionFixture();
  const candidate = await produceTestCandidate(fixture);
  const reaction = invoke(candidate);
  const actionDir = planningActionDir(fixture.ctx, reaction);
  mkdirSync(actionDir, { recursive: true });
  const reviewRunner = vi.fn<() => never>();
  const action = {
    phaseRunId: fixture.ctx.runId,
    handler: "reviewPlanCandidate",
    attempt: reaction.attempt,
    causationEventId: reaction.causationEventId,
  };
  const conflicts = [
    { phaseRunId: "different-run" },
    { handler: "producePlanCandidate" },
    { attempt: reaction.attempt + 1 },
    { causationEventId: "different-cause" },
  ];
  for (const conflict of conflicts) {
    writeFileSync(
      join(actionDir, "review-result.json"),
      `${JSON.stringify({
        version: 1,
        action: { ...action, ...conflict },
        completion: {
          status: "invalid",
          message: "invalid review",
          callerAborted: false,
          review: { kind: "missing", message: "missing review" },
        },
      })}\n`,
    );
    await expect(
      reviewPlanCandidate({
        ctx: fixture.ctx,
        factoryStateRoot: fixture.factoryStateRoot,
        reaction,
        maxRuntimeMs: 1_000,
        agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
        reviewRunner: reviewRunner as never,
      }),
    ).rejects.toThrow("Staged review outcome conflicts with action identity");
  }
  expect(reviewRunner).not.toHaveBeenCalled();
});

test("conflicting local materialization becomes a terminal review result", async () => {
  const fixture = planningActionFixture();
  const candidate = await produceTestCandidate(fixture);
  mkdirSync(join(fixture.ctx.workspace, "dev/plans"), { recursive: true });
  writeFileSync(join(fixture.ctx.workspace, "dev/plans/item-1.md"), "# Existing\n");
  const reviewRunner = vi.fn<
    (reviewCtx: { runDir?: string }) => Promise<{ status: "completed"; verdict: "pass" }>
  >(async (reviewCtx) => {
    mkdirSync(reviewCtx.runDir!, { recursive: true });
    writeFileSync(
      join(reviewCtx.runDir!, "spec-review.raw.json"),
      JSON.stringify(unchangedWorkspace()),
    );
    writeFileSync(
      join(reviewCtx.runDir!, "spec-review.json"),
      JSON.stringify({ verdict: "pass", summary: "approved", findings: [] }),
    );
    return { status: "completed", verdict: "pass" };
  });

  const reviewed = await reviewPlanCandidate({
    ctx: fixture.ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction: invoke(candidate),
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
    reviewRunner: reviewRunner as never,
  });

  expect(reviewRunner).toHaveBeenCalledTimes(1);
  expect(reviewed.event).toMatchObject({
    type: "factory.action.failed",
    data: { failureKind: "terminal" },
  });
});

function planningActionFixture() {
  const workspace = mkdtempSync(join(tmpdir(), "factory-planning-workspace-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "factory-planning-store-"));
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
    title: "Plan item",
    body: "Ship it",
    labels: [],
  };
  const created = createFactoryPlanningRunContext({
    workspace,
    runsDir: store.factoryRunsDir,
    workItem,
    plannerRole: { agent: "cursor", model: "planner" },
    reviewerRole: { agent: "cursor", model: "reviewer" },
    outputPlan: "dev/plans/item-1.md",
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({ name: "cursor", run: vi.fn<Agent["run"]>() }),
    factoryStore: store,
  });
  const ctx = openFactoryPlanningRunContext({
    workspace,
    runsDir: store.factoryRunsDir,
    phaseRunId: created.runId,
    workItem,
    factoryStore: store,
  });
  const imported: FactoryLifecycleEvent = {
    version: 1,
    id: "import:item-1",
    type: "work_item.imported",
    workItemKey: deriveFactoryWorkItemKey(workItem),
    occurredAt: new Date().toISOString(),
    data: { source: "file" },
  };
  appendFactoryActionEvent({ factoryStateRoot, event: imported, expectedLastEventId: null });
  const requested: FactoryLifecycleEvent = {
    version: 1,
    id: `planning.requested:${created.runId}`,
    type: "planning.requested",
    workItemKey: deriveFactoryWorkItemKey(workItem),
    occurredAt: new Date().toISOString(),
    phaseRunId: created.runId,
    data: {
      expectedPredecessor: imported.id,
      inputRefs: [
        {
          base: "factory-store",
          path: `runs/factory/${created.runId}/context/work-item.json`,
          sha256: "0".repeat(64),
        },
      ],
      intent: "start",
      publicationMode: "local",
      outputPlan: "dev/plans/item-1.md",
    },
  };
  const start = appendFactoryActionEvent({
    factoryStateRoot,
    event: requested,
    expectedLastEventId: imported.id,
  });
  return { ctx, factoryStateRoot, start };
}

function planningActionDir(
  ctx: ReturnType<typeof openFactoryPlanningRunContext>,
  reaction: Extract<ReturnType<typeof decideNextFactoryAction>, { kind: "invoke" }>,
): string {
  return join(
    ctx.runDir,
    "actions",
    String(reaction.attempt),
    reaction.handler,
    factoryActionKey({ ...reaction, phaseRunId: ctx.runId }),
  );
}

async function produceTestCandidate(fixture: ReturnType<typeof planningActionFixture>) {
  return producePlanCandidate({
    ctx: fixture.ctx,
    factoryStateRoot: fixture.factoryStateRoot,
    reaction: invoke(fixture.start),
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({
      name: "cursor",
      async run(input) {
        writeFileSync(plannerDraftPath(input), "# Candidate\n");
        return successfulPlannerResult();
      },
    }),
  });
}

function candidateBytes(
  ctx: ReturnType<typeof openFactoryPlanningRunContext>,
  event: FactoryLifecycleEvent,
): string {
  if (event.type !== "planning.candidate.produced") throw new Error("expected candidate");
  return readFileSync(
    verifyFactoryArtifactRef(event.data.candidate, {
      "factory-store": ctx.factoryStore.projectRoot,
      repository: ctx.workspace,
    }),
    "utf8",
  );
}

function plannerDraftPath(input: AgentRunInput): string {
  const draft = /Draft path:\s+```text\s+([^\n]+)/.exec(input.prompt)?.[1];
  if (!draft) throw new Error("missing draft path");
  return draft;
}

function successfulPlannerResult(
  findingDecisions: Array<{
    findingId: string;
    decision: "implement" | "adapt" | "decline";
    rationale: string;
  }> = [],
) {
  return {
    ok: true as const,
    structuredOutput: {
      outcome: "draft-ready",
      summary: "ready",
      humanQuestions: [],
      findingDecisions,
    },
    raw: unchangedWorkspace(),
    session: { provider: "cursor" as const, id: "planner-session" },
  };
}

function git(workspace: string, args: string[]): string {
  return execFileSync("git", args, { cwd: workspace, encoding: "utf8" }).trim();
}

function unchangedWorkspace() {
  return { workspaceStatus: { before: "clean", after: "clean" } };
}

function continuePlanning(
  ctx: ReturnType<typeof openFactoryPlanningRunContext>,
  factoryStateRoot: string,
  decision: "revise" | "re-review",
  response: string,
) {
  return recordFactoryContinuation({
    phase: "planning",
    decision,
    response,
    factoryStateRoot,
    factoryStore: ctx.factoryStore,
    workItemKey: deriveFactoryWorkItemKey(ctx.workItem),
    observed: observeFactoryContinuation(
      readFactoryActionEvents(factoryStateRoot, deriveFactoryWorkItemKey(ctx.workItem)),
      "planning",
    ),
  });
}

function invoke(result: {
  event: FactoryLifecycleEvent;
  state: Parameters<typeof decideNextFactoryAction>[0];
}) {
  const reaction = decideNextFactoryAction(result.state, result.event);
  if (reaction.kind !== "invoke") throw new Error("expected invoke reaction");
  return reaction;
}
