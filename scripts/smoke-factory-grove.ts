#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGrove } from "@ferueda/grove";
import { createAgentProvider } from "../providers/registry.ts";
import { createFactoryArtifactRef } from "../lib/factory-artifact-ref.ts";
import { appendFactoryActionEvent } from "../lib/factory-lifecycle-kernel.ts";
import { createFactoryOperationRef } from "../lib/factory-operation.ts";
import { createFactoryRunContext } from "../lib/factory-run-context.ts";
import {
  deriveFactoryGroveWorkspaceIntent,
  releaseFactoryGroveWorkspace,
  type FactoryGroveWorkspaceConfig,
} from "../lib/factory-grove-workspace.ts";
import { factoryStoreMetadata, resolveFactoryStore } from "../lib/factory-store.ts";

type JsonObject = Record<string, unknown>;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOSTED_RUNNER = pathToFileURL(join(ROOT, "lib/factory-hosted-operation.ts")).href;
const PROVIDERS = pathToFileURL(join(ROOT, "providers/registry.ts")).href;
const startedAt = Date.now();
let station = "fixture allocation";
let lastChild = { stdout: "", stderr: "" };

const fixtureRoot = mkdtempSync(join(tmpdir(), "harness-factory-grove-smoke-"));
const controllerRepository = join(fixtureRoot, "controller");
const remoteRepository = join(fixtureRoot, "remote.git");
const poolDirectory = join(fixtureRoot, "pool");
const storeRoot = join(fixtureRoot, "store");
const toolsRoot = join(fixtureRoot, "bin");
const setupLog = join(fixtureRoot, "setup.log");
const providerLog = join(fixtureRoot, "provider.jsonl");
const fakeCodex = join(toolsRoot, "codex");
const projectId = "factory-grove-smoke";

function fail(message: string): never {
  throw new Error(message);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {},
): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    encoding: "utf8",
    input: options.input,
    timeout: 60_000,
  });
  lastChild = { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} exited ${result.status ?? "without status"}`);
  }
  return result.stdout.trim();
}

function git(args: string[], cwd = controllerRepository): string {
  return run("git", args, { cwd }).trim();
}

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function parseObject(value: string, name: string): JsonObject {
  const parsed: unknown = JSON.parse(value);
  assert(
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed),
    `${name} missing`,
  );
  return parsed as JsonObject;
}

function runHostedInFreshProcess(input: JsonObject): JsonObject {
  const source = `
    const { runHostedFactoryOperation } = await import(${JSON.stringify(HOSTED_RUNNER)});
    const { createAgentProvider } = await import(${JSON.stringify(PROVIDERS)});
    const input = JSON.parse(process.env.FACTORY_GROVE_SMOKE_INPUT);
    input.runtime.agentProviderFactory = createAgentProvider;
    console.log(JSON.stringify(await runHostedFactoryOperation(input)));
  `;
  return parseObject(
    run(process.execPath, ["--input-type=module", "--eval", source], {
      env: { ...process.env, FACTORY_GROVE_SMOKE_INPUT: JSON.stringify(input) },
    }),
    "hosted operation receipt",
  );
}

function lifecyclePath(): string {
  const eventsDirectory = join(storeRoot, "projects", projectId, "factory", "events");
  const entries = existsSync(eventsDirectory)
    ? readdirSync(eventsDirectory)
        .filter((entry) => entry.endsWith(".jsonl"))
        .map((entry) => join(eventsDirectory, entry))
    : [];
  assert(entries.length === 1, `expected one lifecycle log, found ${entries.length}`);
  return entries[0]!;
}

try {
  station = "fixture repository setup";
  mkdirSync(controllerRepository, { recursive: true });
  mkdirSync(toolsRoot, { recursive: true });
  git(["init", "--bare", remoteRepository], fixtureRoot);
  git(["init", "--initial-branch=main", controllerRepository], fixtureRoot);
  git(["config", "user.name", "Factory Grove Smoke"]);
  git(["config", "user.email", "factory-grove-smoke@example.test"]);
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(controllerRepository, "README.md"), "# Factory Grove smoke\n", "utf8");
  writeFileSync(
    join(controllerRepository, "item.json"),
    `${JSON.stringify(
      {
        id: "GROVE-SMOKE-1",
        source: "file",
        title: "Prove Grove-backed triage",
        body: "Run one deterministic local triage action.",
        labels: [],
      },
      null,
      2,
    )}\n`,
  );
  writeExecutable(
    fakeCodex,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
if (!prompt.includes("# Factory Triage")) throw new Error("expected triage prompt");
appendFileSync(process.env.FACTORY_GROVE_SMOKE_PROVIDER_LOG, JSON.stringify({ role: "triager" }) + "\\n");
const output = { route: "ready-to-plan", confidence: "high", rationale: "The isolated fixture is ready for a plan.", evidence: [{ kind: "tracker", path: null, summary: "The fixture requests one bounded action." }], questions: [], reconsiderWhen: null };
console.log(JSON.stringify({ type: "thread.started", thread_id: "grove-smoke-thread" }));
console.log(JSON.stringify({ type: "item.completed", item: { id: "triage-message", type: "agent_message", text: JSON.stringify(output) } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }));
`,
  );
  writeFileSync(
    join(controllerRepository, "harness.json"),
    `${JSON.stringify(
      {
        base: "main",
        defaultAgent: "codex",
        factory: {
          triage: {
            roles: {
              triager: {
                agent: "codex",
                model: "fake-codex",
                executable: fakeCodex,
                sandboxMode: "read-only",
                approvalPolicy: "never",
                modelReasoningEffort: "minimal",
              },
            },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  git(["add", "README.md", "harness.json", "item.json"]);
  git(["commit", "-m", "fixture base"]);
  const baseSha = git(["rev-parse", "HEAD"]);
  git(["remote", "add", "origin", remoteRepository]);
  git(["push", "-u", "origin", "main"]);
  git(["checkout", "--detach", baseSha]);

  const config: FactoryGroveWorkspaceConfig = {
    controllerRepository,
    poolDirectory,
    poolCapacity: 1,
    setupCommand: `printf x >> '${setupLog}'`,
  };
  const store = resolveFactoryStore({
    workspace: controllerRepository,
    factoryStoreRoot: storeRoot,
    factoryStoreProjectId: projectId,
  });
  const factoryStore = factoryStoreMetadata(store);
  const workItem = JSON.parse(readFileSync(join(controllerRepository, "item.json"), "utf8"));
  const ctx = createFactoryRunContext({
    workspace: controllerRepository,
    runsDir: factoryStore.factoryRunsDir,
    workItem,
    executionProfile: {
      provider: "codex",
      model: "fake-codex",
      executable: fakeCodex,
      sandbox: "read-only",
      approvalPolicy: "never",
      reasoningEffort: "minimal",
    },
    maxRuntimeMs: 30_000,
    agentProviderFactory: createAgentProvider,
    factoryStore,
  });
  // Grove owns checkout creation from the attached controller repository; the
  // immutable phase identity remains detached and is validated on its lease.
  git(["switch", "main"]);
  const inputRef = createFactoryArtifactRef({
    base: "factory-store",
    root: factoryStore.projectRoot,
    path: `runs/factory/${ctx.runId}/context/work-item.json`,
  });
  const imported = {
    version: 1 as const,
    id: "grove-smoke-imported",
    type: "work_item.imported" as const,
    workItemKey: "file:GROVE-SMOKE-1",
    occurredAt: "2026-07-16T00:00:00.000Z",
    data: { source: "file" },
  };
  const requested = {
    version: 1 as const,
    id: "grove-smoke-triage-requested",
    type: "triage.requested" as const,
    workItemKey: imported.workItemKey,
    occurredAt: "2026-07-16T00:00:01.000Z",
    phaseRunId: ctx.runId,
    data: { expectedPredecessor: imported.id, inputRefs: [inputRef], intent: "start" as const },
  };
  appendFactoryActionEvent({
    factoryStateRoot: factoryStore.factoryStateRoot,
    event: imported,
    expectedLastEventId: null,
  });
  appendFactoryActionEvent({
    factoryStateRoot: factoryStore.factoryStateRoot,
    event: requested,
    expectedLastEventId: imported.id,
  });
  const operation = createFactoryOperationRef({
    phaseRunId: ctx.runId,
    handler: "triageWorkItem",
    attempt: 1,
    causationEventId: requested.id,
  });
  const request = { projectId, workItemKey: imported.workItemKey, operation };
  const intent = deriveFactoryGroveWorkspaceIntent({
    controllerRepository,
    workItemKey: request.workItemKey,
    phase: "triage",
    phaseGeneration: imported.id,
    baseSha,
  });

  process.env.FACTORY_GROVE_SMOKE_PROVIDER_LOG = providerLog;
  process.env.GIT_TERMINAL_PROMPT = "0";
  process.env.CI = "1";
  station = "hosted Factory execution";
  const runtime = {
    projectId,
    repositoryId: intent.repositoryId,
    factoryStore,
    grove: config,
    maxRuntimeMs: 30_000,
    triage: { nextLiveRunRequiresRerun: false },
  };
  const executed = runHostedInFreshProcess({
    request,
    runtime,
  });
  assert(executed.outcome === "executed", "hosted Factory action did not execute");
  const eventPath = lifecyclePath();
  const evidenceBefore = readFileSync(eventPath, "utf8");
  assert(
    readFileSync(providerLog, "utf8").trim().split(/\r?\n/).length === 1,
    "provider count mismatch",
  );

  assert(readFileSync(setupLog, "utf8") === "x", "setup hook count mismatch");

  station = "terminal release";
  const events = evidenceBefore
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => parseObject(line, "lifecycle event"));
  const terminal = events.find((event) => event.type === "triage.work_item.completed");
  assert(typeof terminal?.id === "string", "durable triage terminal event missing");
  await releaseFactoryGroveWorkspace({
    config,
    intent,
    authority: { phase: "triage", terminalEvent: "triage-terminal", eventId: terminal.id },
  });
  const grove = await createGrove({
    repoRoot: controllerRepository,
    groveDir: poolDirectory,
    maxTrees: 1,
    fetchOnAcquire: false,
  });
  assert((await grove.inspect(intent.leaseId)) === null, "released lease is still present");
  assert(readFileSync(eventPath, "utf8") === evidenceBefore, "release changed Factory evidence");

  station = "hosted Factory replay after release";
  const recovered = runHostedInFreshProcess({
    request,
    runtime,
  });
  assert(recovered.outcome === "recovered", "hosted replay did not recover");
  assert(readFileSync(setupLog, "utf8") === "x", "replay reran the setup hook");
  assert(
    readFileSync(providerLog, "utf8").trim().split(/\r?\n/).length === 1,
    "replay reran provider",
  );
  assert((await grove.inspect(intent.leaseId)) === null, "replay recreated the released lease");
  assert(readFileSync(eventPath, "utf8") === evidenceBefore, "replay changed Factory evidence");

  rmSync(fixtureRoot, { recursive: true, force: true });
  console.log(`Factory Grove smoke PASS (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
} catch (error) {
  const bounded = (value: string) => value.trim().slice(-4000);
  console.error(`Factory Grove smoke FAIL at station: ${station}`);
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  if (lastChild.stderr.trim()) console.error(`--- child stderr ---\n${bounded(lastChild.stderr)}`);
  if (lastChild.stdout.trim()) console.error(`--- child stdout ---\n${bounded(lastChild.stdout)}`);
  console.error(`Retained fixture: ${fixtureRoot}`);
  process.exitCode = 1;
}
