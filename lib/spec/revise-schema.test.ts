import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertCodexStrictSchema, loadSchema, schemaAccepts } from "../agent/json-schema.ts";
import {
  SPEC_REVISION_RESULT_SCHEMA_VERSION,
  SpecRevisionAuthorSessionSchema,
  SpecRevisionDecisionDraftSchema,
  SpecRevisionReviewSchema,
} from "./revise-schema.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const JSON_SCHEMA = loadSchema({
  schemaPath: join(REPO_ROOT, "schemas/spec-revision-result.schema.json"),
})!;
const REVISION = "a".repeat(40);
const FINDING_ID = `spec-review-finding-${"b".repeat(64)}`;

const EVIDENCE = {
  source: "code",
  path: "lib/spec/spec.ts",
  lineStart: 84,
  lineEnd: 156,
  summary: "The existing Spec operation owns initial artifact generation.",
} as const;

const ACCEPTED = {
  findingId: FINDING_ID,
  disposition: "accepted",
  rationale: "The reviewer identified a real ownership error and the artifact now corrects it.",
  evidence: [],
} as const;

const ADAPTED = {
  findingId: FINDING_ID,
  disposition: "adapted",
  rationale: "The concern is valid, but the existing boundary supports a smaller correction.",
  evidence: [EVIDENCE],
} as const;

const DECLINED = {
  findingId: FINDING_ID,
  disposition: "declined",
  rationale: "The cited operation already stops before publication.",
  evidence: [EVIDENCE],
} as const;

const UPDATED = {
  outcome: "updated",
  rationale: "The artifact now keeps publication outside the domain operation.",
  responses: [ACCEPTED],
  questions: [],
} as const;

const UNCHANGED = {
  outcome: "unchanged",
  rationale: "The existing artifact already follows the requested boundary.",
  responses: [DECLINED],
  questions: [],
} as const;

const NEEDS_INPUT = {
  outcome: "needs-input",
  rationale: "Two accepted intent sources conflict on the public boundary.",
  responses: [DECLINED],
  questions: ["Which accepted intent source supersedes the other?"],
} as const;

describe("Spec revision schemas", () => {
  it.each([
    ["updated", UPDATED],
    ["adapted update", { ...UPDATED, responses: [ADAPTED] }],
    ["unchanged", UNCHANGED],
    ["needs input", NEEDS_INPUT],
  ])("accepts a valid %s decision", (_name, decision) => {
    expect(SpecRevisionDecisionDraftSchema.safeParse(decision).success).toBe(true);
  });

  it.each([
    ["updated with only declines", { ...UPDATED, responses: [DECLINED] }],
    ["updated with questions", { ...UPDATED, questions: ["Choose?"] }],
    ["unchanged with an acceptance", { ...UNCHANGED, responses: [ACCEPTED] }],
    ["unchanged with questions", { ...UNCHANGED, questions: ["Choose?"] }],
    ["needs input without questions", { ...NEEDS_INPUT, questions: [] }],
    ["needs input accepting without evidence", { ...NEEDS_INPUT, responses: [ACCEPTED] }],
    ["adapted without evidence", { ...UPDATED, responses: [{ ...ADAPTED, evidence: [] }] }],
    ["declined without evidence", { ...UNCHANGED, responses: [{ ...DECLINED, evidence: [] }] }],
  ])("rejects %s", (_name, decision) => {
    expect(SpecRevisionDecisionDraftSchema.safeParse(decision).success).toBe(false);
  });

  it("accepts only normalized, versioned author sessions", () => {
    expect(
      SpecRevisionAuthorSessionSchema.parse({
        version: 1,
        provider: "codex",
        id: "  thread-283  ",
      }),
    ).toEqual({ version: 1, provider: "codex", id: "thread-283" });
    expect(
      SpecRevisionAuthorSessionSchema.safeParse({
        version: 1,
        provider: "codex",
        id: "thread-283",
        raw: { kind: "codex-thread" },
      }).success,
    ).toBe(false);
  });

  it("validates a complete, unique, revision-bound review input", () => {
    const review = {
      reviewedRevision: REVISION,
      rubricVersion: "2",
      findings: [finding()],
    };

    expect(SpecRevisionReviewSchema.safeParse(review).success).toBe(true);
    expect(
      SpecRevisionReviewSchema.safeParse({
        ...review,
        findings: [finding(), finding()],
      }).success,
    ).toBe(false);
    expect(
      SpecRevisionReviewSchema.safeParse({
        ...review,
        reviewedRevision: "short",
      }).success,
    ).toBe(false);
  });
});

describe("exported Spec revision result JSON schema", () => {
  it("is Codex-strict and requires every provider field", () => {
    expect(SPEC_REVISION_RESULT_SCHEMA_VERSION).toBe("1");
    expect(() => assertCodexStrictSchema(JSON_SCHEMA)).not.toThrow();
    expect(JSON_SCHEMA.required).toEqual(["outcome", "rationale", "responses", "questions"]);
  });

  it.each([
    ["updated", UPDATED],
    ["unchanged", UNCHANGED],
    ["needs input", NEEDS_INPUT],
  ])("stays structurally aligned with Zod for %s", (_name, decision) => {
    expect(schemaAccepts(JSON_SCHEMA, decision)).toBe(true);
    expect(SpecRevisionDecisionDraftSchema.safeParse(decision).success).toBe(true);
  });

  it.each([
    ["an extra root field", { ...UPDATED, session: "thread-283" }],
    ["an extra response field", { ...UPDATED, responses: [{ ...ACCEPTED, reviewerFinding: {} }] }],
    ["an empty response array", { ...UPDATED, responses: [] }],
    ["an overlong rationale", { ...UPDATED, rationale: "x".repeat(4_001) }],
  ])("rejects %s in both provider schemas", (_name, decision) => {
    expect(schemaAccepts(JSON_SCHEMA, decision)).toBe(false);
    expect(SpecRevisionDecisionDraftSchema.safeParse(decision).success).toBe(false);
  });

  it("leaves cross-field outcome policy to Zod", () => {
    const decision = { ...UPDATED, responses: [DECLINED] };

    expect(schemaAccepts(JSON_SCHEMA, decision)).toBe(true);
    expect(SpecRevisionDecisionDraftSchema.safeParse(decision).success).toBe(false);
  });
});

function finding() {
  return {
    id: FINDING_ID,
    criterion: "architecture",
    artifactLocation: {
      section: "Changes",
      lineStart: 8,
      lineEnd: 10,
    },
    evidence: [EVIDENCE],
    problem: "The Spec assigns publication to the domain operation.",
    requiredOutcome: "Keep publication in the later workflow consumer.",
  };
}
