import { Inngest } from "inngest";
import {
  ConnectionState,
  type ConnectHandlerOptions,
  type WorkerConnection,
} from "inngest/connect";
import { describe, expect, it, vi } from "vitest";
import type { Agent } from "../agent/contract.ts";
import type { GitHubPublicationService } from "../github/types.ts";
import type { RepositoryService } from "../repository/types.ts";
import type { LinearAutomationSettings } from "./config.ts";
import { LINEAR_ISSUE_POLL_FUNCTION_ID, type LinearIssuePollerLinear } from "./issue-poller.ts";
import {
  createLinearAutomationFunctions,
  LINEAR_AUTOMATION_APP_ID,
  LINEAR_AUTOMATION_MAX_WORKER_CONCURRENCY,
  linearAutomationCodexEnvironment,
  linearAutomationGitHubRepository,
  linearAutomationObservedStateIds,
  linearAutomationRepositoryPaths,
  parseLinearAutomationWorkerEnvironment,
  startLinearAutomationWorker,
  verifyLinearAutomationCodexAuthentication,
} from "./worker.ts";
import { LINEAR_READINESS_ROUTER_FUNCTION_ID } from "./readiness-router.ts";
import { LINEAR_TRIAGE_FUNCTION_ID, type LinearTriageService } from "./triage-consumer.ts";
import { LINEAR_SPEC_FUNCTION_ID } from "./spec-consumer.ts";
import { LINEAR_IMPLEMENTATION_FUNCTION_ID } from "./implementation-consumer.ts";

const settings: LinearAutomationSettings = {
  workspace: "/workspace/harness",
  readiness: {
    teamId: "team-1",
    projectId: "project-1",
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
    agentReadyLabelId: "label-agent-ready",
  },
  triage: {
    agent: "codex",
    model: "gpt-test",
    modelReasoningEffort: "high",
    maxRuntimeMs: 120_000,
  },
};

function app(options: Readonly<{ settings?: LinearAutomationSettings }> = {}) {
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
  } satisfies LinearTriageService & LinearIssuePollerLinear;
  const agent = {
    name: "codex",
    run: async () => {
      throw new Error("Unexpected agent call");
    },
  } satisfies Agent;
  const selectedSettings = options.settings ?? settings;
  const repository = selectedSettings.implementation
    ? ({
        resolveBase: async () => {
          throw new Error("Unexpected repository call");
        },
        prepareRun: async () => {
          throw new Error("Unexpected repository call");
        },
        inspectChanges: async () => {
          throw new Error("Unexpected repository call");
        },
        checkpointRun: async () => {
          throw new Error("Unexpected repository call");
        },
        openCheckpoint: async () => {
          throw new Error("Unexpected repository call");
        },
        cleanupRun: async () => {
          throw new Error("Unexpected repository call");
        },
      } satisfies RepositoryService)
    : undefined;
  const github = selectedSettings.implementation
    ? ({
        publishCheckpointPullRequest: async () => {
          throw new Error("Unexpected GitHub checkpoint call");
        },
      } satisfies GitHubPublicationService)
    : undefined;
  return createLinearAutomationFunctions({
    client,
    linear,
    triageAgent: agent,
    ...(selectedSettings.implementation
      ? {
          implementationAgent: agent,
          implementationReview: async () => {
            throw new Error("Unexpected implementation review call");
          },
          repository,
          github,
          githubRepository: {
            owner: "ferueda",
            repository: "harness",
            httpsRemote: "https://github.com/ferueda/harness.git",
          },
        }
      : {}),
    settings: selectedSettings,
  });
}

function specApp(
  options: Readonly<{
    includeSpecAuthorAgent?: boolean;
    includeSpecReviewAgent?: boolean;
  }> = {},
) {
  const base = app();
  const repository = {
    resolveBase: async () => {
      throw new Error("Unexpected repository call");
    },
    prepareRun: async () => {
      throw new Error("Unexpected repository call");
    },
    inspectChanges: async () => {
      throw new Error("Unexpected repository call");
    },
    checkpointRun: async () => {
      throw new Error("Unexpected repository call");
    },
    openCheckpoint: async () => {
      throw new Error("Unexpected repository call");
    },
    cleanupRun: async () => {
      throw new Error("Unexpected repository call");
    },
  } satisfies RepositoryService;
  const github = {
    publishCheckpointPullRequest: async () => {
      throw new Error("Unexpected GitHub checkpoint call");
    },
  } satisfies GitHubPublicationService;
  const specSettings: LinearAutomationSettings = {
    ...settings,
    spec: {
      agent: "codex",
      model: "gpt-5.6-sol",
      modelReasoningEffort: "high",
      maxRuntimeMs: 1_800_000,
      baseRef: "main",
      repositoryRuns: {
        remote: "https://github.com/ferueda/harness.git",
        maxTrees: 2,
        setup: { command: ["pnpm", "install"], timeoutMs: 60_000 },
      },
    },
  };
  return createLinearAutomationFunctions({
    client: base.client,
    linear: {
      listIssueRevisions: async () => {
        throw new Error("Unexpected Linear call");
      },
      getIssueContext: async () => {
        throw new Error("Unexpected Linear call");
      },
      ensureComment: async () => {
        throw new Error("Unexpected Linear call");
      },
      ensureDuplicateRelation: async () => {
        throw new Error("Unexpected Linear call");
      },
      ensureBlockedByRelation: async () => {
        throw new Error("Unexpected Linear call");
      },
      updateIssueLabels: async () => {
        throw new Error("Unexpected Linear call");
      },
      updateIssueState: async () => {
        throw new Error("Unexpected Linear call");
      },
    },
    triageAgent: {
      name: "codex",
      run: async () => {
        throw new Error("Unexpected triage agent call");
      },
    },
    ...(options.includeSpecAuthorAgent === false
      ? {}
      : {
          specAuthorAgent: {
            name: "codex",
            run: async () => {
              throw new Error("Unexpected Spec author agent call");
            },
          } satisfies Agent,
        }),
    ...(options.includeSpecReviewAgent === false
      ? {}
      : {
          specReviewAgent: {
            name: "codex",
            run: async () => {
              throw new Error("Unexpected Spec review agent call");
            },
          } satisfies Agent,
        }),
    settings: specSettings,
    repository,
    github,
    githubRepository: {
      owner: "ferueda",
      repository: "harness",
      httpsRemote: "https://github.com/ferueda/harness.git",
    },
  });
}

describe("Linear automation worker", () => {
  it("only exposes the required process environment to Codex", () => {
    expect(
      linearAutomationCodexEnvironment({
        CODEX_HOME: "/codex",
        CODEX_API_KEY: "codex-secret",
        HOME: "/home/worker",
        PATH: "/usr/bin",
        LINEAR_API_KEY: "linear-secret",
        INNGEST_EVENT_KEY: "event-secret",
        INNGEST_SIGNING_KEY: "signing-secret",
        GITHUB_TOKEN: "github-secret",
        UNRELATED_SECRET: "other-secret",
      }),
    ).toEqual({
      CODEX_API_KEY: "codex-secret",
      CODEX_HOME: "/codex",
      HOME: "/home/worker",
      PATH: "/usr/bin",
    });
  });

  it("accepts an API key without checking persistent Codex login", async () => {
    const checkLogin = vi.fn<
      (executable: string, environment: Readonly<Record<string, string>>) => Promise<void>
    >(async () => {
      throw new Error("Unexpected login check");
    });

    await expect(
      verifyLinearAutomationCodexAuthentication({
        environment: { CODEX_API_KEY: "codex-secret" },
        checkLogin,
      }),
    ).resolves.toBe("api-key");
    expect(checkLogin).not.toHaveBeenCalled();
  });

  it("accepts persistent Codex login and rejects a missing credential", async () => {
    const checkLogin = vi.fn<
      (executable: string, environment: Readonly<Record<string, string>>) => Promise<void>
    >(async () => undefined);
    const environment = {
      CODEX_API_KEY: "  ",
      CODEX_HOME: "/codex",
      HOME: "/home/worker",
      PATH: "/usr/bin",
    };

    await expect(
      verifyLinearAutomationCodexAuthentication({ environment, checkLogin }),
    ).resolves.toBe("codex-login");
    expect(checkLogin).toHaveBeenCalledWith("codex", {
      CODEX_HOME: "/codex",
      HOME: "/home/worker",
      PATH: "/usr/bin",
    });

    await expect(
      verifyLinearAutomationCodexAuthentication({
        environment,
        checkLogin: async () => {
          throw new Error("Not logged in");
        },
      }),
    ).rejects.toThrow(/Set CODEX_API_KEY for unattended operation/);
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

    expect(
      parseLinearAutomationWorkerEnvironment({
        LINEAR_API_KEY: "linear-key",
        INNGEST_DEV: "1",
        HARNESS_REPOSITORY_ROOT: "",
        GITHUB_TOKEN: " ",
      }),
    ).toMatchObject({
      linearApiKey: "linear-key",
      isDev: true,
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

    expect(() =>
      parseLinearAutomationWorkerEnvironment(
        { LINEAR_API_KEY: "linear-key", INNGEST_DEV: "1" },
        { repositoryEnabled: true },
      ),
    ).toThrow(/HARNESS_REPOSITORY_ROOT is required/);
    expect(
      parseLinearAutomationWorkerEnvironment(
        {
          LINEAR_API_KEY: "linear-key",
          INNGEST_DEV: "1",
          HARNESS_REPOSITORY_ROOT: "/var/lib/harness",
          GITHUB_TOKEN: "github-key",
        },
        { repositoryEnabled: true },
      ).repository,
    ).toEqual({
      repositoryRoot: "/var/lib/harness",
      githubToken: "github-key",
    });
  });

  it("registers exactly the poller, router, and triage consumer", () => {
    const functions = app().functions;

    expect(functions.map((fn) => fn.opts.id)).toEqual([
      LINEAR_ISSUE_POLL_FUNCTION_ID,
      LINEAR_READINESS_ROUTER_FUNCTION_ID,
      LINEAR_TRIAGE_FUNCTION_ID,
    ]);
    expect(app().readiness.enabledRoutes).toEqual({
      triage: true,
      spec: false,
      implement: false,
    });
    expect(linearAutomationObservedStateIds(app().readiness)).toEqual({
      backlog: settings.readiness.stateIds.backlog,
    });
  });

  it("observes Open only when a composed route can consume it", () => {
    const readiness = app().readiness;

    expect(
      linearAutomationObservedStateIds({
        ...readiness,
        enabledRoutes: { ...readiness.enabledRoutes, spec: true },
      }),
    ).toEqual({
      backlog: settings.readiness.stateIds.backlog,
      open: settings.readiness.stateIds.open,
    });
  });

  it("registers Spec and observes Open only when the Spec profile is composed", () => {
    const composed = specApp();
    expect(composed.functions.map((fn) => fn.opts.id)).toEqual([
      LINEAR_ISSUE_POLL_FUNCTION_ID,
      LINEAR_READINESS_ROUTER_FUNCTION_ID,
      LINEAR_TRIAGE_FUNCTION_ID,
      LINEAR_SPEC_FUNCTION_ID,
    ]);
    expect(composed.readiness.enabledRoutes.spec).toBe(true);
    expect(linearAutomationObservedStateIds(composed.readiness)).toEqual({
      backlog: settings.readiness.stateIds.backlog,
      open: settings.readiness.stateIds.open,
    });
  });

  it("registers Implement and keeps Open observation route-driven", () => {
    const composed = app({
      settings: {
        ...settings,
        implementation: {
          implementer: {
            agent: "codex",
            model: "gpt-5.6-sol",
            modelReasoningEffort: "high",
            maxRuntimeMs: 1_800_000,
          },
          reviewers: {
            agent: "codex",
            model: "gpt-5.6-terra",
            modelReasoningEffort: "medium",
            maxRuntimeMs: 600_000,
          },
          baseRef: "main",
          repositoryRuns: {
            remote: "https://github.com/ferueda/harness.git",
            maxTrees: 2,
            setup: { command: ["pnpm", "install"], timeoutMs: 60_000 },
          },
        },
      },
    });

    expect(composed.functions.map((fn) => fn.opts.id)).toEqual([
      LINEAR_ISSUE_POLL_FUNCTION_ID,
      LINEAR_READINESS_ROUTER_FUNCTION_ID,
      LINEAR_TRIAGE_FUNCTION_ID,
      LINEAR_IMPLEMENTATION_FUNCTION_ID,
    ]);
    expect(composed.readiness.enabledRoutes.implement).toBe(true);
    expect(linearAutomationObservedStateIds(composed.readiness)).toEqual({
      backlog: settings.readiness.stateIds.backlog,
      open: settings.readiness.stateIds.open,
    });
  });

  it("requires separately composed author and review agents when Spec is enabled", () => {
    expect(() => specApp({ includeSpecAuthorAgent: false })).toThrow(
      /requires its author and review agents, repository, and GitHub publication services/,
    );
    expect(() => specApp({ includeSpecReviewAgent: false })).toThrow(
      /requires its author and review agents, repository, and GitHub publication services/,
    );
  });

  it("derives stable isolated repository paths and rejects relative roots", () => {
    const first = linearAutomationRepositoryPaths({
      repositoryRoot: "/var/lib/harness",
      remote: "https://github.com/ferueda/harness.git",
    });
    expect(first).toEqual(
      linearAutomationRepositoryPaths({
        repositoryRoot: "/var/lib/harness",
        remote: "https://github.com/ferueda/harness.git",
      }),
    );
    expect(first.controllerWorkspace).toMatch(/\/[0-9a-f]{16}\/controller$/);
    expect(first.poolDirectory).toMatch(/\/[0-9a-f]{16}\/pool$/);
    expect(() =>
      linearAutomationRepositoryPaths({
        repositoryRoot: "relative",
        remote: "https://github.com/ferueda/harness.git",
      }),
    ).toThrow(/absolute/);
  });

  it("fails Spec startup for invalid or credential-bearing publication remotes", () => {
    expect(
      linearAutomationGitHubRepository("https://github.com/ferueda/harness.git"),
    ).toMatchObject({
      owner: "ferueda",
      repository: "harness",
    });
    expect(() =>
      linearAutomationGitHubRepository("https://token@github.com/ferueda/harness.git"),
    ).toThrow(/credential-free/);
    expect(() =>
      linearAutomationGitHubRepository("https://gitlab.com/ferueda/harness.git"),
    ).toThrow(/credential-free/);
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
