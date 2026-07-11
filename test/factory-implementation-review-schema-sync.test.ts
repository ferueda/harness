import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  FACTORY_REMEDIATION_DECISIONS,
  FactoryImplementationRemediationOutputSchema,
} from "../lib/factory-implementation-review-schemas.ts";
import { assertCodexStrictSchema, loadSchema, schemaAccepts } from "../lib/schema-validation.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA = loadSchema({
  schemaPath: join(REPO_ROOT, "schemas/factory-implementation-remediation-output.schema.json"),
})!;

const VALID_OUTPUT = {
  summary: "No changes needed.",
  findingDecisions: [{ findingId: "finding-1", decision: "decline", rationale: "Advisory only." }],
};

test("factory remediation JSON schema matches the runtime contract", () => {
  expect(() => assertCodexStrictSchema(SCHEMA)).not.toThrow();
  expect(SCHEMA.required).toEqual(["summary", "findingDecisions"]);
  expect(SCHEMA.additionalProperties).toBe(false);
  const item = SCHEMA.properties?.findingDecisions?.items;
  expect(item?.required).toEqual(["findingId", "decision", "rationale"]);
  expect(item?.additionalProperties).toBe(false);
  expect(item?.properties?.decision?.enum).toEqual([...FACTORY_REMEDIATION_DECISIONS]);
  expect(item?.properties?.findingId?.minLength).toBe(1);
  expect(item?.properties?.rationale?.minLength).toBe(1);
});

test("valid and invalid remediation payloads agree across JSON Schema and Zod", () => {
  expect(schemaAccepts(SCHEMA, VALID_OUTPUT)).toBe(true);
  expect(FactoryImplementationRemediationOutputSchema.safeParse(VALID_OUTPUT).success).toBe(true);

  const invalid = {
    ...VALID_OUTPUT,
    findingDecisions: [{ ...VALID_OUTPUT.findingDecisions[0], decision: "ignore" }],
  };
  expect(schemaAccepts(SCHEMA, invalid)).toBe(false);
  expect(FactoryImplementationRemediationOutputSchema.safeParse(invalid).success).toBe(false);
});
