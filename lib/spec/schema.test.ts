import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertCodexStrictSchema, loadSchema, schemaAccepts } from "../agent/json-schema.ts";
import {
  SPEC_RESULT_SCHEMA_VERSION,
  SpecDecisionSchema,
  SpecReviewerDecisionSchema,
  SpecWorkItemContextSchema,
} from "./schema.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const JSON_SCHEMA_PATH = join(REPO_ROOT, "schemas/spec-result.schema.json");
const JSON_SCHEMA = loadSchema({ schemaPath: JSON_SCHEMA_PATH })!;

const REPOSITORY_EVIDENCE = {
  kind: "code",
  path: "lib/agent/contract.ts",
  summary: "The shared Agent contract owns provider-neutral execution.",
};

const REVIEWER_DECISION = {
  question: "Which compatibility boundary should the migration preserve?",
  options: [
    { option: "One-release shim", tradeoffs: "Safer rollout with temporary maintenance." },
    { option: "Atomic cutover", tradeoffs: "Smaller code change with a coordinated release." },
  ],
  recommendation: "Atomic cutover",
  rationale: "The repository has no external compatibility promise.",
};

const READY_FOR_REVIEW = {
  outcome: "ready-for-review",
  artifactPath: "dev/plans/FER-273.md",
  summary: "The Spec recommends a small provider-neutral operation.",
  evidence: [REPOSITORY_EVIDENCE],
  reviewerDecisions: [],
  questions: [],
};

const NEEDS_INPUT = {
  outcome: "needs-input",
  artifactPath: null,
  summary: "Two authoritative intent documents conflict on the required outcome.",
  evidence: [
    { kind: "docs", path: "docs/project-intent.md", summary: "The intent requires one owner." },
  ],
  reviewerDecisions: [],
  questions: ["Which intent source supersedes the other?"],
};

describe("Spec decision schema", () => {
  it.each([
    ["ready for review", READY_FOR_REVIEW],
    [
      "ready with a reviewer decision",
      { ...READY_FOR_REVIEW, reviewerDecisions: [REVIEWER_DECISION] },
    ],
    ["needs input", NEEDS_INPUT],
  ])("accepts a valid %s result", (_name, payload) => {
    expect(SpecDecisionSchema.safeParse(payload).success).toBe(true);
  });

  it.each([
    ["null artifact", { ...READY_FOR_REVIEW, artifactPath: null }],
    ["questions", { ...READY_FOR_REVIEW, questions: ["Choose an option?"] }],
    [
      "tracker-only evidence",
      {
        ...READY_FOR_REVIEW,
        evidence: [{ kind: "tracker", path: null, summary: "The issue requests a Spec." }],
      },
    ],
  ])("rejects ready-for-review with %s", (_name, payload) => {
    expect(SpecDecisionSchema.safeParse(payload).success).toBe(false);
  });

  it.each([
    ["an artifact", { ...NEEDS_INPUT, artifactPath: "dev/plans/FER-273.md" }],
    ["no questions", { ...NEEDS_INPUT, questions: [] }],
    ["reviewer decisions", { ...NEEDS_INPUT, reviewerDecisions: [REVIEWER_DECISION] }],
  ])("rejects needs-input with %s", (_name, payload) => {
    expect(SpecDecisionSchema.safeParse(payload).success).toBe(false);
  });

  it.each([
    ["fewer than two options", { ...REVIEWER_DECISION, options: [REVIEWER_DECISION.options[0]] }],
    [
      "duplicate options",
      {
        ...REVIEWER_DECISION,
        options: [REVIEWER_DECISION.options[0], REVIEWER_DECISION.options[0]],
      },
    ],
    ["an unmatched recommendation", { ...REVIEWER_DECISION, recommendation: "Another option" }],
  ])("rejects a reviewer decision with %s", (_name, payload) => {
    expect(SpecReviewerDecisionSchema.safeParse(payload).success).toBe(false);
  });

  it.each([
    [
      "code without a path",
      { ...READY_FOR_REVIEW, evidence: [{ ...REPOSITORY_EVIDENCE, path: null }] },
    ],
    [
      "tracker evidence with a path",
      {
        ...READY_FOR_REVIEW,
        evidence: [{ kind: "tracker", path: "FER-273", summary: "Issue evidence." }],
      },
    ],
    [
      "a parent traversal",
      { ...READY_FOR_REVIEW, evidence: [{ ...REPOSITORY_EVIDENCE, path: "../outside.ts" }] },
    ],
  ])("rejects invalid evidence: %s", (_name, payload) => {
    expect(SpecDecisionSchema.safeParse(payload).success).toBe(false);
  });
});

describe("Spec work-item context schema", () => {
  it("accepts complete normalized issue context", () => {
    expect(SpecWorkItemContextSchema.safeParse(validContext()).success).toBe(true);
  });

  it("requires an uppercase issue reference", () => {
    expect(
      SpecWorkItemContextSchema.safeParse({ ...validContext(), reference: "fer-273" }).success,
    ).toBe(false);
  });

  it("rejects incomplete or SDK-shaped context", () => {
    const context = validContext();
    const { linksTruncated: _, ...incomplete } = context.completeness;

    expect(
      SpecWorkItemContextSchema.safeParse({ ...context, completeness: incomplete }).success,
    ).toBe(false);
    expect(
      SpecWorkItemContextSchema.safeParse({ ...context, team: { id: "team-fer" } }).success,
    ).toBe(false);
  });
});

describe("exported Spec result JSON schema", () => {
  it("is strict and defines every required provider field", () => {
    expect(SPEC_RESULT_SCHEMA_VERSION).toBe("1");
    expect(() => assertCodexStrictSchema(JSON_SCHEMA)).not.toThrow();
    expect(JSON_SCHEMA.additionalProperties).toBe(false);
    expect(JSON_SCHEMA.required).toEqual([
      "outcome",
      "artifactPath",
      "summary",
      "evidence",
      "reviewerDecisions",
      "questions",
    ]);
  });

  it.each([
    ["ready for review", READY_FOR_REVIEW],
    [
      "ready with reviewer decisions",
      { ...READY_FOR_REVIEW, reviewerDecisions: [REVIEWER_DECISION] },
    ],
    ["needs input", NEEDS_INPUT],
  ])("stays structurally aligned with Zod for %s", (_name, payload) => {
    expect(schemaAccepts(JSON_SCHEMA, payload)).toBe(true);
    expect(SpecDecisionSchema.safeParse(payload).success).toBe(true);
  });

  it.each([
    ["an invalid outcome", { ...READY_FOR_REVIEW, outcome: "draft-ready" }],
    ["empty evidence", { ...READY_FOR_REVIEW, evidence: [] }],
    ["an extra property", { ...READY_FOR_REVIEW, confidence: "high" }],
    ["an omitted nullable field", omit(NEEDS_INPUT, "artifactPath")],
    [
      "an incomplete reviewer option",
      {
        ...READY_FOR_REVIEW,
        reviewerDecisions: [
          {
            ...REVIEWER_DECISION,
            options: [
              omit(REVIEWER_DECISION.options[0], "tradeoffs"),
              REVIEWER_DECISION.options[1],
            ],
          },
        ],
      },
    ],
  ])("rejects %s in both schemas", (_name, payload) => {
    expect(schemaAccepts(JSON_SCHEMA, payload)).toBe(false);
    expect(SpecDecisionSchema.safeParse(payload).success).toBe(false);
  });

  it("leaves cross-field policy validation to Zod", () => {
    const payload = { ...READY_FOR_REVIEW, artifactPath: null };

    expect(schemaAccepts(JSON_SCHEMA, payload)).toBe(true);
    expect(SpecDecisionSchema.safeParse(payload).success).toBe(false);
  });
});

function validContext() {
  return {
    id: "issue-273",
    reference: "FER-273",
    title: "Build a provider-neutral Spec operation",
    description: "Write one code-grounded implementation Spec.",
    url: "https://linear.app/issue/FER-273",
    state: "In Progress",
    labels: ["Spec"],
    comments: [
      {
        author: "Felipe",
        body: "Use dev/plans/FER-273.md.",
        createdAt: "2026-07-22T20:00:00.000Z",
      },
    ],
    parent: null,
    children: [],
    duplicateOf: null,
    blockedBy: [],
    related: [],
    links: [{ title: "Architecture", url: "https://example.com/architecture" }],
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

function omit<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const { [key]: _, ...rest } = value;
  return rest;
}
