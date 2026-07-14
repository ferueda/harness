import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { AgentProviderOptions, AgentRunInput } from "../lib/agents.ts";
import {
  createFactoryRunContext,
  createFactoryRunContextForTest,
  openFactoryRunContext,
  readFactoryWorkItemFile,
} from "../lib/factory-run-context.ts";
import type { FactoryTriageOutput, FactoryWorkItem } from "../lib/factory-schemas.ts";
import type { WorkflowEvent } from "../lib/workflow-events.ts";
import { run as runFactoryTriage } from "../workflows/factory-triage.workflow.ts";

function createWorkspace() {
  const workspace = mkdtempSync(join(tmpdir(), "harness-factory-workspace-"));
  return workspace;
}

const WORK_ITEM: FactoryWorkItem = {
  id: "item-1",
  source: "file",
  title: "Fix export crash",
  body: "Export crashes when the output directory is missing.",
  labels: ["bug"],
};

const TRIAGE_OUTPUT = {
  route: "ready-to-plan",
  confidence: "medium",
  rationale: "The request affects export behavior and needs a short implementation plan.",
  evidence: [
    {
      kind: "repo-state",
      path: null,
      summary: "No target intent docs were found in the fixture.",
    },
  ],
  questions: [],
  reconsiderWhen: null,
} satisfies FactoryTriageOutput;

test("factory triage dry-run writes placeholder artifacts without calling provider", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-runs-"));
  const ctx = createFactoryRunContextForTest({
    executionProfile: { provider: "cursor", model: "test-model" },
    workspace,
    runsDir,
    workItem: WORK_ITEM,
    dryRun: true,
    maxRuntimeMs: 1_000,
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run() {
          throw new Error("dry-run should not call provider");
        },
      };
    },
  });

  const meta = await runFactoryTriage(ctx);
  expect(meta.status).toBe("dry_run");
  expect(meta.route).toBe("needs-info");
  expect(meta.nextAction).toBe("ask-human");
  expect(existsSync(join(ctx.runDir, "events.jsonl"))).toBe(false);
  expect(existsSync(join(ctx.runDir, "context/work-item.json"))).toBe(true);
  expect(existsSync(join(ctx.runDir, "context/diff.patch"))).toBe(false);
  expect(readFileSync(join(ctx.runDir, "factory-route.md"), "utf8")).toContain("# Factory Route");
  expect(readFileSync(join(ctx.runDir, "factory-route.md"), "utf8")).toContain("ask-human");
  expect(JSON.parse(readFileSync(join(ctx.runDir, "factory-route.json"), "utf8"))).toMatchObject({
    route: "needs-info",
    nextAction: "ask-human",
  });
});

test("factory triage does not invent an executable rerun command", async () => {
  for (const nextLiveRunRequiresRerun of [false, true]) {
    const workspace = createWorkspace();
    const ctx = createFactoryRunContextForTest({
      executionProfile: { provider: "cursor", model: "test-model" },
      workspace,
      runsDir: mkdtempSync(join(tmpdir(), "harness-factory-runs-")),
      workItem: WORK_ITEM,
      dryRun: true,
      maxRuntimeMs: 1_000,
      agentProviderFactory(options) {
        return {
          name: options.provider,
          async run() {
            throw new Error("not called");
          },
        };
      },
    });
    await runFactoryTriage(ctx, { nextLiveRunRequiresRerun });
    const route = readFileSync(join(ctx.runDir, "factory-route.md"), "utf8");
    expect(route).not.toContain("--rerun");
  }
});

test("factory triage live run writes artifacts and workflow events", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-runs-"));
  const events: WorkflowEvent[] = [];
  const calls: AgentRunInput[] = [];
  const ctx = createFactoryRunContextForTest({
    executionProfile: { provider: "cursor", model: "test-model" },
    workspace,
    runsDir,
    workItem: WORK_ITEM,
    maxRuntimeMs: 1_000,
    eventSink(event) {
      events.push(event);
    },
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run(input) {
          calls.push(input);
          return {
            ok: true,
            structuredOutput: TRIAGE_OUTPUT,
            raw: { finalResponse: JSON.stringify(TRIAGE_OUTPUT) },
          };
        },
      };
    },
  });

  const meta = await runFactoryTriage(ctx);
  expect(meta.status).toBe("completed");
  expect(meta.workflow).toBe("factory-triage");
  expect(meta.route).toBe("ready-to-plan");
  expect(meta.nextAction).toBe("create-plan");
  expect(meta.artifacts).toEqual({
    triage: "factory-triage.json",
    route: "factory-route.json",
    routeSummary: "factory-route.md",
    summary: "summary.md",
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.schemaPath).toMatch(/schemas\/factory-triage-output\.schema\.json$/);
  expect(calls[0]?.logPath).toBe(join(ctx.runDir, "factory-triage.stream.jsonl"));
  expect(readFileSync(join(ctx.runDir, "factory-triage.prompt.md"), "utf8")).toContain(
    "Work item JSON",
  );
  const prompt = readFileSync(join(ctx.runDir, "factory-triage.prompt.md"), "utf8");
  expect(prompt).toContain("strong chance a coding agent can complete it correctly in one pass");
  expect(prompt).toContain("operational or verification-only work");
  expect(prompt).toContain("not already shipped, duplicated, or actively being implemented");
  expect(prompt).toContain("Do not emit interim or placeholder objects matching the schema");
  expect(prompt).toContain("Put line numbers or ranges in evidence.summary");
  expect(prompt).not.toContain("suggestedNext");
  expect(readFileSync(join(ctx.runDir, "factory-route.md"), "utf8")).toContain("create-plan");
  expect(JSON.parse(readFileSync(join(ctx.runDir, "meta.json"), "utf8"))).toMatchObject({
    status: "completed",
    workflow: "factory-triage",
    route: "ready-to-plan",
    nextAction: "create-plan",
    eventsFile: "events.jsonl",
  });

  expect(events.map((event) => event.type)).toEqual([
    "run:start",
    "step:start",
    "step:end",
    "run:end",
  ]);
  expect(events[2]).toMatchObject({
    stepId: "factory-triage",
    cliStep: "factory-triage",
    status: "completed",
    outputs: [
      "factory-triage.prompt.md",
      "factory-triage.raw.json",
      "factory-triage.json",
      "factory-route.json",
      "factory-route.md",
      "summary.md",
      "meta.json",
    ],
  });
  expect(readFileSync(join(ctx.runDir, "events.jsonl"), "utf8")).toContain('"type":"run:start"');
});

test("factory triage persists heartbeats while the handler is running", async () => {
  const workspace = createWorkspace();
  const events: WorkflowEvent[] = [];
  const ctx = createFactoryRunContextForTest({
    executionProfile: { provider: "cursor", model: "test-model" },
    workspace,
    runsDir: mkdtempSync(join(tmpdir(), "harness-factory-runs-")),
    workItem: WORK_ITEM,
    maxRuntimeMs: 1_000,
    eventSink: (event) => events.push(event),
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run() {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { ok: true, structuredOutput: TRIAGE_OUTPUT, raw: {} };
        },
      };
    },
  });
  await runFactoryTriage(ctx, { heartbeatMs: 1 });
  expect(events.some((event) => event.type === "step:heartbeat")).toBe(true);
  expect(readFileSync(join(ctx.runDir, "events.jsonl"), "utf8")).toContain(
    '"type":"step:heartbeat"',
  );
});

test("factory triage provider failure writes failed metadata and returns without throwing", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-runs-"));
  const events: WorkflowEvent[] = [];
  const ctx = createFactoryRunContextForTest({
    executionProfile: { provider: "cursor", model: "test-model" },
    workspace,
    runsDir,
    workItem: WORK_ITEM,
    maxRuntimeMs: 1_000,
    eventSink(event) {
      events.push(event);
    },
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run() {
          return { ok: false, error: "provider failed", exitCode: 1 };
        },
      };
    },
  });

  const meta = await runFactoryTriage(ctx);
  expect(meta.status).toBe("failed");
  expect(meta.error).toContain("provider failed");
  expect(existsSync(join(ctx.runDir, "meta.json"))).toBe(true);
  expect(existsSync(join(ctx.runDir, "factory-triage.raw.json"))).toBe(true);
  expect(events.at(-1)).toMatchObject({ type: "run:end", status: "failed" });
});

test("factory triage invalid provider output writes failed metadata and preserves raw artifacts", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-runs-"));
  const ctx = createFactoryRunContextForTest({
    executionProfile: { provider: "cursor", model: "test-model" },
    workspace,
    runsDir,
    workItem: WORK_ITEM,
    maxRuntimeMs: 1_000,
    agentProviderFactory(options) {
      return {
        name: options.provider,
        async run() {
          return {
            ok: true,
            structuredOutput: {
              ...TRIAGE_OUTPUT,
              evidence: [],
            },
            raw: { finalResponse: "missing required evidence" },
          };
        },
      };
    },
  });

  const meta = await runFactoryTriage(ctx);
  expect(meta.status).toBe("failed");
  expect(meta.error).toContain("Invalid factory triage output");
  expect(readFileSync(join(ctx.runDir, "meta.json"), "utf8")).toContain('"status": "failed"');
  expect(readFileSync(join(ctx.runDir, "factory-triage.prompt.md"), "utf8")).toContain(
    "Work item JSON",
  );
  expect(readFileSync(join(ctx.runDir, "factory-triage.raw.json"), "utf8")).toContain(
    "missing required evidence",
  );
  expect(existsSync(join(ctx.runDir, "factory-triage.json"))).toBe(false);
});

test("factory work item fixture parses through runtime reader", () => {
  const fixturePath = join(dirnameFromTest(), "fixtures/factory/work-item.json");
  const workItem = readFactoryWorkItemFile(fixturePath);
  expect(workItem).toMatchObject({
    id: "local-1",
    source: "file",
    title: "Add keyboard shortcut for export",
  });
});

test("opening a phase uses its persisted profile and validates it before provider construction", () => {
  const workspace = createWorkspace();
  const projectRoot = mkdtempSync(join(tmpdir(), "factory-store-project-"));
  const runsDir = join(projectRoot, "runs/factory");
  const factoryStore = {
    storeRoot: projectRoot,
    projectId: "project",
    projectRoot,
    factoryStateRoot: join(projectRoot, "factory"),
    factoryRunsDir: runsDir,
    reviewRunsDir: join(projectRoot, "runs/reviews"),
    repo: { name: "repo", id: "repo", idSource: "config" as const },
    overrides: {},
    warnings: [],
  };
  const providers: string[] = [];
  const providerFactory = (options: AgentProviderOptions) => {
    providers.push(options.provider);
    return {
      name: options.provider,
      run: async () => ({ ok: false as const, error: "unused", exitCode: 1 }),
    };
  };
  const created = createFactoryRunContext({
    workspace,
    runsDir,
    workItem: WORK_ITEM,
    executionProfile: { provider: "cursor", model: "frozen-model" },
    maxRuntimeMs: 1_000,
    factoryStore,
    agentProviderFactory: providerFactory,
  });
  const opened = openFactoryRunContext({
    workspace,
    runsDir,
    phaseRunId: created.runId,
    workItem: WORK_ITEM,
    maxRuntimeMs: 1_000,
    factoryStore,
    agentProviderFactory: providerFactory,
  });
  expect(opened.executionProfile).toEqual({ provider: "cursor", model: "frozen-model" });
  expect(providers).toEqual(["cursor", "cursor"]);

  writeFileSync(join(created.runDir, "context/phase-run.json"), "{}\n");
  expect(() =>
    openFactoryRunContext({
      workspace,
      runsDir,
      phaseRunId: created.runId,
      workItem: WORK_ITEM,
      maxRuntimeMs: 1_000,
      factoryStore,
      agentProviderFactory: providerFactory,
    }),
  ).toThrow();
  expect(providers).toEqual(["cursor", "cursor"]);
});

function dirnameFromTest(): string {
  return new URL(".", import.meta.url).pathname;
}
