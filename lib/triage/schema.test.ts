import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertCodexStrictSchema, loadSchema, schemaAccepts } from "../schema-validation.ts";
import {
  TRIAGE_DECISION_SCHEMA_VERSION,
  TriageDecisionSchema,
  TriageWorkItemContextSchema,
} from "./schema.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const JSON_SCHEMA_PATH = join(REPO_ROOT, "schemas/triage-decision.schema.json");
const JSON_SCHEMA = loadSchema({ schemaPath: JSON_SCHEMA_PATH })!;

const TRACKER_EVIDENCE = {
  kind: "tracker",
  path: null,
  summary: "The issue asks for one bounded outcome.",
};

const READY_TO_IMPLEMENT = {
  decision: "ready-for-agent",
  scope: "bounded",
  agentAction: "implement",
  summary: "The issue is bounded and specified for implementation.",
  evidence: [TRACKER_EVIDENCE],
  questions: [],
  inputReason: null,
  duplicateOf: null,
  blockedBy: [],
};

const READY_TO_PLAN = {
  ...READY_TO_IMPLEMENT,
  agentAction: "plan",
  summary: "The goal is clear, but repository investigation should come first.",
};

const NEEDS_RESCOPE = {
  ...READY_TO_IMPLEMENT,
  decision: "needs-input",
  scope: "too-broad",
  agentAction: null,
  summary: "The issue contains two independently shippable outcomes.",
  questions: ["Should this issue keep only the first outcome?"],
  inputReason: "rescope",
};

const NEEDS_PRODUCT_DECISION = {
  ...NEEDS_RESCOPE,
  scope: "bounded",
  summary: "The desired user-facing behavior is not specified.",
  questions: ["Should the action be visible to all users?"],
  inputReason: "product-decision",
};

const DUPLICATE = {
  ...READY_TO_IMPLEMENT,
  decision: "duplicate",
  agentAction: null,
  summary: "FER-100 already represents this work.",
  duplicateOf: "FER-100",
};

describe("triage decision schema", () => {
  it.each([
    ["ready to implement", READY_TO_IMPLEMENT],
    ["ready to plan", READY_TO_PLAN],
    ["needs rescope", NEEDS_RESCOPE],
    ["needs a product decision", NEEDS_PRODUCT_DECISION],
    ["duplicate", DUPLICATE],
  ])("accepts a valid %s result", (_name, payload) => {
    expect(TriageDecisionSchema.safeParse(payload).success).toBe(true);
  });

  it("rejects invalid decision names", () => {
    const payload = { ...READY_TO_IMPLEMENT, decision: "backlog" };

    expect(TriageDecisionSchema.safeParse(payload).success).toBe(false);
  });

  it.each([
    ["missing action", { ...READY_TO_IMPLEMENT, agentAction: null }],
    ["questions", { ...READY_TO_IMPLEMENT, questions: ["What should happen?"] }],
    ["input reason", { ...READY_TO_IMPLEMENT, inputReason: "clarification" }],
    ["broad scope", { ...READY_TO_IMPLEMENT, scope: "too-broad" }],
  ])("rejects ready-for-agent with %s", (_name, payload) => {
    expect(TriageDecisionSchema.safeParse(payload).success).toBe(false);
  });

  it.each([
    ["no question", { ...NEEDS_PRODUCT_DECISION, questions: [] }],
    ["no reason", { ...NEEDS_PRODUCT_DECISION, inputReason: null }],
    ["an agent action", { ...NEEDS_PRODUCT_DECISION, agentAction: "plan" }],
    ["a duplicate target", { ...NEEDS_PRODUCT_DECISION, duplicateOf: "FER-100" }],
  ])("rejects needs-input with %s", (_name, payload) => {
    expect(TriageDecisionSchema.safeParse(payload).success).toBe(false);
  });

  it("requires exactly one rescope question for a too-broad issue", () => {
    expect(TriageDecisionSchema.safeParse({ ...NEEDS_RESCOPE, questions: [] }).success).toBe(false);
    expect(
      TriageDecisionSchema.safeParse({
        ...NEEDS_RESCOPE,
        questions: ["Keep the first outcome?", "Keep the second outcome?"],
      }).success,
    ).toBe(false);
  });

  it("keeps rescope exclusive to too-broad issues", () => {
    const payload = { ...NEEDS_PRODUCT_DECISION, inputReason: "rescope" };

    expect(TriageDecisionSchema.safeParse(payload).success).toBe(false);
  });

  it.each([
    ["without a target", { ...DUPLICATE, duplicateOf: null }],
    ["with questions", { ...DUPLICATE, questions: ["Is this a duplicate?"] }],
    ["with an action", { ...DUPLICATE, agentAction: "plan" }],
    ["with a broad scope", { ...DUPLICATE, scope: "too-broad" }],
  ])("rejects a duplicate %s", (_name, payload) => {
    expect(TriageDecisionSchema.safeParse(payload).success).toBe(false);
  });

  it("allows blockers without changing a ready-for-agent decision", () => {
    const result = TriageDecisionSchema.safeParse({
      ...READY_TO_PLAN,
      blockedBy: ["FER-201", "FER-202"],
    });

    expect(result.success).toBe(true);
  });

  it.each([
    [
      "code without a path",
      {
        ...READY_TO_IMPLEMENT,
        evidence: [{ kind: "code", path: null, summary: "Implementation exists." }],
      },
    ],
    [
      "tracker evidence with a path",
      {
        ...READY_TO_IMPLEMENT,
        evidence: [{ kind: "tracker", path: "FER-216", summary: "Issue text." }],
      },
    ],
    [
      "a parent traversal",
      {
        ...READY_TO_IMPLEMENT,
        evidence: [{ kind: "code", path: "../outside.ts", summary: "Unsafe path." }],
      },
    ],
    [
      "an empty path segment",
      {
        ...READY_TO_IMPLEMENT,
        evidence: [{ kind: "docs", path: "docs//intent.md", summary: "Unsafe path." }],
      },
    ],
    [
      "an empty summary",
      {
        ...READY_TO_IMPLEMENT,
        evidence: [{ kind: "test", path: "test/example.test.ts", summary: "" }],
      },
    ],
  ])("rejects invalid evidence: %s", (_name, payload) => {
    expect(TriageDecisionSchema.safeParse(payload).success).toBe(false);
  });
});

describe("triage work-item context schema", () => {
  it("accepts complete source-neutral context", () => {
    expect(TriageWorkItemContextSchema.safeParse(validContext()).success).toBe(true);
  });

  it("requires explicit completeness signals", () => {
    const context = validContext();
    const { linksTruncated: _, ...incomplete } = context.completeness;

    expect(
      TriageWorkItemContextSchema.safeParse({ ...context, completeness: incomplete }).success,
    ).toBe(false);
  });

  it("rejects SDK-shaped or extra fields", () => {
    const context = { ...validContext(), team: { id: "team-fer", name: "Harness" } };

    expect(TriageWorkItemContextSchema.safeParse(context).success).toBe(false);
  });
});

describe("exported triage decision JSON schema", () => {
  it("is strict and defines every required provider field", () => {
    expect(TRIAGE_DECISION_SCHEMA_VERSION).toBe("1");
    expect(() => assertCodexStrictSchema(JSON_SCHEMA)).not.toThrow();
    expect(JSON_SCHEMA.additionalProperties).toBe(false);
    expect(JSON_SCHEMA.required).toEqual([
      "decision",
      "scope",
      "agentAction",
      "summary",
      "evidence",
      "questions",
      "inputReason",
      "duplicateOf",
      "blockedBy",
    ]);
  });

  it.each([
    ["ready to implement", READY_TO_IMPLEMENT],
    ["ready to plan", READY_TO_PLAN],
    ["needs input", NEEDS_PRODUCT_DECISION],
    ["duplicate", DUPLICATE],
  ])("stays structurally aligned with Zod for %s", (_name, payload) => {
    expect(schemaAccepts(JSON_SCHEMA, payload)).toBe(true);
    expect(TriageDecisionSchema.safeParse(payload).success).toBe(true);
  });

  it.each([
    ["an invalid decision", { ...READY_TO_IMPLEMENT, decision: "backlog" }],
    ["empty evidence", { ...READY_TO_IMPLEMENT, evidence: [] }],
    ["an extra property", { ...READY_TO_IMPLEMENT, confidence: "high" }],
    ["an omitted nullable field", omit(READY_TO_IMPLEMENT, "duplicateOf")],
    [
      "an omitted nested nullable field",
      {
        ...READY_TO_IMPLEMENT,
        evidence: [omit(TRACKER_EVIDENCE, "path")],
      },
    ],
  ])("rejects %s in both schemas", (_name, payload) => {
    expect(schemaAccepts(JSON_SCHEMA, payload)).toBe(false);
    expect(TriageDecisionSchema.safeParse(payload).success).toBe(false);
  });

  it("leaves cross-field policy validation to Zod", () => {
    const payload = { ...READY_TO_IMPLEMENT, agentAction: null };

    expect(schemaAccepts(JSON_SCHEMA, payload)).toBe(true);
    expect(TriageDecisionSchema.safeParse(payload).success).toBe(false);
  });
});

function validContext() {
  return {
    id: "issue-216",
    reference: "FER-216",
    title: "Define standalone triage",
    description: "Create a provider-independent triage policy.",
    url: "https://linear.app/issue/FER-216",
    state: "Backlog",
    labels: ["automation"],
    comments: [
      {
        author: "Felipe",
        body: "Keep planning out of Linear.",
        createdAt: "2026-07-19T12:00:00.000Z",
      },
    ],
    parent: null,
    children: [],
    duplicateOf: null,
    blockedBy: [],
    related: [],
    links: [{ title: "Triage example", url: "https://example.com/triage" }],
    createdAt: "2026-07-19T10:00:00.000Z",
    updatedAt: "2026-07-19T12:00:00.000Z",
    completeness: {
      commentsTruncated: false,
      labelsTruncated: false,
      relationsTruncated: false,
      linksTruncated: false,
      childrenTruncated: false,
    },
  };
}

function omit<T extends Record<string, unknown>, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}
