import { Inngest } from "inngest";
import {
  ConnectionState,
  type ConnectHandlerOptions,
  type WorkerConnection,
} from "inngest/connect";
import { describe, expect, it, vi } from "vitest";
import type { Agent } from "./agents.ts";
import type { LinearAutomationSettings } from "./config.ts";
import {
  LINEAR_BACKLOG_POLL_FUNCTION_ID,
  type LinearBacklogPollerLinear,
} from "./linear-backlog-poller.ts";
import {
  createLinearAutomationFunctions,
  LINEAR_AUTOMATION_APP_ID,
  LINEAR_AUTOMATION_ENABLED_ROUTES,
  LINEAR_AUTOMATION_MAX_WORKER_CONCURRENCY,
  linearAutomationCodexEnvironment,
  parseLinearAutomationWorkerEnvironment,
  startLinearAutomationWorker,
} from "./linear-automation-worker.ts";
import { LINEAR_READINESS_ROUTER_FUNCTION_ID } from "./linear-readiness-router.ts";
import { LINEAR_TRIAGE_FUNCTION_ID, type LinearTriageService } from "./linear-triage.ts";

const settings: LinearAutomationSettings = {
  workspace: "/workspace/harness",
  readiness: {
    teamId: "team-1",
    projectId: "project-1",
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
    model: "gpt-test",
    modelReasoningEffort: "high",
    maxRuntimeMs: 120_000,
  },
};

function app() {
  const client = new Inngest({ id: LINEAR_AUTOMATION_APP_ID, eventKey: "test" });
  const never = async () => {
    throw new Error("Unexpected Linear call");
  };
  const linear = {
    listIssueRevisions: never,
    getIssueContext: never,
    ensureComment: never,
    ensureDuplicateRelation: never,
    ensureBlockedByRelation: never,
    updateIssueLabels: never,
    updateIssueState: never,
  } satisfies LinearTriageService & LinearBacklogPollerLinear;
  const agent = {
    name: "codex",
    run: async () => {
      throw new Error("Unexpected agent call");
    },
  } satisfies Agent;
  return createLinearAutomationFunctions({
    client,
    linear,
    agent,
    settings,
  });
}

describe("Linear automation worker", () => {
  it("only exposes the required process environment to Codex", () => {
    expect(
      linearAutomationCodexEnvironment({
        CODEX_HOME: "/codex",
        HOME: "/home/worker",
        PATH: "/usr/bin",
        LINEAR_API_KEY: "linear-secret",
        INNGEST_EVENT_KEY: "event-secret",
        INNGEST_SIGNING_KEY: "signing-secret",
        UNRELATED_SECRET: "other-secret",
      }),
    ).toEqual({
      CODEX_HOME: "/codex",
      HOME: "/home/worker",
      PATH: "/usr/bin",
    });
  });

  it("validates self-hosted secrets and keeps SDK development minimal", () => {
    expect(
      parseLinearAutomationWorkerEnvironment({
        LINEAR_API_KEY: "linear-key",
        INNGEST_DEV: "1",
        HARNESS_WORKER_HOST: "127.0.0.1",
        HARNESS_WORKER_PORT: "8088",
        HARNESS_WORKER_INSTANCE_ID: "worker-1",
        HARNESS_APP_VERSION: "commit-1",
      }),
    ).toEqual({
      linearApiKey: "linear-key",
      isDev: true,
      host: "127.0.0.1",
      port: 8088,
      instanceId: "worker-1",
      appVersion: "commit-1",
    });

    expect(() =>
      parseLinearAutomationWorkerEnvironment({
        LINEAR_API_KEY: "linear-key",
      }),
    ).toThrow(/INNGEST_EVENT_KEY is required unless INNGEST_DEV is enabled/);
    expect(() =>
      parseLinearAutomationWorkerEnvironment({
        LINEAR_API_KEY: "linear-key",
        INNGEST_DEV: "1",
        HARNESS_WORKER_PORT: "70000",
      }),
    ).toThrow(/HARNESS_WORKER_PORT must be an integer from 1 to 65535/);

    expect(
      parseLinearAutomationWorkerEnvironment({
        LINEAR_API_KEY: "linear-key",
        INNGEST_EVENT_KEY: "event-key",
        INNGEST_SIGNING_KEY: "signing-key",
        INNGEST_BASE_URL: "http://127.0.0.1:8288",
      }),
    ).toMatchObject({
      linearApiKey: "linear-key",
      inngestEventKey: "event-key",
      inngestSigningKey: "signing-key",
      inngestBaseUrl: "http://127.0.0.1:8288",
      isDev: false,
    });
    expect(() =>
      parseLinearAutomationWorkerEnvironment({
        LINEAR_API_KEY: "linear-key",
        INNGEST_EVENT_KEY: "event-key",
        INNGEST_SIGNING_KEY: "signing-key",
      }),
    ).toThrow(/INNGEST_BASE_URL is required unless INNGEST_DEV is enabled/);
  });

  it("registers exactly the poller, router, and triage consumer", () => {
    const functions = app().functions;

    expect(functions.map((fn) => fn.opts.id)).toEqual([
      LINEAR_BACKLOG_POLL_FUNCTION_ID,
      LINEAR_READINESS_ROUTER_FUNCTION_ID,
      LINEAR_TRIAGE_FUNCTION_ID,
    ]);
    expect(app().readiness.enabledRoutes).toEqual({
      triage: true,
      plan: false,
      implement: false,
    });
    expect(app().readiness.enabledRoutes).toBe(LINEAR_AUTOMATION_ENABLED_ROUTES);
  });

  it("reports liveness separately from Connect readiness and closes cleanly", async () => {
    const connectionClosed = Promise.withResolvers<void>();
    const close = vi.fn<WorkerConnection["close"]>(async () => {
      connection.state = ConnectionState.CLOSED;
      connectionClosed.resolve();
    });
    const connection: WorkerConnection = {
      connectionId: "connection-1",
      state: ConnectionState.CONNECTING,
      closed: connectionClosed.promise,
      close,
      getDebugState: vi.fn<WorkerConnection["getDebugState"]>(() => ({
        state: connection.state,
        activeConnectionId: connection.connectionId,
        drainingConnectionId: undefined,
        lastHeartbeatSentAt: undefined,
        lastHeartbeatReceivedAt: undefined,
        lastMessageReceivedAt: undefined,
        shutdownRequested: false,
        inFlightRequestCount: 0,
        inFlightRequests: [],
      })),
    };
    const connectWorker = vi.fn<(options: ConnectHandlerOptions) => Promise<WorkerConnection>>(
      async () => connection,
    );
    const worker = await startLinearAutomationWorker({
      app: app(),
      host: "127.0.0.1",
      port: 0,
      instanceId: "worker-1",
      connectWorker,
    });

    try {
      expect(connectWorker).toHaveBeenCalledWith(
        expect.objectContaining({
          instanceId: "worker-1",
          maxWorkerConcurrency: LINEAR_AUTOMATION_MAX_WORKER_CONCURRENCY,
        }),
      );
      expect((await fetch(`${worker.healthUrl}/health`)).status).toBe(200);
      expect((await fetch(`${worker.healthUrl}/ready`)).status).toBe(503);
      expect((await fetch(`${worker.healthUrl}/missing`)).status).toBe(404);

      connection.state = ConnectionState.ACTIVE;
      expect((await fetch(`${worker.healthUrl}/ready`)).status).toBe(200);
    } finally {
      await worker.close();
      await worker.closed;
    }
    expect(close).toHaveBeenCalledOnce();
    await expect(fetch(`${worker.healthUrl}/health`)).rejects.toBeDefined();
  });
});
