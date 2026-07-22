#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMPOSE_FILE = join(ROOT, "compose.linear-automation.yaml");
const SMOKE_OVERRIDE = join(ROOT, "compose.linear-automation.smoke.yaml");
const POLL_EVENT_NAME = "linear/poll.requested";
const EVENT_KEY = "0123456789abcdef0123456789abcdef";
const SIGNING_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const fixtureRoot = mkdtempSync(join(tmpdir(), "harness-linear-compose-smoke-"));
const workspace = join(fixtureRoot, "workspace");
const environmentFile = join(fixtureRoot, "compose.env");
const projectName = `harness-linear-smoke-${process.pid}`;
const startedAt = Date.now();
let station = "preflight";
let lastOutput = "";
let workerImageId = "";

type EventRun = Readonly<{ status: string }>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function run(command: string, args: readonly string[], timeout = 600_000): string {
  try {
    const output = execFileSync(command, [...args], {
      cwd: ROOT,
      encoding: "utf8",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
    });
    lastOutput = output.trim();
    return output;
  } catch (error) {
    if (isExecError(error)) {
      lastOutput = [error.stdout, error.stderr].filter(Boolean).join("\n").trim();
    }
    throw error;
  }
}

function compose(args: readonly string[], timeout?: number): string {
  return run(
    "docker",
    [
      "compose",
      "--project-name",
      projectName,
      "--env-file",
      environmentFile,
      "--file",
      COMPOSE_FILE,
      "--file",
      SMOKE_OVERRIDE,
      ...args,
    ],
    timeout,
  );
}

async function allocatePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveReady);
  });
  const address = server.address();
  assert(address && typeof address === "object", "failed to allocate a loopback port");
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolveClose();
    });
  });
  return address.port;
}

async function waitUntil(
  description: string,
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (await predicate()) return;
    await delay(1_000);
  }
  throw new Error(`timed out waiting for ${description}`);
}

function serviceHealth(service: string): string {
  const containerId = compose(["ps", "--quiet", service], 30_000).trim();
  if (!containerId) return "missing";
  return run(
    "docker",
    [
      "inspect",
      "--format",
      "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}",
      containerId,
    ],
    30_000,
  ).trim();
}

async function waitForHealthy(service: string): Promise<void> {
  await waitUntil(`${service} health`, () => serviceHealth(service) === "healthy");
}

function sendPollEvent(eventId: string): string {
  const script = [
    'import { Inngest } from "inngest";',
    'const client = new Inngest({ id: "compose-smoke", eventKey: process.env.INNGEST_EVENT_KEY, signingKey: process.env.INNGEST_SIGNING_KEY, baseUrl: process.env.INNGEST_BASE_URL, isDev: false });',
    `const sent = await client.send({ name: ${JSON.stringify(POLL_EVENT_NAME)}, data: {}, id: process.argv[1] });`,
    "console.log(JSON.stringify(sent));",
  ].join("\n");
  const raw = compose(
    ["exec", "--no-TTY", "worker", "node", "--input-type=module", "--eval", script, eventId],
    30_000,
  );
  const parsed: unknown = JSON.parse(raw);
  assert(isRecord(parsed) && Array.isArray(parsed.ids), "smoke event response was invalid");
  assert(
    parsed.ids.length === 1 && typeof parsed.ids[0] === "string",
    "smoke event was not accepted",
  );
  return parsed.ids[0];
}

function getEventRuns(eventId: string): EventRun[] {
  const raw = compose(
    [
      "exec",
      "--no-TTY",
      "inngest",
      "inngest",
      "api",
      "--api-host",
      "http://127.0.0.1:8288",
      "--signing-key",
      SIGNING_KEY,
      "--raw",
      "get-event-runs",
      eventId,
      "--limit",
      "10",
    ],
    30_000,
  );
  const parsed: unknown = JSON.parse(raw);
  assert(isRecord(parsed), "event runs response was invalid");
  if (parsed.data === undefined) return [];
  assert(Array.isArray(parsed.data), "event runs data was invalid");
  return parsed.data.map((run) => {
    assert(isRecord(run) && typeof run.status === "string", "event run status was invalid");
    return { status: run.status };
  });
}

function prepareFixture(dashboardPort: number): void {
  run("git", ["init", "--quiet", "--initial-branch", "main", workspace], 30_000);
  writeFileSync(
    join(workspace, "harness.json"),
    `${JSON.stringify(
      {
        base: "main",
        linearAutomation: {
          readiness: {
            teamId: "team-compose-smoke",
            projectId: "project-compose-smoke",
            stateIds: {
              backlog: "state-backlog",
              open: "state-open",
              inProgress: "state-in-progress",
              needsInput: "state-needs-input",
              needsReview: "state-needs-review",
              done: "state-done",
              canceled: "state-canceled",
              duplicate: "state-duplicate",
            },
            agentActionLabelIds: {
              spec: "label-spec",
              implement: "label-implement",
            },
          },
          triage: {
            agent: "codex",
            model: "smoke-model",
            modelReasoningEffort: "medium",
            maxRuntimeMs: 30_000,
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(
    environmentFile,
    [
      `HARNESS_LINEAR_WORKSPACE=${workspace}`,
      `INNGEST_DASHBOARD_PORT=${dashboardPort}`,
      `INNGEST_EVENT_KEY=${EVENT_KEY}`,
      `INNGEST_SIGNING_KEY=${SIGNING_KEY}`,
      "CODEX_API_KEY=blocked-by-internal-smoke-network",
      "LINEAR_API_KEY=blocked-by-internal-smoke-network",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 },
  );
}

function composeVolumes(): string[] {
  return run(
    "docker",
    ["volume", "ls", "--quiet", "--filter", `label=com.docker.compose.project=${projectName}`],
    30_000,
  )
    .split("\n")
    .filter(Boolean);
}

function cleanup(): void {
  try {
    compose(["down", "--remove-orphans"], 180_000);
  } catch {
    // Continue with direct cleanup so a failed smoke does not leave resources behind.
  }
  try {
    const volumes = composeVolumes();
    if (volumes.length > 0) run("docker", ["volume", "rm", "--force", ...volumes], 60_000);
  } catch {
    // Docker may not be available when preflight itself fails.
  }
  if (workerImageId) {
    try {
      run("docker", ["image", "rm", "--force", workerImageId], 60_000);
    } catch {
      // Shared layers and concurrent builds may keep the disposable image referenced.
    }
  }
  rmSync(fixtureRoot, { recursive: true, force: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isExecError(
  value: unknown,
): value is Error & { stdout?: string | Buffer; stderr?: string | Buffer } {
  return value instanceof Error && ("stdout" in value || "stderr" in value);
}

try {
  run("docker", ["version", "--format", "{{.Server.Version}}"], 30_000);
  run("docker", ["compose", "version"], 30_000);
  const dashboardPort = await allocatePort();
  prepareFixture(dashboardPort);

  station = "Compose validation";
  compose(["config", "--quiet"], 30_000);

  station = "container build and startup";
  compose(["up", "--build", "--detach", "--wait", "--wait-timeout", "180"], 900_000);
  workerImageId = compose(["images", "--quiet", "worker"], 30_000).trim();
  assert(serviceHealth("inngest") === "healthy", "Inngest service was not healthy");
  assert(serviceHealth("worker") === "healthy", "worker service was not ready");

  station = "worker runtime boundary";
  const runtimeProbe = [
    'import { execFileSync } from "node:child_process";',
    'import { access } from "node:fs/promises";',
    'import { constants } from "node:fs";',
    'if (process.getuid?.() === 0) throw new Error("worker runs as root");',
    "await access(process.env.CODEX_HOME, constants.W_OK);",
    'execFileSync("codex", ["--version"], { stdio: "inherit" });',
  ].join("\n");
  compose(
    ["exec", "--no-TTY", "worker", "node", "--input-type=module", "--eval", runtimeProbe],
    30_000,
  );

  station = "worker restart";
  compose(["restart", "worker"], 180_000);
  await waitForHealthy("worker");

  station = "durable event acceptance";
  const eventId = sendPollEvent(`linear-compose-smoke-${process.pid}`);
  let runs: EventRun[] = [];
  await waitUntil("accepted event history", () => {
    runs = getEventRuns(eventId);
    return runs.length > 0;
  });

  station = "Inngest restart and worker reconnection";
  compose(["restart", "inngest"], 180_000);
  await Promise.all([waitForHealthy("inngest"), waitForHealthy("worker")]);
  const retainedRuns = getEventRuns(eventId);
  assert(retainedRuns.length === runs.length, "accepted event history changed after restart");

  station = "persistent shutdown";
  compose(["down", "--remove-orphans"], 180_000);
  const preservedVolumes = composeVolumes();
  assert(
    preservedVolumes.some((volume) => volume.endsWith("_inngest-data")),
    "Inngest volume was not preserved by normal shutdown",
  );
  assert(
    preservedVolumes.some((volume) => volume.endsWith("_codex-home")),
    "Codex volume was not preserved by normal shutdown",
  );

  cleanup();
  console.log(
    `Linear automation Compose smoke PASS (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`,
  );
} catch (error) {
  const failureOutput = lastOutput;
  let composeLogs = "";
  try {
    composeLogs = compose(["logs", "--no-color", "--tail", "200"], 30_000);
  } catch {
    // The stack may not have reached container creation.
  }
  cleanup();
  console.error(`Linear automation Compose smoke FAIL at station: ${station}`);
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  if (failureOutput) console.error(`Failed command output:\n${failureOutput.slice(-8_000)}`);
  if (composeLogs) console.error(`Compose logs:\n${composeLogs.slice(-8_000)}`);
  process.exitCode = 1;
}
