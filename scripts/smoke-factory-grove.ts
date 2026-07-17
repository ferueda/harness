#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
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
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { createGrove } from "@ferueda/grove";
import { Inngest } from "inngest";
import { connect } from "inngest/connect";
import { createAgentProvider } from "../providers/registry.ts";
import { requestHostedFactoryPhase } from "../lib/factory-hosted-authority.ts";
import {
  createFactoryInngestAdapter,
  createFactoryInngestDelivery,
  createFactoryOperationRequestedEvent,
  FACTORY_INNGEST_APP_ID,
  FACTORY_INNGEST_FUNCTION_ID,
  factoryOperationDeliveryId,
  FactoryOperationRequestedEvent,
} from "../lib/factory-inngest-adapter.ts";
import { readFactoryActionEvents } from "../lib/factory-lifecycle-kernel.ts";
import {
  createFactoryOperationRef,
  FactoryOperationReceiptSchema,
} from "../lib/factory-operation.ts";
import {
  deriveFactoryGroveWorkspaceIntent,
  releaseFactoryGroveWorkspace,
  type FactoryGroveWorkspaceConfig,
} from "../lib/factory-grove-workspace.ts";
import {
  deriveFactoryRepoIdentity,
  factoryStoreMetadata,
  resolveFactoryStore,
} from "../lib/factory-store.ts";

type JsonObject = Record<string, unknown>;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INNGEST_CLI = join(ROOT, "node_modules/.bin/inngest");
const HOSTED_RUNNER = pathToFileURL(join(ROOT, "lib/factory-hosted-operation.ts")).href;
const PROVIDERS = pathToFileURL(join(ROOT, "providers/registry.ts")).href;
const startedAt = Date.now();
let station = "fixture allocation";
let lastChild = { stdout: "", stderr: "" };
let devOutput = { stdout: "", stderr: "" };
let devServer: ReturnType<typeof spawn> | undefined;
let worker: Awaited<ReturnType<typeof connect>> | undefined;

for (const key of Object.keys(process.env)) {
  if (key.startsWith("INNGEST_")) delete process.env[key];
}

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

async function allocatePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveReady);
  });
  const address = server.address();
  assert(address && typeof address === "object", "failed to allocate loopback port");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolveClose();
    });
  });
  return port;
}

async function runAsync(command: string, args: string[]): Promise<string> {
  const child = spawn(command, args, {
    cwd: ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  const status = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  });
  lastChild = { stdout, stderr };
  if (status !== 0) fail(`${command} ${args.join(" ")} exited ${status ?? "without status"}`);
  return stdout.trim();
}

function rememberDevOutput(target: "stdout" | "stderr", chunk: unknown): void {
  devOutput[target] = `${devOutput[target]}${String(chunk)}`.slice(-8000);
}

async function waitForDevServer(baseUrl: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (devServer?.exitCode !== null) fail(`Inngest Dev Server exited ${devServer?.exitCode}`);
    try {
      const response = await fetch(baseUrl, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // The child may still be binding its loopback listener.
    }
    await delay(100);
  }
  fail(`Inngest Dev Server was not ready at ${baseUrl}`);
}

function findReceipt(value: unknown, outcome: "executed" | "recovered"): JsonObject | undefined {
  if (typeof value === "string") {
    try {
      return findReceipt(JSON.parse(value), outcome);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object") return undefined;
  if (!Array.isArray(value) && (value as JsonObject).outcome === outcome)
    return value as JsonObject;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findReceipt(child, outcome);
    if (found) return found;
  }
  return undefined;
}

async function pollEventReceipt(
  apiHost: string,
  eventId: string,
  outcome: "executed" | "recovered",
): Promise<JsonObject> {
  let last = "";
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      last = await runAsync(INNGEST_CLI, [
        "api",
        "--api-host",
        apiHost,
        "--raw",
        "get-event-runs",
        "--event-id",
        eventId,
        "--include-output",
      ]);
      const receipt = findReceipt(JSON.parse(last), outcome);
      if (receipt) return receipt;
    } catch {
      // Registration and execution are asynchronous; retain the last child diagnostics.
    }
    await delay(100);
  }
  fail(`event ${eventId} did not resolve to ${outcome}; last response: ${last.slice(-1000)}`);
}

async function waitForWorkerIdle(): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (worker?.getDebugState().inFlightRequestCount === 0) {
      // Let provider child cleanup finish after the worker releases its lease.
      await delay(100);
      return;
    }
    await delay(50);
  }
  fail("Inngest Connect worker did not become idle");
}

async function stopInngest(): Promise<void> {
  const errors: unknown[] = [];
  const currentWorker = worker;
  worker = undefined;
  if (currentWorker) {
    try {
      await currentWorker.close();
    } catch (error) {
      errors.push(error);
    }
  }

  const currentDevServer = devServer;
  devServer = undefined;
  if (currentDevServer && currentDevServer.exitCode === null) {
    try {
      const exited = new Promise<void>((resolveExit, rejectExit) => {
        const cleanup = () => {
          currentDevServer.off("exit", onExit);
          currentDevServer.off("error", onError);
        };
        const onExit = () => {
          cleanup();
          resolveExit();
        };
        const onError = (error: Error) => {
          cleanup();
          rejectExit(error);
        };
        currentDevServer.once("exit", onExit);
        currentDevServer.once("error", onError);
        if (currentDevServer.exitCode !== null) onExit();
      });

      currentDevServer.kill("SIGTERM");
      const exitedGracefully = await Promise.race([
        exited.then(() => true),
        delay(2_000).then(() => false),
      ]);
      if (!exitedGracefully) {
        if (currentDevServer.exitCode === null) currentDevServer.kill("SIGKILL");
        await exited;
      }
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length > 0) throw new AggregateError(errors, "Failed to stop Inngest smoke resources");
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
  const repositoryId = deriveFactoryRepoIdentity(controllerRepository).id;

  process.env.FACTORY_GROVE_SMOKE_PROVIDER_LOG = providerLog;
  process.env.GIT_TERMINAL_PROMPT = "0";
  process.env.CI = "1";
  station = "Inngest Dev Server startup";
  const [httpPort, gatewayPort] = await Promise.all([allocatePort(), allocatePort()]);
  assert(httpPort !== gatewayPort, "Inngest smoke ports must differ");
  const apiHost = `http://127.0.0.1:${httpPort}`;
  const gatewayUrl = `ws://127.0.0.1:${gatewayPort}/v0/connect`;
  devServer = spawn(
    INNGEST_CLI,
    [
      "dev",
      "--host",
      "127.0.0.1",
      "--port",
      String(httpPort),
      "--connect-gateway-port",
      String(gatewayPort),
      "--no-discovery",
      "--no-poll",
    ],
    { cwd: fixtureRoot, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
  );
  devServer.stdout!.on("data", (chunk) => rememberDevOutput("stdout", chunk));
  devServer.stderr!.on("data", (chunk) => rememberDevOutput("stderr", chunk));
  await waitForDevServer(apiHost);

  process.env.INNGEST_DEV = "1";
  process.env.INNGEST_BASE_URL = apiHost;
  process.env.INNGEST_EVENT_KEY = "factory-grove-smoke";
  const runtime = {
    projectId,
    repositoryId,
    factoryStore,
    grove: config,
    maxRuntimeMs: 30_000,
    agentProviderFactory: createAgentProvider,
    triage: { nextLiveRunRequiresRerun: false },
  };
  const inngest = new Inngest({ id: FACTORY_INNGEST_APP_ID });
  const factoryFunction = createFactoryInngestAdapter({
    client: inngest,
    runtime,
    runner: async ({ request: deliveredRequest, runtime: deliveredRuntime }) =>
      FactoryOperationReceiptSchema.parse(
        runHostedInFreshProcess({
          request: deliveredRequest,
          runtime: { ...deliveredRuntime, signal: undefined },
        }),
      ),
  });
  station = "Inngest Connect registration";
  worker = await connect({
    apps: [{ client: inngest, functions: [factoryFunction] }],
    instanceId: "factory-grove-smoke",
    maxWorkerConcurrency: 1,
    handleShutdownSignals: [],
    gatewayUrl,
    isolateExecution: false,
  });

  const functions = await runAsync(INNGEST_CLI, [
    "api",
    "--api-host",
    apiHost,
    "--raw",
    "get-functions",
    "--app-id",
    FACTORY_INNGEST_APP_ID,
  ]);
  assert(functions.includes(FACTORY_INNGEST_APP_ID), "registered Inngest app missing");
  assert(functions.includes(FACTORY_INNGEST_FUNCTION_ID), "registered Inngest function missing");

  station = "hosted Factory execution through Inngest";
  const deliverFactoryOperation = createFactoryInngestDelivery(inngest);
  let executedEventId: string | undefined;
  const reconciled = await requestHostedFactoryPhase({
    request: {
      projectId,
      workItem,
      phase: "triage",
      intent: "start",
      expectedPredecessor: null,
    },
    runtime: {
      projectId,
      repositoryId,
      factoryStore,
      grove: config,
      baseRef: "main",
      deliver: async (deliveredRequest) => {
        const durable = readFactoryActionEvents(
          factoryStore.factoryStateRoot,
          "file:GROVE-SMOKE-1",
        );
        assert(durable.at(-1)?.type === "triage.requested", "delivery preceded durable authority");
        const sent = await deliverFactoryOperation(deliveredRequest);
        executedEventId = sent.ids[0];
      },
      triage: {
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
      },
      planning: {
        plannerRole: { agent: "codex", model: "fake-codex" },
        reviewerRole: { agent: "codex", model: "fake-codex" },
        maxRuntimeMs: 30_000,
        agentProviderFactory: createAgentProvider,
        publicationMode: "local",
      },
      implementation: {
        implementerRole: { agent: "codex", model: "fake-codex" },
        reviewerRole: { agent: "codex", model: "fake-codex" },
      },
    },
  });
  assert(reconciled.outcome === "delivered", "Factory operation was not reconciled");
  const authorityEvents = readFactoryActionEvents(
    factoryStore.factoryStateRoot,
    "file:GROVE-SMOKE-1",
  );
  const requested = authorityEvents.find((event) => event.type === "triage.requested");
  assert(requested?.type === "triage.requested", "durable triage request missing");
  const operation = createFactoryOperationRef({
    phaseRunId: requested.phaseRunId,
    handler: "triageWorkItem",
    attempt: 1,
    causationEventId: requested.id,
  });
  const request = { projectId, workItemKey: requested.workItemKey, operation };
  const intent = deriveFactoryGroveWorkspaceIntent({
    controllerRepository,
    workItemKey: request.workItemKey,
    phase: "triage",
    phaseGeneration: requested.data.expectedPredecessor!,
    baseSha,
  });
  assert(intent.baseSha === baseSha, "authority changed the controller baseline");
  assert(
    factoryOperationDeliveryId(request) === createFactoryOperationRequestedEvent(request).id,
    "deterministic delivery identity mismatch",
  );
  assert(typeof executedEventId === "string", "executed delivery event ID missing");
  const executed = await pollEventReceipt(apiHost, executedEventId, "executed");
  await waitForWorkerIdle();
  assert(executed.outcome === "executed", "hosted Factory action did not execute");
  const eventPath = lifecyclePath();
  const evidenceBefore = readFileSync(eventPath, "utf8");
  assert(
    readFileSync(providerLog, "utf8").trim().split(/\r?\n/).length === 1,
    "provider count mismatch",
  );

  assert(readFileSync(setupLog, "utf8") === "xx", "setup hook count mismatch");

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

  station = "hosted Factory replay through Inngest after release";
  const replayEventId = `${executedEventId.slice(0, -1)}${executedEventId.endsWith("0") ? "1" : "0"}`;
  const recoveredEvent = await inngest.send(
    FactoryOperationRequestedEvent.create(request, { id: replayEventId }),
  );
  const recoveredEventId = recoveredEvent.ids[0];
  assert(typeof recoveredEventId === "string", "recovered delivery event ID missing");
  const recovered = await pollEventReceipt(apiHost, recoveredEventId, "recovered");
  assert(recovered.outcome === "recovered", "hosted replay did not recover");
  assert(readFileSync(setupLog, "utf8") === "xx", "replay reran the setup hook");
  assert(
    readFileSync(providerLog, "utf8").trim().split(/\r?\n/).length === 1,
    "replay reran provider",
  );
  assert((await grove.inspect(intent.leaseId)) === null, "replay recreated the released lease");
  assert(readFileSync(eventPath, "utf8") === evidenceBefore, "replay changed Factory evidence");

  await stopInngest();
  rmSync(fixtureRoot, { recursive: true, force: true });
  console.log(`Factory Grove smoke PASS (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
} catch (error) {
  let cleanupError: unknown;
  try {
    await stopInngest();
  } catch (caught) {
    cleanupError = caught;
  }
  const bounded = (value: string) => value.trim().slice(-4000);
  console.error(`Factory Grove smoke FAIL at station: ${station}`);
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  if (cleanupError)
    console.error(
      `--- cleanup error ---\n${cleanupError instanceof Error ? (cleanupError.stack ?? cleanupError.message) : String(cleanupError)}`,
    );
  if (lastChild.stderr.trim()) console.error(`--- child stderr ---\n${bounded(lastChild.stderr)}`);
  if (lastChild.stdout.trim()) console.error(`--- child stdout ---\n${bounded(lastChild.stdout)}`);
  if (devOutput.stderr.trim())
    console.error(`--- Dev Server stderr ---\n${bounded(devOutput.stderr)}`);
  if (devOutput.stdout.trim())
    console.error(`--- Dev Server stdout ---\n${bounded(devOutput.stdout)}`);
  console.error(`Retained fixture: ${fixtureRoot}`);
  process.exitCode = 1;
}
