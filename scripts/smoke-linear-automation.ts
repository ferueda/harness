#!/usr/bin/env node

import { spawn } from "node:child_process";
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
  LinearPollRequestedEvent,
  linearIssueRevisionEventId,
} from "../lib/inngest/linear-revision-events.ts";
import {
  createLinearAutomationFunctions,
  LINEAR_AUTOMATION_APP_ID,
  startLinearAutomationWorker,
  type LinearAutomationWorker,
} from "../lib/linear-automation-worker.ts";
import {
  LINEAR_BACKLOG_POLL_FUNCTION_ID,
  LINEAR_BACKLOG_POLL_LIMIT,
  type LinearBacklogPollerLinear,
} from "../lib/linear-backlog-poller.ts";
import { LINEAR_READINESS_ROUTER_FUNCTION_ID } from "../lib/linear-readiness-router.ts";
import { LINEAR_TRIAGE_FUNCTION_ID, type LinearTriageService } from "../lib/linear-triage.ts";
import type { LinearIssueContext } from "../lib/linear/read.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INNGEST_CLI = join(ROOT, "node_modules/.bin/inngest");
const INNGEST_CLI_TIMEOUT_MS = 10_000;
const EVENT_KEY = "linear-automation-smoke-event";
const SIGNING_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const REVISION_UPDATED_AT = "2026-07-20T12:00:00.000Z";
const fixtureRoot = mkdtempSync(join(tmpdir(), "harness-linear-automation-smoke-"));
const startedAt = Date.now();
let station = "allocation";
let inngestServer: ReturnType<typeof spawn> | undefined;
let worker: LinearAutomationWorker | undefined;
let devOutput = "";
let lastCommandOutput = "";

type InngestEventRun = Readonly<{
  status: string;
}>;

const settings: LinearAutomationSettings = {
  workspace: fixtureRoot,
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
  contextReads: 0,
  pollInputs: [] as Array<{
    teamId: string;
    projectId: string;
    stateId: string;
    limit: number;
  }>,
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
    if (inngestServer?.exitCode !== null) {
      throw new Error(`Inngest server exited ${inngestServer?.exitCode}`);
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

async function getEventRuns(apiHost: string, eventId: string): Promise<InngestEventRun[]> {
  const raw = await runCli([
    "api",
    "--api-host",
    apiHost,
    "--signing-key",
    SIGNING_KEY,
    "--raw",
    "get-event-runs",
    eventId,
    "--limit",
    "10",
  ]);
  const parsed: unknown = JSON.parse(raw);
  assert(isRecord(parsed), "event runs response was invalid");
  if (parsed.data === undefined) return [];
  assert(Array.isArray(parsed.data), "event runs data was invalid");
  return parsed.data.map((run) => {
    assert(isRecord(run) && typeof run.status === "string", "event run status was invalid");
    return { status: run.status.toUpperCase() };
  });
}

async function waitForEventRuns(apiHost: string, eventId: string): Promise<InngestEventRun[]> {
  let runs: InngestEventRun[] = [];
  await waitUntil(`event ${eventId} runs`, async () => {
    runs = await getEventRuns(apiHost, eventId);
    const failed = runs.find((run) => run.status === "FAILED" || run.status === "CANCELLED");
    if (failed) throw new Error(`event ${eventId} run ${failed.status.toLowerCase()}`);
    return runs.length > 0 && runs.every((run) => run.status === "COMPLETED");
  });
  return runs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function publishedInternalEventIds(externalId: string): string[] {
  const ids = new Set<string>();
  for (const line of devOutput.split("\n")) {
    try {
      const entry: unknown = JSON.parse(line);
      if (
        isRecord(entry) &&
        entry.external_id === externalId &&
        typeof entry.internal_id === "string"
      ) {
        ids.add(entry.internal_id);
      }
    } catch {
      // Inngest also writes plain-text startup lines; only JSON event records matter here.
    }
  }
  return [...ids];
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
    updatedAt: REVISION_UPDATED_AT,
    completeness: {
      commentsTruncated: false,
      labelsTruncated: false,
      relationsTruncated: false,
      attachmentsTruncated: false,
      childrenTruncated: false,
    },
  };
}

function fakeLinear(): LinearTriageService & LinearBacklogPollerLinear {
  return {
    listIssueRevisions: async (input) => {
      projection.pollInputs.push(input);
      return {
        revisions: [
          {
            id: "issue-smoke",
            identifier: "FER-SMOKE",
            updatedAt: REVISION_UPDATED_AT,
          },
        ],
        truncated: false,
      };
    },
    getIssueContext: async () => {
      projection.contextReads += 1;
      return issueContext();
    },
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
  if (inngestServer?.exitCode === null) {
    const child = inngestServer;
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
  inngestServer = undefined;
  if (errors.length > 0) throw new AggregateError(errors, "smoke cleanup failed");
}

try {
  const [httpPort, gatewayPort] = await Promise.all([allocatePort(), allocatePort()]);
  assert(httpPort !== gatewayPort, "Inngest smoke ports must differ");
  const apiHost = `http://127.0.0.1:${httpPort}`;
  const gatewayUrl = `ws://127.0.0.1:${gatewayPort}/v0/connect`;

  station = "self-hosted Inngest startup";
  inngestServer = spawn(
    INNGEST_CLI,
    [
      "start",
      "--host",
      "127.0.0.1",
      "--port",
      String(httpPort),
      "--connect-gateway-port",
      String(gatewayPort),
      "--sqlite-dir",
      join(fixtureRoot, "inngest"),
      "--event-key",
      EVENT_KEY,
      "--signing-key",
      SIGNING_KEY,
    ],
    { cwd: fixtureRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  inngestServer.stdout!.on("data", (chunk) => (devOutput += String(chunk)));
  inngestServer.stderr!.on("data", (chunk) => (devOutput += String(chunk)));
  await waitUntil("self-hosted Inngest", async () => {
    try {
      return (await fetch(apiHost, { signal: AbortSignal.timeout(500) })).ok;
    } catch {
      return false;
    }
  });

  process.env.INNGEST_DEV = "0";
  process.env.INNGEST_BASE_URL = apiHost;
  process.env.INNGEST_EVENT_KEY = EVENT_KEY;
  process.env.INNGEST_SIGNING_KEY = SIGNING_KEY;
  const client = new Inngest({
    id: LINEAR_AUTOMATION_APP_ID,
    eventKey: EVENT_KEY,
    signingKey: SIGNING_KEY,
    baseUrl: apiHost,
    isDev: false,
  });
  const app = createLinearAutomationFunctions({
    client,
    linear: fakeLinear(),
    agent,
    settings,
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
    "--signing-key",
    SIGNING_KEY,
    "--raw",
    "get-functions",
    "--app-id",
    LINEAR_AUTOMATION_APP_ID,
  ]);
  assert(registered.includes(LINEAR_BACKLOG_POLL_FUNCTION_ID), "poller registration missing");
  assert(registered.includes(LINEAR_READINESS_ROUTER_FUNCTION_ID), "router registration missing");
  assert(registered.includes(LINEAR_TRIAGE_FUNCTION_ID), "triage registration missing");

  station = "polled Backlog triage journey";
  const pollInputsBeforeJourney = projection.pollInputs.length;
  const sent = await client.send(
    LinearPollRequestedEvent.create({}, { id: "linear-automation-smoke-poll-1" }),
  );
  assert(sent.ids.length === 1, "poll event was not accepted");
  await waitForEventRuns(apiHost, sent.ids[0]!);

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
  assert(
    projection.pollInputs.length > pollInputsBeforeJourney,
    "explicit poll did not list Backlog",
  );
  assert(
    projection.pollInputs.slice(pollInputsBeforeJourney).some(
      (pollInput) =>
        JSON.stringify(pollInput) ===
        JSON.stringify({
          teamId: settings.readiness.teamId,
          projectId: settings.readiness.projectId,
          stateId: settings.readiness.stateIds.backlog,
          limit: LINEAR_BACKLOG_POLL_LIMIT,
        }),
    ),
    "poller used unexpected Linear scope",
  );
  const revisionEventId = linearIssueRevisionEventId({
    issueId: "issue-smoke",
    issueIdentifier: "FER-SMOKE",
    updatedAt: REVISION_UPDATED_AT,
  });
  await waitUntil(
    "published revision event",
    () => publishedInternalEventIds(revisionEventId).length > 0,
  );
  const firstRevisionInternalId = publishedInternalEventIds(revisionEventId)[0]!;
  const firstRevisionRuns = await waitForEventRuns(apiHost, firstRevisionInternalId);
  assert(
    firstRevisionRuns.length === 1 && firstRevisionRuns[0]?.status === "COMPLETED",
    "initial revision readiness run did not complete",
  );

  station = "unchanged revision deduplication";
  const contextReadsAfterProjection = projection.contextReads;
  const pollInputsBeforeRepeat = projection.pollInputs.length;
  const repeated = await client.send(
    LinearPollRequestedEvent.create({}, { id: "linear-automation-smoke-poll-2" }),
  );
  assert(repeated.ids.length === 1, "repeated poll event was not accepted");
  await waitForEventRuns(apiHost, repeated.ids[0]!);
  assert(projection.pollInputs.length > pollInputsBeforeRepeat, "repeated poll did not run");
  const revisionRuns = (
    await Promise.all(
      publishedInternalEventIds(revisionEventId).map((eventId) => getEventRuns(apiHost, eventId)),
    )
  ).flat();
  assert(
    revisionRuns.length === 1 && revisionRuns[0]?.status === "COMPLETED",
    "unchanged revision did not retain exactly one completed readiness run",
  );
  assert(
    projection.contextReads === contextReadsAfterProjection,
    `unchanged revision ${revisionEventId} was routed twice`,
  );
  assert(projection.agentRuns === 1, "unchanged revision reran triage");

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
  if (devOutput) console.error(`Inngest server output:\n${devOutput.slice(-4000)}`);
  console.error(`Retained fixture: ${fixtureRoot}`);
  process.exitCode = 1;
}
