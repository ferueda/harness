import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Agent, AgentProviderName, AgentRunInput, AgentRunResult } from "../agent/contract.ts";
import { renderSpecPrompt, SPEC_POLICY_VERSION } from "./prompt.ts";
import {
  SPEC_RESULT_SCHEMA_VERSION,
  type SpecDecision,
  type SpecWorkItemContext,
} from "./schema.ts";
import {
  SPEC_RESULT_SCHEMA_PATH,
  specArtifactPath,
  specIssue,
  type SpecIssueFailureKind,
} from "./spec.ts";

const READY_FOR_REVIEW = {
  outcome: "ready-for-review",
  artifactPath: "dev/plans/FER-273.md",
  summary: "The Spec defines the provider-neutral operation.",
  evidence: [
    {
      kind: "code",
      path: "lib/agent/contract.ts",
      summary: "The Agent interface is the provider boundary.",
    },
  ],
  reviewerDecisions: [],
  questions: [],
} satisfies SpecDecision;

const NEEDS_INPUT = {
  outcome: "needs-input",
  artifactPath: null,
  summary: "Two authoritative intent sources conflict.",
  evidence: [
    {
      kind: "docs",
      path: "docs/project-intent.md",
      summary: "The current source assigns one owner.",
    },
  ],
  reviewerDecisions: [],
  questions: ["Which intent source supersedes the other?"],
} satisfies SpecDecision;

const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("specIssue", () => {
  it("runs the exact prompt through the shared writable Agent boundary", async () => {
    const workspace = createWorkspace();
    const signal = new AbortController().signal;
    const fake = fakeAgent(
      {
        ok: true,
        structuredOutput: READY_FOR_REVIEW,
        raw: {},
        session: {
          provider: "codex",
          id: "thread-273",
          raw: { adapterField: "must-not-leak" },
        },
      },
      "codex",
      () => writeArtifact(workspace, "# FER-273 Spec\n"),
    );

    const result = await specIssue({
      workItem: validWorkItem(),
      agent: fake.agent,
      workspace,
      execution: {
        model: "gpt-5.6-sol",
        modelReasoningEffort: "xhigh",
        maxRuntimeMs: 120_000,
        logPath: "/logs/spec.jsonl",
        signal,
      },
    });

    expect(fake.inputs).toHaveLength(1);
    expect(fake.inputs[0]).toEqual({
      workspace,
      prompt: renderSpecPrompt({
        workItem: validWorkItem(),
        artifactPath: "dev/plans/FER-273.md",
      }),
      schemaPath: SPEC_RESULT_SCHEMA_PATH,
      model: "gpt-5.6-sol",
      modelReasoningEffort: "xhigh",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      workspaceGuard: "record",
      maxRuntimeMs: 120_000,
      logPath: "/logs/spec.jsonl",
      signal,
    });
    expect(result).toMatchObject({
      ok: true,
      decision: READY_FOR_REVIEW,
      provenance: {
        provider: "codex",
        model: "gpt-5.6-sol",
        modelReasoningEffort: "xhigh",
        policyVersion: SPEC_POLICY_VERSION,
        resultSchemaVersion: SPEC_RESULT_SCHEMA_VERSION,
        session: { provider: "codex", id: "thread-273" },
      },
    });
    expect(result.provenance.session).toEqual({ provider: "codex", id: "thread-273" });
  });

  it.each(["codex", "cursor"] satisfies AgentProviderName[])(
    "keeps %s execution behind the shared Agent interface",
    async (provider) => {
      const workspace = createWorkspace();
      const fake = fakeAgent(
        {
          ok: true,
          structuredOutput: READY_FOR_REVIEW,
          raw: {},
          session: { provider, id: `${provider}-session` },
        },
        provider,
        () => writeArtifact(workspace, "# Spec\n"),
      );

      const result = await run(fake.agent, workspace);

      expect(result).toMatchObject({
        ok: true,
        provenance: { provider, session: { provider, id: `${provider}-session` } },
      });
    },
  );

  it("returns Needs Input without requiring an artifact", async () => {
    const workspace = createWorkspace();
    const result = await run(
      fakeAgent({ ok: true, structuredOutput: NEEDS_INPUT, raw: {} }).agent,
      workspace,
    );

    expect(result).toEqual({
      ok: true,
      decision: NEEDS_INPUT,
      provenance: expect.objectContaining({ provider: "codex", session: null }),
    });
  });

  it("records deterministic prompt and schema hashes", async () => {
    const workspace = createWorkspace();
    const fake = fakeAgent({ ok: true, structuredOutput: READY_FOR_REVIEW, raw: {} }, "codex", () =>
      writeArtifact(workspace, "# Spec\n"),
    );

    const result = await run(fake.agent, workspace);

    expect(result.provenance.promptSha256).toBe(
      createHash("sha256")
        .update(
          renderSpecPrompt({
            workItem: validWorkItem(),
            artifactPath: "dev/plans/FER-273.md",
          }),
        )
        .digest("hex"),
    );
    expect(result.provenance.schemaSha256).toBe(
      createHash("sha256").update(readFileSync(SPEC_RESULT_SCHEMA_PATH)).digest("hex"),
    );
  });

  it("returns invalid-output when provider output violates the result contract", async () => {
    const workspace = createWorkspace();
    const fake = fakeAgent({
      ok: true,
      structuredOutput: { ...READY_FOR_REVIEW, questions: ["Choose one?"] },
      raw: {},
    });

    const result = await run(fake.agent, workspace);

    expect(result).toMatchObject({
      ok: false,
      failureKind: "invalid-output",
      error: expect.stringContaining("questions"),
    });
  });

  it.each([
    ["a missing file", () => undefined, READY_FOR_REVIEW, "no such file"],
    [
      "an empty file",
      (workspace: string) => writeArtifact(workspace, "\n"),
      READY_FOR_REVIEW,
      "is empty",
    ],
    [
      "a wrong claimed path",
      (workspace: string) => writeArtifact(workspace, "# Spec\n"),
      { ...READY_FOR_REVIEW, artifactPath: "dev/plans/other.md" },
      "expected dev/plans/FER-273.md",
    ],
    [
      "an out-of-workspace claim",
      (workspace: string) => writeArtifact(workspace, "# Spec\n"),
      { ...READY_FOR_REVIEW, artifactPath: "../FER-273.md" },
      "Invalid Spec structured output",
    ],
  ])("rejects %s", async (_name, prepare, decision, error) => {
    const workspace = createWorkspace();
    prepare(workspace);
    const result = await run(
      fakeAgent({ ok: true, structuredOutput: decision, raw: {} }).agent,
      workspace,
    );

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining(error) });
  });

  it("rejects a directory in place of the claimed artifact", async () => {
    const workspace = createWorkspace();
    mkdirSync(join(workspace, "dev/plans/FER-273.md"), { recursive: true });

    const result = await run(
      fakeAgent({ ok: true, structuredOutput: READY_FOR_REVIEW, raw: {} }).agent,
      workspace,
    );

    expect(result).toMatchObject({
      ok: false,
      failureKind: "invalid-artifact",
      error: expect.stringContaining("must be a regular file"),
    });
  });

  it("rejects a symlinked artifact", async () => {
    const workspace = createWorkspace();
    const outside = createWorkspace();
    const target = join(outside, "outside.md");
    writeFileSync(target, "# Outside\n", "utf8");
    mkdirSync(join(workspace, "dev/plans"), { recursive: true });
    symlinkSync(target, join(workspace, "dev/plans/FER-273.md"));

    const result = await run(
      fakeAgent({ ok: true, structuredOutput: READY_FOR_REVIEW, raw: {} }).agent,
      workspace,
    );

    expect(result).toMatchObject({
      ok: false,
      failureKind: "invalid-artifact",
      error: expect.stringContaining("must be a regular file"),
    });
  });

  it("rejects an artifact reached through a symlinked parent directory", async () => {
    const workspace = createWorkspace();
    const outside = createWorkspace();
    writeFileSync(join(outside, "FER-273.md"), "# Outside\n", "utf8");
    mkdirSync(join(workspace, "dev"), { recursive: true });
    symlinkSync(outside, join(workspace, "dev/plans"));

    const result = await run(
      fakeAgent({ ok: true, structuredOutput: READY_FOR_REVIEW, raw: {} }).agent,
      workspace,
    );

    expect(result).toMatchObject({
      ok: false,
      failureKind: "invalid-artifact",
      error: expect.stringContaining("resolves outside the supplied workspace"),
    });
  });

  it.each([
    ["provider", { ok: false, error: "Codex failed", exitCode: 1 } satisfies AgentRunResult],
    ["timeout", { ok: false, error: "Agent timed out", exitCode: 124 } satisfies AgentRunResult],
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
        error: "Workspace could not be inspected",
        exitCode: 1,
        failureKind: "workspace-guard",
      } satisfies AgentRunResult,
    ],
  ] satisfies ReadonlyArray<[SpecIssueFailureKind, AgentRunResult]>)(
    "returns a typed %s failure",
    async (failureKind, agentResult) => {
      const result = await run(fakeAgent(agentResult).agent, createWorkspace());

      expect(result).toMatchObject({
        ok: false,
        failureKind,
        error: agentResult.ok ? undefined : agentResult.error,
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

    await expect(run(agent, createWorkspace())).resolves.toMatchObject({
      ok: false,
      failureKind: "provider",
      error: "Spec agent failed: transport unavailable",
    });
  });
});

describe("specArtifactPath", () => {
  it("uses the exact normalized issue reference", () => {
    expect(specArtifactPath("FER-273")).toBe("dev/plans/FER-273.md");
  });

  it.each(["fer-273", "FER/273", "../FER-273", "FER-ABC"])(
    "rejects invalid reference %s",
    (reference) => {
      expect(() => specArtifactPath(reference)).toThrow(/uppercase issue reference/);
    },
  );
});

function fakeAgent(
  result: AgentRunResult,
  provider: AgentProviderName = "codex",
  onRun?: (input: AgentRunInput) => void,
): { agent: Agent; inputs: AgentRunInput[] } {
  const inputs: AgentRunInput[] = [];
  return {
    inputs,
    agent: {
      name: provider,
      async run(input) {
        inputs.push(input);
        onRun?.(input);
        return result;
      },
    },
  };
}

function run(agent: Agent, workspace: string) {
  return specIssue({
    workItem: validWorkItem(),
    agent,
    workspace,
    execution: {
      model: "gpt-5.6-sol",
      modelReasoningEffort: "high",
      maxRuntimeMs: 120_000,
    },
  });
}

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "harness-spec-"));
  temporaryPaths.push(workspace);
  return workspace;
}

function writeArtifact(workspace: string, contents: string): void {
  const path = join(workspace, "dev/plans/FER-273.md");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

function validWorkItem(): SpecWorkItemContext {
  return {
    id: "issue-273",
    reference: "FER-273",
    title: "Build a provider-neutral Spec operation",
    description: "Write one code-grounded implementation Spec.",
    url: "https://linear.app/issue/FER-273",
    state: "Open",
    labels: ["Spec"],
    comments: [],
    parent: null,
    children: [],
    duplicateOf: null,
    blockedBy: [],
    related: [],
    links: [],
    createdAt: "2026-07-21T22:12:57.641Z",
    updatedAt: "2026-07-22T20:00:00.000Z",
    completeness: {
      commentsTruncated: false,
      labelsTruncated: false,
      relationsTruncated: false,
      linksTruncated: false,
      childrenTruncated: false,
    },
  };
}
