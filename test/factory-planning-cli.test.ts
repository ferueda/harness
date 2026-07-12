import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { formatFactoryActionOutput } from "../bin/factory-action-output.ts";
import {
  recordPlanningPublication,
  runOneFactoryPlanningAction,
} from "../bin/factory-planning-cli.ts";
import type { AgentRunInput } from "../lib/agents.ts";
import { ensureFactoryStoreFormat } from "../lib/factory-store-format.ts";
import { readFactoryActionEvents } from "../lib/factory-lifecycle-kernel.ts";
import {
  factoryStoreMetadata,
  resolveFactoryStore,
  type FactoryStoreMeta,
} from "../lib/factory-store.ts";

test("planning uses the shared one-action output contract", () => {
  expect(
    formatFactoryActionOutput({
      phase: "planning",
      phaseRunId: "run-1",
      action: { handler: "producePlanCandidate", attempt: 1, eventId: "candidate-1" },
      next: { kind: "wait", reason: "plan-merge" },
      linearApplied: false,
    }),
  ).toMatchObject({ outcome: "action-completed", phase: "planning", phaseRunId: "run-1" });
});

test.each([
  { mode: "local" as const, linearIssue: undefined, expectedWait: "phase-command" },
  { mode: "pull-request" as const, linearIssue: "ENG-123", expectedWait: "plan-merge" },
])("coordinator runs one planning handler per invocation in $mode mode", async (testCase) => {
  const workspace = mkdtempSync(join(tmpdir(), "factory-planning-cli-workspace-"));
  const store = createStore();
  const calls: AgentRunInput[] = [];
  const providerFactory = () => ({
    name: "cursor" as const,
    async run(input: AgentRunInput) {
      calls.push(input);
      const draftPath = /Draft path:\s+```text\s+([^\n]+)/.exec(input.prompt)?.[1];
      if (draftPath) {
        writeFileSync(draftPath, "# Candidate\n", "utf8");
        return {
          ok: true as const,
          structuredOutput: {
            outcome: "draft-ready",
            summary: "ready",
            humanQuestions: [],
            findingDecisions: [],
          },
          raw: {},
          session: { provider: "cursor" as const, id: "planner-session" },
        };
      }
      return {
        ok: true as const,
        structuredOutput: { verdict: "pass", summary: "approved", findings: [] },
        raw: {},
      };
    },
  });
  const input = {
    factoryStateRoot: store.factoryStateRoot,
    factoryStore: store,
    workspace,
    workItem: {
      id: `item-${testCase.mode}`,
      source: testCase.linearIssue ? ("linear" as const) : ("file" as const),
      title: "Plan item",
      body: "Ship it",
      labels: [],
    },
    itemFile: testCase.linearIssue ? undefined : "item.json",
    linearIssue: testCase.linearIssue,
    outputPlan: "dev/plans/item.md",
    rerun: false,
    reviewCeiling: 2,
    plannerRole: { agent: "cursor" as const, model: "planner" },
    reviewerRole: { agent: "cursor" as const, model: "reviewer" },
    maxRuntimeMs: 1_000,
    agentProviderFactory: providerFactory,
  };

  const candidate = await runOneFactoryPlanningAction(input);
  expect(candidate.action).toMatchObject({ handler: "producePlanCandidate", attempt: 1 });
  expect(candidate.next).toMatchObject({ kind: "invoke", handler: "reviewPlanCandidate" });
  expect(calls).toHaveLength(1);

  const reviewed = await runOneFactoryPlanningAction(input);
  expect(reviewed.phaseRunId).toBe(candidate.phaseRunId);
  expect(reviewed.action).toMatchObject({ handler: "reviewPlanCandidate", attempt: 1 });
  expect(reviewed.next).toMatchObject({ kind: "wait", reason: testCase.expectedWait });
  expect(calls).toHaveLength(2);
  expect(existsSync(join(workspace, "dev/plans/item.md"))).toBe(testCase.mode === "local");
});

test("coordinator rejects rerun while planning remains active", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "factory-planning-cli-workspace-"));
  const store = createStore();
  const provider = vi.fn(async (input: AgentRunInput) => {
    const draftPath = /Draft path:\s+```text\s+([^\n]+)/.exec(input.prompt)?.[1];
    if (!draftPath) throw new Error("missing draft path");
    writeFileSync(draftPath, "# Candidate\n", "utf8");
    return {
      ok: true as const,
      structuredOutput: {
        outcome: "draft-ready",
        summary: "ready",
        humanQuestions: [],
        findingDecisions: [],
      },
      raw: {},
      session: { provider: "cursor" as const, id: "planner-session" },
    };
  });
  const input = coordinatorInput(workspace, store, () => ({
    name: "cursor" as const,
    run: provider,
  }));
  await runOneFactoryPlanningAction(input);

  await expect(runOneFactoryPlanningAction({ ...input, rerun: true })).rejects.toThrow(
    "planning --rerun is allowed only from needs-human or failed",
  );
  expect(provider).toHaveBeenCalledTimes(1);
});

test("publication apply appends once and repairs its Linear projection on retry", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "factory-planning-publication-workspace-"));
  const storeRoot = mkdtempSync(join(tmpdir(), "factory-planning-publication-store-"));
  writeFileSync(join(workspace, "harness.json"), JSON.stringify(linearConfig()), "utf8");
  const resolved = resolveFactoryStore({
    workspace,
    factoryStoreRoot: storeRoot,
    factoryStoreProjectId: "repo",
    env: {},
  });
  ensureFactoryStoreFormat(resolved.factoryStateRoot);
  const store = factoryStoreMetadata(resolved);
  const workItem = {
    id: "linear:ENG-123",
    source: "linear" as const,
    title: "Plan",
    body: "Ship it",
    labels: [],
  };
  const calls: AgentRunInput[] = [];
  const providerFactory = passingProvider(calls);
  const coordinator = {
    factoryStateRoot: store.factoryStateRoot,
    factoryStore: store,
    workspace,
    workItem,
    linearIssue: "ENG-123",
    outputPlan: "dev/plans/item.md",
    rerun: false,
    reviewCeiling: 2,
    plannerRole: { agent: "cursor" as const, model: "planner" },
    reviewerRole: { agent: "cursor" as const, model: "reviewer" },
    maxRuntimeMs: 1_000,
    agentProviderFactory: providerFactory,
  };
  await runOneFactoryPlanningAction(coordinator);
  await runOneFactoryPlanningAction(coordinator);
  const candidateEvent = readFactoryActionEvents(store.factoryStateRoot, "linear:ENG-123").find(
    (event) => event.type === "planning.candidate.produced",
  );
  if (!candidateEvent || candidateEvent.type !== "planning.candidate.produced")
    throw new Error("candidate event missing");
  const candidatePath = join(store.projectRoot, candidateEvent.data.candidate.path);
  const publishedPlan = join(workspace, "published.md");
  writeFileSync(publishedPlan, readFileSync(candidatePath));
  const applyPlanningPublished = vi.fn(async () => undefined);
  const deps = {
    resolveWorkItemInput: vi.fn(async () => ({ source: "linear" as const, workItem })),
    linearAdapterFactory: vi.fn(() => ({ applyPlanningPublished }) as never),
  };
  const options = {
    workspace,
    linearIssue: "ENG-123",
    url: "https://example.test/pr/1",
    plan: "published.md",
    apply: true,
    factoryStoreRoot: storeRoot,
    factoryStoreProjectId: "repo",
  };
  const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    await recordPlanningPublication(options, "opened", deps);
    await recordPlanningPublication(options, "opened", deps);
  } finally {
    output.mockRestore();
  }
  expect(applyPlanningPublished).toHaveBeenCalledTimes(2);
  const events = readFactoryActionEvents(store.factoryStateRoot, "linear:ENG-123");
  expect(events.filter((event) => event.type === "plan_pr.opened")).toHaveLength(1);
});

function coordinatorInput(
  workspace: string,
  store: FactoryStoreMeta,
  agentProviderFactory: NonNullable<
    Parameters<typeof runOneFactoryPlanningAction>[0]["agentProviderFactory"]
  >,
) {
  return {
    factoryStateRoot: store.factoryStateRoot,
    factoryStore: store,
    workspace,
    workItem: { id: "item-rerun", source: "file" as const, title: "Plan", body: "", labels: [] },
    itemFile: "item.json",
    outputPlan: "dev/plans/item.md",
    rerun: false,
    reviewCeiling: 2,
    plannerRole: { agent: "cursor" as const, model: "planner" },
    reviewerRole: { agent: "cursor" as const, model: "reviewer" },
    maxRuntimeMs: 1_000,
    agentProviderFactory,
  };
}

function createStore(): FactoryStoreMeta {
  const projectRoot = mkdtempSync(join(tmpdir(), "factory-planning-cli-store-"));
  const factoryStateRoot = join(projectRoot, "factory");
  ensureFactoryStoreFormat(factoryStateRoot);
  return {
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
}

function passingProvider(calls: AgentRunInput[]) {
  return () => ({
    name: "cursor" as const,
    async run(input: AgentRunInput) {
      calls.push(input);
      const draftPath = /Draft path:\s+```text\s+([^\n]+)/.exec(input.prompt)?.[1];
      if (draftPath) {
        writeFileSync(draftPath, "# Candidate\n", "utf8");
        return {
          ok: true as const,
          structuredOutput: {
            outcome: "draft-ready",
            summary: "ready",
            humanQuestions: [],
            findingDecisions: [],
          },
          raw: {},
          session: { provider: "cursor" as const, id: "planner-session" },
        };
      }
      return {
        ok: true as const,
        structuredOutput: { verdict: "pass", summary: "approved", findings: [] },
        raw: {},
      };
    },
  });
}

function linearConfig() {
  return {
    factory: {
      linear: {
        teamKey: "ENG",
        statuses: {
          intake: "Backlog",
          parked: "Parked",
          needsInfo: "Needs Clarification",
          needsPlan: "Needs Plan",
          needsPlanReview: "Plan Needs Review",
          readyToImplement: "Ready to Implement",
          implementing: "Implementing",
          implementationFailed: "Implementation Failed",
          triaging: "Triaging",
          planning: "Planning",
          triageFailed: "Triage Failed",
          planningFailed: "Planning Failed",
        },
      },
    },
  };
}
