import { execFile } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { Inngest, type InngestFunction } from "inngest";
import {
  connect,
  ConnectionState,
  type ConnectHandlerOptions,
  type WorkerConnection,
} from "inngest/connect";
import { z } from "zod";
import type { Agent } from "../agent/contract.ts";
import { resolveLinearAutomationSettings, type LinearAutomationSettings } from "./config.ts";
import {
  createLinearIssuePoller,
  type LinearIssuePollerConfig,
  type LinearIssuePollerLinear,
} from "./issue-poller.ts";
import { createLinearReadinessRouter } from "./readiness-router.ts";
import type { LinearReadinessConfig } from "./readiness.ts";
import { createLinearTriageFunction, type LinearTriageService } from "./triage-consumer.ts";
import { createLinear, type LinearService } from "../linear/client.ts";
import { createAgentProvider } from "../../providers/registry.ts";

export const LINEAR_AUTOMATION_APP_ID = "harness-linear-automation";
export const LINEAR_AUTOMATION_MAX_WORKER_CONCURRENCY = 1;
export const LINEAR_AUTOMATION_ENABLED_ROUTES = Object.freeze({
  triage: true,
  spec: false,
  implement: false,
});
export const LINEAR_AUTOMATION_READ_LIMITS = Object.freeze({
  comments: 200,
  labels: 100,
  relations: 100,
  attachments: 50,
  children: 100,
});
const LINEAR_AUTOMATION_CODEX_ENV_KEYS = Object.freeze([
  "CODEX_API_KEY",
  "CODEX_CA_CERTIFICATE",
  "CODEX_HOME",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NODE_EXTRA_CA_CERTS",
  "PATH",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TMPDIR",
] as const);
const execFileAsync = promisify(execFile);

const WorkerEnvironmentSchema = z
  .object({
    LINEAR_API_KEY: z.string().trim().min(1),
    INNGEST_EVENT_KEY: z.string().trim().min(1).optional(),
    INNGEST_SIGNING_KEY: z.string().trim().min(1).optional(),
    INNGEST_BASE_URL: z.string().trim().url().optional(),
    INNGEST_DEV: z.string().optional(),
    HARNESS_WORKER_HOST: z.string().trim().min(1).default("0.0.0.0"),
    HARNESS_WORKER_PORT: z.string().regex(/^\d+$/).default("8080"),
    HARNESS_WORKER_INSTANCE_ID: z.string().trim().min(1).optional(),
    HARNESS_APP_VERSION: z.string().trim().min(1).optional(),
  })
  .passthrough()
  .superRefine((environment, ctx) => {
    if (isInngestDev(environment.INNGEST_DEV)) return;
    for (const key of ["INNGEST_EVENT_KEY", "INNGEST_SIGNING_KEY"] as const) {
      if (environment[key]) continue;
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: `${key} is required unless INNGEST_DEV is enabled`,
      });
    }
    if (!environment.INNGEST_BASE_URL) {
      ctx.addIssue({
        code: "custom",
        path: ["INNGEST_BASE_URL"],
        message: "INNGEST_BASE_URL is required unless INNGEST_DEV is enabled",
      });
    }
  });

export type LinearAutomationWorkerEnvironment = Readonly<{
  linearApiKey: string;
  inngestEventKey?: string;
  inngestSigningKey?: string;
  inngestBaseUrl?: string;
  isDev: boolean;
  host: string;
  port: number;
  instanceId: string;
  appVersion?: string;
}>;

export type LinearAutomationFunctions = Readonly<{
  client: Inngest.Any;
  functions: readonly InngestFunction.Any[];
  readiness: LinearReadinessConfig;
}>;

export type LinearAutomationWorker = Readonly<{
  connection: WorkerConnection;
  healthUrl: string;
  closed: Promise<void>;
  close: () => Promise<void>;
}>;

export function parseLinearAutomationWorkerEnvironment(
  environment: NodeJS.ProcessEnv,
): LinearAutomationWorkerEnvironment {
  const parsed = WorkerEnvironmentSchema.parse(environment);
  const port = Number(parsed.HARNESS_WORKER_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("HARNESS_WORKER_PORT must be an integer from 1 to 65535.");
  }

  return Object.freeze({
    linearApiKey: parsed.LINEAR_API_KEY,
    ...(parsed.INNGEST_EVENT_KEY ? { inngestEventKey: parsed.INNGEST_EVENT_KEY } : {}),
    ...(parsed.INNGEST_SIGNING_KEY ? { inngestSigningKey: parsed.INNGEST_SIGNING_KEY } : {}),
    ...(parsed.INNGEST_BASE_URL ? { inngestBaseUrl: parsed.INNGEST_BASE_URL } : {}),
    isDev: isInngestDev(parsed.INNGEST_DEV),
    host: parsed.HARNESS_WORKER_HOST,
    port,
    instanceId: parsed.HARNESS_WORKER_INSTANCE_ID ?? hostname(),
    ...(parsed.HARNESS_APP_VERSION ? { appVersion: parsed.HARNESS_APP_VERSION } : {}),
  });
}

export function linearAutomationCodexEnvironment(
  environment: NodeJS.ProcessEnv,
): Readonly<Record<string, string>> {
  const selected: Record<string, string> = {};
  for (const key of LINEAR_AUTOMATION_CODEX_ENV_KEYS) {
    const value = environment[key];
    if (value !== undefined && (key !== "CODEX_API_KEY" || value.trim().length > 0)) {
      selected[key] = value;
    }
  }
  return Object.freeze(selected);
}

export async function verifyLinearAutomationCodexAuthentication(input: {
  environment: NodeJS.ProcessEnv;
  codexExecutable?: string;
  checkLogin?: (executable: string, environment: Readonly<Record<string, string>>) => Promise<void>;
}): Promise<"api-key" | "codex-login"> {
  const codexEnvironment = linearAutomationCodexEnvironment(input.environment);
  if (codexEnvironment.CODEX_API_KEY) return "api-key";

  try {
    await (input.checkLogin ?? checkCodexLogin)(
      input.codexExecutable ?? input.environment.CODEX_EXECUTABLE ?? "codex",
      codexEnvironment,
    );
    return "codex-login";
  } catch {
    throw new Error(
      "Codex authentication is unavailable. Set CODEX_API_KEY for unattended operation or initialize the persistent Codex login with `docker compose run --rm --no-deps worker codex login --device-auth`.",
    );
  }
}

async function checkCodexLogin(
  executable: string,
  environment: Readonly<Record<string, string>>,
): Promise<void> {
  await execFileAsync(executable, ["login", "status"], {
    env: { ...environment },
    timeout: 10_000,
  });
}

export function createLinearAutomationFunctions(input: {
  client: Inngest.Any;
  linear: LinearTriageService & LinearIssuePollerLinear;
  agent: Agent;
  settings: LinearAutomationSettings;
}): LinearAutomationFunctions {
  // The route map follows the consumers in this composition, not target-repo config.
  const readiness = Object.freeze({
    ...input.settings.readiness,
    enabledRoutes: LINEAR_AUTOMATION_ENABLED_ROUTES,
  });
  const poller = createLinearIssuePoller({
    client: input.client,
    linear: input.linear,
    config: {
      teamId: readiness.teamId,
      projectId: readiness.projectId,
      stateIds: linearAutomationObservedStateIds(readiness),
    },
  });
  const router = createLinearReadinessRouter({
    client: input.client,
    linear: input.linear,
    config: { readiness },
  });
  const triage = createLinearTriageFunction({
    client: input.client,
    linear: input.linear,
    agent: input.agent,
    config: {
      readiness,
      workspace: input.settings.workspace,
      execution: {
        model: input.settings.triage.model,
        modelReasoningEffort: input.settings.triage.modelReasoningEffort,
        maxRuntimeMs: input.settings.triage.maxRuntimeMs,
      },
    },
  });

  return Object.freeze({
    client: input.client,
    functions: Object.freeze([poller, router, triage]),
    readiness,
  });
}

export function linearAutomationObservedStateIds(
  readiness: LinearReadinessConfig,
): LinearIssuePollerConfig["stateIds"] {
  return Object.freeze({
    backlog: readiness.stateIds.backlog,
    ...(readiness.enabledRoutes.spec || readiness.enabledRoutes.implement
      ? { open: readiness.stateIds.open }
      : {}),
  });
}

export async function startLinearAutomationWorker(input: {
  app: LinearAutomationFunctions;
  host: string;
  port: number;
  instanceId: string;
  connectWorker?: (options: ConnectHandlerOptions) => Promise<WorkerConnection>;
}): Promise<LinearAutomationWorker> {
  let connection: WorkerConnection | null = null;
  const server = createHealthServer(() => connection?.state ?? ConnectionState.CONNECTING);
  await listen(server, input.host, input.port);

  try {
    connection = await (input.connectWorker ?? connect)({
      apps: [{ client: input.app.client, functions: [...input.app.functions] }],
      instanceId: input.instanceId,
      maxWorkerConcurrency: LINEAR_AUTOMATION_MAX_WORKER_CONCURRENCY,
    });
  } catch (error) {
    await closeServer(server);
    throw error;
  }

  const activeConnection = connection;
  let healthClosePromise: Promise<void> | undefined;
  const closeHealth = () => {
    healthClosePromise ??= closeServer(server);
    return healthClosePromise;
  };
  const closed = activeConnection.closed.finally(closeHealth);
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    connection: activeConnection,
    healthUrl: healthUrl(server, input.host),
    closed,
    close: () => {
      closePromise ??= activeConnection.close().finally(closeHealth);
      return closePromise;
    },
  });
}

export async function runLinearAutomationWorker(input: {
  workspace?: string;
  environment?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}): Promise<void> {
  const processEnvironment = input.environment ?? process.env;
  const environment = parseLinearAutomationWorkerEnvironment(processEnvironment);
  const settings = resolveLinearAutomationSettings({ workspace: input.workspace });
  if (settings.triage.agent === "codex") {
    await verifyLinearAutomationCodexAuthentication({
      environment: processEnvironment,
      codexExecutable: settings.triage.codexPathOverride,
    });
  }
  const client = new Inngest({
    id: LINEAR_AUTOMATION_APP_ID,
    eventKey: environment.inngestEventKey,
    signingKey: environment.inngestSigningKey,
    baseUrl: environment.inngestBaseUrl,
    isDev: environment.isDev,
    appVersion: environment.appVersion,
  });
  const linear: LinearService = createLinear({
    apiKey: environment.linearApiKey,
    limits: LINEAR_AUTOMATION_READ_LIMITS,
  });
  const agent = createAgentProvider({
    provider: settings.triage.agent,
    codexPathOverride: settings.triage.codexPathOverride,
    codexEnvironment: linearAutomationCodexEnvironment(processEnvironment),
  });
  const app = createLinearAutomationFunctions({
    client,
    linear,
    agent,
    settings,
  });
  const worker = await startLinearAutomationWorker({
    app,
    host: environment.host,
    port: environment.port,
    instanceId: environment.instanceId,
  });
  (input.log ?? console.log)(
    `Linear automation worker connected (${app.functions.length} functions; health ${worker.healthUrl}).`,
  );
  await worker.closed;
}

function createHealthServer(readConnectionState: () => ConnectionState): Server {
  return createServer((request, response) => {
    if (request.url === "/health") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (request.url === "/ready") {
      const state = readConnectionState();
      sendJson(response, state === ConnectionState.ACTIVE ? 200 : 503, {
        status: state === ConnectionState.ACTIVE ? "ready" : "not-ready",
        connectionState: state,
      });
      return;
    }
    sendJson(response, 404, { status: "not-found" });
  });
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function healthUrl(server: Server, host: string): string {
  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error("Linear automation health server is not listening.");
  const displayHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${displayHost}:${address.port}`;
}

function isInngestDev(value: string | undefined): boolean {
  if (!value) return false;
  return value !== "0" && value.toLowerCase() !== "false";
}
