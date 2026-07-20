import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Agent, AgentProviderName, AgentRunInput, AgentRunResult } from "../agents.ts";
import { renderTriagePrompt, TRIAGE_POLICY_VERSION } from "./prompt.ts";
import {
  TRIAGE_DECISION_SCHEMA_VERSION,
  type TriageDecision,
  type TriageWorkItemContext,
} from "./schema.ts";
import { TRIAGE_DECISION_SCHEMA_PATH, triageIssue, type TriageIssueFailureKind } from "./triage.ts";

const READY_TO_IMPLEMENT = {
  decision: "ready-for-agent",
  scope: "bounded",
  agentAction: "implement",
  rationale: "The issue is bounded and specified for implementation.",
  evidence: [
    {
      kind: "tracker",
      path: null,
      summary: "The issue asks for one observable outcome.",
    },
  ],
  questions: [],
  inputReason: null,
  duplicateOf: null,
  blockedBy: [],
} satisfies TriageDecision;

const READY_TO_PLAN = {
  ...READY_TO_IMPLEMENT,
  agentAction: "plan",
  rationale: "Repository investigation should come before implementation.",
} satisfies TriageDecision;

describe("triageIssue", () => {
  it("runs the exact triage prompt through the existing read-only Agent boundary", async () => {
    const signal = new AbortController().signal;
    const fake = fakeAgent({
      ok: true,
      structuredOutput: READY_TO_IMPLEMENT,
      raw: {},
      session: {
        provider: "codex",
        id: "thread-217",
        raw: { kind: "codex-thread", adapterField: "must-not-leak" },
      },
    });

    const result = await triageIssue({
      workItem: validWorkItem(),
      agent: fake.agent,
      workspace: "/workspace/harness",
      execution: {
        model: "gpt-5.6-sol",
        modelReasoningEffort: "xhigh",
        maxRuntimeMs: 120_000,
        logPath: "/logs/triage.jsonl",
        signal,
      },
    });

    expect(fake.inputs).toHaveLength(1);
    expect(fake.inputs[0]).toEqual({
      workspace: "/workspace/harness",
      prompt: renderTriagePrompt(validWorkItem()),
      schemaPath: TRIAGE_DECISION_SCHEMA_PATH,
      model: "gpt-5.6-sol",
      modelReasoningEffort: "xhigh",
      sandboxMode: "read-only",
      approvalPolicy: "never",
      workspaceGuard: "enforce",
      maxRuntimeMs: 120_000,
      logPath: "/logs/triage.jsonl",
      signal,
    });
    expect(result).toMatchObject({
      ok: true,
      decision: READY_TO_IMPLEMENT,
      provenance: {
        provider: "codex",
        model: "gpt-5.6-sol",
        modelReasoningEffort: "xhigh",
        policyVersion: TRIAGE_POLICY_VERSION,
        decisionSchemaVersion: TRIAGE_DECISION_SCHEMA_VERSION,
        session: { provider: "codex", id: "thread-217" },
      },
    });
    expect(result.provenance.session).toEqual({
      provider: "codex",
      id: "thread-217",
    });
  });

  it.each([
    ["implement", READY_TO_IMPLEMENT],
    ["plan", READY_TO_PLAN],
  ])("returns a validated %s decision", async (_name, decision) => {
    const fake = fakeAgent({ ok: true, structuredOutput: decision, raw: {} });

    const result = await run(fake.agent);

    expect(result).toEqual({
      ok: true,
      decision,
      provenance: expect.objectContaining({
        provider: "codex",
        session: null,
      }),
    });
  });

  it.each(["codex", "cursor"] satisfies AgentProviderName[])(
    "keeps %s execution behind the shared Agent interface",
    async (provider) => {
      const fake = fakeAgent(
        {
          ok: true,
          structuredOutput: READY_TO_IMPLEMENT,
          raw: {},
          session: {
            provider,
            id: `${provider}-session`,
            raw: { adapter: provider },
          },
        },
        provider,
      );

      const result = await run(fake.agent);

      expect(result).toMatchObject({
        ok: true,
        provenance: {
          provider,
          session: { provider, id: `${provider}-session` },
        },
      });
      expect(result.provenance.session).toEqual({
        provider,
        id: `${provider}-session`,
      });
    },
  );

  it("records deterministic prompt and schema hashes", async () => {
    const fake = fakeAgent({
      ok: true,
      structuredOutput: READY_TO_IMPLEMENT,
      raw: {},
    });

    const result = await run(fake.agent);

    expect(result.provenance.promptSha256).toBe(
      createHash("sha256").update(renderTriagePrompt(validWorkItem())).digest("hex"),
    );
    expect(result.provenance.schemaSha256).toBe(
      createHash("sha256").update(readFileSync(TRIAGE_DECISION_SCHEMA_PATH)).digest("hex"),
    );
  });

  it("returns invalid-output when provider output violates the Zod decision contract", async () => {
    const fake = fakeAgent({
      ok: true,
      structuredOutput: { ...READY_TO_IMPLEMENT, agentAction: null },
      raw: {},
    });

    const result = await run(fake.agent);

    expect(result).toMatchObject({
      ok: false,
      failureKind: "invalid-output",
      error: expect.stringContaining("ready-for-agent requires implement or plan"),
    });
  });

  it.each([
    ["provider", { ok: false, error: "Codex failed", exitCode: 1 } satisfies AgentRunResult],
    [
      "cancelled",
      {
        ok: false,
        error: "Agent was aborted",
        exitCode: 130,
        aborted: true,
      } satisfies AgentRunResult,
    ],
    [
      "workspace-guard",
      {
        ok: false,
        error: "Agent modified the workspace",
        exitCode: 1,
        failureKind: "workspace-guard",
      } satisfies AgentRunResult,
    ],
  ] satisfies ReadonlyArray<[TriageIssueFailureKind, AgentRunResult]>)(
    "returns a typed %s failure",
    async (failureKind, agentResult) => {
      const fake = fakeAgent(agentResult);

      const result = await run(fake.agent);

      expect(result).toMatchObject({
        ok: false,
        failureKind,
        error: agentResult.ok ? undefined : agentResult.error,
        provenance: {
          provider: "codex",
          model: "gpt-5.6-sol",
          modelReasoningEffort: "high",
          policyVersion: TRIAGE_POLICY_VERSION,
          decisionSchemaVersion: TRIAGE_DECISION_SCHEMA_VERSION,
          session: null,
        },
      });
    },
  );

  it("converts a thrown provider error into a typed provider failure", async () => {
    const agent: Agent = {
      name: "codex",
      run: async () => {
        throw new Error("transport unavailable");
      },
    };

    await expect(run(agent)).resolves.toMatchObject({
      ok: false,
      failureKind: "provider",
      error: "Triage agent failed: transport unavailable",
    });
  });
});

function fakeAgent(
  result: AgentRunResult,
  provider: AgentProviderName = "codex",
): { agent: Agent; inputs: AgentRunInput[] } {
  const inputs: AgentRunInput[] = [];
  return {
    inputs,
    agent: {
      name: provider,
      async run(input) {
        inputs.push(input);
        return result;
      },
    },
  };
}

function run(agent: Agent) {
  return triageIssue({
    workItem: validWorkItem(),
    agent,
    workspace: "/workspace/harness",
    execution: {
      model: "gpt-5.6-sol",
      modelReasoningEffort: "high",
      maxRuntimeMs: 120_000,
    },
  });
}

function validWorkItem(): TriageWorkItemContext {
  return {
    id: "issue-217",
    reference: "FER-217",
    title: "Run triage through the Agent boundary",
    description: "Execute the existing prompt and decision schema.",
    url: "https://linear.app/issue/FER-217",
    state: "Open",
    labels: ["Implement"],
    comments: [],
    parent: null,
    children: [],
    duplicateOf: null,
    blockedBy: [],
    related: [],
    links: [],
    createdAt: "2026-07-19T10:00:00.000Z",
    updatedAt: "2026-07-19T12:00:00.000Z",
    completeness: {
      commentsTruncated: false,
      labelsTruncated: false,
      relationsTruncated: false,
      linksTruncated: false,
      childrenTruncated: false,
    },
  };
}
