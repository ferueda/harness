import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createCodexAgent } from "./codex-agent.ts";
import type { CodexOptions, ThreadEvent, ThreadOptions, TurnOptions } from "@openai/codex-sdk";

type FakeTurnInput = {
  finalResponse?: string;
  runError?: Error;
  streamEvents?: ThreadEvent[];
  streamError?: Error;
};

function createSchemaFile(workspace: string): string {
  const schemaPath = join(workspace, "schema.json");
  writeFileSync(
    schemaPath,
    JSON.stringify({
      type: "object",
      properties: { verdict: { type: "string" } },
      required: ["verdict"],
    }),
    "utf8",
  );
  return schemaPath;
}

function createFakeCodex({
  finalResponse = '{"verdict":"pass"}',
  runError,
  streamEvents,
  streamError,
}: FakeTurnInput = {}) {
  const calls: {
    codexOptions?: CodexOptions;
    threadOptions?: ThreadOptions;
    prompt?: string;
    streamedPrompt?: string;
    turnOptions?: TurnOptions;
    runStreamed: boolean;
  } = {
    runStreamed: false,
  };

  const codexFactory = (codexOptions: CodexOptions) => {
    calls.codexOptions = codexOptions;
    return {
      startThread(threadOptions: ThreadOptions) {
        calls.threadOptions = threadOptions;
        return {
          id: "thread-123",
          async run(prompt: string, turnOptions: TurnOptions) {
            calls.prompt = prompt;
            calls.turnOptions = turnOptions;
            if (runError) throw runError;
            return {
              finalResponse,
              items: [],
              usage: {
                input_tokens: 1,
                cached_input_tokens: 0,
                output_tokens: 2,
                reasoning_output_tokens: 0,
              },
            };
          },
          async runStreamed(prompt: string, turnOptions: TurnOptions) {
            calls.runStreamed = true;
            calls.streamedPrompt = prompt;
            calls.turnOptions = turnOptions;
            if (runError) throw runError;
            return {
              events: (async function* () {
                for (const event of streamEvents ?? codexSuccessStream(finalResponse)) {
                  yield event;
                }
                if (streamError) throw streamError;
              })(),
            };
          },
        };
      },
    };
  };

  return { calls, codexFactory };
}

function codexSuccessStream(finalResponse: string): ThreadEvent[] {
  return [
    {
      type: "item.completed",
      item: { id: "message-1", type: "agent_message", text: finalResponse },
    },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 1,
        cached_input_tokens: 0,
        output_tokens: 2,
        reasoning_output_tokens: 0,
      },
    },
  ];
}

function readJsonLines(path: string): unknown[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("createCodexAgent runs Codex with schema and review defaults", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-codex-agent-"));
  const schemaPath = createSchemaFile(workspace);
  const { calls, codexFactory } = createFakeCodex();

  const result = await createCodexAgent({
    codexPathOverride: "/opt/codex",
    codexFactory,
  }).run({
    workspace,
    prompt: "review this",
    schemaPath,
    model: "gpt-test",
    sandboxMode: "read-only",
    approvalPolicy: "never",
    modelReasoningEffort: "high",
    maxRuntimeMs: 1_000,
  });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.structuredOutput).toEqual({ verdict: "pass" });
  expect(result.sessionId).toBe("thread-123");
  expect(result.usage).toEqual({
    input_tokens: 1,
    cached_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
  });
  expect(calls.codexOptions).toEqual({ codexPathOverride: "/opt/codex" });
  expect(calls.threadOptions).toMatchObject({
    workingDirectory: workspace,
    model: "gpt-test",
    sandboxMode: "read-only",
    approvalPolicy: "never",
    modelReasoningEffort: "high",
  });
  expect(calls.prompt).toBe("review this");
  expect(calls.runStreamed).toBe(false);
  expect(calls.turnOptions?.outputSchema).toEqual(JSON.parse(readFileSync(schemaPath, "utf8")));
  expect(calls.turnOptions?.signal).toBeInstanceOf(AbortSignal);
});

test("createCodexAgent streams Codex thread events to logPath", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-codex-agent-"));
  const logPath = join(workspace, ".harness", "codex.stream.jsonl");
  const { calls, codexFactory } = createFakeCodex();

  const result = await createCodexAgent({ codexFactory }).run({
    workspace,
    prompt: "review this",
    logPath,
    maxRuntimeMs: 1_000,
  });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.structuredOutput).toEqual({ verdict: "pass" });
  expect(result.sessionId).toBe("thread-123");
  expect(result.usage).toEqual({
    input_tokens: 1,
    cached_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
  });
  expect(calls.prompt).toBeUndefined();
  expect(calls.streamedPrompt).toBe("review this");
  expect(readJsonLines(logPath)[0]).toMatchObject({
    provider: "codex",
    format: "codex-thread-event",
    sequence: 1,
    event: {
      type: "item.completed",
      item: { type: "agent_message", text: '{"verdict":"pass"}' },
    },
  });
  expect(result.raw).toMatchObject({
    finalResponse: '{"verdict":"pass"}',
    streamLog: {
      path: logPath,
      status: "written",
      provider: "codex",
      format: "codex-thread-event",
    },
  });
});

test("createCodexAgent uses completed agent_message as streamed final response", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-codex-agent-"));
  const logPath = join(workspace, ".harness", "codex.stream.jsonl");
  const { codexFactory } = createFakeCodex({
    finalResponse: '{"verdict":"from-stream"}',
  });

  const result = await createCodexAgent({ codexFactory }).run({
    workspace,
    prompt: "review this",
    logPath,
    maxRuntimeMs: 1_000,
  });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.structuredOutput).toEqual({ verdict: "from-stream" });
});

test("createCodexAgent returns streamed turn failures with stream log metadata", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-codex-agent-"));
  const logPath = join(workspace, ".harness", "codex.stream.jsonl");
  const { codexFactory } = createFakeCodex({
    streamEvents: [{ type: "turn.failed", error: { message: "model failed" } }],
  });

  const result = await createCodexAgent({ codexFactory }).run({
    workspace,
    prompt: "review this",
    logPath,
    maxRuntimeMs: 1_000,
  });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toContain("model failed");
  expect(readJsonLines(logPath)).toHaveLength(2);
  expect(result.raw).toMatchObject({
    streamLog: {
      path: logPath,
      status: "error",
      error: "Codex turn failed: model failed",
    },
  });
});

test("createCodexAgent supports non-review sandbox and approval modes", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-codex-agent-"));
  const { calls, codexFactory } = createFakeCodex();

  const result = await createCodexAgent({ codexFactory }).run({
    workspace,
    prompt: "implement this",
    model: "gpt-test",
    sandboxMode: "workspace-write",
    approvalPolicy: "on-request",
    modelReasoningEffort: "medium",
    maxRuntimeMs: 1_000,
  });

  expect(result.ok).toBe(true);
  expect(calls.threadOptions).toMatchObject({
    sandboxMode: "workspace-write",
    approvalPolicy: "on-request",
    modelReasoningEffort: "medium",
  });
});

test("createCodexAgent returns invalid JSON failures", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-codex-agent-"));
  const { codexFactory } = createFakeCodex({ finalResponse: "not json" });

  const result = await createCodexAgent({ codexFactory }).run({
    workspace,
    prompt: "review this",
    maxRuntimeMs: 1_000,
  });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toMatch(/not valid JSON/);
  expect(result.raw).toMatchObject({ finalResponse: "not json" });
});

test("createCodexAgent recovers JSON when final response prepends prose", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-codex-agent-"));
  const schemaPath = createSchemaFile(workspace);
  const payload = { verdict: "pass" };
  const { codexFactory } = createFakeCodex({
    finalResponse: `Analysis complete.\n\n${JSON.stringify(payload)}`,
  });

  const result = await createCodexAgent({ codexFactory }).run({
    workspace,
    prompt: "review this",
    schemaPath,
    maxRuntimeMs: 1_000,
  });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.structuredOutput).toEqual(payload);
});

test("createCodexAgent recovers JSON from fenced final response", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-codex-agent-"));
  const schemaPath = createSchemaFile(workspace);
  const payload = { verdict: "pass" };
  const { codexFactory } = createFakeCodex({
    finalResponse: `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``,
  });

  const result = await createCodexAgent({ codexFactory }).run({
    workspace,
    prompt: "review this",
    schemaPath,
    maxRuntimeMs: 1_000,
  });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.structuredOutput).toEqual(payload);
});

test("createCodexAgent recovers top-level object when nested fragments parse", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-codex-agent-"));
  const schemaPath = join(workspace, "schema.json");
  writeFileSync(
    schemaPath,
    JSON.stringify({
      type: "object",
      required: ["verdict", "findings"],
      properties: {
        verdict: { type: "string" },
        findings: {
          type: "array",
          items: {
            type: "object",
            required: ["title"],
            properties: { title: { type: "string" } },
          },
        },
      },
    }),
    "utf8",
  );
  const payload = {
    verdict: "needs_changes",
    findings: [{ title: "missing test" }],
  };
  const { codexFactory } = createFakeCodex({
    finalResponse: `Here is my review.\n\n${JSON.stringify(payload)}`,
  });

  const result = await createCodexAgent({ codexFactory }).run({
    workspace,
    prompt: "review this",
    schemaPath,
    maxRuntimeMs: 1_000,
  });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.structuredOutput).toEqual(payload);
});

test("createCodexAgent returns schema validation failures for parseable invalid output", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-codex-agent-"));
  const schemaPath = join(workspace, "schema.json");
  writeFileSync(
    schemaPath,
    JSON.stringify({
      type: "object",
      required: ["verdict"],
      properties: { verdict: { enum: ["pass", "fail"] } },
    }),
    "utf8",
  );
  const { codexFactory } = createFakeCodex({ finalResponse: '{"verdict":"maybe"}' });

  const result = await createCodexAgent({ codexFactory }).run({
    workspace,
    prompt: "review this",
    schemaPath,
    maxRuntimeMs: 1_000,
  });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toMatch(/did not match schema|expected one of|missing required/i);
});

test("createCodexAgent returns invalid schema failures", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-codex-agent-"));
  const malformedSchemaPath = join(workspace, "schema.json");
  writeFileSync(malformedSchemaPath, "{", "utf8");

  const malformedResult = await createCodexAgent().run({
    workspace,
    prompt: "review this",
    schemaPath: malformedSchemaPath,
    maxRuntimeMs: 1_000,
  });

  expect(malformedResult.ok).toBe(false);
  if (malformedResult.ok) return;
  expect(malformedResult.exitCode).toBe(1);
  expect(malformedResult.error).toMatch(/Invalid Codex output schema/);

  const missingResult = await createCodexAgent().run({
    workspace,
    prompt: "review this",
    schemaPath: join(workspace, "missing-schema.json"),
    maxRuntimeMs: 1_000,
  });

  expect(missingResult.ok).toBe(false);
  if (missingResult.ok) return;
  expect(missingResult.exitCode).toBe(1);
  expect(missingResult.error).toMatch(/Invalid Codex output schema/);
});

test("createCodexAgent returns SDK run failures", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-codex-agent-"));
  const { codexFactory } = createFakeCodex({ runError: new Error("auth failed") });

  const result = await createCodexAgent({ codexFactory }).run({
    workspace,
    prompt: "review this",
    maxRuntimeMs: 1_000,
  });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.exitCode).toBe(1);
  expect(result.error).toContain("auth failed");
  expect(result.raw).toMatchObject({
    name: "Error",
    message: "auth failed",
  });
});

test("createCodexAgent returns aborted without starting a pre-aborted run", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-codex-agent-"));
  const controller = new AbortController();
  controller.abort();
  let factoryCalled = false;
  const codexFactory = () => {
    factoryCalled = true;
    return {
      startThread() {
        throw new Error("should not start thread");
      },
    };
  };

  const result = await createCodexAgent({ codexFactory }).run({
    workspace,
    prompt: "review this",
    maxRuntimeMs: 1_000,
    signal: controller.signal,
  });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result).toMatchObject({
    error: "Agent was aborted",
    exitCode: 130,
    aborted: true,
  });
  expect(factoryCalled).toBe(false);
});

test("createCodexAgent returns aborted when external signal aborts a pending run", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-codex-agent-"));
  const controller = new AbortController();
  const calls: { signal?: AbortSignal } = {};
  const codexFactory = () => ({
    startThread() {
      return {
        id: "thread-abort",
        run(_prompt: string, turnOptions: TurnOptions) {
          calls.signal = turnOptions.signal;
          queueMicrotask(() => controller.abort());
          return new Promise<never>(() => {});
        },
      };
    },
  });

  const result = await createCodexAgent({ codexFactory }).run({
    workspace,
    prompt: "review this",
    maxRuntimeMs: 1_000,
    signal: controller.signal,
  });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result).toMatchObject({
    error: "Agent was aborted",
    exitCode: 130,
    aborted: true,
  });
  expect(calls.signal?.aborted).toBe(true);
});

test("createCodexAgent uses CODEX_EXECUTABLE when no explicit override is set", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-codex-agent-"));
  const { calls, codexFactory } = createFakeCodex();
  const previousExecutable = process.env.CODEX_EXECUTABLE;
  process.env.CODEX_EXECUTABLE = "/env/codex";
  try {
    const result = await createCodexAgent({ codexFactory }).run({
      workspace,
      prompt: "review this",
      maxRuntimeMs: 1_000,
    });

    expect(result.ok).toBe(true);
    expect(calls.codexOptions).toEqual({ codexPathOverride: "/env/codex" });
  } finally {
    if (previousExecutable === undefined) {
      delete process.env.CODEX_EXECUTABLE;
    } else {
      process.env.CODEX_EXECUTABLE = previousExecutable;
    }
  }
});

test("createCodexAgent returns timeout failures through AbortSignal", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-codex-agent-"));
  const calls: { signal?: AbortSignal } = {};
  const codexFactory = () => ({
    startThread() {
      return {
        id: "thread-timeout",
        run(_prompt: string, turnOptions: TurnOptions) {
          calls.signal = turnOptions.signal;
          return new Promise<never>(() => {});
        },
      };
    },
  });

  const result = await createCodexAgent({ codexFactory }).run({
    workspace,
    prompt: "review this",
    maxRuntimeMs: 1,
  });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.exitCode).toBe(124);
  expect(result.aborted).toBeUndefined();
  expect(result.error).toMatch(/timed out/);
  expect(calls.signal?.aborted).toBe(true);
});

test("createCodexAgent keeps partial stream logs on timeout", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-codex-agent-"));
  const logPath = join(workspace, ".harness", "codex.stream.jsonl");
  const codexFactory = () => ({
    startThread() {
      return {
        id: "thread-timeout",
        async run() {
          throw new Error("run should not be used when logPath is set");
        },
        async runStreamed(_prompt: string, turnOptions: TurnOptions) {
          return {
            events: (async function* () {
              yield {
                type: "item.completed",
                item: { id: "message-1", type: "agent_message", text: '{"partial":true}' },
              } satisfies ThreadEvent;
              await new Promise<void>((resolve) => {
                turnOptions.signal?.addEventListener("abort", () => resolve(), { once: true });
              });
            })(),
          };
        },
      };
    },
  });

  const result = await createCodexAgent({ codexFactory }).run({
    workspace,
    prompt: "review this",
    logPath,
    maxRuntimeMs: 1,
  });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.exitCode).toBe(124);
  expect(readJsonLines(logPath)[0]).toMatchObject({
    event: {
      type: "item.completed",
      item: { type: "agent_message", text: '{"partial":true}' },
    },
  });
  expect(result.raw).toMatchObject({
    streamLog: {
      status: "written",
      path: logPath,
    },
  });
});

test("createCodexAgent keeps partial stream logs on external abort", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-codex-agent-"));
  const logPath = join(workspace, ".harness", "codex.stream.jsonl");
  const controller = new AbortController();
  const codexFactory = () => ({
    startThread() {
      return {
        id: "thread-abort",
        async run() {
          throw new Error("run should not be used when logPath is set");
        },
        async runStreamed(_prompt: string, turnOptions: TurnOptions) {
          return {
            events: (async function* () {
              yield {
                type: "item.completed",
                item: { id: "message-1", type: "agent_message", text: '{"partial":true}' },
              } satisfies ThreadEvent;
              queueMicrotask(() => controller.abort());
              await new Promise<void>((resolve) => {
                turnOptions.signal?.addEventListener("abort", () => resolve(), { once: true });
              });
            })(),
          };
        },
      };
    },
  });

  const result = await createCodexAgent({ codexFactory }).run({
    workspace,
    prompt: "review this",
    logPath,
    maxRuntimeMs: 1_000,
    signal: controller.signal,
  });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.exitCode).toBe(130);
  expect(result.aborted).toBe(true);
  expect(readJsonLines(logPath)[0]).toMatchObject({
    event: {
      type: "item.completed",
      item: { type: "agent_message", text: '{"partial":true}' },
    },
  });
  expect(result.raw).toMatchObject({
    streamLog: {
      status: "written",
      path: logPath,
    },
  });
});

test("createCodexAgent does not return success when a turn resolves after external abort", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-codex-agent-"));
  const controller = new AbortController();
  const codexFactory = () => ({
    startThread() {
      return {
        id: "thread-abort",
        run() {
          controller.abort();
          return Promise.resolve({
            finalResponse: '{"ok":true}',
            items: [],
            usage: {
              input_tokens: 1,
              cached_input_tokens: 0,
              output_tokens: 2,
              reasoning_output_tokens: 0,
            },
          });
        },
      };
    },
  });

  const result = await createCodexAgent({ codexFactory }).run({
    workspace,
    prompt: "review this",
    maxRuntimeMs: 1_000,
    signal: controller.signal,
  });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.exitCode).toBe(130);
  expect(result.aborted).toBe(true);
  expect(result.error).toBe("Agent was aborted");
});

test("createCodexAgent observes delayed run rejection after timeout", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-codex-agent-"));
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (error: unknown) => {
    unhandledRejections.push(error);
  };
  const codexFactory = () => ({
    startThread() {
      return {
        id: "thread-timeout",
        run(_prompt: string, turnOptions: TurnOptions) {
          return new Promise<never>((_, reject) => {
            turnOptions.signal?.addEventListener("abort", () => {
              setTimeout(() => reject(new Error("aborted after timeout")), 0);
            });
          });
        },
      };
    },
  });

  process.on("unhandledRejection", onUnhandledRejection);
  try {
    const result = await createCodexAgent({ codexFactory }).run({
      workspace,
      prompt: "review this",
      maxRuntimeMs: 1,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.exitCode).toBe(124);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(unhandledRejections).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }
});

test("createCodexAgent observes delayed run rejection after external abort", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-codex-agent-"));
  const controller = new AbortController();
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (error: unknown) => {
    unhandledRejections.push(error);
  };
  const codexFactory = () => ({
    startThread() {
      return {
        id: "thread-abort",
        run(_prompt: string, turnOptions: TurnOptions) {
          queueMicrotask(() => controller.abort());
          return new Promise<never>((_, reject) => {
            turnOptions.signal?.addEventListener("abort", () => {
              setTimeout(() => reject(new Error("aborted after external signal")), 0);
            });
          });
        },
      };
    },
  });

  process.on("unhandledRejection", onUnhandledRejection);
  try {
    const result = await createCodexAgent({ codexFactory }).run({
      workspace,
      prompt: "review this",
      maxRuntimeMs: 1_000,
      signal: controller.signal,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.exitCode).toBe(130);
    expect(result.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(unhandledRejections).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }
});
