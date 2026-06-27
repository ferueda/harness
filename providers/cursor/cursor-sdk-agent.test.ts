import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { createCursorSdkAgent, type CursorSdkAgentFactoryOptions } from "./cursor-sdk-agent.ts";

const REVIEW_SCHEMA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../schemas/review-output.schema.json",
);

type FakeSdkOptions = {
  result?: {
    status: "finished" | "error" | "cancelled";
    result?: string;
    requestId?: string;
    model?: string;
  };
  createError?: Error;
  sendError?: Error;
  disposeError?: Error;
  waitError?: Error;
  onWait?: () => void;
  waitForever?: boolean;
};

function createGitWorkspace() {
  const workspace = mkdtempSync(join(tmpdir(), "harness-cursor-sdk-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "harness@example.com"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "Harness Test"], { cwd: workspace });
  writeFileSync(join(workspace, "README.md"), "# Test\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: workspace });
  execFileSync("git", ["commit", "-m", "init"], { cwd: workspace, stdio: "ignore" });
  return workspace;
}

function createSchemaFile(workspace: string): string {
  const schemaPath = join(workspace, "schema.json");
  writeFileSync(
    schemaPath,
    JSON.stringify({
      type: "object",
      additionalProperties: false,
      required: ["verdict"],
      properties: {
        verdict: { enum: ["pass", "fail"] },
      },
    }),
    "utf8",
  );
  return schemaPath;
}

function createFakeSdk({
  result = { status: "finished", result: '{"verdict":"pass"}' },
  createError,
  sendError,
  disposeError,
  waitError,
  onWait,
  waitForever = false,
}: FakeSdkOptions = {}) {
  const calls: {
    options?: Parameters<NonNullable<CursorSdkAgentFactoryOptions["createSdkAgent"]>>[0];
    prompt?: string;
    cancelled: boolean;
    disposed: boolean;
    closed: boolean;
  } = {
    cancelled: false,
    disposed: false,
    closed: false,
  };

  const createSdkAgent: NonNullable<CursorSdkAgentFactoryOptions["createSdkAgent"]> = async (
    options,
  ) => {
    calls.options = options;
    if (createError) throw createError;
    return {
      agentId: "agent-123",
      model: options.model,
      async send(prompt: string) {
        calls.prompt = prompt;
        if (sendError) throw sendError;
        return {
          id: "run-123",
          requestId: "req-123",
          agentId: "agent-123",
          supports: () => true,
          unsupportedReason: () => undefined,
          async *stream() {},
          async conversation() {
            return [];
          },
          wait() {
            onWait?.();
            if (waitError) throw waitError;
            if (waitForever) return new Promise<never>(() => {});
            return Promise.resolve({
              id: "run-123",
              requestId: "req-result-123",
              durationMs: 25,
              ...result,
            });
          },
          async cancel() {
            calls.cancelled = true;
          },
          status: "finished",
          onDidChangeStatus: () => () => undefined,
        } as never;
      },
      close() {
        calls.closed = true;
      },
      async reload() {},
      async listArtifacts() {
        return [];
      },
      async downloadArtifact() {
        return Buffer.from("");
      },
      async [Symbol.asyncDispose]() {
        if (disposeError) throw disposeError;
        calls.disposed = true;
      },
    } as never;
  };

  return { calls, createSdkAgent };
}

test("createCursorSdkAgent sends wrapped prompt and parses structured output", async () => {
  const workspace = createGitWorkspace();
  const schemaPath = createSchemaFile(workspace);
  const { calls, createSdkAgent } = createFakeSdk();

  const result = await createCursorSdkAgent({
    apiKey: "cursor-key",
    createSdkAgent,
  }).run({
    workspace,
    prompt: "review this",
    schemaPath,
    model: "gpt-5.5",
    maxRuntimeMs: 1_000,
  });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.structuredOutput).toEqual({ verdict: "pass" });
  expect(result.sessionId).toBe("agent-123");
  expect(calls.options).toMatchObject({
    apiKey: "cursor-key",
    model: {
      id: "gpt-5.5",
      params: [
        { id: "context", value: "272k" },
        { id: "reasoning", value: "high" },
        { id: "fast", value: "false" },
      ],
    },
    mode: "agent",
    local: {
      cwd: workspace,
      settingSources: [],
      autoReview: true,
    },
  });
  expect(calls.prompt).toContain("Return ONLY valid JSON");
  expect(calls.prompt).toContain("review this");
  expect(calls.disposed).toBe(true);
  expect(calls.closed).toBe(false);
});

test("createCursorSdkAgent parses prose-prefixed review JSON with findings", async () => {
  const workspace = createGitWorkspace();
  const reviewPayload = {
    verdict: "pass",
    summary: "looks good",
    findings: [
      {
        title: "style nit",
        severity: "Low",
        location: "schema.ts",
        issue: "minor",
        recommendation: "optional cleanup",
        rationale: "readability",
        must_fix: false,
      },
    ],
  };
  const resultText = `Review complete.\n\n${JSON.stringify(reviewPayload)}`;
  const { createSdkAgent } = createFakeSdk({
    result: { status: "finished", result: resultText },
  });

  const result = await createCursorSdkAgent({ apiKey: "cursor-key", createSdkAgent }).run({
    workspace,
    prompt: "review changes",
    schemaPath: REVIEW_SCHEMA_PATH,
    maxRuntimeMs: 1_000,
  });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.structuredOutput).toEqual(reviewPayload);
});

test("createCursorSdkAgent defaults to non-fast Composer 2.5", async () => {
  const workspace = createGitWorkspace();
  const { calls, createSdkAgent } = createFakeSdk();

  const result = await createCursorSdkAgent({
    apiKey: "cursor-key",
    createSdkAgent,
  }).run({
    workspace,
    prompt: "review this",
    maxRuntimeMs: 1_000,
  });

  expect(result.ok).toBe(true);
  expect(calls.options?.model).toEqual({
    id: "composer-2.5",
    params: [{ id: "fast", value: "false" }],
  });
});

test("createCursorSdkAgent supports non-fast Opus 4.8 high thinking mode", async () => {
  const workspace = createGitWorkspace();
  const { calls, createSdkAgent } = createFakeSdk();

  const result = await createCursorSdkAgent({
    apiKey: "cursor-key",
    createSdkAgent,
  }).run({
    workspace,
    prompt: "review this",
    model: "claude-opus-4-8",
    maxRuntimeMs: 1_000,
  });

  expect(result.ok).toBe(true);
  expect(calls.options?.model).toEqual({
    id: "claude-opus-4-8",
    params: [
      { id: "thinking", value: "true" },
      { id: "effort", value: "high" },
      { id: "fast", value: "false" },
    ],
  });
});

test.each(["claude-opus-4-8-thinking-high", "gpt-5.5-high"])(
  "createCursorSdkAgent rejects unsupported SDK model mode %s",
  async (model) => {
    const workspace = createGitWorkspace();
    const { calls, createSdkAgent } = createFakeSdk();

    const result = await createCursorSdkAgent({
      apiKey: "cursor-key",
      createSdkAgent,
    }).run({
      workspace,
      prompt: "review this",
      model,
      maxRuntimeMs: 1_000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(
      `Unsupported Cursor SDK model: ${model}. Use one of: composer-2.5, claude-opus-4-8, gpt-5.5. For Cursor CLI model IDs, use --runtime cli.`,
    );
    expect(calls.options).toBeUndefined();
  },
);

test("createCursorSdkAgent requires an API key", async () => {
  const workspace = createGitWorkspace();
  const { calls, createSdkAgent } = createFakeSdk();
  const previousApiKey = process.env.CURSOR_API_KEY;
  delete process.env.CURSOR_API_KEY;
  try {
    const result = await createCursorSdkAgent({ createSdkAgent }).run({
      workspace,
      prompt: "review this",
      maxRuntimeMs: 1_000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("CURSOR_API_KEY required for Cursor SDK runtime");
    expect(calls.options).toBeUndefined();
  } finally {
    if (previousApiKey === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = previousApiKey;
  }
});

test("createCursorSdkAgent returns invalid schema failures", async () => {
  const workspace = createGitWorkspace();
  const malformedSchemaPath = join(workspace, "schema.json");
  writeFileSync(malformedSchemaPath, "{", "utf8");

  const result = await createCursorSdkAgent({ apiKey: "cursor-key" }).run({
    workspace,
    prompt: "review this",
    schemaPath: malformedSchemaPath,
    maxRuntimeMs: 1_000,
  });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toMatch(/Invalid Cursor SDK output schema/);
});

test("createCursorSdkAgent detects workspace mutations outside .harness", async () => {
  const workspace = createGitWorkspace();
  const { createSdkAgent } = createFakeSdk({
    onWait() {
      writeFileSync(join(workspace, "changed.txt"), "changed\n", "utf8");
    },
  });

  const result = await createCursorSdkAgent({ apiKey: "cursor-key", createSdkAgent }).run({
    workspace,
    prompt: "review this",
    maxRuntimeMs: 1_000,
  });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toBe("Cursor SDK runtime modified the workspace during a review run");
});

test("createCursorSdkAgent allows .harness artifacts", async () => {
  const workspace = createGitWorkspace();
  const { createSdkAgent } = createFakeSdk({
    onWait() {
      mkdirSync(join(workspace, ".harness"), { recursive: true });
      writeFileSync(join(workspace, ".harness", "trace.txt"), "trace\n", "utf8");
    },
  });

  const result = await createCursorSdkAgent({ apiKey: "cursor-key", createSdkAgent }).run({
    workspace,
    prompt: "review this",
    maxRuntimeMs: 1_000,
  });

  expect(result.ok).toBe(true);
});

test("createCursorSdkAgent reports terminal SDK statuses", async () => {
  const workspace = createGitWorkspace();
  const errorSdk = createFakeSdk({
    result: {
      status: "error",
      result: "failed because auth expired",
      requestId: "req-error",
      model: "composer-2.5",
    },
  });
  const errorResult = await createCursorSdkAgent({
    apiKey: "cursor-key",
    createSdkAgent: errorSdk.createSdkAgent,
  }).run({ workspace, prompt: "review this", maxRuntimeMs: 1_000 });
  expect(errorResult.ok).toBe(false);
  if (errorResult.ok) return;
  expect(errorResult.error).toMatch(/error status/);
  expect(errorResult.error).toContain("failed because auth expired");
  expect(errorResult.error).toContain("req-error");
  expect(errorResult.error).toContain("composer-2.5");

  const cancelledSdk = createFakeSdk({ result: { status: "cancelled", result: "cancelled" } });
  const cancelledResult = await createCursorSdkAgent({
    apiKey: "cursor-key",
    createSdkAgent: cancelledSdk.createSdkAgent,
  }).run({ workspace, prompt: "review this", maxRuntimeMs: 1_000 });
  expect(cancelledResult.ok).toBe(false);
  if (cancelledResult.ok) return;
  expect(cancelledResult.exitCode).toBe(130);
});

test("createCursorSdkAgent cancels timed-out runs", async () => {
  const workspace = createGitWorkspace();
  const { calls, createSdkAgent } = createFakeSdk({ waitForever: true });

  const result = await createCursorSdkAgent({ apiKey: "cursor-key", createSdkAgent }).run({
    workspace,
    prompt: "review this",
    maxRuntimeMs: 1,
  });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.exitCode).toBe(124);
  expect(result.error).toMatch(/timed out/);
  expect(calls.cancelled).toBe(true);
  expect(calls.disposed).toBe(true);
  expect(result.raw).toMatchObject({
    workspaceStatus: {
      before: "",
      after: "",
    },
  });
});

test("createCursorSdkAgent bounds Agent.create with maxRuntimeMs", async () => {
  const workspace = createGitWorkspace();
  const createSdkAgent: NonNullable<CursorSdkAgentFactoryOptions["createSdkAgent"]> = async () =>
    new Promise<never>(() => {});

  const result = await createCursorSdkAgent({ apiKey: "cursor-key", createSdkAgent }).run({
    workspace,
    prompt: "review this",
    maxRuntimeMs: 1,
  });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.exitCode).toBe(124);
  expect(result.error).toMatch(/timed out/);
});

test("createCursorSdkAgent bounds send with maxRuntimeMs and disposes the agent", async () => {
  const workspace = createGitWorkspace();
  const calls = { disposed: false };
  const createSdkAgent: NonNullable<CursorSdkAgentFactoryOptions["createSdkAgent"]> = async (
    options,
  ) =>
    ({
      agentId: "agent-123",
      model: options.model,
      async send() {
        return new Promise<never>(() => {});
      },
      close() {},
      async reload() {},
      async listArtifacts() {
        return [];
      },
      async downloadArtifact() {
        return Buffer.from("");
      },
      async [Symbol.asyncDispose]() {
        calls.disposed = true;
      },
    }) as never;

  const result = await createCursorSdkAgent({ apiKey: "cursor-key", createSdkAgent }).run({
    workspace,
    prompt: "review this",
    maxRuntimeMs: 1,
  });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.exitCode).toBe(124);
  expect(calls.disposed).toBe(true);
});

test("createCursorSdkAgent detects workspace mutations on timeout", async () => {
  const workspace = createGitWorkspace();
  const { createSdkAgent } = createFakeSdk({
    waitForever: true,
    onWait() {
      writeFileSync(join(workspace, "changed-on-timeout.txt"), "changed\n", "utf8");
    },
  });

  const result = await createCursorSdkAgent({ apiKey: "cursor-key", createSdkAgent }).run({
    workspace,
    prompt: "review this",
    maxRuntimeMs: 1,
  });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.exitCode).toBe(124);
  expect(result.error).toBe("Cursor SDK runtime modified the workspace during a review run");
  expect(result.raw).toMatchObject({
    underlyingFailure: {
      exitCode: 124,
      error: expect.stringContaining("timed out"),
    },
    workspaceStatus: {
      before: "",
      after: expect.stringContaining("changed-on-timeout.txt"),
    },
  });
});

test("createCursorSdkAgent detects workspace mutations on thrown wait errors", async () => {
  const workspace = createGitWorkspace();
  const { createSdkAgent } = createFakeSdk({
    waitError: new Error("wait failed"),
    onWait() {
      writeFileSync(join(workspace, "changed-on-error.txt"), "changed\n", "utf8");
    },
  });

  const result = await createCursorSdkAgent({ apiKey: "cursor-key", createSdkAgent }).run({
    workspace,
    prompt: "review this",
    maxRuntimeMs: 1_000,
  });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toBe("Cursor SDK runtime modified the workspace during a review run");
  expect(result.raw).toMatchObject({
    workspaceStatus: {
      before: "",
      after: expect.stringContaining("changed-on-error.txt"),
    },
  });
});

test("createCursorSdkAgent creates and disposes a fresh SDK agent per run", async () => {
  const workspace = createGitWorkspace();
  const calls = {
    createCount: 0,
    disposedAgentIds: [] as string[],
  };
  const createSdkAgent: NonNullable<CursorSdkAgentFactoryOptions["createSdkAgent"]> = async (
    options,
  ) => {
    calls.createCount += 1;
    const agentId = `agent-${calls.createCount}`;
    const runId = `run-${calls.createCount}`;
    return {
      agentId,
      model: options.model,
      async send() {
        return {
          id: runId,
          agentId,
          supports: () => true,
          unsupportedReason: () => undefined,
          async *stream() {},
          async conversation() {
            return [];
          },
          async wait() {
            return { id: runId, status: "finished", result: '{"verdict":"pass"}' };
          },
          async cancel() {},
          status: "finished",
          onDidChangeStatus: () => () => undefined,
        } as never;
      },
      close() {},
      async reload() {},
      async listArtifacts() {
        return [];
      },
      async downloadArtifact() {
        return Buffer.from("");
      },
      async [Symbol.asyncDispose]() {
        calls.disposedAgentIds.push(agentId);
      },
    } as never;
  };
  const agent = createCursorSdkAgent({ apiKey: "cursor-key", createSdkAgent });

  const first = await agent.run({ workspace, prompt: "first", maxRuntimeMs: 1_000 });
  const second = await agent.run({ workspace, prompt: "second", maxRuntimeMs: 1_000 });

  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);
  expect(calls.createCount).toBe(2);
  expect(calls.disposedAgentIds).toEqual(["agent-1", "agent-2"]);
  expect(first.raw).toMatchObject({ agentId: "agent-1", runId: "run-1" });
  expect(second.raw).toMatchObject({ agentId: "agent-2", runId: "run-2" });
});

test("createCursorSdkAgent preserves SDK error details", async () => {
  const workspace = createGitWorkspace();
  const sdkError = Object.assign(new Error("auth failed"), {
    name: "AuthenticationError",
    code: "unauthorized",
    status: 401,
    requestId: "req-401",
    isRetryable: false,
    operation: "create",
    endpoint: "/agents",
  });
  const { createSdkAgent } = createFakeSdk({ createError: sdkError });

  const result = await createCursorSdkAgent({ apiKey: "cursor-key", createSdkAgent }).run({
    workspace,
    prompt: "review this",
    maxRuntimeMs: 1_000,
  });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toContain("auth failed");
  expect(result.raw).toMatchObject({
    error: {
      name: "AuthenticationError",
      code: "unauthorized",
      status: 401,
      requestId: "req-401",
      operation: "create",
      endpoint: "/agents",
    },
  });
});

test("createCursorSdkAgent preserves send error details and workspace status", async () => {
  const workspace = createGitWorkspace();
  const sendError = Object.assign(new Error("send failed"), {
    name: "NetworkError",
    code: "unavailable",
    status: 503,
    requestId: "req-503",
    isRetryable: true,
    helpUrl: "https://cursor.com/help",
  });
  const { calls, createSdkAgent } = createFakeSdk({ sendError });

  const result = await createCursorSdkAgent({ apiKey: "cursor-key", createSdkAgent }).run({
    workspace,
    prompt: "review this",
    maxRuntimeMs: 1_000,
  });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.exitCode).toBe(1);
  expect(result.error).toContain("send failed");
  expect(calls.disposed).toBe(true);
  expect(result.raw).toMatchObject({
    agentId: "agent-123",
    error: {
      name: "NetworkError",
      code: "unavailable",
      status: 503,
      requestId: "req-503",
      isRetryable: true,
      helpUrl: "https://cursor.com/help",
    },
    workspaceStatus: {
      before: "",
      after: "",
    },
  });
});

test("createCursorSdkAgent does not let dispose failures mask successful results", async () => {
  const workspace = createGitWorkspace();
  const { createSdkAgent } = createFakeSdk({ disposeError: new Error("dispose failed") });

  const result = await createCursorSdkAgent({ apiKey: "cursor-key", createSdkAgent }).run({
    workspace,
    prompt: "review this",
    maxRuntimeMs: 1_000,
  });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.structuredOutput).toEqual({ verdict: "pass" });
});

test("createCursorSdkAgent validates final JSON against schema", async () => {
  const workspace = createGitWorkspace();
  const schemaPath = createSchemaFile(workspace);
  const { createSdkAgent } = createFakeSdk({
    result: { status: "finished", result: '{"verdict":"maybe"}' },
  });

  const result = await createCursorSdkAgent({ apiKey: "cursor-key", createSdkAgent }).run({
    workspace,
    prompt: "review this",
    schemaPath,
    maxRuntimeMs: 1_000,
  });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toMatch(/JSON did not match schema/);
  expect(readFileSync(schemaPath, "utf8")).toContain("verdict");
});
