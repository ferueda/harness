import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type { AgentRunInput } from "../lib/agents.ts";
import { producePlanCandidate } from "../lib/factory-plan-candidate-action.ts";
import { reviewPlanCandidate } from "../lib/factory-plan-review-action.ts";
import { appendFactoryActionEvent } from "../lib/factory-lifecycle-kernel.ts";
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

test("candidate and review actions step separately and revisions resume the planner session", async () => {
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
  const key = deriveFactoryWorkItemKey(workItem);
  const created = createFactoryPlanningRunContext({
    workspace,
    runsDir: store.factoryRunsDir,
    workItem,
    plannerRole: { agent: "cursor", model: "planner" },
    reviewerRole: { agent: "cursor", model: "reviewer" },
    outputPlan: "dev/plans/item-1.md",
    maxReviewIterations: 2,
    maxRuntimeMs: 1_000,
    agentProviderFactory: () => ({ name: "cursor", run: vi.fn() }),
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
    workItemKey: key,
    occurredAt: new Date().toISOString(),
    data: { source: "file" },
  };
  appendFactoryActionEvent({ factoryStateRoot, event: imported, expectedLastEventId: null });
  const requested: FactoryLifecycleEvent = {
    version: 1,
    id: `planning.requested:${created.runId}`,
    type: "planning.requested",
    workItemKey: key,
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
      reviewCeiling: 2,
      publicationMode: "local",
      outputPlan: "dev/plans/item-1.md",
    },
  };
  const start = appendFactoryActionEvent({
    factoryStateRoot,
    event: requested,
    expectedLastEventId: imported.id,
  });
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
        raw: {},
        session: { provider: "cursor" as const, id: "planner-session" },
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

  let reviewCount = 0;
  const reviewRunner = async (reviewCtx: { runDir?: string }) => {
    reviewCount += 1;
    mkdirSync(reviewCtx.runDir!, { recursive: true });
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
              ],
            }
          : { verdict: "pass", summary: "ok", findings: [] },
      ),
    );
    return { status: "completed", verdict: reviewCount === 1 ? "needs_changes" : "pass" };
  };
  const reviewed = await reviewPlanCandidate({
    ctx,
    factoryStateRoot,
    reaction: invoke(first),
    maxRuntimeMs: 1_000,
    agentProviderFactory: providerFactory,
    reviewRunner: reviewRunner as never,
  });
  expect(reviewCount).toBe(1);
  const revised = await producePlanCandidate({
    ctx,
    factoryStateRoot,
    reaction: invoke(reviewed),
    maxRuntimeMs: 1_000,
    agentProviderFactory: providerFactory,
  });
  expect(providerCalls).toHaveLength(2);
  expect(providerCalls[1]?.session).toEqual({ provider: "cursor", id: "planner-session" });
  expect(providerCalls[1]?.prompt).toContain("spec-001");
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
});

function invoke(result: {
  event: FactoryLifecycleEvent;
  state: Parameters<typeof decideNextFactoryAction>[0];
}) {
  const reaction = decideNextFactoryAction(result.state, result.event);
  if (reaction.kind !== "invoke") throw new Error("expected invoke reaction");
  return reaction;
}
