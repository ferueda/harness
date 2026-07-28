import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Agent, AgentProviderName, AgentRunInput, AgentRunResult } from "../agent/contract.ts";
import { createSpecReviewFindingId } from "../spec-review/finding-identity.ts";
import type {
  SpecReviewArtifact,
  SpecReviewFinding,
  SpecReviewFindingDraft,
} from "../spec-review/schema.ts";
import { renderSpecRevisionPrompt, SPEC_REVISION_POLICY_VERSION } from "./revise-prompt.ts";
import {
  SPEC_REVISION_RESULT_SCHEMA_VERSION,
  type SpecRevisionAuthorSession,
  type SpecRevisionDecision,
  type SpecRevisionFindingResponse,
  type SpecRevisionReview,
} from "./revise-schema.ts";
import {
  reviseSpec,
  SPEC_REVISION_RESULT_SCHEMA_PATH,
  type SpecRevisionFailureKind,
  type SpecRevisionResult,
} from "./revise.ts";
import type { SpecWorkItemContext } from "./schema.ts";

const REVISION = "a".repeat(40);
const ARTIFACT: SpecReviewArtifact = {
  path: "dev/plans/FER-283.md",
  revision: REVISION,
};
const INITIAL_ARTIFACT = "# FER-283\n\nKeep revision separate from publication.\n";
const UPDATED_ARTIFACT = "# FER-283\n\nKeep revision separate from Git and publication.\n";
const FINDING_DRAFT = {
  criterion: "architecture",
  artifactLocation: {
    section: "Changes",
    lineStart: 3,
    lineEnd: 3,
  },
  evidence: [
    {
      source: "code",
      path: "lib/spec/spec.ts",
      lineStart: 84,
      lineEnd: 156,
      summary: "The initial Spec operation does not own publication.",
    },
  ],
  problem: "The proposed revision operation also owns Git publication.",
  requiredOutcome: "Keep Git and publication in the workflow consumer.",
} satisfies SpecReviewFindingDraft;

const FINDING_ID = createSpecReviewFindingId({
  artifact: ARTIFACT,
  rubricVersion: "2",
  finding: FINDING_DRAFT,
});

const FINDING: SpecReviewFinding = {
  id: FINDING_ID,
  ...FINDING_DRAFT,
};

const REVIEW: SpecRevisionReview = {
  reviewedRevision: REVISION,
  rubricVersion: "2",
  findings: [FINDING],
};

const ACCEPTED_RESPONSE = {
  findingId: FINDING_ID,
  disposition: "accepted",
  rationale: "The concern is valid and the artifact now keeps Git outside the operation.",
  evidence: [],
} satisfies SpecRevisionFindingResponse;

const DECLINED_RESPONSE = {
  findingId: FINDING_ID,
  disposition: "declined",
  rationale: "The artifact already assigns Git to the workflow consumer.",
  evidence: FINDING.evidence,
} satisfies SpecRevisionFindingResponse;

const UPDATED: SpecRevisionDecision = {
  outcome: "updated",
  rationale: "The artifact now states the correct ownership boundary.",
  responses: [ACCEPTED_RESPONSE],
  questions: [],
};

const UNCHANGED: SpecRevisionDecision = {
  outcome: "unchanged",
  rationale: "The existing artifact already states the correct boundary.",
  responses: [DECLINED_RESPONSE],
  questions: [],
};

const NEEDS_INPUT: SpecRevisionDecision = {
  outcome: "needs-input",
  rationale: "Two accepted intent sources conflict.",
  responses: [DECLINED_RESPONSE],
  questions: ["Which accepted intent source supersedes the other?"],
};

const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("reviseSpec", () => {
  it("resumes the exact normalized author and returns only the latest normalized continuation", async () => {
    const workspace = createWorkspace();
    writeArtifact(workspace);
    const signal = new AbortController().signal;
    const fake = fakeAgent(
      {
        ok: true,
        structuredOutput: UPDATED,
        raw: {},
        session: {
          provider: "codex",
          id: "thread-283-revised",
          raw: { adapterField: "must-not-leak" },
        },
      },
      "codex",
      () => writeArtifact(workspace, UPDATED_ARTIFACT),
    );

    const result = await reviseSpec({
      workItem: validWorkItem(),
      artifact: ARTIFACT,
      review: REVIEW,
      authorSession: { version: 1, provider: "codex", id: "  thread-283  " },
      workspace,
      agent: fake.agent,
      execution: {
        model: "gpt-5.6-sol",
        modelReasoningEffort: "high",
        maxRuntimeMs: 120_000,
        logPath: "/logs/spec-revision.jsonl",
        signal,
      },
    });

    expect(fake.inputs).toEqual([
      {
        workspace,
        prompt: renderSpecRevisionPrompt({
          workItem: validWorkItem(),
          artifact: ARTIFACT,
          review: REVIEW,
        }),
        schemaPath: SPEC_REVISION_RESULT_SCHEMA_PATH,
        model: "gpt-5.6-sol",
        modelReasoningEffort: "high",
        session: { provider: "codex", id: "thread-283" },
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
        workspaceGuard: "record",
        maxRuntimeMs: 120_000,
        logPath: "/logs/spec-revision.jsonl",
        signal,
      },
    ]);
    expect(result).toMatchObject({
      ok: true,
      artifact: ARTIFACT,
      decision: UPDATED,
      authorSession: { version: 1, provider: "codex", id: "thread-283-revised" },
      provenance: {
        provider: "codex",
        model: "gpt-5.6-sol",
        modelReasoningEffort: "high",
        policyVersion: SPEC_REVISION_POLICY_VERSION,
        resultSchemaVersion: SPEC_REVISION_RESULT_SCHEMA_VERSION,
        reviewRubricVersion: "2",
      },
    });
    expect(JSON.stringify(result)).not.toContain("adapterField");
  });

  it.each(["codex", "cursor"] satisfies AgentProviderName[])(
    "keeps %s continuation behind the provider-neutral Agent interface",
    async (provider) => {
      const workspace = createWorkspace();
      writeArtifact(workspace);
      const result = await run(
        workspace,
        fakeAgent(
          {
            ok: true,
            structuredOutput: UNCHANGED,
            raw: {},
            session: { provider, id: `${provider}-next` },
          },
          provider,
        ).agent,
        {
          version: 1,
          provider,
          id: `${provider}-original`,
        },
      );

      expect(result).toMatchObject({
        ok: true,
        authorSession: { version: 1, provider, id: `${provider}-next` },
        provenance: { provider },
      });
    },
  );

  it.each([
    ["unchanged", UNCHANGED],
    ["needs input", NEEDS_INPUT],
  ])("returns %s only when the artifact stays unchanged", async (_name, decision) => {
    const workspace = createWorkspace();
    writeArtifact(workspace);

    const result = await run(
      workspace,
      fakeAgent({
        ok: true,
        structuredOutput: decision,
        raw: {},
        session: { provider: "codex", id: "thread-next" },
      }).agent,
    );

    expect(result).toMatchObject({ ok: true, decision });
    expect(readFileSync(join(workspace, ARTIFACT.path), "utf8")).toBe(INITIAL_ARTIFACT);
  });

  it("records deterministic prompt, schema, and artifact hashes", async () => {
    const workspace = createWorkspace();
    writeArtifact(workspace);

    const result = await run(
      workspace,
      fakeAgent(
        {
          ok: true,
          structuredOutput: UPDATED,
          raw: {},
          session: { provider: "codex", id: "thread-next" },
        },
        "codex",
        () => writeArtifact(workspace, UPDATED_ARTIFACT),
      ).agent,
    );

    expect(result.provenance.promptSha256).toBe(
      sha256(
        renderSpecRevisionPrompt({
          workItem: validWorkItem(),
          artifact: ARTIFACT,
          review: REVIEW,
        }),
      ),
    );
    expect(result.provenance.schemaSha256).toBe(
      sha256(readFileSync(SPEC_REVISION_RESULT_SCHEMA_PATH)),
    );
    expect(result.provenance.artifactBeforeSha256).toBe(sha256(INITIAL_ARTIFACT));
    expect(result.provenance.artifactAfterSha256).toBe(sha256(UPDATED_ARTIFACT));
  });

  it("rejects stale review findings before invoking the agent", async () => {
    const workspace = createWorkspace();
    writeArtifact(workspace);
    const fake = fakeAgent({
      ok: true,
      structuredOutput: UNCHANGED,
      raw: {},
      session: { provider: "codex", id: "thread-next" },
    });

    const result = await reviseSpec({
      ...validInput(workspace, fake.agent),
      review: { ...REVIEW, reviewedRevision: "c".repeat(40) },
    });

    expect(result).toMatchObject({ ok: false, failureKind: "stale-review" });
    expect(fake.inputs).toHaveLength(0);
  });

  it.each([
    ["missing", undefined],
    [
      "raw-dependent",
      { version: 1, provider: "codex", id: "thread-283", raw: { kind: "codex-thread" } },
    ],
    ["blank", { version: 1, provider: "codex", id: "   " }],
    ["provider-mismatched", { version: 1, provider: "cursor", id: "cursor-session" }],
  ])("rejects a %s input session before invocation", async (_name, authorSession) => {
    const workspace = createWorkspace();
    writeArtifact(workspace);
    const fake = fakeAgent({
      ok: true,
      structuredOutput: UNCHANGED,
      raw: {},
      session: { provider: "codex", id: "thread-next" },
    });

    const result = await reviseSpec({
      ...validInput(workspace, fake.agent),
      authorSession: authorSession as SpecRevisionAuthorSession,
    });

    expect(result).toMatchObject({ ok: false, failureKind: "invalid-session" });
    expect(fake.inputs).toHaveLength(0);
  });

  it.each([
    ["missing", undefined],
    ["raw-dependent", { provider: "codex", id: undefined, raw: { kind: "codex-thread" } }],
    ["blank", { provider: "codex", id: "   " }],
    ["overlong", { provider: "codex", id: "x".repeat(2_001) }],
    ["provider-mismatched", { provider: "cursor", id: "cursor-next" }],
  ])("rejects a %s returned continuation", async (_name, session) => {
    const workspace = createWorkspace();
    writeArtifact(workspace);
    const result = await run(
      workspace,
      fakeAgent({
        ok: true,
        structuredOutput: UNCHANGED,
        raw: {},
        session,
      } as AgentRunResult).agent,
    );

    expect(result).toMatchObject({ ok: false, failureKind: "invalid-session" });
  });

  it.each([
    [
      "unknown",
      {
        ...UNCHANGED,
        responses: [
          {
            ...DECLINED_RESPONSE,
            findingId: `spec-review-finding-${"c".repeat(64)}`,
          },
        ],
      },
    ],
    [
      "duplicate",
      {
        ...UNCHANGED,
        responses: [DECLINED_RESPONSE, DECLINED_RESPONSE],
      },
    ],
  ])("rejects a %s finding response set", async (_name, decision) => {
    const workspace = createWorkspace();
    writeArtifact(workspace);
    const result = await run(
      workspace,
      fakeAgent({
        ok: true,
        structuredOutput: decision,
        raw: {},
        session: { provider: "codex", id: "thread-next" },
      }).agent,
    );

    expect(result).toMatchObject({
      ok: false,
      failureKind: "invalid-output",
      error: expect.stringContaining("finding response"),
    });
  });

  it("rejects a missing finding response", async () => {
    const workspace = createWorkspace();
    writeArtifact(workspace);
    const secondFindingDraft = {
      ...FINDING,
      problem: "The verification seam is too low-level.",
    };
    const secondFinding = {
      ...secondFindingDraft,
      id: createSpecReviewFindingId({
        artifact: ARTIFACT,
        rubricVersion: REVIEW.rubricVersion,
        finding: secondFindingDraft,
      }),
    };
    const result = await reviseSpec({
      ...validInput(
        workspace,
        fakeAgent({
          ok: true,
          structuredOutput: UNCHANGED,
          raw: {},
          session: { provider: "codex", id: "thread-next" },
        }).agent,
      ),
      review: { ...REVIEW, findings: [FINDING, secondFinding] },
    });

    expect(result).toMatchObject({
      ok: false,
      failureKind: "invalid-output",
      error: expect.stringContaining("missing"),
    });
  });

  it("rejects artifact citations that name another path", async () => {
    const workspace = createWorkspace();
    writeArtifact(workspace);
    const decision = {
      ...UNCHANGED,
      responses: [
        {
          ...DECLINED_RESPONSE,
          evidence: [
            {
              ...DECLINED_RESPONSE.evidence[0],
              source: "artifact",
              path: "dev/plans/OTHER.md",
            },
          ],
        },
      ],
    };

    const result = await run(
      workspace,
      fakeAgent({
        ok: true,
        structuredOutput: decision,
        raw: {},
        session: { provider: "codex", id: "thread-next" },
      }).agent,
    );

    expect(result).toMatchObject({
      ok: false,
      failureKind: "invalid-output",
      error: expect.stringContaining("expected dev/plans/FER-283.md"),
    });
  });

  it.each([
    ["updated", UPDATED, false],
    ["unchanged", UNCHANGED, true],
    ["needs-input", NEEDS_INPUT, true],
  ])("rejects %s when the artifact effect disagrees", async (_name, decision, changeArtifact) => {
    const workspace = createWorkspace();
    writeArtifact(workspace);
    const result = await run(
      workspace,
      fakeAgent(
        {
          ok: true,
          structuredOutput: decision,
          raw: {},
          session: { provider: "codex", id: "thread-next" },
        },
        "codex",
        changeArtifact ? () => writeArtifact(workspace, UPDATED_ARTIFACT) : undefined,
      ).agent,
    );

    expect(result).toMatchObject({
      ok: false,
      failureKind: "invalid-artifact",
      error: expect.stringContaining("artifact effect"),
    });
  });

  it("rejects an unsafe or invalidated artifact after execution", async () => {
    const workspace = createWorkspace();
    const outside = createWorkspace();
    writeArtifact(workspace);
    writeFileSync(join(outside, "outside.md"), "# Outside\n", "utf8");

    const result = await run(
      workspace,
      fakeAgent(
        {
          ok: true,
          structuredOutput: UPDATED,
          raw: {},
          session: { provider: "codex", id: "thread-next" },
        },
        "codex",
        () => {
          rmSync(join(workspace, ARTIFACT.path));
          symlinkSync(join(outside, "outside.md"), join(workspace, ARTIFACT.path));
        },
      ).agent,
    );

    expect(result).toMatchObject({
      ok: false,
      failureKind: "invalid-artifact",
      error: expect.stringContaining("must be a regular file"),
    });
  });

  it("rejects incomplete current work-item context", async () => {
    const workspace = createWorkspace();
    writeArtifact(workspace);
    const fake = fakeAgent({
      ok: true,
      structuredOutput: UNCHANGED,
      raw: {},
      session: { provider: "codex", id: "thread-next" },
    });

    const result = await reviseSpec({
      ...validInput(workspace, fake.agent),
      workItem: {
        ...validWorkItem(),
        completeness: {
          ...validWorkItem().completeness,
          commentsTruncated: true,
        },
      },
    });

    expect(result).toMatchObject({ ok: false, failureKind: "insufficient-context" });
    expect(fake.inputs).toHaveLength(0);
  });

  it.each([
    [
      "altered content",
      {
        ...FINDING,
        problem: "The finding content changed after trusted identity was assigned.",
      },
    ],
    [
      "a fabricated ID",
      {
        ...FINDING,
        id: `spec-review-finding-${"f".repeat(64)}`,
      },
    ],
  ])("rejects review findings with %s before invocation", async (_name, finding) => {
    const workspace = createWorkspace();
    writeArtifact(workspace);
    const fake = fakeAgent({
      ok: true,
      structuredOutput: UNCHANGED,
      raw: {},
      session: { provider: "codex", id: "thread-next" },
    });

    const result = await reviseSpec({
      ...validInput(workspace, fake.agent),
      review: { ...REVIEW, findings: [finding] },
    });

    expect(result).toMatchObject({
      ok: false,
      failureKind: "invalid-review",
      error: expect.stringContaining("not bound"),
    });
    expect(fake.inputs).toHaveLength(0);
  });

  it("rejects an artifact path that does not match the work item", async () => {
    const workspace = createWorkspace();
    writeArtifact(workspace);
    const fake = fakeAgent({
      ok: true,
      structuredOutput: UNCHANGED,
      raw: {},
      session: { provider: "codex", id: "thread-next" },
    });

    const result = await reviseSpec({
      ...validInput(workspace, fake.agent),
      artifact: { ...ARTIFACT, path: "dev/plans/FER-999.md" },
    });

    expect(result).toMatchObject({
      ok: false,
      failureKind: "invalid-artifact",
      error: expect.stringContaining("expected dev/plans/FER-283.md"),
    });
    expect(fake.inputs).toHaveLength(0);
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
  ] satisfies ReadonlyArray<[SpecRevisionFailureKind, AgentRunResult]>)(
    "returns a typed %s failure",
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

  it("converts a thrown provider error into a typed provider failure", async () => {
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
      error: "Spec revision agent failed: transport unavailable",
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

function run(
  workspace: string,
  agent: Agent,
  authorSession: SpecRevisionAuthorSession = {
    version: 1,
    provider: agent.name,
    id: `${agent.name}-original`,
  },
): Promise<SpecRevisionResult> {
  return reviseSpec({
    ...validInput(workspace, agent),
    authorSession,
  });
}

function validInput(workspace: string, agent: Agent) {
  return {
    workItem: validWorkItem(),
    artifact: ARTIFACT,
    review: REVIEW,
    authorSession: {
      version: 1,
      provider: agent.name,
      id: `${agent.name}-original`,
    } satisfies SpecRevisionAuthorSession,
    workspace,
    agent,
    execution: {
      model: "gpt-5.6-sol",
      modelReasoningEffort: "high",
      maxRuntimeMs: 120_000,
    },
  } as const;
}

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "harness-spec-revision-"));
  temporaryPaths.push(workspace);
  return workspace;
}

function writeArtifact(workspace: string, contents = INITIAL_ARTIFACT): void {
  const path = join(workspace, ARTIFACT.path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

function sha256(value: string | NodeJS.ArrayBufferView): string {
  return createHash("sha256").update(value).digest("hex");
}

function validWorkItem(): SpecWorkItemContext {
  return {
    id: "issue-283",
    reference: "FER-283",
    title: "Build a resumable Spec revision operation",
    description: "Resume the original author to evaluate trusted review findings.",
    url: "https://linear.app/issue/FER-283",
    state: "In Progress",
    labels: ["Implement"],
    comments: [],
    parent: null,
    children: [],
    duplicateOf: null,
    blockedBy: [],
    related: [],
    links: [],
    createdAt: "2026-07-28T18:00:00.000Z",
    updatedAt: "2026-07-28T19:00:00.000Z",
    completeness: {
      commentsTruncated: false,
      labelsTruncated: false,
      relationsTruncated: false,
      linksTruncated: false,
      childrenTruncated: false,
    },
  };
}
