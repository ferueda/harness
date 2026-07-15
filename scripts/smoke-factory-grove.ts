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
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGrove } from "@ferueda/grove";
import {
  deriveFactoryGroveWorkspaceIntent,
  releaseFactoryGroveWorkspace,
  type FactoryGroveWorkspace,
  type FactoryGroveWorkspaceConfig,
} from "../lib/factory-grove-workspace.ts";

type JsonObject = Record<string, unknown>;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin/harness.ts");
const ADAPTER = pathToFileURL(join(ROOT, "lib/factory-grove-workspace.ts")).href;
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

function ensureInFreshProcess(
  config: FactoryGroveWorkspaceConfig,
  intent: ReturnType<typeof deriveFactoryGroveWorkspaceIntent>,
): FactoryGroveWorkspace {
  const source = `
    const { ensureFactoryGroveWorkspace } = await import(${JSON.stringify(ADAPTER)});
    const input = JSON.parse(process.env.FACTORY_GROVE_SMOKE_INPUT);
    console.log(JSON.stringify(await ensureFactoryGroveWorkspace(input)));
  `;
  const output = run(process.execPath, ["--input-type=module", "--eval", source], {
    env: {
      ...process.env,
      FACTORY_GROVE_SMOKE_INPUT: JSON.stringify({ config, intent }),
    },
  });
  return parseObject(output, "ensure result") as FactoryGroveWorkspace;
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

  const config: FactoryGroveWorkspaceConfig = {
    controllerRepository,
    poolDirectory,
    poolCapacity: 1,
    setupCommand: `printf x >> '${setupLog}'`,
  };
  const intent = deriveFactoryGroveWorkspaceIntent({
    controllerRepository,
    workItemKey: "file:GROVE-SMOKE-1",
    phase: "triage",
    phaseGeneration: "triage-generation-1",
    baseSha,
  });

  station = "Grove acquire and setup";
  const acquired = ensureInFreshProcess(config, intent);
  assert(
    git(["rev-parse", "HEAD"], acquired.workspace) === baseSha,
    "Grove checkout base mismatch",
  );
  assert(git(["branch", "--show-current"], acquired.workspace) === "", "triage was not detached");
  assert(readFileSync(setupLog, "utf8") === "x", "setup hook did not run on acquire");

  station = "Factory triage action";
  const factoryOutput = parseObject(
    run(
      process.execPath,
      [
        BIN,
        "factory",
        "triage",
        "--workspace",
        acquired.workspace,
        "--item-file",
        join(acquired.workspace, "item.json"),
        "--factory-store-root",
        storeRoot,
        "--factory-store-project-id",
        projectId,
      ],
      {
        env: {
          ...process.env,
          PATH: `${toolsRoot}${delimiter}${process.env.PATH ?? ""}`,
          FACTORY_GROVE_SMOKE_PROVIDER_LOG: providerLog,
          GIT_TERMINAL_PROMPT: "0",
          CI: "1",
        },
      },
    ),
    "Factory output",
  );
  assert(factoryOutput.outcome === "action-completed", "Factory triage action did not complete");
  const eventPath = lifecyclePath();
  const evidenceBefore = readFileSync(eventPath, "utf8");
  assert(
    readFileSync(providerLog, "utf8").trim().split(/\r?\n/).length === 1,
    "provider count mismatch",
  );

  station = "restart reacquire";
  const reopened = ensureInFreshProcess({ ...config }, { ...intent });
  assert(reopened.workspace === acquired.workspace, "reacquire changed the canonical path");
  assert(readFileSync(setupLog, "utf8") === "xx", "setup hook did not rerun on reacquire");
  assert(readFileSync(eventPath, "utf8") === evidenceBefore, "reacquire changed Factory evidence");

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
