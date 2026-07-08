import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { AgentRunInput } from "../lib/agents.ts";
import {
  createFactoryRunContextForTest,
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
  evidence: [{ kind: "repo-state", summary: "No target intent docs were found in the fixture." }],
  suggestedNext: { action: "create-plan", command: "ignored by deterministic router" },
} satisfies FactoryTriageOutput;

test("factory triage dry-run writes placeholder artifacts without calling provider", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-runs-"));
  const ctx = createFactoryRunContextForTest({
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
  expect(JSON.parse(readFileSync(join(ctx.runDir, "factory-route.json"), "utf8"))).toMatchObject({
    route: "needs-info",
    nextAction: "ask-human",
  });
});

test("factory triage live run writes artifacts and workflow events", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-runs-"));
  const events: WorkflowEvent[] = [];
  const calls: AgentRunInput[] = [];
  const ctx = createFactoryRunContextForTest({
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
  expect(prompt).toContain("Include blocking questions only for needs-info");
  expect(prompt).toContain("ready-to-implement must not include questions");
  expect(prompt).toContain("ready-to-plan may include optional non-blocking planning questions");
  expect(readFileSync(join(ctx.runDir, "factory-route.md"), "utf8")).toContain(
    "Use the planning-workflow coordinator",
  );
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

test("factory triage provider failure writes failed metadata and returns without throwing", async () => {
  const workspace = createWorkspace();
  const runsDir = mkdtempSync(join(tmpdir(), "harness-factory-runs-"));
  const events: WorkflowEvent[] = [];
  const ctx = createFactoryRunContextForTest({
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
              suggestedNext: { action: "implement-directly" },
            },
            raw: { finalResponse: "route/action mismatch" },
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
    "route/action mismatch",
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

function dirnameFromTest(): string {
  return new URL(".", import.meta.url).pathname;
}
