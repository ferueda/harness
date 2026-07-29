import { expect, test } from "vitest";
import { assertCodexStrictSchema, validateJsonSchema } from "./json-schema.ts";

test("validateJsonSchema enforces minItems", () => {
  const schema = { type: "array", minItems: 1 } as const;

  expect(validateJsonSchema([], schema, "$.evidence")).toBe(
    "$.evidence: expected array length >= 1",
  );
  expect(validateJsonSchema(["tracker"], schema, "$.evidence")).toBeUndefined();
});

test("validateJsonSchema enforces upper and numeric bounds", () => {
  expect(validateJsonSchema("long", { type: "string", maxLength: 3 }, "$.summary")).toBe(
    "$.summary: expected string length <= 3",
  );
  expect(validateJsonSchema([1, 2], { type: "array", maxItems: 1 }, "$.findings")).toBe(
    "$.findings: expected array length <= 1",
  );
  expect(validateJsonSchema(0, { type: "number", minimum: 1 }, "$.line")).toBe(
    "$.line: expected number >= 1",
  );
  expect(validateJsonSchema(3, { type: "number", maximum: 2 }, "$.line")).toBe(
    "$.line: expected number <= 2",
  );
  expect(validateJsonSchema(1.5, { type: "integer" }, "$.line")).toBe(
    "$.line: expected integer, got number",
  );
});

test("validateJsonSchema enforces string patterns", () => {
  expect(validateJsonSchema(" \n", { type: "string", pattern: "\\S" }, "$.summary")).toBe(
    "$.summary: expected string to match \\S",
  );
  expect(
    validateJsonSchema("Implemented the change.", { type: "string", pattern: "\\S" }, "$.summary"),
  ).toBeUndefined();
});

test("validateJsonSchema accepts one matching anyOf variant", () => {
  const schema = {
    anyOf: [{ type: "string", enum: ["code"] }, { type: "null" }],
  } as const;

  expect(validateJsonSchema("code", schema, "$.path")).toBeUndefined();
  expect(validateJsonSchema(null, schema, "$.path")).toBeUndefined();
  expect(validateJsonSchema("docs", schema, "$.path")).toBe(
    "$.path: did not match any allowed schema",
  );
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

test("assertCodexStrictSchema checks object schemas inside anyOf", () => {
  expect(() =>
    assertCodexStrictSchema({
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["kind"],
          properties: {
            kind: { type: "string" },
            path: { type: "string" },
          },
        },
      ],
    }),
  ).toThrow("$.anyOf[0]: properties missing from required: path");
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
