import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { runFactoryTriageWithLinearApply } from "../bin/factory-commands.ts";
import { appendFactoryLifecycleEvent } from "../lib/factory-lifecycle.ts";
import type { FactoryRunContext, FactoryRunMeta } from "../lib/factory-run-context.ts";
import type { FactoryWorkItem } from "../lib/factory-schemas.ts";
import { fakeLinearAdapter } from "./factory-linear-test-helpers.ts";

const WORK_ITEM: FactoryWorkItem = {
  id: "linear:ENG-37",
  source: "linear",
  title: "Lifecycle triage",
  body: "",
  labels: [],
  metadata: { tracker: { source: "linear", id: "ENG-37" } },
};

function completed(root: string): void {
  appendFactoryLifecycleEvent({
    factoryStateRoot: root,
    event: {
      version: 1,
      id: "triage.completed:old-run",
      type: "triage.completed",
      workItemKey: "linear:ENG-37",
      occurredAt: "2026-07-09T00:00:00.000Z",
      runId: "old-run",
      source: "harness",
      data: {
        route: "ready-to-plan",
        nextAction: "create-plan",
        rationale: "Needs plan",
        routeArtifactPath: "factory-route.md",
        triageArtifactPath: "factory-triage.json",
      },
    },
  });
}

function context(workspace: string, dryRun: boolean): FactoryRunContext {
  const runDir = join(workspace, "runs/run-new");
  mkdirSync(runDir, { recursive: true });
  return {
    runId: "run-new",
    runDir,
    workspace,
    workItem: WORK_ITEM,
    dryRun,
    eventSink: () => {},
    invokeTriageAgent: vi.fn(),
    export: vi.fn(),
    exportFailed: vi.fn(),
  } as unknown as FactoryRunContext;
}

function meta(ctx: FactoryRunContext): FactoryRunMeta {
  return {
    runId: ctx.runId,
    workflow: "factory-triage",
    status: "completed",
    workspace: ctx.workspace,
    runDir: ctx.runDir,
    workItem: { id: WORK_ITEM.id, source: "linear", title: WORK_ITEM.title },
    route: "needs-info",
    nextAction: "ask-human",
    artifacts: {
      triage: "factory-triage.json",
      route: "factory-route.md",
      routeSummary: "factory-route.md",
      summary: "summary.md",
    },
    agent: { name: "cursor", model: "test" },
    startedAt: "2026-07-09T00:00:00.000Z",
    durationMs: 1,
  };
}

test.each([false, true])(
  "completed history blocks before every side effect (dryRun=%s)",
  async (dryRun) => {
    const root = mkdtempSync(join(tmpdir(), "triage-apply-blocked-"));
    completed(root);
    const calls = [vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    const runTriage = vi.fn();
    const applyTriageStarted = vi.fn();
    await expect(
      runFactoryTriageWithLinearApply({
        factoryStateRoot: root,
        workItem: WORK_ITEM,
        rerun: false,
        issueRef: "ENG-37",
        createContext: calls[0]!,
        announceRunStarted: calls[1]!,
        appendImported: calls[2]!,
        appendStarted: calls[3]!,
        appendTerminal: calls[4]!,
        runTriage,
        applyAdapter: fakeLinearAdapter({ applyTriageStarted }),
      }),
    ).rejects.toThrow(/--rerun/);
    for (const call of calls) expect(call).not.toHaveBeenCalled();
    expect(runTriage).not.toHaveBeenCalled();
    expect(applyTriageStarted).not.toHaveBeenCalled();
  },
);

test.each([
  { prior: false, dryRun: true, expected: false },
  { prior: true, dryRun: true, expected: true },
  { prior: false, dryRun: false, expected: true },
])(
  "passes rerun guidance and apply intent: $prior/$dryRun",
  async ({ prior, dryRun, expected }) => {
    const workspace = mkdtempSync(join(tmpdir(), "triage-apply-run-"));
    const root = join(workspace, "state");
    if (prior) completed(root);
    const ctx = context(workspace, dryRun);
    writeFileSync(
      join(ctx.runDir, "factory-triage.json"),
      JSON.stringify({
        route: "needs-info",
        confidence: "high",
        rationale: "Question",
        evidence: [{ kind: "tracker", path: null, summary: "Missing detail" }],
        questions: ["Which target?"],
        reconsiderWhen: null,
        suggestedNext: { action: "ask-human", command: null, artifact: null },
      }),
    );
    const started = vi.fn(async () => ({
      issueIdentifier: "ENG-37",
      runId: ctx.runId,
      runDir: ctx.runDir,
      stage: "start" as const,
      targetStatus: "Triaging",
    }));
    const runTriage = vi.fn(async () => meta(ctx));
    const completedApply = vi.fn(async () => ({
      issueIdentifier: "ENG-37",
      runId: ctx.runId,
      runDir: ctx.runDir,
      stage: "complete" as const,
      targetStatus: "Needs Clarification",
    }));
    await runFactoryTriageWithLinearApply({
      factoryStateRoot: root,
      workItem: WORK_ITEM,
      rerun: prior,
      issueRef: "ENG-37",
      createContext: () => ctx,
      announceRunStarted: () => {},
      appendImported: () => {},
      appendStarted: () => {},
      appendTerminal: () => {},
      runTriage,
      applyAdapter: fakeLinearAdapter({
        applyTriageStarted: started,
        applyTriageCompleted: completedApply,
      }),
    });
    expect(runTriage).toHaveBeenCalledWith(ctx, { nextLiveRunRequiresRerun: expected });
    expect(started).toHaveBeenCalledWith(expect.objectContaining({ rerun: prior }));
    expect(completedApply).toHaveBeenCalledWith(
      expect.not.objectContaining({ rerun: expect.anything() }),
    );
  },
);
