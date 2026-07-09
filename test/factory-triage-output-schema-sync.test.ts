import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { FactoryTriageOutputSchema } from "../lib/factory-schemas.ts";
import { assertCodexStrictSchema, loadSchema, schemaAccepts } from "../lib/schema-validation.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FACTORY_SCHEMA_PATH = join(REPO_ROOT, "schemas/factory-triage-output.schema.json");
const FACTORY_SCHEMA = loadSchema({ schemaPath: FACTORY_SCHEMA_PATH })!;

const VALID_READY_TO_PLAN = {
  route: "ready-to-plan",
  confidence: "medium",
  rationale: "The request is aligned but needs planning.",
  evidence: [
    { kind: "docs", path: "docs/project-intent.md", summary: "Factory intake is in scope." },
  ],
  questions: [],
  reconsiderWhen: null,
  suggestedNext: { action: "create-plan", command: null, artifact: null },
};

test("factory triage JSON schema file defines expected root shape", () => {
  expect(() => assertCodexStrictSchema(FACTORY_SCHEMA)).not.toThrow();
  expect(FACTORY_SCHEMA.required).toEqual(
    expect.arrayContaining([
      "route",
      "confidence",
      "rationale",
      "evidence",
      "questions",
      "reconsiderWhen",
      "suggestedNext",
    ]),
  );
  expect(FACTORY_SCHEMA.required).toHaveLength(7);
  expect(FACTORY_SCHEMA.additionalProperties).toBe(false);
  expect(FACTORY_SCHEMA.properties?.route?.enum).toEqual([
    "ready-to-implement",
    "ready-to-plan",
    "needs-info",
    "wait-to-implement",
  ]);
  expect(FACTORY_SCHEMA.properties?.suggestedNext?.properties?.action?.enum).toEqual([
    "implement-directly",
    "create-plan",
    "ask-human",
    "park",
  ]);
});

test("valid ready-to-plan payload passes JSON schema and Zod", () => {
  expect(schemaAccepts(FACTORY_SCHEMA, VALID_READY_TO_PLAN)).toBe(true);
  expect(FactoryTriageOutputSchema.safeParse(VALID_READY_TO_PLAN).success).toBe(true);
});

test("extra top-level property fails JSON schema and Zod", () => {
  const payload = { ...VALID_READY_TO_PLAN, applyLabel: "ready-to-plan" };
  expect(schemaAccepts(FACTORY_SCHEMA, payload)).toBe(false);
  expect(FactoryTriageOutputSchema.safeParse(payload).success).toBe(false);
});

test("invalid route enum fails JSON schema and Zod", () => {
  const payload = { ...VALID_READY_TO_PLAN, route: "ready-to-spec" };
  expect(schemaAccepts(FACTORY_SCHEMA, payload)).toBe(false);
  expect(FactoryTriageOutputSchema.safeParse(payload).success).toBe(false);
});

test("JSON schema can accept cross-field mismatch that Zod rejects", () => {
  const payload = {
    ...VALID_READY_TO_PLAN,
    suggestedNext: { action: "implement-directly", command: null, artifact: null },
  };
  expect(schemaAccepts(FACTORY_SCHEMA, payload)).toBe(true);
  expect(FactoryTriageOutputSchema.safeParse(payload).success).toBe(false);
});

test("legacy omitted nullable fields fail JSON schema and Zod", () => {
  for (const payload of [
    omit(VALID_READY_TO_PLAN, "questions"),
    omit(VALID_READY_TO_PLAN, "reconsiderWhen"),
    {
      ...VALID_READY_TO_PLAN,
      evidence: [omit(VALID_READY_TO_PLAN.evidence[0], "path")],
    },
    {
      ...VALID_READY_TO_PLAN,
      suggestedNext: omit(VALID_READY_TO_PLAN.suggestedNext, "command"),
    },
    {
      ...VALID_READY_TO_PLAN,
      suggestedNext: omit(VALID_READY_TO_PLAN.suggestedNext, "artifact"),
    },
  ]) {
    expect(schemaAccepts(FACTORY_SCHEMA, payload)).toBe(false);
    expect(FactoryTriageOutputSchema.safeParse(payload).success).toBe(false);
  }
});

test("nullable string fields reject empty-string absence markers", () => {
  for (const payload of [
    { ...VALID_READY_TO_PLAN, evidence: [{ ...VALID_READY_TO_PLAN.evidence[0], path: "" }] },
    { ...VALID_READY_TO_PLAN, reconsiderWhen: "" },
    {
      ...VALID_READY_TO_PLAN,
      suggestedNext: { ...VALID_READY_TO_PLAN.suggestedNext, command: "" },
    },
    {
      ...VALID_READY_TO_PLAN,
      suggestedNext: { ...VALID_READY_TO_PLAN.suggestedNext, artifact: "" },
    },
  ]) {
    expect(schemaAccepts(FACTORY_SCHEMA, payload)).toBe(false);
    expect(FactoryTriageOutputSchema.safeParse(payload).success).toBe(false);
  }
});

test("wait-to-implement requires non-null reconsiderWhen in Zod", () => {
  const nullPayload = {
    ...VALID_READY_TO_PLAN,
    route: "wait-to-implement",
    suggestedNext: { action: "park", command: null, artifact: null },
    reconsiderWhen: null,
  };
  const validPayload = {
    ...nullPayload,
    reconsiderWhen: "Roadmap priority changes.",
  };

  expect(schemaAccepts(FACTORY_SCHEMA, nullPayload)).toBe(true);
  expect(FactoryTriageOutputSchema.safeParse(nullPayload).success).toBe(false);
  expect(schemaAccepts(FACTORY_SCHEMA, validPayload)).toBe(true);
  expect(FactoryTriageOutputSchema.safeParse(validPayload).success).toBe(true);
});

function omit<T extends Record<string, unknown>, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}
