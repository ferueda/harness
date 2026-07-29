import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Agent, AgentRunInput } from "../agent/contract.ts";
import { reviseSpec } from "./revise.ts";
import type { SpecRevisionReview } from "./revise-schema.ts";
import type { SpecWorkItemContext } from "./schema.ts";

const fsState = vi.hoisted(() => ({ failSchemaRead: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const actualReadFileSync = actual.readFileSync as (...values: unknown[]) => unknown;
  return {
    ...actual,
    readFileSync: (...args: unknown[]) => {
      if (
        fsState.failSchemaRead &&
        String(args[0]).endsWith("/schemas/spec-revision-result.schema.json")
      ) {
        throw new Error("schema fixture unavailable");
      }
      return actualReadFileSync(...args);
    },
  };
});

const temporaryPaths: string[] = [];

afterEach(() => {
  fsState.failSchemaRead = false;
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

it("returns a typed provider failure when the result schema cannot be read", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-spec-revision-schema-"));
  temporaryPaths.push(workspace);
  const artifactPath = "dev/plans/FER-283.md";
  const artifactFile = join(workspace, artifactPath);
  mkdirSync(dirname(artifactFile), { recursive: true });
  writeFileSync(artifactFile, "# Spec\n", "utf8");
  const inputs: AgentRunInput[] = [];
  const agent: Agent = {
    name: "codex",
    async run(input) {
      inputs.push(input);
      throw new Error("agent must not run");
    },
  };
  fsState.failSchemaRead = true;

  await expect(
    reviseSpec({
      workItem: validWorkItem(),
      artifact: {
        path: artifactPath,
        revision: "a".repeat(40),
      },
      review: validReview(),
      authorSession: {
        version: 1,
        provider: "codex",
        id: "thread-283",
      },
      workspace,
      agent,
      execution: {
        model: "gpt-5.6-sol",
        modelReasoningEffort: "high",
        maxRuntimeMs: 120_000,
      },
    }),
  ).resolves.toEqual({
    ok: false,
    failureKind: "provider",
    error: "Spec revision result schema is unavailable: schema fixture unavailable",
    provenance: {
      provider: "codex",
      model: "gpt-5.6-sol",
      modelReasoningEffort: "high",
      policyVersion: "2",
      resultSchemaVersion: "1",
      reviewRubricVersion: null,
      promptSha256: null,
      schemaSha256: null,
      artifactBeforeSha256: null,
      artifactAfterSha256: null,
    },
  });
  expect(inputs).toHaveLength(0);
});

function validReview(): SpecRevisionReview {
  return {
    reviewedRevision: "a".repeat(40),
    rubricVersion: "2",
    findings: [
      {
        id: `spec-review-finding-${"b".repeat(64)}`,
        criterion: "architecture",
        artifactLocation: {
          section: "Changes",
          lineStart: 4,
          lineEnd: 6,
        },
        evidence: [
          {
            source: "code",
            path: "lib/spec/spec.ts",
            lineStart: 84,
            lineEnd: 156,
            summary: "The current operation stops before publication.",
          },
        ],
        problem: "The Spec assigns publication to the domain operation.",
        requiredOutcome: "Keep publication in the workflow consumer.",
      },
    ],
  };
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
