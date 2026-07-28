import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Agent, AgentRunInput } from "../agent/contract.ts";
import { reviewSpec } from "./review.ts";
import type { SpecReviewWorkItemContext } from "./schema.ts";

const fsState = vi.hoisted(() => ({ failSchemaRead: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const actualReadFileSync = actual.readFileSync as (...values: unknown[]) => unknown;
  return {
    ...actual,
    readFileSync: (...args: unknown[]) => {
      if (
        fsState.failSchemaRead &&
        String(args[0]).endsWith("/schemas/spec-review-result.schema.json")
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
  const workspace = mkdtempSync(join(tmpdir(), "harness-spec-review-schema-"));
  temporaryPaths.push(workspace);
  const artifactPath = "dev/plans/FER-282.md";
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
    reviewSpec({
      workItem: validWorkItem(),
      artifact: {
        path: artifactPath,
        revision: "a".repeat(40),
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
    error: "Spec review result schema is unavailable: schema fixture unavailable",
    provenance: {
      provider: "codex",
      model: "gpt-5.6-sol",
      modelReasoningEffort: "high",
      rubricVersion: "2",
      promptVersion: "2",
      resultSchemaVersion: "2",
      promptSha256: null,
      schemaSha256: null,
      artifactSha256: null,
    },
  });
  expect(inputs).toHaveLength(0);
});

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
