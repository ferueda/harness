import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertCodexStrictSchema, loadSchema, schemaAccepts } from "../agent/json-schema.ts";
import {
  IMPLEMENTATION_REVISION_RESULT_SCHEMA_VERSION,
  ImplementationRevisionAuthorSessionSchema,
  ImplementationRevisionDecisionSchema,
  type ImplementationRevisionFindingResponse,
} from "./revise-schema.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const JSON_SCHEMA = loadSchema({
  schemaPath: join(REPO_ROOT, "schemas/implementation-revision-result.schema.json"),
})!;
const FINDING_ID = `implementation-review-finding-${"b".repeat(64)}`;

const EVIDENCE = {
  source: "code",
  path: "lib/implementation/revise.ts",
  lineStart: 100,
  lineEnd: 130,
  summary: "The operation verifies the selected source after the provider returns.",
} as const;
const PROOF = {
  action: "pnpm exec vitest run lib/implementation/revise.test.ts",
  status: "passed",
  observedResult: "All focused revision tests passed.",
} as const;
const ACCEPTED = response("accepted", []);
const ADAPTED = response("adapted", [EVIDENCE]);
const DECLINED = response("declined", [EVIDENCE]);

const UPDATED = {
  outcome: "updated",
  rationale: "The implementation now preserves source integrity.",
  responses: [ACCEPTED],
  proof: [PROOF],
  remainingUncertainty: [],
  questions: [],
} as const;
const UNCHANGED = {
  outcome: "unchanged",
  rationale: "The current implementation already preserves source integrity.",
  responses: [DECLINED],
  proof: [PROOF],
  remainingUncertainty: [],
  questions: [],
} as const;
const NEEDS_INPUT = {
  outcome: "needs-input",
  rationale: "Two accepted project invariants conflict.",
  responses: [{ ...ACCEPTED, evidence: [EVIDENCE] }],
  proof: [],
  remainingUncertainty: [],
  questions: ["Which project invariant supersedes the other?"],
} as const;

describe("implementation revision schemas", () => {
  it.each([
    ["updated", UPDATED],
    ["adapted update", { ...UPDATED, responses: [ADAPTED] }],
    ["unchanged", UNCHANGED],
    ["needs input", NEEDS_INPUT],
  ])("accepts a valid %s decision", (_name, decision) => {
    expect(ImplementationRevisionDecisionSchema.safeParse(decision).success).toBe(true);
  });

  it.each([
    ["updated with only declines", { ...UPDATED, responses: [DECLINED] }],
    ["updated without proof", { ...UPDATED, proof: [] }],
    ["updated with questions", { ...UPDATED, questions: ["Choose?"] }],
    ["unchanged with acceptance", { ...UNCHANGED, responses: [ACCEPTED] }],
    ["unchanged without proof", { ...UNCHANGED, proof: [] }],
    ["needs input without questions", { ...NEEDS_INPUT, questions: [] }],
    ["needs input with proof", { ...NEEDS_INPUT, proof: [PROOF] }],
    ["needs input without response evidence", { ...NEEDS_INPUT, responses: [ACCEPTED] }],
    ["adapted without evidence", { ...UPDATED, responses: [{ ...ADAPTED, evidence: [] }] }],
    ["declined without evidence", { ...UNCHANGED, responses: [{ ...DECLINED, evidence: [] }] }],
    ["failed proof without uncertainty", { ...UPDATED, proof: [{ ...PROOF, status: "failed" }] }],
  ])("rejects %s", (_name, decision) => {
    expect(ImplementationRevisionDecisionSchema.safeParse(decision).success).toBe(false);
  });

  it("accepts only normalized versioned author sessions", () => {
    expect(
      ImplementationRevisionAuthorSessionSchema.parse({
        version: 1,
        provider: "codex",
        id: "  thread-325  ",
      }),
    ).toEqual({ version: 1, provider: "codex", id: "thread-325" });
    expect(
      ImplementationRevisionAuthorSessionSchema.safeParse({
        version: 1,
        provider: "codex",
        id: "thread-325",
        raw: {},
      }).success,
    ).toBe(false);
  });
});

describe("exported implementation revision JSON schema", () => {
  it("is Codex-strict and requires every provider field", () => {
    expect(IMPLEMENTATION_REVISION_RESULT_SCHEMA_VERSION).toBe("1");
    expect(() => assertCodexStrictSchema(JSON_SCHEMA)).not.toThrow();
    expect(JSON_SCHEMA.required).toEqual([
      "outcome",
      "rationale",
      "responses",
      "proof",
      "remainingUncertainty",
      "questions",
    ]);
  });

  it.each([
    ["updated", UPDATED],
    ["unchanged", UNCHANGED],
    ["needs input", NEEDS_INPUT],
  ])("stays structurally aligned with Zod for %s", (_name, decision) => {
    expect(schemaAccepts(JSON_SCHEMA, decision)).toBe(true);
    expect(ImplementationRevisionDecisionSchema.safeParse(decision).success).toBe(true);
  });

  it.each([
    ["extra root field", { ...UPDATED, session: "thread-325" }],
    ["extra response field", { ...UPDATED, responses: [{ ...ACCEPTED, raw: {} }] }],
    ["empty response array", { ...UPDATED, responses: [] }],
    ["malformed finding ID", { ...UPDATED, responses: [{ ...ACCEPTED, findingId: "short" }] }],
  ])("rejects %s in both provider schemas", (_name, decision) => {
    expect(schemaAccepts(JSON_SCHEMA, decision)).toBe(false);
    expect(ImplementationRevisionDecisionSchema.safeParse(decision).success).toBe(false);
  });
});

function response(
  disposition: ImplementationRevisionFindingResponse["disposition"],
  evidence: ImplementationRevisionFindingResponse["evidence"],
): ImplementationRevisionFindingResponse {
  return {
    findingId: FINDING_ID,
    disposition,
    rationale: `The finding was ${disposition}.`,
    evidence,
  };
}
