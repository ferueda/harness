import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { FactoryTriageOutputSchema, parseFactoryTriageOutput } from "../lib/factory-schemas.ts";
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
    ]),
  );
  expect(FACTORY_SCHEMA.required).toHaveLength(6);
  expect(FACTORY_SCHEMA.additionalProperties).toBe(false);
  expect(FACTORY_SCHEMA.properties?.route?.enum).toEqual([
    "ready-to-implement",
    "ready-to-plan",
    "needs-info",
    "wait-to-implement",
  ]);
  expect(FACTORY_SCHEMA.properties?.suggestedNext).toBeUndefined();
});

test("valid ready-to-plan payload passes JSON schema and Zod", () => {
  expect(schemaAccepts(FACTORY_SCHEMA, VALID_READY_TO_PLAN)).toBe(true);
  expect(FactoryTriageOutputSchema.safeParse(VALID_READY_TO_PLAN).success).toBe(true);
});

test("empty evidence fails JSON schema and Zod", () => {
  const payload = { ...VALID_READY_TO_PLAN, evidence: [] };

  expect(schemaAccepts(FACTORY_SCHEMA, payload)).toBe(false);
  expect(FactoryTriageOutputSchema.safeParse(payload).success).toBe(false);
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

test("factory triage contracts reject model-owned next actions", () => {
  const payload = {
    ...VALID_READY_TO_PLAN,
    suggestedNext: { action: "create-plan", command: null, artifact: null },
  };
  expect(schemaAccepts(FACTORY_SCHEMA, payload)).toBe(false);
  expect(FactoryTriageOutputSchema.safeParse(payload).success).toBe(false);
  expect(() => parseFactoryTriageOutput(payload)).toThrow(/Invalid factory triage output/);
});

test("required nullable fields fail when omitted", () => {
  for (const payload of [
    omit(VALID_READY_TO_PLAN, "questions"),
    omit(VALID_READY_TO_PLAN, "reconsiderWhen"),
    {
      ...VALID_READY_TO_PLAN,
      evidence: [omit(VALID_READY_TO_PLAN.evidence[0], "path")],
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
  ]) {
    expect(schemaAccepts(FACTORY_SCHEMA, payload)).toBe(false);
    expect(FactoryTriageOutputSchema.safeParse(payload).success).toBe(false);
  }
});

test("wait-to-implement requires non-null reconsiderWhen in Zod", () => {
  const nullPayload = {
    ...VALID_READY_TO_PLAN,
    route: "wait-to-implement",
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
