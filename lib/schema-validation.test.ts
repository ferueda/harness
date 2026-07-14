import { expect, test } from "vitest";
import { assertCodexStrictSchema, validateJsonSchema } from "./schema-validation.ts";

test("validateJsonSchema enforces minItems", () => {
  const schema = { type: "array", minItems: 1 } as const;

  expect(validateJsonSchema([], schema, "$.evidence")).toBe(
    "$.evidence: expected array length >= 1",
  );
  expect(validateJsonSchema(["tracker"], schema, "$.evidence")).toBeUndefined();
});

test("assertCodexStrictSchema rejects object properties omitted from required", () => {
  expect(() =>
    assertCodexStrictSchema({
      type: "object",
      additionalProperties: false,
      required: ["verdict"],
      properties: {
        verdict: { type: "string" },
        summary: { type: "string" },
      },
    }),
  ).toThrow("$: properties missing from required: summary");
});

test("assertCodexStrictSchema checks nested object schemas", () => {
  expect(() =>
    assertCodexStrictSchema({
      type: "object",
      additionalProperties: false,
      required: ["findings"],
      properties: {
        findings: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["title"],
            properties: {
              title: { type: "string" },
              rationale: { type: "string" },
            },
          },
        },
      },
    }),
  ).toThrow("$.findings[]: properties missing from required: rationale");
});

test("assertCodexStrictSchema rejects object schemas that allow additional properties", () => {
  expect(() =>
    assertCodexStrictSchema({
      type: "object",
      required: ["verdict"],
      properties: {
        verdict: { type: "string" },
      },
    }),
  ).toThrow("$: object schemas must set additionalProperties=false");
});
