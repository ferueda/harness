import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Agent, AgentRunInput } from "../agent/contract.ts";
import type { WorkItemContext } from "../work-item/schema.ts";
import { implementWorkItem } from "./implementation.ts";
import { IMPLEMENTATION_POLICY_VERSION } from "./prompt.ts";

const fsState = vi.hoisted(() => ({ failSchemaRead: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const actualReadFileSync = actual.readFileSync as (...values: unknown[]) => unknown;
  return {
    ...actual,
    readFileSync: (...args: unknown[]) => {
      if (
        fsState.failSchemaRead &&
        String(args[0]).endsWith("/schemas/implementation-result.schema.json")
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
  const workspace = mkdtempSync(join(tmpdir(), "harness-implementation-schema-"));
  temporaryPaths.push(workspace);
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
    implementWorkItem({
      source: { kind: "linear", workItem: validWorkItem() },
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
    error: "Implementation result schema is unavailable: schema fixture unavailable",
    provenance: {
      provider: "codex",
      model: "gpt-5.6-sol",
      modelReasoningEffort: "high",
      policyVersion: IMPLEMENTATION_POLICY_VERSION,
      resultSchemaVersion: "1",
      promptSha256: null,
      schemaSha256: null,
      source: null,
      session: null,
    },
  });
  expect(inputs).toHaveLength(0);
});

function validWorkItem(): WorkItemContext {
  return {
    id: "issue-323",
    reference: "FER-323",
    title: "Build the implementation operation",
    description: "Apply one trusted source.",
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
