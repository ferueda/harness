import { expect, test } from "vitest";
import { assertCodexStrictSchema } from "./schema-validation.ts";

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
