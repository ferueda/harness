import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertCodexStrictSchema, loadSchema, schemaAccepts } from "../agent/json-schema.ts";
import {
  SPEC_REVIEW_MAX_CITATIONS,
  SPEC_REVIEW_MAX_FINDINGS,
  SPEC_REVIEW_RESULT_SCHEMA_VERSION,
  SpecReviewArtifactSchema,
  SpecReviewCitationSchema,
  SpecReviewDecisionDraftSchema,
  SpecReviewDecisionSchema,
} from "./schema.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const JSON_SCHEMA = loadSchema({
  schemaPath: join(REPO_ROOT, "schemas/spec-review-result.schema.json"),
})!;

const ARTIFACT_CITATION = {
  source: "artifact",
  path: "dev/plans/FER-282.md",
  lineStart: 12,
  lineEnd: 18,
  summary: "The Spec assigns review and publication to one step.",
} as const;

const FINDING = {
  criterion: "architecture",
  artifactLocation: {
    section: "Changes",
    lineStart: 12,
    lineEnd: 18,
  },
  evidence: [
    ARTIFACT_CITATION,
    {
      source: "code",
      path: "lib/spec/spec.ts",
      lineStart: 70,
      lineEnd: null,
      summary: "The Spec operation already ends before publication.",
    },
  ],
  problem: "The plan gives publication policy to the domain operation.",
  requiredOutcome: "Keep publication in the later execution consumer.",
} as const;

const APPROVED = {
  outcome: "approved",
  rationale: "The Spec is grounded, bounded, and verifiable.",
  evidence: [
    {
      source: "code",
      path: "lib/spec/spec.ts",
      lineStart: 69,
      lineEnd: 118,
      summary: "The operation uses the shared Agent boundary and validates one artifact.",
    },
  ],
  findings: [],
} as const;

const CHANGES_REQUESTED = {
  outcome: "changes-requested",
  rationale: "One ownership boundary needs correction.",
  evidence: [],
  findings: [FINDING],
} as const;

describe("Spec review schemas", () => {
  it.each([
    ["approval", APPROVED],
    ["changes requested", CHANGES_REQUESTED],
  ])("accepts a valid %s model decision", (_name, decision) => {
    expect(SpecReviewDecisionDraftSchema.safeParse(decision).success).toBe(true);
  });

  it.each([
    ["approval without evidence", { ...APPROVED, evidence: [] }],
    ["approval with findings", { ...APPROVED, findings: [FINDING] }],
    ["changes without findings", { ...CHANGES_REQUESTED, findings: [] }],
    ["changes with top-level evidence", { ...CHANGES_REQUESTED, evidence: [ARTIFACT_CITATION] }],
  ])("rejects %s", (_name, decision) => {
    expect(SpecReviewDecisionDraftSchema.safeParse(decision).success).toBe(false);
  });

  it("keeps trusted fields outside model output", () => {
    expect(
      SpecReviewDecisionDraftSchema.safeParse({
        ...CHANGES_REQUESTED,
        findings: [{ ...FINDING, id: "model-id" }],
      }).success,
    ).toBe(false);
    expect(
      SpecReviewDecisionDraftSchema.safeParse({
        ...APPROVED,
        artifact: { path: "dev/plans/FER-282.md", revision: "a".repeat(40) },
      }).success,
    ).toBe(false);
    expect(
      SpecReviewDecisionDraftSchema.safeParse({
        ...APPROVED,
        provenance: { provider: "codex" },
      }).success,
    ).toBe(false);
  });

  it.each([
    ["work-item path", { ...ARTIFACT_CITATION, source: "work-item", path: "FER-282" }],
    ["missing code path", { ...ARTIFACT_CITATION, source: "code", path: null }],
    ["line end without start", { ...ARTIFACT_CITATION, lineStart: null, lineEnd: 4 }],
    ["reversed line range", { ...ARTIFACT_CITATION, lineStart: 9, lineEnd: 4 }],
    ["non-positive line", { ...ARTIFACT_CITATION, lineStart: 0, lineEnd: null }],
    ["non-portable path", { ...ARTIFACT_CITATION, path: "../FER-282.md" }],
  ])("rejects an invalid citation %s", (_name, citation) => {
    expect(SpecReviewCitationSchema.safeParse(citation).success).toBe(false);
  });

  it("enforces bounded findings, citations, and strings", () => {
    expect(
      SpecReviewDecisionDraftSchema.safeParse({
        ...CHANGES_REQUESTED,
        findings: Array.from({ length: SPEC_REVIEW_MAX_FINDINGS + 1 }, () => FINDING),
      }).success,
    ).toBe(false);
    expect(
      SpecReviewDecisionDraftSchema.safeParse({
        ...CHANGES_REQUESTED,
        findings: [
          {
            ...FINDING,
            evidence: Array.from(
              { length: SPEC_REVIEW_MAX_CITATIONS + 1 },
              () => ARTIFACT_CITATION,
            ),
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      SpecReviewDecisionDraftSchema.safeParse({
        ...APPROVED,
        rationale: "x".repeat(4_001),
      }).success,
    ).toBe(false);
  });

  it("validates portable artifact paths and exact Git revisions", () => {
    expect(
      SpecReviewArtifactSchema.safeParse({
        path: "dev/plans/FER-282.md",
        revision: "a".repeat(40),
      }).success,
    ).toBe(true);
    expect(
      SpecReviewArtifactSchema.safeParse({
        path: "/dev/plans/FER-282.md",
        revision: "a".repeat(39),
      }).success,
    ).toBe(false);
  });

  it("keeps the trusted decision distinct from the provider draft", () => {
    const trusted = {
      outcome: "changes-requested",
      rationale: CHANGES_REQUESTED.rationale,
      findings: [
        {
          ...FINDING,
          id: `spec-review-finding-${"a".repeat(64)}`,
        },
      ],
    };

    expect(SpecReviewDecisionSchema.safeParse(trusted).success).toBe(true);
    expect(SpecReviewDecisionDraftSchema.safeParse(trusted).success).toBe(false);
  });
});

describe("exported Spec review result JSON schema", () => {
  it("is Codex-strict and requires every provider field", () => {
    expect(SPEC_REVIEW_RESULT_SCHEMA_VERSION).toBe("1");
    expect(() => assertCodexStrictSchema(JSON_SCHEMA)).not.toThrow();
    expect(JSON_SCHEMA.required).toEqual(["outcome", "rationale", "evidence", "findings"]);
  });

  it.each([
    ["approval", APPROVED],
    ["changes requested", CHANGES_REQUESTED],
  ])("stays structurally aligned with Zod for %s", (_name, decision) => {
    expect(schemaAccepts(JSON_SCHEMA, decision)).toBe(true);
    expect(SpecReviewDecisionDraftSchema.safeParse(decision).success).toBe(true);
  });

  it.each([
    ["extra root field", { ...APPROVED, artifact: {} }],
    ["extra finding field", { ...CHANGES_REQUESTED, findings: [{ ...FINDING, id: "x" }] }],
    [
      "too many findings",
      {
        ...CHANGES_REQUESTED,
        findings: Array.from({ length: SPEC_REVIEW_MAX_FINDINGS + 1 }, () => FINDING),
      },
    ],
    ["overlong rationale", { ...APPROVED, rationale: "x".repeat(4_001) }],
  ])("rejects %s in both provider schemas", (_name, decision) => {
    expect(schemaAccepts(JSON_SCHEMA, decision)).toBe(false);
    expect(SpecReviewDecisionDraftSchema.safeParse(decision).success).toBe(false);
  });

  it("leaves cross-field outcome policy to Zod", () => {
    const decision = { ...APPROVED, evidence: [] };

    expect(schemaAccepts(JSON_SCHEMA, decision)).toBe(true);
    expect(SpecReviewDecisionDraftSchema.safeParse(decision).success).toBe(false);
  });
});
