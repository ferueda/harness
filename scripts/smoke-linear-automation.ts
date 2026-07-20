#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Inngest } from "inngest";
import { connect } from "inngest/connect";
import type { Agent } from "../lib/agents.ts";
import type { LinearAutomationSettings } from "../lib/config.ts";
import {
  createLinearAutomationFunctions,
  LINEAR_AUTOMATION_APP_ID,
  startLinearAutomationWorker,
  type LinearAutomationWorker,
} from "../lib/linear-automation-worker.ts";
import { LINEAR_READINESS_ROUTER_FUNCTION_ID } from "../lib/linear-readiness-router.ts";
import { LINEAR_TRIAGE_FUNCTION_ID, type LinearTriageService } from "../lib/linear-triage.ts";
import {
  LINEAR_WEBHOOK_RECEIVED_EVENT_ID_PREFIX,
  LinearWebhookReceivedEvent,
} from "../lib/inngest/linear-webhook-transform.ts";
import type { LinearIssueContext } from "../lib/linear/read.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INNGEST_CLI = join(ROOT, "node_modules/.bin/inngest");
const INNGEST_CLI_TIMEOUT_MS = 10_000;
const WEBHOOK_SECRET = "linear-automation-smoke-secret";
const fixtureRoot = mkdtempSync(join(tmpdir(), "harness-linear-automation-smoke-"));
const startedAt = Date.now();
let station = "allocation";
let devServer: ReturnType<typeof spawn> | undefined;
let worker: LinearAutomationWorker | undefined;
let devOutput = "";
let lastCommandOutput = "";

const settings: LinearAutomationSettings = {
  workspace: fixtureRoot,
  organizationId: "organization-smoke",
  readiness: {
    teamId: "team-smoke",
    projectId: "project-smoke",
    stateIds: {
      backlog: "state-backlog",
      open: "state-open",
      inProgress: "state-in-progress",
      inReview: "state-in-review",
      done: "state-done",
      canceled: "state-canceled",
      duplicate: "state-duplicate",
    },
    nextActionLabelIds: {
      plan: "label-plan",
      implement: "label-implement",
      needsInput: "label-needs-input",
    },
  },
  triage: {
    agent: "codex",
    model: "fake-model",
    modelReasoningEffort: "medium",
    maxRuntimeMs: 30_000,
  },
};

const projection = {
  stateId: settings.readiness.stateIds.backlog,
  labelIds: new Set<string>(),
  comments: [] as string[],
  agentRuns: 0,
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
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
      if (error) reject(error);
      else resolveClose();
    });
  });
  return address.port;
}

async function waitUntil(
  description: string,
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await predicate()) return;
    if (devServer?.exitCode !== null) {
      throw new Error(`Inngest Dev Server exited ${devServer?.exitCode}`);
    }
    await delay(100);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function runCli(args: string[]): Promise<string> {
  const child = spawn(INNGEST_CLI, args, {
    cwd: fixtureRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: INNGEST_CLI_TIMEOUT_MS,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  const status = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  });
  lastCommandOutput = `${stdout}\n${stderr}`.trim();
  if (status !== 0) throw new Error(`Inngest CLI exited ${status ?? "without status"}`);
  return stdout;
}

function issueContext(): LinearIssueContext {
  const stateId = projection.stateId;
  return {
    id: "issue-smoke",
    identifier: "FER-SMOKE",
    title: "Prove the independent triage journey",
    description: "A bounded issue with enough detail to implement directly.",
    url: "https://linear.app/example/FER-SMOKE",
    state: { id: stateId, name: stateId, type: "unstarted" },
    team: { id: settings.readiness.teamId, key: "FER", name: "Harness" },
    project: {
      id: settings.readiness.projectId,
      name: "Harness",
      url: "https://linear.app/example/project/harness",
    },
    assignee: null,
    creator: null,
    labels: [...projection.labelIds].map((id) => ({ id, name: id })),
    comments: [],
    parent: null,
    children: [],
    duplicateOf: null,
    blockedBy: [],
    related: [],
    attachments: [],
    createdAt: "2026-07-20T12:00:00.000Z",
    updatedAt: "2026-07-20T12:00:00.000Z",
    completeness: {
      commentsTruncated: false,
      labelsTruncated: false,
      relationsTruncated: false,
      attachmentsTruncated: false,
      childrenTruncated: false,
    },
  };
}

function fakeLinear(): LinearTriageService {
  return {
    getIssueContext: async () => issueContext(),
    ensureComment: async (input) => {
      if (!projection.comments.some((comment) => comment.includes(input.marker))) {
        projection.comments.push(input.body);
        return { created: true, id: "comment-smoke" };
      }
      return { created: false, id: "comment-smoke" };
    },
    ensureDuplicateRelation: async () => {
      throw new Error("duplicate relation was not expected");
    },
    ensureBlockedByRelation: async () => {
      throw new Error("blocker relation was not expected");
    },
    updateIssueLabels: async (input) => {
      for (const id of input.removeLabelIds) projection.labelIds.delete(id);
      for (const id of input.addLabelIds) projection.labelIds.add(id);
      return {
        submitted: true,
        addedLabelIds: input.addLabelIds,
        removedLabelIds: input.removeLabelIds,
      };
    },
    updateIssueState: async (input) => {
      assert(
        projection.stateId === input.expectedStateId,
        "triage state guard did not match the current state",
      );
      projection.stateId = input.stateId;
      return { changed: true, stateId: input.stateId };
    },
  };
}

const agent: Agent = {
  name: "codex",
  run: async () => {
    projection.agentRuns += 1;
    return {
      ok: true,
      structuredOutput: {
        decision: "ready-for-agent",
        scope: "bounded",
        agentAction: "implement",
        rationale: "The issue is bounded and gives the implementation outcome directly.",
        evidence: [
          {
            kind: "tracker",
            path: null,
            summary: "The issue description states one concrete outcome.",
          },
        ],
        questions: [],
        inputReason: null,
        duplicateOf: null,
        blockedBy: [],
      },
      raw: { source: "linear-automation-smoke" },
    };
  },
};

async function stop(): Promise<void> {
  const errors: unknown[] = [];
  if (worker) {
    try {
      await worker.close();
      await worker.closed;
    } catch (error) {
      errors.push(error);
    }
    worker = undefined;
  }
  if (devServer?.exitCode === null) {
    const child = devServer;
    const exited = new Promise<void>((resolveExit, rejectExit) => {
      const cleanup = () => {
        child.off("exit", onExit);
        child.off("error", onError);
      };
      const onExit = () => {
        cleanup();
        resolveExit();
      };
      const onError = (error: Error) => {
        cleanup();
        rejectExit(error);
      };
      child.once("exit", onExit);
      child.once("error", onError);
      if (child.exitCode !== null) onExit();
    });
    child.kill("SIGTERM");
    const graceful = await Promise.race([exited.then(() => true), delay(2_000).then(() => false)]);
    if (!graceful) {
      if (child.exitCode === null) child.kill("SIGKILL");
      await exited;
    }
  }
  devServer = undefined;
  if (errors.length > 0) throw new AggregateError(errors, "smoke cleanup failed");
}

try {
  const [httpPort, gatewayPort] = await Promise.all([allocatePort(), allocatePort()]);
  assert(httpPort !== gatewayPort, "Inngest smoke ports must differ");
  const apiHost = `http://127.0.0.1:${httpPort}`;
  const gatewayUrl = `ws://127.0.0.1:${gatewayPort}/v0/connect`;

  station = "Inngest Dev Server startup";
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
    { cwd: fixtureRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  devServer.stdout!.on("data", (chunk) => (devOutput += String(chunk)));
  devServer.stderr!.on("data", (chunk) => (devOutput += String(chunk)));
  await waitUntil("Inngest Dev Server", async () => {
    try {
      return (await fetch(apiHost, { signal: AbortSignal.timeout(500) })).ok;
    } catch {
      return false;
    }
  });

  process.env.INNGEST_DEV = "1";
  process.env.INNGEST_BASE_URL = apiHost;
  process.env.INNGEST_EVENT_KEY = "linear-automation-smoke";
  const client = new Inngest({
    id: LINEAR_AUTOMATION_APP_ID,
    eventKey: "linear-automation-smoke",
    isDev: true,
  });
  const app = createLinearAutomationFunctions({
    client,
    linear: fakeLinear(),
    agent,
    settings,
    webhookSecret: WEBHOOK_SECRET,
  });

  station = "Inngest Connect registration";
  worker = await startLinearAutomationWorker({
    app,
    host: "127.0.0.1",
    port: 0,
    instanceId: "linear-automation-smoke",
    connectWorker: (options) =>
      connect({
        ...options,
        gatewayUrl,
        handleShutdownSignals: [],
      }),
  });
  await waitUntil("worker readiness", async () => {
    try {
      return (await fetch(`${worker?.healthUrl}/ready`)).ok;
    } catch {
      return false;
    }
  });
  const registered = await runCli([
    "api",
    "--api-host",
    apiHost,
    "--raw",
    "get-functions",
    "--app-id",
    LINEAR_AUTOMATION_APP_ID,
  ]);
  assert(registered.includes(LINEAR_READINESS_ROUTER_FUNCTION_ID), "router registration missing");
  assert(registered.includes(LINEAR_TRIAGE_FUNCTION_ID), "triage registration missing");

  station = "signed webhook triage journey";
  const now = Date.now();
  const deliveryId = "delivery-smoke";
  const rawBody = JSON.stringify({
    action: "create",
    type: "Issue",
    organizationId: settings.organizationId,
    webhookTimestamp: now,
    data: {
      id: "issue-smoke",
      updatedAt: new Date(now).toISOString(),
    },
  });
  const signature = createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");
  const sent = await client.send(
    LinearWebhookReceivedEvent.create(
      { rawBody, signature, deliveryId },
      {
        id: `${LINEAR_WEBHOOK_RECEIVED_EVENT_ID_PREFIX}${deliveryId}`,
        ts: now,
      },
    ),
  );
  assert(sent.ids.length === 1, "webhook event was not accepted");

  await waitUntil(
    "triage projection",
    () =>
      projection.stateId === settings.readiness.stateIds.open &&
      projection.labelIds.has(settings.readiness.nextActionLabelIds.implement) &&
      projection.comments.length === 1,
  );
  assert(projection.agentRuns === 1, "triage agent did not run exactly once");
  assert(
    projection.comments[0]?.includes("**Why Implement:**"),
    "triage rationale comment missing",
  );

  station = "clean shutdown";
  await stop();
  rmSync(fixtureRoot, { recursive: true, force: true });
  console.log(`Linear automation smoke PASS (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
} catch (error) {
  let cleanupError: unknown;
  try {
    await stop();
  } catch (caught) {
    cleanupError = caught;
  }
  console.error(`Linear automation smoke FAIL at station: ${station}`);
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  if (cleanupError) {
    console.error(
      `Cleanup error: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
    );
  }
  if (lastCommandOutput) console.error(`Last CLI output:\n${lastCommandOutput.slice(-4000)}`);
  if (devOutput) console.error(`Dev Server output:\n${devOutput.slice(-4000)}`);
  console.error(`Retained fixture: ${fixtureRoot}`);
  process.exitCode = 1;
}
