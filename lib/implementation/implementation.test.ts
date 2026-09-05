import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentRunInput, AgentRunResult } from "../agent/contract.ts";
import type { WorkItemContext } from "../work-item/schema.ts";
import {
  implementWorkItem,
  IMPLEMENTATION_RESULT_SCHEMA_PATH,
  type ImplementationExecution,
} from "./implementation.ts";
import { IMPLEMENTATION_POLICY_VERSION } from "./prompt.ts";
import type { ImplementationSource } from "./source.ts";

const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("implementWorkItem", () => {
  it("runs a provider-neutral implementation and returns its normalized author session", async () => {
    const workspace = temporaryWorkspace();
    const inputs: AgentRunInput[] = [];
    const agent = fakeAgent(inputs, {
      ok: true,
      structuredOutput: implementedDecision(),
      raw: {},
      session: { provider: "codex", id: " thread-323 ", raw: { kind: "codex-thread" } },
    });

    const result = await implementWorkItem({
      source: linearSource(),
      workspace,
      agent,
      execution: execution(),
    });

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      workspace,
      schemaPath: IMPLEMENTATION_RESULT_SCHEMA_PATH,
      model: "gpt-5.6-sol",
      modelReasoningEffort: "high",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      workspaceGuard: "record",
      maxRuntimeMs: 120_000,
      logPath: "/tmp/implementation.jsonl",
    });
    expect(result).toMatchObject({
      ok: true,
      decision: { outcome: "implemented" },
      provenance: {
        provider: "codex",
        model: "gpt-5.6-sol",
        modelReasoningEffort: "high",
        policyVersion: IMPLEMENTATION_POLICY_VERSION,
        resultSchemaVersion: "1",
        promptSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        schemaSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        source: {
          kind: "linear",
          issueReference: "FER-323",
          path: null,
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
        session: { provider: "codex", id: "thread-323" },
      },
    });
  });

  it("discards a provider session when the implementation needs input", async () => {
    const workspace = temporaryWorkspace();
    const partialPath = join(workspace, "partial.ts");
    const agent: Agent = {
      name: "codex",
      async run() {
        writeFileSync(partialPath, "export const partial = true;\n");
        return {
          ok: true,
          structuredOutput: needsInputDecision(),
          raw: {},
          session: { provider: "cursor", id: "must-not-survive" },
        };
      },
    };

    const result = await implementWorkItem({
      source: linearSource(),
      workspace,
      agent,
      execution: execution(),
    });

    expect(result).toMatchObject({
      ok: true,
      decision: { outcome: "needs-input" },
      provenance: { session: null },
    });
    expect(existsSync(partialPath)).toBe(true);
  });

  it.each([
    [
      {
        ok: false,
        error: "provider unavailable",
        exitCode: 1,
      } satisfies AgentRunResult,
      "provider",
    ],
    [
      {
        ok: false,
        error: "timed out",
        exitCode: 124,
      } satisfies AgentRunResult,
      "timeout",
    ],
    [
      {
        ok: false,
        error: "cancelled",
        exitCode: 1,
        aborted: true,
      } satisfies AgentRunResult,
      "cancelled",
    ],
    [
      {
        ok: false,
        error: "workspace guard",
        exitCode: 1,
        failureKind: "workspace-guard",
      } satisfies AgentRunResult,
      "workspace-guard",
    ],
  ] as const)("returns typed %s provider results", async (agentResult, failureKind) => {
    const result = await implementWorkItem({
      source: linearSource(),
      workspace: temporaryWorkspace(),
      agent: fakeAgent([], agentResult),
      execution: execution(),
    });

    expect(result).toMatchObject({ ok: false, failureKind });
  });

  it("returns a typed provider failure when the agent throws", async () => {
    const agent: Agent = {
      name: "codex",
      async run() {
        throw new Error("SDK unavailable");
      },
    };

    await expect(
      implementWorkItem({
        source: linearSource(),
        workspace: temporaryWorkspace(),
        agent,
        execution: execution(),
      }),
    ).resolves.toMatchObject({
      ok: false,
      failureKind: "provider",
      error: "Implementation agent failed: SDK unavailable",
    });
  });

  it("rejects invalid structured output before accepting a session", async () => {
    const result = await implementWorkItem({
      source: linearSource(),
      workspace: temporaryWorkspace(),
      agent: fakeAgent([], {
        ok: true,
        structuredOutput: { outcome: "implemented" },
        raw: {},
        session: { provider: "codex", id: "thread-323" },
      }),
      execution: execution(),
    });

    expect(result).toMatchObject({
      ok: false,
      failureKind: "invalid-output",
      error: expect.stringContaining("Invalid implementation structured output"),
    });
  });

  it.each([
    ["missing", undefined, "did not return a resumable author session"],
    [
      "wrong-provider",
      { provider: "cursor" as const, id: "agent-323" },
      "Cannot resume codex agent from cursor session",
    ],
    ["blank", { provider: "codex" as const, id: " " }, "blank session id"],
  ])("rejects a %s author session for implemented work", async (_name, session, message) => {
    const result = await implementWorkItem({
      source: linearSource(),
      workspace: temporaryWorkspace(),
      agent: fakeAgent([], {
        ok: true,
        structuredOutput: implementedDecision(),
        raw: {},
        ...(session ? { session } : {}),
      }),
      execution: execution(),
    });

    expect(result).toMatchObject({
      ok: false,
      failureKind: "invalid-session",
      error: expect.stringContaining(message),
    });
  });

  it("rejects an explicit missing plan before invoking the agent", async () => {
    const inputs: AgentRunInput[] = [];
    const result = await implementWorkItem({
      source: planSource(),
      workspace: temporaryWorkspace(),
      agent: fakeAgent(inputs, {
        ok: true,
        structuredOutput: implementedDecision(),
        raw: {},
        session: { provider: "codex", id: "thread-323" },
      }),
      execution: execution(),
    });

    expect(result).toMatchObject({ ok: false, failureKind: "invalid-source" });
    expect(inputs).toHaveLength(0);
  });

  it("implements against an unchanged explicit plan", async () => {
    const workspace = temporaryWorkspace();
    writePlan(workspace, "# Approved plan\n");

    const result = await implementWorkItem({
      source: planSource(),
      workspace,
      agent: fakeAgent([], {
        ok: true,
        structuredOutput: implementedDecision(),
        raw: {},
        session: { provider: "codex", id: "thread-plan" },
      }),
      execution: execution(),
    });

    expect(result).toMatchObject({
      ok: true,
      provenance: {
        source: {
          kind: "plan",
          issueReference: "FER-323",
          path: "dev/plans/FER-323.md",
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
        session: { provider: "codex", id: "thread-plan" },
      },
    });
  });

  it("fails closed when the selected plan changes during the provider run", async () => {
    const workspace = temporaryWorkspace();
    writePlan(workspace, "# Initial plan\n");
    const agent: Agent = {
      name: "codex",
      async run() {
        writePlan(workspace, "# Mutated plan\n");
        return {
          ok: true,
          structuredOutput: implementedDecision(),
          raw: {},
          session: { provider: "codex", id: "thread-323" },
        };
      },
    };

    const result = await implementWorkItem({
      source: planSource(),
      workspace,
      agent,
      execution: execution(),
    });

    expect(result).toMatchObject({
      ok: false,
      failureKind: "source-integrity",
      error: expect.stringContaining("content no longer matches its initial snapshot"),
      provenance: {
        source: {
          kind: "plan",
          issueReference: "FER-323",
          path: "dev/plans/FER-323.md",
        },
      },
    });
  });

  it("passes cancellation and log settings through unchanged", async () => {
    const workspace = temporaryWorkspace();
    const controller = new AbortController();
    const inputs: AgentRunInput[] = [];
    await implementWorkItem({
      source: linearSource(),
      workspace,
      agent: fakeAgent(inputs, {
        ok: true,
        structuredOutput: needsInputDecision(),
        raw: {},
      }),
      execution: { ...execution(), signal: controller.signal },
    });

    expect(inputs[0]?.signal).toBe(controller.signal);
  });
});

function fakeAgent(inputs: AgentRunInput[], result: AgentRunResult): Agent {
  return {
    name: "codex",
    run: vi.fn<Agent["run"]>(async (input: AgentRunInput) => {
      inputs.push(input);
      return result;
    }),
  };
}

function execution(): ImplementationExecution {
  return {
    model: "gpt-5.6-sol",
    modelReasoningEffort: "high",
    maxRuntimeMs: 120_000,
    logPath: "/tmp/implementation.jsonl",
  };
}

function linearSource(): ImplementationSource {
  return {
    kind: "linear",
    workItem: validWorkItem(),
  };
}

function planSource(): ImplementationSource {
  return {
    kind: "plan",
    issueReference: "FER-323",
    path: "dev/plans/FER-323.md",
  };
}

function implementedDecision() {
  return {
    outcome: "implemented",
    summary: "Added the implementation operation.",
    proof: [
      {
        action: "Run focused tests",
        status: "passed",
        observedResult: "Focused tests passed.",
      },
    ],
    remainingUncertainty: [],
    questions: [],
  };
}

function needsInputDecision() {
  return {
    outcome: "needs-input",
    summary: "Two accepted requirements conflict.",
    proof: [],
    remainingUncertainty: [],
    questions: ["Which requirement supersedes the other?"],
  };
}

function temporaryWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "harness-implementation-"));
  temporaryPaths.push(workspace);
  return workspace;
}

function writePlan(workspace: string, contents: string): void {
  const path = join(workspace, "dev/plans/FER-323.md");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

function validWorkItem(): WorkItemContext {
  return {
    id: "issue-323",
    reference: "FER-323",
    title: "Build the provider-neutral implementation operation",
    description: "Apply exactly one trusted source.",
    url: "https://linear.app/issue/FER-323",
    state: "Open",
    labels: ["Implement"],
    comments: [],
    parent: null,
    children: [],
    duplicateOf: null,
    blockedBy: [],
    related: [],
    links: [],
    createdAt: "2026-07-29T20:00:00.000Z",
    updatedAt: "2026-07-29T21:00:00.000Z",
    completeness: {
      commentsTruncated: false,
      labelsTruncated: false,
      relationsTruncated: false,
      linksTruncated: false,
      childrenTruncated: false,
    },
  };
}
