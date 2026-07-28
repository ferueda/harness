import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Agent, AgentProviderName, AgentRunInput, AgentRunResult } from "../agent/contract.ts";
import {
  renderSpecReviewPrompt,
  SPEC_REVIEW_PROMPT_VERSION,
  SPEC_REVIEW_RUBRIC_VERSION,
} from "./prompt.ts";
import {
  SPEC_REVIEW_RESULT_SCHEMA_VERSION,
  type SpecReviewArtifact,
  type SpecReviewDecisionDraft,
  type SpecReviewFinding,
  type SpecReviewFindingDraft,
  type SpecReviewWorkItemContext,
} from "./schema.ts";
import {
  reviewSpec,
  SPEC_REVIEW_RESULT_SCHEMA_PATH,
  type SpecReviewFailureKind,
  type SpecReviewResult,
} from "./review.ts";

const REVISION = "a".repeat(40);
const ARTIFACT: SpecReviewArtifact = {
  path: "dev/plans/FER-282.md",
  revision: REVISION,
};
const ARTIFACT_CONTENT = `# Goal

Build one independent Spec reviewer.

# Changes

Add a read-only domain operation and strict result contract.

# Verify

Run focused contract tests and the repository gate.
`;

const APPROVED: SpecReviewDecisionDraft = {
  outcome: "approved",
  rationale: "The Spec is bounded, grounded, and verifiable.",
  evidence: [
    {
      source: "artifact",
      path: ARTIFACT.path,
      lineStart: 1,
      lineEnd: 13,
      summary: "The artifact defines the outcome, boundary, and proof.",
    },
  ],
  findings: [],
};

const FINDING: SpecReviewFindingDraft = {
  criterion: "architecture",
  artifactLocation: {
    section: "Changes",
    lineStart: 7,
    lineEnd: 9,
  },
  evidence: [
    {
      source: "artifact",
      path: ARTIFACT.path,
      lineStart: 7,
      lineEnd: 9,
      summary: "The Spec assigns publication to the review operation.",
    },
    {
      source: "code",
      path: "lib/spec/spec.ts",
      lineStart: 72,
      lineEnd: 118,
      summary: "The existing domain operation ends after validating its artifact.",
    },
  ],
  problem: "The proposed review operation also owns publication.",
  requiredOutcome: "Keep publication in a later execution consumer.",
};

const CHANGES_REQUESTED: SpecReviewDecisionDraft = {
  outcome: "changes-requested",
  rationale: "One ownership boundary must change.",
  evidence: [],
  findings: [FINDING],
};

const INSUFFICIENT_CONTEXT: SpecReviewDecisionDraft = {
  outcome: "insufficient-context",
  rationale: "The required project intent source is unavailable.",
  evidence: [],
  findings: [],
};

const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("reviewSpec", () => {
  it("runs a fresh read-only reviewer through the shared Agent boundary", async () => {
    const workspace = createWorkspace();
    writeArtifact(workspace);
    const signal = new AbortController().signal;
    const fake = fakeAgent({
      ok: true,
      structuredOutput: APPROVED,
      raw: {},
      session: {
        provider: "codex",
        id: "reviewer-session-must-not-leak",
        raw: { hidden: true },
      },
    });

    const result = await reviewSpec({
      workItem: validWorkItem(),
      artifact: ARTIFACT,
      workspace,
      agent: fake.agent,
      execution: {
        model: "gpt-5.6-sol",
        modelReasoningEffort: "high",
        maxRuntimeMs: 120_000,
        logPath: "/logs/spec-review.jsonl",
        signal,
      },
    });

    expect(fake.inputs).toEqual([
      {
        workspace,
        prompt: renderSpecReviewPrompt({ workItem: validWorkItem(), artifact: ARTIFACT }),
        schemaPath: SPEC_REVIEW_RESULT_SCHEMA_PATH,
        model: "gpt-5.6-sol",
        modelReasoningEffort: "high",
        sandboxMode: "read-only",
        approvalPolicy: "never",
        workspaceGuard: "enforce",
        maxRuntimeMs: 120_000,
        logPath: "/logs/spec-review.jsonl",
        signal,
      },
    ]);
    expect(result).toMatchObject({
      ok: true,
      artifact: ARTIFACT,
      decision: APPROVED,
      provenance: {
        provider: "codex",
        model: "gpt-5.6-sol",
        modelReasoningEffort: "high",
        rubricVersion: SPEC_REVIEW_RUBRIC_VERSION,
        promptVersion: SPEC_REVIEW_PROMPT_VERSION,
        resultSchemaVersion: SPEC_REVIEW_RESULT_SCHEMA_VERSION,
      },
    });
    expect(JSON.stringify(result)).not.toContain("reviewer-session-must-not-leak");
  });

  it.each(["codex", "cursor"] satisfies AgentProviderName[])(
    "keeps %s behind the provider-neutral Agent interface",
    async (provider) => {
      const workspace = createWorkspace();
      writeArtifact(workspace);

      const result = await run(
        workspace,
        fakeAgent({ ok: true, structuredOutput: APPROVED, raw: {} }, provider).agent,
      );

      expect(result).toMatchObject({ ok: true, provenance: { provider } });
    },
  );

  it("adds deterministic trusted IDs to changes requested", async () => {
    const firstWorkspace = createWorkspace();
    const secondWorkspace = createWorkspace();
    writeArtifact(firstWorkspace);
    writeArtifact(secondWorkspace);

    const first = await run(
      firstWorkspace,
      fakeAgent({ ok: true, structuredOutput: CHANGES_REQUESTED, raw: {} }).agent,
    );
    const second = await run(
      secondWorkspace,
      fakeAgent({ ok: true, structuredOutput: CHANGES_REQUESTED, raw: {} }).agent,
    );

    expect(first).toMatchObject({
      ok: true,
      artifact: ARTIFACT,
      decision: {
        outcome: "changes-requested",
        rationale: CHANGES_REQUESTED.rationale,
        findings: [{ ...FINDING, id: expect.stringMatching(/^spec-review-finding-[0-9a-f]{64}$/) }],
      },
    });
    expect(firstFinding(first).id).toBe(firstFinding(second).id);
  });

  it("binds finding identity to the reviewed revision", async () => {
    const firstWorkspace = createWorkspace();
    const secondWorkspace = createWorkspace();
    writeArtifact(firstWorkspace);
    writeArtifact(secondWorkspace);

    const first = await run(
      firstWorkspace,
      fakeAgent({ ok: true, structuredOutput: CHANGES_REQUESTED, raw: {} }).agent,
    );
    const second = await run(
      secondWorkspace,
      fakeAgent({ ok: true, structuredOutput: CHANGES_REQUESTED, raw: {} }).agent,
      { ...ARTIFACT, revision: "b".repeat(40) },
    );

    expect(firstFinding(first).id).not.toBe(firstFinding(second).id);
  });

  it("binds finding identity to the reviewed artifact path", async () => {
    const firstWorkspace = createWorkspace();
    const secondWorkspace = createWorkspace();
    const secondArtifact = { path: "dev/plans/FER-283.md", revision: REVISION };
    const finding = {
      ...FINDING,
      evidence: [FINDING.evidence[1]],
    };
    const decision = {
      ...CHANGES_REQUESTED,
      findings: [finding],
    };
    writeArtifact(firstWorkspace);
    writeArtifact(secondWorkspace, ARTIFACT_CONTENT, secondArtifact.path);

    const first = await run(
      firstWorkspace,
      fakeAgent({ ok: true, structuredOutput: decision, raw: {} }).agent,
    );
    const second = await reviewSpec({
      workItem: {
        ...validWorkItem(),
        id: "issue-283",
        reference: "FER-283",
        title: "Build a resumable Spec revision operation",
      },
      artifact: secondArtifact,
      workspace: secondWorkspace,
      agent: fakeAgent({ ok: true, structuredOutput: decision, raw: {} }).agent,
      execution: execution(),
    });

    expect(firstFinding(first).id).not.toBe(firstFinding(second).id);
  });

  it("keeps finding identity stable across Unicode evidence order changes", async () => {
    const firstWorkspace = createWorkspace();
    const secondWorkspace = createWorkspace();
    writeArtifact(firstWorkspace);
    writeArtifact(secondWorkspace);
    const unicodeFinding = {
      ...FINDING,
      evidence: [
        {
          ...FINDING.evidence[0],
          summary: "The café boundary is documented.",
        },
        {
          ...FINDING.evidence[0],
          summary: "The cafe\u0301 boundary is documented.",
        },
      ],
    };
    const reorderedFinding = {
      ...unicodeFinding,
      evidence: [...unicodeFinding.evidence].reverse(),
    };

    const first = await run(
      firstWorkspace,
      fakeAgent({
        ok: true,
        structuredOutput: {
          ...CHANGES_REQUESTED,
          findings: [unicodeFinding],
        },
        raw: {},
      }).agent,
    );
    const second = await run(
      secondWorkspace,
      fakeAgent({
        ok: true,
        structuredOutput: {
          ...CHANGES_REQUESTED,
          findings: [reorderedFinding],
        },
        raw: {},
      }).agent,
    );

    const firstResult = firstFinding(first);
    const secondResult = firstFinding(second);
    expect(firstResult.evidence).toEqual(unicodeFinding.evidence);
    expect(secondResult.evidence).toEqual(reorderedFinding.evidence);
    expect(firstResult.id).toBe(secondResult.id);
  });

  it("rejects duplicate canonical findings", async () => {
    const workspace = createWorkspace();
    writeArtifact(workspace);

    const result = await run(
      workspace,
      fakeAgent({
        ok: true,
        structuredOutput: {
          ...CHANGES_REQUESTED,
          findings: [FINDING, { ...FINDING }],
        },
        raw: {},
      }).agent,
    );

    expect(result).toMatchObject({
      ok: false,
      failureKind: "invalid-output",
      error: expect.stringContaining("duplicate canonical finding"),
    });
  });

  it("rejects model-supplied trusted fields", async () => {
    const workspace = createWorkspace();
    writeArtifact(workspace);

    const result = await run(
      workspace,
      fakeAgent({
        ok: true,
        structuredOutput: {
          ...CHANGES_REQUESTED,
          findings: [{ ...FINDING, id: "chosen-by-model" }],
        },
        raw: {},
      }).agent,
    );

    expect(result).toMatchObject({
      ok: false,
      failureKind: "invalid-output",
      error: expect.stringContaining("Unrecognized key"),
    });
  });

  it("requires artifact citations to name the exact reviewed artifact", async () => {
    const workspace = createWorkspace();
    writeArtifact(workspace);
    const finding = {
      ...FINDING,
      evidence: [
        {
          ...FINDING.evidence[0],
          path: "dev/plans/FER-999.md",
        },
      ],
    };

    const result = await run(
      workspace,
      fakeAgent({
        ok: true,
        structuredOutput: { ...CHANGES_REQUESTED, findings: [finding] },
        raw: {},
      }).agent,
    );

    expect(result).toMatchObject({
      ok: false,
      failureKind: "invalid-output",
      error: expect.stringContaining(`expected ${ARTIFACT.path}`),
    });
  });

  it("maps reviewer-reported missing authority to insufficient-context", async () => {
    const workspace = createWorkspace();
    writeArtifact(workspace);

    const result = await run(
      workspace,
      fakeAgent({
        ok: true,
        structuredOutput: INSUFFICIENT_CONTEXT,
        raw: {},
        session: { provider: "codex", id: "discarded-reviewer-session" },
      }).agent,
    );

    expect(result).toMatchObject({
      ok: false,
      failureKind: "insufficient-context",
      error: `Spec reviewer lacks required context: ${INSUFFICIENT_CONTEXT.rationale}`,
      provenance: {
        promptSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        schemaSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        artifactSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
    expect(JSON.stringify(result)).not.toContain("discarded-reviewer-session");
  });

  it.each([
    "commentsTruncated",
    "labelsTruncated",
    "relationsTruncated",
    "linksTruncated",
    "childrenTruncated",
  ] as const)("returns insufficient-context for %s context", async (flag) => {
    const workspace = createWorkspace();
    writeArtifact(workspace);
    const fake = fakeAgent({ ok: true, structuredOutput: APPROVED, raw: {} });
    const workItem = validWorkItem();
    workItem.completeness[flag] = true;

    const result = await reviewSpec({
      workItem,
      artifact: ARTIFACT,
      workspace,
      agent: fake.agent,
      execution: execution(),
    });

    expect(fake.inputs).toHaveLength(0);
    expect(result).toMatchObject({
      ok: false,
      failureKind: "insufficient-context",
    });
  });

  it.each([
    ["missing", () => undefined, ARTIFACT, "no such file"],
    ["empty", (workspace: string) => writeArtifact(workspace, "\n"), ARTIFACT, "is empty"],
    [
      "wrong path",
      (workspace: string) => writeArtifact(workspace),
      { ...ARTIFACT, path: "dev/plans/FER-999.md" },
      `expected ${ARTIFACT.path}`,
    ],
  ])(
    "rejects a %s artifact before invoking the reviewer",
    async (_name, prepare, artifact, error) => {
      const workspace = createWorkspace();
      prepare(workspace);
      const fake = fakeAgent({ ok: true, structuredOutput: APPROVED, raw: {} });

      const result = await run(workspace, fake.agent, artifact);

      expect(fake.inputs).toHaveLength(0);
      expect(result).toMatchObject({
        ok: false,
        failureKind: "invalid-artifact",
        error: expect.stringContaining(error),
      });
    },
  );

  it("rejects a symlinked artifact before invoking the reviewer", async () => {
    const workspace = createWorkspace();
    const outside = createWorkspace();
    const target = join(outside, "FER-282.md");
    writeFileSync(target, ARTIFACT_CONTENT, "utf8");
    mkdirSync(join(workspace, "dev/plans"), { recursive: true });
    symlinkSync(target, join(workspace, ARTIFACT.path));
    const fake = fakeAgent({ ok: true, structuredOutput: APPROVED, raw: {} });

    const result = await run(workspace, fake.agent);

    expect(fake.inputs).toHaveLength(0);
    expect(result).toMatchObject({
      ok: false,
      failureKind: "invalid-artifact",
      error: expect.stringContaining("must be a regular file"),
    });
  });

  it("reports artifact mutation as a workspace-guard failure", async () => {
    const workspace = createWorkspace();
    writeArtifact(workspace);
    const fake = fakeAgent({ ok: true, structuredOutput: APPROVED, raw: {} }, "codex", () =>
      writeArtifact(workspace, `${ARTIFACT_CONTENT}\nchanged\n`),
    );

    const result = await run(workspace, fake.agent);

    expect(result).toMatchObject({
      ok: false,
      failureKind: "workspace-guard",
      error: expect.stringContaining("content changed"),
    });
  });

  it.each([
    ["provider", { ok: false, error: "provider failed", exitCode: 1 }],
    ["timeout", { ok: false, error: "review timed out", exitCode: 124 }],
    ["cancelled", { ok: false, error: "review cancelled", exitCode: 130, aborted: true }],
    [
      "workspace-guard",
      {
        ok: false,
        error: "mutation attempted",
        exitCode: 1,
        failureKind: "workspace-guard",
      },
    ],
  ] satisfies ReadonlyArray<[SpecReviewFailureKind, AgentRunResult]>)(
    "returns a typed %s execution failure",
    async (failureKind, agentResult) => {
      const workspace = createWorkspace();
      writeArtifact(workspace);

      const result = await run(workspace, fakeAgent(agentResult).agent);

      expect(result).toMatchObject({
        ok: false,
        failureKind,
        error: agentResult.ok ? undefined : agentResult.error,
      });
    },
  );

  it("converts a thrown provider error into a typed failure", async () => {
    const workspace = createWorkspace();
    writeArtifact(workspace);
    const agent: Agent = {
      name: "codex",
      run: async () => {
        throw new Error("transport unavailable");
      },
    };

    await expect(run(workspace, agent)).resolves.toMatchObject({
      ok: false,
      failureKind: "provider",
      error: "Spec review agent failed: transport unavailable",
    });
  });

  it("records trusted artifact, prompt, and schema hashes", async () => {
    const workspace = createWorkspace();
    writeArtifact(workspace);

    const result = await run(
      workspace,
      fakeAgent({ ok: true, structuredOutput: APPROVED, raw: {} }).agent,
    );

    expect(result).toMatchObject({
      ok: true,
      artifact: ARTIFACT,
      provenance: {
        promptSha256: createHash("sha256")
          .update(renderSpecReviewPrompt({ workItem: validWorkItem(), artifact: ARTIFACT }))
          .digest("hex"),
        schemaSha256: createHash("sha256")
          .update(readFileSync(SPEC_REVIEW_RESULT_SCHEMA_PATH))
          .digest("hex"),
        artifactSha256: createHash("sha256").update(ARTIFACT_CONTENT).digest("hex"),
      },
    });
  });
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

function run(workspace: string, agent: Agent, artifact: SpecReviewArtifact = ARTIFACT) {
  return reviewSpec({
    workItem: validWorkItem(),
    artifact,
    workspace,
    agent,
    execution: execution(),
  });
}

function execution() {
  return {
    model: "gpt-5.6-sol",
    modelReasoningEffort: "high",
    maxRuntimeMs: 120_000,
  } as const;
}

function firstFinding(result: SpecReviewResult): SpecReviewFinding {
  expect(result).toMatchObject({
    ok: true,
    decision: {
      outcome: "changes-requested",
    },
  });
  if (!result.ok || result.decision.outcome !== "changes-requested") {
    throw new Error("Expected a changes-requested Spec review result.");
  }
  const finding = result.decision.findings[0];
  if (!finding) throw new Error("Expected a Spec review finding.");
  return finding;
}

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "harness-spec-review-"));
  temporaryPaths.push(workspace);
  return workspace;
}

function writeArtifact(
  workspace: string,
  contents = ARTIFACT_CONTENT,
  artifactPath = ARTIFACT.path,
): void {
  const path = join(workspace, artifactPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

function validWorkItem(): SpecReviewWorkItemContext {
  return {
    id: "issue-282",
    reference: "FER-282",
    title: "Build an independent read-only Spec review operation",
    description: "Review one exact generated Spec.",
    url: "https://linear.app/issue/FER-282",
    state: "Open",
    labels: ["Implement"],
    comments: [],
    parent: null,
    children: [],
    duplicateOf: null,
    blockedBy: [],
    related: [],
    links: [],
    createdAt: "2026-07-23T02:45:33.277Z",
    updatedAt: "2026-07-28T17:34:14.392Z",
    completeness: {
      commentsTruncated: false,
      labelsTruncated: false,
      relationsTruncated: false,
      linksTruncated: false,
      childrenTruncated: false,
    },
  };
}
