import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertCodexStrictSchema, loadSchema, schemaAccepts } from "../agent/json-schema.ts";
import { IMPLEMENTATION_RESULT_SCHEMA_VERSION, ImplementationDecisionSchema } from "./schema.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const JSON_SCHEMA_PATH = join(REPO_ROOT, "schemas/implementation-result.schema.json");
const JSON_SCHEMA = loadSchema({ schemaPath: JSON_SCHEMA_PATH })!;

const IMPLEMENTED = {
  outcome: "implemented",
  summary: "Added the provider-neutral implementation operation.",
  proof: [
    {
      action: "Run focused implementation tests",
      status: "passed",
      observedResult: "All focused tests passed.",
    },
  ],
  remainingUncertainty: [],
  questions: [],
};

const NEEDS_INPUT = {
  outcome: "needs-input",
  summary: "Two accepted requirements prescribe incompatible public APIs.",
  proof: [],
  remainingUncertainty: [],
  questions: ["Which public API supersedes the other?"],
};

describe("implementation decision schema", () => {
  it.each([
    ["implemented", IMPLEMENTED],
    ["implemented with a reported proof limit", limitedImplementation()],
    ["needs input", NEEDS_INPUT],
  ])("accepts a valid %s decision", (_name, decision) => {
    expect(ImplementationDecisionSchema.safeParse(decision).success).toBe(true);
  });

  it.each([
    ["no proof", { ...IMPLEMENTED, proof: [] }],
    ["questions", { ...IMPLEMENTED, questions: ["Should this ship?"] }],
    [
      "failed proof without uncertainty",
      {
        ...IMPLEMENTED,
        proof: [{ ...IMPLEMENTED.proof[0], status: "failed" }],
      },
    ],
    [
      "skipped proof without uncertainty",
      {
        ...IMPLEMENTED,
        proof: [{ ...IMPLEMENTED.proof[0], status: "skipped" }],
      },
    ],
    ["an extra field", { ...IMPLEMENTED, confidence: "high" }],
  ])("rejects implemented with %s", (_name, decision) => {
    expect(ImplementationDecisionSchema.safeParse(decision).success).toBe(false);
  });

  it.each([
    ["proof", { ...NEEDS_INPUT, proof: IMPLEMENTED.proof }],
    ["uncertainty", { ...NEEDS_INPUT, remainingUncertainty: ["Still blocked."] }],
    ["no questions", { ...NEEDS_INPUT, questions: [] }],
  ])("rejects needs-input with %s", (_name, decision) => {
    expect(ImplementationDecisionSchema.safeParse(decision).success).toBe(false);
  });
});

describe("exported implementation result JSON schema", () => {
  it("is strict and exposes every provider field", () => {
    expect(IMPLEMENTATION_RESULT_SCHEMA_VERSION).toBe("1");
    expect(() => assertCodexStrictSchema(JSON_SCHEMA)).not.toThrow();
    expect(JSON_SCHEMA.additionalProperties).toBe(false);
    expect(JSON_SCHEMA.required).toEqual([
      "outcome",
      "summary",
      "proof",
      "remainingUncertainty",
      "questions",
    ]);
  });

  it.each([
    ["implemented", IMPLEMENTED],
    ["implemented with proof limits", limitedImplementation()],
    ["needs input", NEEDS_INPUT],
  ])("stays structurally aligned with Zod for %s", (_name, decision) => {
    expect(schemaAccepts(JSON_SCHEMA, decision)).toBe(true);
    expect(ImplementationDecisionSchema.safeParse(decision).success).toBe(true);
  });

  it.each([
    ["an invalid outcome", { ...IMPLEMENTED, outcome: "completed" }],
    ["an incomplete proof", { ...IMPLEMENTED, proof: [{ action: "Run tests" }] }],
    ["an extra property", { ...IMPLEMENTED, confidence: "high" }],
  ])("rejects structural mismatch in both schemas: %s", (_name, decision) => {
    expect(schemaAccepts(JSON_SCHEMA, decision)).toBe(false);
    expect(ImplementationDecisionSchema.safeParse(decision).success).toBe(false);
  });

  it("leaves branch policy to Zod", () => {
    const decision = { ...IMPLEMENTED, proof: [] };

    expect(schemaAccepts(JSON_SCHEMA, decision)).toBe(true);
    expect(ImplementationDecisionSchema.safeParse(decision).success).toBe(false);
  });
});

function limitedImplementation() {
  return {
    ...IMPLEMENTED,
    proof: [
      {
        action: "Run the canonical gate",
        status: "skipped",
        observedResult: "The repository does not define a canonical gate.",
      },
    ],
    remainingUncertainty: ["General repository health was not independently verified."],
  };
}
