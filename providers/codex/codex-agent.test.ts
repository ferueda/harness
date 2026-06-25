import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createCodexAgent } from "./codex-agent.ts";
import type { CodexOptions, ThreadOptions, TurnOptions } from "@openai/codex-sdk";

type FakeTurnInput = {
  finalResponse?: string;
  runError?: Error;
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

function createFakeCodex({ finalResponse = '{"verdict":"pass"}', runError }: FakeTurnInput = {}) {
  const calls: {
    codexOptions?: CodexOptions;
    threadOptions?: ThreadOptions;
    prompt?: string;
    turnOptions?: TurnOptions;
  } = {};

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
        };
      },
    };
  };

  return { calls, codexFactory };
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
  expect(calls.turnOptions?.outputSchema).toEqual(JSON.parse(readFileSync(schemaPath, "utf8")));
  expect(calls.turnOptions?.signal).toBeInstanceOf(AbortSignal);
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
  expect(result.error).toMatch(/timed out/);
  expect(calls.signal?.aborted).toBe(true);
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
