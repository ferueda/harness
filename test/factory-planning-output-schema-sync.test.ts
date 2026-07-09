import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  FACTORY_PLANNING_FINDING_DECISIONS,
  FACTORY_PLANNING_OUTCOMES,
  FactoryPlanningOutputSchema,
} from "../lib/factory-planning-schemas.ts";
import { assertCodexStrictSchema, loadSchema, schemaAccepts } from "../lib/schema-validation.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FACTORY_PLANNING_SCHEMA_PATH = join(REPO_ROOT, "schemas/factory-planning-output.schema.json");
const FACTORY_PLANNING_SCHEMA = loadSchema({ schemaPath: FACTORY_PLANNING_SCHEMA_PATH })!;

const VALID_DRAFT = {
  outcome: "draft-ready",
  summary: "Plan is ready for review.",
  humanQuestions: [],
  findingDecisions: [
    {
      findingId: "spec-001",
      decision: "implement",
      rationale: "The finding identifies a correctness gap.",
    },
  ],
};

const VALID_NEEDS_HUMAN = {
  outcome: "needs-human",
  summary: "The request has an unresolved product choice.",
  humanQuestions: ["Which export format should be canonical?"],
  findingDecisions: [],
};

test("factory planning JSON schema file defines expected root shape", () => {
  expect(FACTORY_PLANNING_SCHEMA.additionalProperties).toBe(false);
  expect(() => assertCodexStrictSchema(FACTORY_PLANNING_SCHEMA)).not.toThrow();
  expect(FACTORY_PLANNING_SCHEMA.properties?.outcome?.enum).toEqual([...FACTORY_PLANNING_OUTCOMES]);
  expect(
    FACTORY_PLANNING_SCHEMA.properties?.findingDecisions?.items?.properties?.decision?.enum,
  ).toEqual([...FACTORY_PLANNING_FINDING_DECISIONS]);
  expect(FACTORY_PLANNING_SCHEMA.properties?.shortSlug).toBeUndefined();
  expect(FACTORY_PLANNING_SCHEMA.properties?.planMarkdown).toBeUndefined();
  expect(FACTORY_PLANNING_SCHEMA.properties?.findingDecisions?.items?.additionalProperties).toBe(
    false,
  );
});

test("valid draft payload passes JSON schema and Zod", () => {
  expect(schemaAccepts(FACTORY_PLANNING_SCHEMA, VALID_DRAFT)).toBe(true);
  expect(FactoryPlanningOutputSchema.safeParse(VALID_DRAFT).success).toBe(true);
});

test("valid needs-human payload passes JSON schema and Zod", () => {
  expect(schemaAccepts(FACTORY_PLANNING_SCHEMA, VALID_NEEDS_HUMAN)).toBe(true);
  expect(FactoryPlanningOutputSchema.safeParse(VALID_NEEDS_HUMAN).success).toBe(true);
});

test("extra field fails JSON schema and Zod", () => {
  const payload = { ...VALID_DRAFT, extra: true };
  expect(schemaAccepts(FACTORY_PLANNING_SCHEMA, payload)).toBe(false);
  expect(FactoryPlanningOutputSchema.safeParse(payload).success).toBe(false);
});

test("invalid decision enum fails JSON schema and Zod", () => {
  const payload = {
    ...VALID_DRAFT,
    findingDecisions: [{ findingId: "spec-001", decision: "ignore", rationale: "Nope." }],
  };
  expect(schemaAccepts(FACTORY_PLANNING_SCHEMA, payload)).toBe(false);
  expect(FactoryPlanningOutputSchema.safeParse(payload).success).toBe(false);
});

test("empty summary fails JSON schema and Zod", () => {
  const payload = { ...VALID_DRAFT, summary: "" };
  expect(schemaAccepts(FACTORY_PLANNING_SCHEMA, payload)).toBe(false);
  expect(FactoryPlanningOutputSchema.safeParse(payload).success).toBe(false);
});

test("needs-human with no questions is rejected by Zod", () => {
  const payload = { ...VALID_NEEDS_HUMAN, humanQuestions: [] };
  expect(schemaAccepts(FACTORY_PLANNING_SCHEMA, payload)).toBe(true);
  expect(FactoryPlanningOutputSchema.safeParse(payload).success).toBe(false);
});

test("missing arrays are rejected by JSON schema and Zod", () => {
  const payload = { outcome: "draft-ready", summary: "Plan is ready for review." };
  expect(schemaAccepts(FACTORY_PLANNING_SCHEMA, payload)).toBe(false);
  expect(FactoryPlanningOutputSchema.safeParse(payload).success).toBe(false);
});

test("empty strings fail JSON schema and Zod", () => {
  const payload = {
    ...VALID_DRAFT,
    humanQuestions: [""],
    findingDecisions: [{ findingId: "", decision: "implement", rationale: "" }],
  };
  expect(schemaAccepts(FACTORY_PLANNING_SCHEMA, payload)).toBe(false);
  expect(FactoryPlanningOutputSchema.safeParse(payload).success).toBe(false);
});
