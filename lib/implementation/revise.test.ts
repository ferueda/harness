import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentRunInput, AgentRunResult } from "../agent/contract.ts";
import type { WorkItemContext } from "../work-item/schema.ts";
import { createImplementationReviewFindingId } from "./finding-identity.ts";
import {
  reviseImplementation,
  IMPLEMENTATION_REVISION_RESULT_SCHEMA_PATH,
  type ImplementationRevisionExecution,
} from "./revise.ts";
import {
  IMPLEMENTATION_REVISION_RESULT_SCHEMA_VERSION,
  type ImplementationRevisionDecision,
  type ImplementationRevisionReview,
} from "./revise-schema.ts";
import type { ImplementationSource } from "./source.ts";

const REVISION = "a".repeat(40);
const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("reviseImplementation", () => {
  it("resumes the exact plan author and returns the normalized continuation", async () => {
    const workspace = temporaryWorkspace();
    writePlan(workspace, "# Approved plan\n");
    const inputs: AgentRunInput[] = [];
    const review = trustedReview();
    const result = await reviseImplementation({
      source: planSource(),
      review,
      authorSession: { version: 1, provider: "codex", id: "  thread-323  " },
      workspace,
      agent: fakeAgent(
        inputs,
        {
          ok: true,
          structuredOutput: updatedDecision(review),
          raw: {},
          session: {
            provider: "codex",
            id: " thread-325 ",
            raw: { providerField: "must-not-leak" },
          },
        },
        () => writeFileSync(join(workspace, "revision.ts"), "export const revised = true;\n"),
      ),
      execution: execution(),
    });

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      workspace,
      schemaPath: IMPLEMENTATION_REVISION_RESULT_SCHEMA_PATH,
      model: "gpt-5.6-sol",
      modelReasoningEffort: "high",
      session: { provider: "codex", id: "thread-323" },
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      workspaceGuard: "record",
      maxRuntimeMs: 120_000,
      logPath: "/tmp/implementation-revision.jsonl",
    });
    expect(result).toMatchObject({
      ok: true,
      decision: { outcome: "updated" },
      authorSession: { version: 1, provider: "codex", id: "thread-325" },
      provenance: {
        provider: "codex",
        model: "gpt-5.6-sol",
        modelReasoningEffort: "high",
        policyVersion: "1",
        resultSchemaVersion: IMPLEMENTATION_REVISION_RESULT_SCHEMA_VERSION,
        reviewedRevision: REVISION,
        promptSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        schemaSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        source: {
          kind: "plan",
          issueReference: "FER-323",
          path: "dev/plans/FER-323.md",
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("providerField");
    expect(readFileSync(join(workspace, "revision.ts"), "utf8")).toContain("revised");
  });

  it.each([
    ["unchanged", unchangedDecision],
    ["needs-input", needsInputDecision],
  ] as const)(
    "supports a %s Linear-source outcome and preserves its continuation",
    async (_name, decision) => {
      const workspace = temporaryWorkspace();
      const review = trustedReview();
      const partialPath = join(workspace, "partial.ts");
      const result = await reviseImplementation({
        source: linearSource(),
        review,
        authorSession: { version: 1, provider: "codex", id: "thread-323" },
        workspace,
        agent: fakeAgent(
          [],
          {
            ok: true,
            structuredOutput: decision(review),
            raw: {},
            session: { provider: "codex", id: "thread-next" },
          },
          _name === "needs-input"
            ? () => writeFileSync(partialPath, "export const partial = true;\n")
            : undefined,
        ),
        execution: execution(),
      });

      expect(result).toMatchObject({
        ok: true,
        decision: { outcome: _name },
        authorSession: { version: 1, provider: "codex", id: "thread-next" },
        provenance: {
          source: {
            kind: "linear",
            issueReference: "FER-323",
            path: null,
          },
        },
      });
      expect(existsSync(partialPath)).toBe(_name === "needs-input");
    },
  );

  it("records deterministic prompt and schema provenance", async () => {
    const workspace = temporaryWorkspace();
    const review = trustedReview();
    const result = await run(workspace, review, {
      ok: true,
      structuredOutput: unchangedDecision(review),
      raw: {},
      session: { provider: "codex", id: "thread-next" },
    });

    expect(result.provenance.promptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.provenance.schemaSha256).toBe(
      sha256(readFileSync(IMPLEMENTATION_REVISION_RESULT_SCHEMA_PATH)),
    );
  });

  it("rejects altered trusted finding content before invoking the agent", async () => {
    const workspace = temporaryWorkspace();
    const inputs: AgentRunInput[] = [];
    const review = trustedReview();
    const result = await reviseImplementation({
      ...validInput(workspace, review, fakeAgent(inputs, providerFailure())),
      review: {
        ...review,
        findings: [
          {
            ...review.findings[0]!,
            recommendation: "A different recommendation was substituted.",
          },
        ],
      },
    });

    expect(result).toMatchObject({
      ok: false,
      failureKind: "invalid-review",
      error: expect.stringContaining("not bound"),
    });
    expect(inputs).toHaveLength(0);
  });

  it("rejects blank trusted finding content before invoking the agent", async () => {
    const workspace = temporaryWorkspace();
    const inputs: AgentRunInput[] = [];
    const review = trustedReview();
    const result = await reviseImplementation({
      ...validInput(workspace, review, fakeAgent(inputs, providerFailure())),
      review: {
        ...review,
        findings: [{ ...review.findings[0]!, issue: "   " }],
      },
    });

    expect(result).toMatchObject({
      ok: false,
      failureKind: "invalid-review",
      error: expect.stringContaining("must contain non-whitespace content"),
    });
    expect(inputs).toHaveLength(0);
  });

  it.each([
    ["missing", undefined],
    ["wrong provider", { version: 1, provider: "cursor", id: "cursor-323" }],
    ["blank", { version: 1, provider: "codex", id: "  " }],
  ])("rejects a %s author session before invocation", async (_name, authorSession) => {
    const workspace = temporaryWorkspace();
    const inputs: AgentRunInput[] = [];
    const review = trustedReview();
    const result = await reviseImplementation({
      ...validInput(workspace, review, fakeAgent(inputs, providerFailure())),
      authorSession: authorSession as never,
    });

    expect(result).toMatchObject({ ok: false, failureKind: "invalid-session" });
    expect(inputs).toHaveLength(0);
  });

  it.each([
    ["missing", undefined],
    ["wrong provider", { provider: "cursor" as const, id: "cursor-next" }],
    ["blank", { provider: "codex" as const, id: " " }],
  ])("rejects a %s returned continuation", async (_name, session) => {
    const workspace = temporaryWorkspace();
    const review = trustedReview();
    const result = await run(workspace, review, {
      ok: true,
      structuredOutput: unchangedDecision(review),
      raw: {},
      ...(session ? { session } : {}),
    });

    expect(result).toMatchObject({ ok: false, failureKind: "invalid-session" });
  });

  it("rejects unknown, missing, and duplicate finding responses", async () => {
    const workspace = temporaryWorkspace();
    const review = trustedReview();
    const unknownId = `implementation-review-finding-${"c".repeat(64)}`;
    const mismatch = await run(workspace, review, {
      ok: true,
      structuredOutput: {
        ...unchangedDecision(review),
        responses: [
          {
            ...unchangedDecision(review).responses[0],
            findingId: unknownId,
          },
        ],
      },
      raw: {},
      session: { provider: "codex", id: "thread-next" },
    });
    expect(mismatch).toMatchObject({
      ok: false,
      failureKind: "invalid-output",
      error: expect.stringContaining("response set mismatch"),
    });
    if (mismatch.ok) throw new Error("expected mismatch failure");
    expect(mismatch.error).not.toContain(unknownId);
    expect(mismatch.error).not.toContain(review.findings[0]!.id);

    const duplicate = await run(workspace, review, {
      ok: true,
      structuredOutput: {
        ...unchangedDecision(review),
        responses: [unchangedDecision(review).responses[0], unchangedDecision(review).responses[0]],
      },
      raw: {},
      session: { provider: "codex", id: "thread-next" },
    });
    expect(duplicate).toMatchObject({
      ok: false,
      failureKind: "invalid-output",
      error: expect.stringContaining("duplicate finding responses"),
    });
  });

  it("rejects selected-source evidence that does not match the source mode", async () => {
    const workspace = temporaryWorkspace();
    const review = trustedReview();
    const decision = unchangedDecision(review);
    const result = await run(workspace, review, {
      ok: true,
      structuredOutput: {
        ...decision,
        responses: [
          {
            ...decision.responses[0],
            evidence: [
              {
                source: "selected-source",
                path: "dev/plans/FER-323.md",
                lineStart: null,
                lineEnd: null,
                summary: "This path is invalid for a Linear source.",
              },
            ],
          },
        ],
      },
      raw: {},
      session: { provider: "codex", id: "thread-next" },
    });

    expect(result).toMatchObject({
      ok: false,
      failureKind: "invalid-output",
      error: expect.stringContaining("expected null"),
    });
  });

  it("fails closed when the selected plan changes during the provider run", async () => {
    const workspace = temporaryWorkspace();
    writePlan(workspace, "# Initial plan\n");
    const review = trustedReview();
    const result = await reviseImplementation({
      source: planSource(),
      review,
      authorSession: { version: 1, provider: "codex", id: "thread-323" },
      workspace,
      agent: fakeAgent(
        [],
        {
          ok: true,
          structuredOutput: updatedDecision(review),
          raw: {},
          session: { provider: "codex", id: "thread-next" },
        },
        () => writePlan(workspace, "# Mutated plan\n"),
      ),
      execution: execution(),
    });

    expect(result).toMatchObject({
      ok: false,
      failureKind: "source-integrity",
      error: expect.stringContaining("content no longer matches its initial snapshot"),
    });
  });

  it.each([
    ["provider", providerFailure(), "provider"],
    ["timeout", { ok: false, error: "timed out", exitCode: 124 }, "timeout"],
    ["cancelled", { ok: false, error: "cancelled", exitCode: 1, aborted: true }, "cancelled"],
    [
      "workspace guard",
      { ok: false, error: "workspace guard", exitCode: 1, failureKind: "workspace-guard" },
      "workspace-guard",
    ],
  ] as const)("returns a typed %s failure", async (_name, providerResult, failureKind) => {
    const result = await run(temporaryWorkspace(), trustedReview(), providerResult);
    expect(result).toMatchObject({ ok: false, failureKind });
  });
});

function trustedReview(): ImplementationRevisionReview {
  const finding = {
    reviewer: "implementation" as const,
    title: "Preserve source integrity",
    severity: "High" as const,
    location: "lib/implementation/revise.ts:180",
    issue: "The selected source might change during the run.",
    recommendation: "Verify the source after provider execution.",
    rationale: "The selected source remains task authority.",
  };
  return {
    reviewedRevision: REVISION,
    findings: [
      {
        id: createImplementationReviewFindingId({
          reviewedRevision: REVISION,
          reviewer: finding.reviewer,
          finding,
        }),
        ...finding,
      },
    ],
  };
}

function updatedDecision(review: ImplementationRevisionReview): ImplementationRevisionDecision {
  return {
    outcome: "updated",
    rationale: "The implementation now preserves source integrity.",
    responses: [
      {
        findingId: review.findings[0]!.id,
        disposition: "accepted",
        rationale: "The finding was correct and is now addressed.",
        evidence: [],
      },
    ],
    proof: [proof()],
    remainingUncertainty: [],
    questions: [],
  };
}

function unchangedDecision(review: ImplementationRevisionReview): ImplementationRevisionDecision {
  return {
    outcome: "unchanged",
    rationale: "The existing source-integrity check already handles the concern.",
    responses: [
      {
        findingId: review.findings[0]!.id,
        disposition: "declined",
        rationale: "The current post-run verification already fails closed.",
        evidence: [codeEvidence()],
      },
    ],
    proof: [proof()],
    remainingUncertainty: [],
    questions: [],
  };
}

function needsInputDecision(review: ImplementationRevisionReview): ImplementationRevisionDecision {
  return {
    outcome: "needs-input",
    rationale: "Two accepted project invariants conflict.",
    responses: [
      {
        findingId: review.findings[0]!.id,
        disposition: "accepted",
        rationale: "The concern is valid but the authority conflict blocks a safe correction.",
        evidence: [codeEvidence()],
      },
    ],
    proof: [],
    remainingUncertainty: [],
    questions: ["Which accepted project invariant supersedes the other?"],
  };
}

function proof() {
  return {
    action: "pnpm exec vitest run lib/implementation/revise.test.ts",
    status: "passed" as const,
    observedResult: "Focused revision tests passed.",
  };
}

function codeEvidence() {
  return {
    source: "code" as const,
    path: "lib/implementation/revise.ts",
    lineStart: 180,
    lineEnd: 220,
    summary: "The selected source is verified after provider execution.",
  };
}

async function run(
  workspace: string,
  review: ImplementationRevisionReview,
  result: AgentRunResult,
) {
  return reviseImplementation({
    ...validInput(workspace, review, fakeAgent([], result)),
  });
}

function validInput(
  workspace: string,
  review: ImplementationRevisionReview,
  agent: Agent,
): Parameters<typeof reviseImplementation>[0] {
  return {
    source: linearSource(),
    review,
    authorSession: { version: 1, provider: "codex", id: "thread-323" },
    workspace,
    agent,
    execution: execution(),
  };
}

function fakeAgent(
  inputs: AgentRunInput[],
  result: AgentRunResult,
  beforeReturn?: () => void,
): Agent {
  return {
    name: "codex",
    run: vi.fn<Agent["run"]>(async (input) => {
      inputs.push(input);
      beforeReturn?.();
      return result;
    }),
  };
}

function providerFailure(): AgentRunResult {
  return { ok: false, error: "provider unavailable", exitCode: 1 };
}

function execution(): ImplementationRevisionExecution {
  return {
    model: "gpt-5.6-sol",
    modelReasoningEffort: "high",
    maxRuntimeMs: 120_000,
    logPath: "/tmp/implementation-revision.jsonl",
  };
}

function linearSource(): ImplementationSource {
  return { kind: "linear", workItem: validWorkItem() };
}

function planSource(): ImplementationSource {
  return {
    kind: "plan",
    issueReference: "FER-323",
    path: "dev/plans/FER-323.md",
  };
}

function validWorkItem(): WorkItemContext {
  return {
    id: "issue-323",
    reference: "FER-323",
    title: "Build the implementation operation",
    description: "Apply one trusted source.",
    url: "https://linear.app/issue/FER-323",
    state: "In Progress",
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

function temporaryWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "harness-implementation-revision-"));
  temporaryPaths.push(workspace);
  return workspace;
}

function writePlan(workspace: string, content: string): void {
  const path = join(workspace, "dev/plans/FER-323.md");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function sha256(value: string | NodeJS.ArrayBufferView): string {
  return createHash("sha256").update(value).digest("hex");
}
