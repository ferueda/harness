import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { formatFactoryActionOutput } from "../bin/factory-action-output.ts";
import {
  assertLivePlanningStatus,
  runOneFactoryPlanningAction,
} from "../bin/factory-planning-cli.ts";
import { publishPlanPullRequest } from "../lib/factory-plan-publication.ts";
import { factoryActionKey } from "../lib/factory-action-contract.ts";
import type { AgentRunInput } from "../lib/agents.ts";
import {
  observeFactoryContinuation,
  recordFactoryContinuation,
} from "../lib/factory-continuation.ts";
import { readFactoryPhaseRunIdentity } from "../lib/factory-phase-run.ts";
import { ensureFactoryStoreFormat } from "../lib/factory-store-format.ts";
import {
  appendFactoryActionEvent,
  readFactoryActionEvents,
} from "../lib/factory-lifecycle-kernel.ts";
import { deriveFactoryWorkItemKey } from "../lib/factory-lifecycle.ts";
import { reduceFactoryLifecycleEvents } from "../lib/factory-state-machine.ts";
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
  {
    mode: "pull-request" as const,
    linearIssue: "ENG-123",
    expectedWait: "plan-publication",
  },
])("coordinator runs one planning handler per invocation in $mode mode", async (testCase) => {
  const workspace = mkdtempSync(join(tmpdir(), "factory-planning-cli-workspace-"));
  initializeGit(workspace);
  const originalMain = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: workspace,
    encoding: "utf8",
  }).trim();
  let acceptedBase = originalMain;
  if (testCase.mode === "pull-request") {
    writeFileSync(join(workspace, "accepted.txt"), "accepted\n");
    execFileSync("git", ["add", "accepted.txt"], { cwd: workspace });
    execFileSync("git", ["commit", "-m", "accepted baseline"], {
      cwd: workspace,
      stdio: "ignore",
    });
    acceptedBase = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspace,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["switch", "-c", "codex/plan"], {
      cwd: workspace,
      stdio: "ignore",
    });
    execFileSync("git", ["update-ref", "refs/heads/main", originalMain], { cwd: workspace });
  }
  const store = createStore();
  const calls: AgentRunInput[] = [];
  const providerFactory = passingProvider(calls);
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
    issueRef: testCase.linearIssue,
    applyAdapter: testCase.linearIssue
      ? ({ applyPlanningStarted: vi.fn(async () => undefined) } as never)
      : undefined,
    outputPlan: "dev/plans/item.md",
    rerun: false,
    plannerRole: { agent: "cursor" as const, model: "planner" },
    reviewerRole: { agent: "cursor" as const, model: "reviewer" },
    maxRuntimeMs: 1_000,
    agentProviderFactory: providerFactory,
  };

  const candidate = await runOneFactoryPlanningAction(input);
  expect(candidate.action).toMatchObject({ handler: "producePlanCandidate", attempt: 1 });
  expect(candidate.next).toMatchObject({ kind: "invoke", handler: "reviewPlanCandidate" });
  expect(calls).toHaveLength(1);
  if (testCase.mode === "pull-request") {
    expect(
      readFactoryPhaseRunIdentity(join(store.factoryRunsDir, candidate.phaseRunId)),
    ).toMatchObject({
      baseRef: "main",
      git: {
        baseSha: acceptedBase,
        target: { mode: "branch", branchRef: "refs/heads/codex/plan" },
      },
    });
    execFileSync("git", ["update-ref", "refs/heads/main", acceptedBase], { cwd: workspace });
  }

  const reviewed = await runOneFactoryPlanningAction(input);
  expect(reviewed.phaseRunId).toBe(candidate.phaseRunId);
  expect(reviewed.action).toMatchObject({ handler: "reviewPlanCandidate", attempt: 1 });
  expect(reviewed.next).toMatchObject({ kind: "wait", reason: testCase.expectedWait });
  expect(calls).toHaveLength(2);
  expect(existsSync(join(workspace, "dev/plans/item.md"))).toBe(testCase.mode === "local");
});

test("planning review rejects attached branch HEAD drift without invoking the reviewer", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "factory-planning-cli-workspace-"));
  initializeGit(workspace);
  execFileSync("git", ["switch", "-c", "codex/plan"], {
    cwd: workspace,
    stdio: "ignore",
  });
  const store = createStore();
  const calls: AgentRunInput[] = [];
  const input = {
    ...coordinatorInput(workspace, store, passingProvider(calls)),
    workItem: {
      id: "item-branch-drift",
      source: "linear" as const,
      title: "Plan item",
      body: "Ship it",
      labels: [],
    },
    itemFile: undefined,
    linearIssue: "ENG-123",
    issueRef: "ENG-123",
    applyAdapter: { applyPlanningStarted: vi.fn(async () => undefined) } as never,
  };

  await runOneFactoryPlanningAction(input);
  execFileSync("git", ["commit", "--allow-empty", "-m", "unexpected branch drift"], {
    cwd: workspace,
    stdio: "ignore",
  });

  await expect(runOneFactoryPlanningAction(input)).rejects.toThrow(
    /Git identity changed since phase start/,
  );
  expect(calls).toHaveLength(1);
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
      raw: unchangedWorkspace(),
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

test("active Linear planning continuations require Planning status", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "factory-planning-cli-workspace-"));
  const store = createStore();
  const input = coordinatorInput(workspace, store, passingProvider([]));
  await runOneFactoryPlanningAction(input);
  const events = readFactoryActionEvents(
    store.factoryStateRoot,
    deriveFactoryWorkItemKey(input.workItem),
  );
  const state = reduceFactoryLifecycleEvents(events);
  const latest = events.at(-1);
  if (!state || !latest) throw new Error("active planning state missing");
  const settings = linearConfig().factory.linear;
  expect(() =>
    assertLivePlanningStatus(
      { ...input.workItem, metadata: { linearStatus: "Needs Plan" } },
      settings,
      false,
      state,
      latest,
    ),
  ).toThrow("is not valid for Factory planning");
  expect(() =>
    assertLivePlanningStatus(
      { ...input.workItem, metadata: { linearStatus: "Planning" } },
      settings,
      false,
      state,
      latest,
    ),
  ).not.toThrow();
});

test("ready-to-plan triage accepts an already projected Planning start", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "factory-planning-linear-recovery-"));
  const store = createStore();
  const workItem = {
    id: "linear:ENG-106",
    source: "linear" as const,
    title: "Plan",
    body: "",
    labels: [],
    metadata: { linearStatus: "Planning" },
  };
  appendTriageRoute(store, workItem.id, "ready-to-plan");
  const events = readFactoryActionEvents(store.factoryStateRoot, workItem.id);
  const state = reduceFactoryLifecycleEvents(events);
  const latest = events.at(-1);
  if (!state || !latest) throw new Error("ready-to-plan state missing");
  const settings = linearConfig().factory.linear;

  expect(() => assertLivePlanningStatus(workItem, settings, false, state, latest)).not.toThrow();

  const applyPlanningStarted = vi.fn(async () => undefined);
  const provider = vi.fn(passingProvider([])().run);
  const result = await runOneFactoryPlanningAction({
    ...coordinatorInput(workspace, store, () => ({ name: "cursor" as const, run: provider })),
    workItem,
    itemFile: undefined,
    linearIssue: "ENG-106",
    issueRef: "ENG-106",
    applyAdapter: { applyPlanningStarted } as never,
  });

  expect(result.action).toMatchObject({ handler: "producePlanCandidate", attempt: 1 });
  expect(applyPlanningStarted).toHaveBeenCalledTimes(1);
  expect(provider).toHaveBeenCalledTimes(1);
  expect(
    readFactoryActionEvents(store.factoryStateRoot, workItem.id).filter(
      (event) => event.type === "planning.requested",
    ),
  ).toHaveLength(1);
});

test("Planning status does not bypass a non-planning triage route", () => {
  const store = createStore();
  const workItem = {
    id: "linear:ENG-107",
    source: "linear" as const,
    title: "Plan",
    body: "",
    labels: [],
    metadata: { linearStatus: "Planning" },
  };
  appendTriageRoute(store, workItem.id, "ready-to-implement");
  const events = readFactoryActionEvents(store.factoryStateRoot, workItem.id);
  const state = reduceFactoryLifecycleEvents(events);
  const latest = events.at(-1);
  if (!state || !latest) throw new Error("ready-to-implement state missing");

  expect(() =>
    assertLivePlanningStatus(workItem, linearConfig().factory.linear, false, state, latest),
  ).toThrow("is not valid for Factory planning");
});

test("Linear planning start appends its request before projection and provider work", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "factory-planning-linear-start-"));
  const store = createStore();
  const provider = vi.fn(passingProvider([])().run);
  const base = {
    ...coordinatorInput(workspace, store, () => ({ name: "cursor" as const, run: provider })),
    workItem: {
      id: "linear:ENG-101",
      source: "linear" as const,
      title: "Plan",
      body: "",
      labels: [],
    },
    itemFile: undefined,
    linearIssue: "ENG-101",
    issueRef: "ENG-101",
  };

  await expect(runOneFactoryPlanningAction(base)).rejects.toThrow(/--apply|apply/i);
  expect(readFactoryActionEvents(store.factoryStateRoot, "linear:ENG-101")).toEqual([]);
  expect(provider).not.toHaveBeenCalled();

  const ordering: string[] = [];
  const applyPlanningStarted = vi.fn(async () => {
    const events = readFactoryActionEvents(store.factoryStateRoot, "linear:ENG-101");
    expect(events.at(-1)?.type).toBe("planning.requested");
    expect(events.filter((event) => event.type === "planning.requested")).toHaveLength(1);
    ordering.push("projection");
  });
  provider.mockImplementation(async (input) => {
    expect(readFactoryActionEvents(store.factoryStateRoot, "linear:ENG-101").at(-1)?.type).toBe(
      "planning.requested",
    );
    ordering.push("provider");
    return passingProvider([])().run(input);
  });
  const result = await runOneFactoryPlanningAction({
    ...base,
    applyAdapter: { applyPlanningStarted } as never,
  });
  expect(result.linearApplied).toBe(true);
  expect(ordering).toEqual(["projection", "provider"]);
});

test("failed Linear start projection repairs the same request before provider work", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "factory-planning-linear-start-"));
  const store = createStore();
  const provider = vi.fn(passingProvider([])().run);
  const applyPlanningStarted = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error("Linear unavailable"))
    .mockResolvedValue(undefined);
  const input = {
    ...coordinatorInput(workspace, store, () => ({ name: "cursor" as const, run: provider })),
    workItem: {
      id: "linear:ENG-102",
      source: "linear" as const,
      title: "Plan",
      body: "",
      labels: [],
    },
    itemFile: undefined,
    linearIssue: "ENG-102",
    issueRef: "ENG-102",
    applyAdapter: { applyPlanningStarted } as never,
  };

  await expect(runOneFactoryPlanningAction(input)).rejects.toThrow("Linear unavailable");
  const pending = readFactoryActionEvents(store.factoryStateRoot, "linear:ENG-102");
  expect(pending.at(-1)?.type).toBe("planning.requested");
  expect(pending.filter((event) => event.type === "planning.requested")).toHaveLength(1);
  expect(provider).not.toHaveBeenCalled();

  const repaired = await runOneFactoryPlanningAction(input);
  expect(repaired.phaseRunId).toBe(pending.at(-1)?.phaseRunId);
  expect(repaired.action).toMatchObject({ handler: "producePlanCandidate", attempt: 1 });
  expect(applyPlanningStarted).toHaveBeenCalledTimes(2);
  expect(provider).toHaveBeenCalledTimes(1);
  const recovered = readFactoryActionEvents(store.factoryStateRoot, "linear:ENG-102");
  expect(recovered.filter((event) => event.type === "planning.requested")).toHaveLength(1);
  expect(recovered.filter((event) => event.type === "planning.candidate.produced")).toHaveLength(1);
});

test("failed Linear rerun projection repairs the same restart request", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "factory-planning-linear-rerun-"));
  const store = createStore();
  let providerCalls = 0;
  const provider = vi.fn(async (input: AgentRunInput) => {
    providerCalls += 1;
    if (providerCalls === 1)
      return {
        ok: true as const,
        structuredOutput: {
          outcome: "needs-human" as const,
          summary: "question",
          humanQuestions: ["Which scope?"],
          findingDecisions: [],
        },
        raw: unchangedWorkspace(),
      };
    return passingProvider([])().run(input);
  });
  const workItem = {
    id: "linear:ENG-104",
    source: "linear" as const,
    title: "Plan",
    body: "",
    labels: [],
  };
  const base = {
    ...coordinatorInput(workspace, store, () => ({ name: "cursor" as const, run: provider })),
    workItem,
    itemFile: undefined,
    linearIssue: "ENG-104",
    issueRef: "ENG-104",
  };
  const initial = await runOneFactoryPlanningAction({
    ...base,
    applyAdapter: {
      applyPlanningStarted: vi.fn(async () => undefined),
      applyPlanningCompleted: vi.fn(async () => undefined),
    } as never,
  });
  expect(initial.next).toMatchObject({ kind: "wait", reason: "human" });

  const failedApply = vi.fn(async () => {
    throw new Error("Linear unavailable");
  });
  const rerun = {
    ...base,
    rerun: true,
    applyAdapter: { applyPlanningStarted: failedApply } as never,
  };
  await expect(runOneFactoryPlanningAction(rerun)).rejects.toThrow("Linear unavailable");
  const pending = readFactoryActionEvents(store.factoryStateRoot, workItem.id);
  const requests = pending.filter((event) => event.type === "planning.requested");
  expect(requests).toHaveLength(2);
  expect(requests.at(-1)?.data.intent).toBe("restart");
  expect(provider).toHaveBeenCalledTimes(1);

  const repaired = await runOneFactoryPlanningAction({
    ...rerun,
    applyAdapter: { applyPlanningStarted: vi.fn(async () => undefined) } as never,
  });
  expect(repaired.phaseRunId).toBe(requests.at(-1)?.phaseRunId);
  expect(repaired.action).toMatchObject({ handler: "producePlanCandidate", attempt: 1 });
  expect(provider).toHaveBeenCalledTimes(2);
  expect(
    readFactoryActionEvents(store.factoryStateRoot, workItem.id).filter(
      (event) => event.type === "planning.requested",
    ),
  ).toHaveLength(2);
});

test("illegal planning predecessor fails before Linear or provider mutation", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "factory-planning-linear-illegal-"));
  const store = createStore();
  const workItem = {
    id: "linear:ENG-105",
    source: "linear" as const,
    title: "Plan",
    body: "",
    labels: [],
  };
  appendTriageRoute(store, workItem.id, "ready-to-implement");
  const applyPlanningStarted = vi.fn(async () => undefined);
  const provider = vi.fn(passingProvider([])().run);

  await expect(
    runOneFactoryPlanningAction({
      ...coordinatorInput(workspace, store, () => ({ name: "cursor" as const, run: provider })),
      workItem,
      itemFile: undefined,
      linearIssue: "ENG-105",
      issueRef: "ENG-105",
      applyAdapter: { applyPlanningStarted } as never,
    }),
  ).rejects.toThrow("Invalid Factory transition");
  expect(applyPlanningStarted).not.toHaveBeenCalled();
  expect(provider).not.toHaveBeenCalled();
  expect(
    readFactoryActionEvents(store.factoryStateRoot, workItem.id).filter(
      (event) => event.type === "planning.requested",
    ),
  ).toHaveLength(0);
});

test("terminal Linear wait projection is repaired only with explicit apply", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "factory-planning-linear-wait-"));
  const store = createStore();
  const provider = vi.fn(async () => ({
    ok: true as const,
    structuredOutput: {
      outcome: "needs-human" as const,
      summary: "question",
      humanQuestions: ["Which scope?"],
      findingDecisions: [],
    },
    raw: unchangedWorkspace(),
  }));
  const applyPlanningStarted = vi.fn(async () => undefined);
  const applyPlanningCompleted = vi.fn(async () => undefined);
  const base = {
    ...coordinatorInput(workspace, store, () => ({ name: "cursor" as const, run: provider })),
    workItem: {
      id: "linear:ENG-103",
      source: "linear" as const,
      title: "Plan",
      body: "",
      labels: [],
    },
    itemFile: undefined,
    linearIssue: "ENG-103",
    issueRef: "ENG-103",
  };
  const adapter = { applyPlanningStarted, applyPlanningCompleted } as never;
  const first = await runOneFactoryPlanningAction({ ...base, applyAdapter: adapter });
  expect(first.next).toMatchObject({ kind: "wait", reason: "human" });
  expect(applyPlanningCompleted).toHaveBeenCalledTimes(1);
  expect(applyPlanningCompleted).toHaveBeenLastCalledWith(
    expect.objectContaining({
      status: "plan-needs-human",
      humanQuestions: ["Which scope?"],
    }),
  );
  const terminalEvents = readFactoryActionEvents(store.factoryStateRoot, base.workItem.id);

  const withoutApply = await runOneFactoryPlanningAction(base);
  expect(withoutApply.linearApplied).toBe(false);
  expect(applyPlanningCompleted).toHaveBeenCalledTimes(1);
  const repaired = await runOneFactoryPlanningAction({ ...base, applyAdapter: adapter });
  expect(repaired.linearApplied).toBe(true);
  expect(applyPlanningCompleted).toHaveBeenCalledTimes(2);
  expect(applyPlanningCompleted).toHaveBeenLastCalledWith(
    expect.objectContaining({
      status: "plan-needs-human",
      humanQuestions: ["Which scope?"],
    }),
  );
  expect(provider).toHaveBeenCalledTimes(1);
  expect(readFactoryActionEvents(store.factoryStateRoot, base.workItem.id)).toEqual(terminalEvents);
});

test("terminal Linear wait repair rejects tampered questions before projection", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "factory-planning-linear-wait-tampered-"));
  const store = createStore();
  const provider = vi.fn(async () => ({
    ok: true as const,
    structuredOutput: {
      outcome: "needs-human" as const,
      summary: "question",
      humanQuestions: ["Which scope?"],
      findingDecisions: [],
    },
    raw: unchangedWorkspace(),
  }));
  const base = {
    ...coordinatorInput(workspace, store, () => ({ name: "cursor" as const, run: provider })),
    workItem: {
      id: "linear:ENG-106",
      source: "linear" as const,
      title: "Plan",
      body: "",
      labels: [],
    },
    itemFile: undefined,
    linearIssue: "ENG-106",
    issueRef: "ENG-106",
  };
  const failedProjection = vi.fn(async () => {
    throw new Error("Linear unavailable");
  });
  await expect(
    runOneFactoryPlanningAction({
      ...base,
      applyAdapter: {
        applyPlanningStarted: vi.fn(async () => undefined),
        applyPlanningCompleted: failedProjection,
      } as never,
    }),
  ).rejects.toThrow("Linear unavailable");

  const terminalEvents = readFactoryActionEvents(store.factoryStateRoot, base.workItem.id);
  const terminal = terminalEvents.at(-1);
  if (terminal?.type !== "planning.input.required") throw new Error("missing questions event");
  writeFileSync(join(store.projectRoot, terminal.data.questions.path), '["Changed question?"]\n');

  const repairedProjection = vi.fn(async () => undefined);
  await expect(
    runOneFactoryPlanningAction({
      ...base,
      applyAdapter: { applyPlanningCompleted: repairedProjection } as never,
    }),
  ).rejects.toThrow("Factory artifact hash mismatch");
  expect(repairedProjection).not.toHaveBeenCalled();
  expect(provider).toHaveBeenCalledTimes(1);
  expect(readFactoryActionEvents(store.factoryStateRoot, base.workItem.id)).toEqual(terminalEvents);
});

test("coordinator propagates its abort signal to the planning provider", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "factory-planning-abort-"));
  const store = createStore();
  const abort = new AbortController();
  const provider = vi.fn(async (input: AgentRunInput) => {
    expect(input.signal).toBe(abort.signal);
    return {
      ok: true as const,
      structuredOutput: {
        outcome: "needs-human" as const,
        summary: "question",
        humanQuestions: ["Continue?"],
        findingDecisions: [],
      },
      raw: unchangedWorkspace(),
    };
  });

  await runOneFactoryPlanningAction({
    ...coordinatorInput(workspace, store, () => ({ name: "cursor" as const, run: provider })),
    signal: abort.signal,
  });
  expect(provider).toHaveBeenCalledOnce();
});

test("publication apply appends once and repairs its Linear projection on retry", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "factory-planning-publication-workspace-"));
  initializeGit(workspace);
  mkdirSync(join(workspace, "dev/plans"), { recursive: true });
  writeFileSync(
    join(workspace, "dev/plans/README.md"),
    "# Plans & handoffs\n\n## Active queue\n\n## Shipped (git history only)\n",
  );
  execFileSync("git", ["add", "dev/plans/README.md"], { cwd: workspace });
  execFileSync("git", ["commit", "-m", "add plan index"], { cwd: workspace, stdio: "ignore" });
  const storeRoot = mkdtempSync(join(tmpdir(), "factory-planning-publication-store-"));
  writeFileSync(join(workspace, "harness.json"), JSON.stringify(linearConfig()), "utf8");
  execFileSync("git", ["add", "harness.json"], { cwd: workspace });
  execFileSync("git", ["commit", "-m", "add config"], { cwd: workspace, stdio: "ignore" });
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
  let reviewCount = 0;
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
            outcome: "draft-ready" as const,
            summary: "ready",
            humanQuestions: [],
            findingDecisions: [],
          },
          raw: unchangedWorkspace(),
          session: { provider: "cursor" as const, id: "planner-session" },
        };
      }
      reviewCount += 1;
      return {
        ok: true as const,
        structuredOutput:
          reviewCount === 1
            ? {
                verdict: "needs_changes" as const,
                summary: "proof required",
                findings: [
                  {
                    title: "External proof",
                    severity: "High" as const,
                    location: "verification",
                    issue: "proof missing",
                    recommendation: "attach proof",
                    rationale: "required",
                    must_fix: true,
                  },
                ],
              }
            : { verdict: "pass" as const, summary: "approved", findings: [] },
        raw: unchangedWorkspace(),
      };
    },
  });
  const coordinator = {
    factoryStateRoot: store.factoryStateRoot,
    factoryStore: store,
    workspace,
    workItem,
    linearIssue: "ENG-123",
    issueRef: "ENG-123",
    applyAdapter: { applyPlanningStarted: vi.fn(async () => undefined) } as never,
    outputPlan: "dev/plans/item.md",
    rerun: false,
    plannerRole: { agent: "cursor" as const, model: "planner" },
    reviewerRole: { agent: "cursor" as const, model: "reviewer" },
    maxRuntimeMs: 1_000,
    agentProviderFactory: providerFactory,
  };
  await runOneFactoryPlanningAction(coordinator);
  await runOneFactoryPlanningAction(coordinator);
  recordFactoryContinuation({
    phase: "planning",
    decision: "re-review",
    response: "The accepted external proof is now available.",
    factoryStateRoot: store.factoryStateRoot,
    factoryStore: store,
    workItemKey: deriveFactoryWorkItemKey(workItem),
    observed: observeFactoryContinuation(
      readFactoryActionEvents(store.factoryStateRoot, deriveFactoryWorkItemKey(workItem)),
      "planning",
    ),
  });
  await runOneFactoryPlanningAction(coordinator);
  expect(reviewCount).toBe(2);
  const applyPlanningPublished = vi.fn(async () => undefined);
  let remote = "";
  let pullRequest: unknown[] = [];
  let failCreate = true;
  const commandRunner = (command: string, args: readonly string[]) => {
    if (command === "git" && args[0] === "rev-parse")
      return execFileSync("git", [...args], { cwd: workspace, encoding: "utf8" });
    if (command === "git" && args[0] === "remote") return "git@example.test:owner/repo.git\n";
    if (command === "git" && args[0] === "ls-remote")
      return remote
        ? `${remote}\trefs/heads/${String(args.at(-1)).replace("refs/heads/", "")}\n`
        : "";
    if (command === "git" && args[0] === "push") {
      remote = String(args[2]).split(":")[0]!;
      return "";
    }
    if (command === "gh" && args[1] === "list") return JSON.stringify(pullRequest);
    if (command === "gh" && args[1] === "create") {
      if (failCreate) {
        failCreate = false;
        throw new Error("GitHub unavailable");
      }
      const branch = String(args[args.indexOf("--head") + 1]);
      pullRequest = [
        {
          url: "https://example.test/pr/1",
          baseRefName: "main",
          headRefName: branch,
          headRefOid: remote,
        },
      ];
      return "https://example.test/pr/1\n";
    }
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };
  const options = {
    workspace,
    factoryStateRoot: store.factoryStateRoot,
    factoryStore: store,
    workItem,
    issueRef: "ENG-123",
    applyAdapter: { applyPlanningPublished } as never,
    commandRunner,
  };
  await expect(publishPlanPullRequest(options)).rejects.toThrow("GitHub unavailable");
  await publishPlanPullRequest(options);
  await publishPlanPullRequest(options);
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
  initializeGit(workspace);
  return {
    factoryStateRoot: store.factoryStateRoot,
    factoryStore: store,
    workspace,
    workItem: { id: "item-rerun", source: "file" as const, title: "Plan", body: "", labels: [] },
    itemFile: "item.json",
    outputPlan: "dev/plans/item.md",
    rerun: false,
    plannerRole: { agent: "cursor" as const, model: "planner" },
    reviewerRole: { agent: "cursor" as const, model: "reviewer" },
    maxRuntimeMs: 1_000,
    agentProviderFactory,
  };
}

function initializeGit(workspace: string): void {
  if (existsSync(join(workspace, ".git"))) return;
  execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: workspace });
  writeFileSync(join(workspace, ".gitignore"), ".harness/\n");
  execFileSync("git", ["add", ".gitignore"], { cwd: workspace });
  execFileSync("git", ["commit", "-m", "base"], {
    cwd: workspace,
    stdio: "ignore",
  });
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

function appendTriageRoute(
  store: FactoryStoreMeta,
  workItemKey: string,
  route: "ready-to-plan" | "ready-to-implement",
): void {
  const importedId = `work_item.imported:${workItemKey}`;
  const requestId = `triage.requested:${workItemKey}`;
  const runRef = {
    base: "factory-store" as const,
    path: "runs/factory/triage-run/meta.json",
    sha256: "0".repeat(64),
  };
  appendFactoryActionEvent({
    factoryStateRoot: store.factoryStateRoot,
    expectedLastEventId: null,
    event: {
      version: 1,
      id: importedId,
      type: "work_item.imported",
      workItemKey,
      occurredAt: "2026-07-12T00:00:00.000Z",
      data: { source: "linear" },
    },
  });
  appendFactoryActionEvent({
    factoryStateRoot: store.factoryStateRoot,
    expectedLastEventId: importedId,
    event: {
      version: 1,
      id: requestId,
      type: "triage.requested",
      workItemKey,
      occurredAt: "2026-07-12T00:01:00.000Z",
      phaseRunId: "triage-run",
      data: { expectedPredecessor: importedId, inputRefs: [runRef], intent: "start" },
    },
  });
  const actionKey = factoryActionKey({
    phaseRunId: "triage-run",
    handler: "triageWorkItem",
    attempt: 1,
    causationEventId: requestId,
  });
  appendFactoryActionEvent({
    factoryStateRoot: store.factoryStateRoot,
    expectedLastEventId: requestId,
    event: {
      version: 1,
      id: `triage.work_item.completed:${actionKey}`,
      type: "triage.work_item.completed",
      workItemKey,
      occurredAt: "2026-07-12T00:02:00.000Z",
      phaseRunId: "triage-run",
      data: {
        handler: "triageWorkItem",
        handlerVersion: 1,
        attempt: 1,
        causationEventId: requestId,
        execution: { workspaceRef: "repo", runRef },
        evidence: [runRef],
        route,
        rationale: "routed",
      },
    },
  });
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
          raw: unchangedWorkspace(),
          session: { provider: "cursor" as const, id: "planner-session" },
        };
      }
      return {
        ok: true as const,
        structuredOutput: { verdict: "pass", summary: "approved", findings: [] },
        raw: unchangedWorkspace(),
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
          readyForReview: "Ready for Review",
          done: "Done",
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

function unchangedWorkspace() {
  return { workspaceStatus: { before: "clean", after: "clean" } };
}
