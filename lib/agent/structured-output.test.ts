import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { parseStructuredOutput, type JsonSchema } from "./structured-output.ts";

const MODULE_ROOT = dirname(fileURLToPath(import.meta.url));
const REVIEW_SCHEMA_PATH = join(MODULE_ROOT, "../../schemas/review-output.schema.json");
const REVIEW_SCHEMA = JSON.parse(readFileSync(REVIEW_SCHEMA_PATH, "utf8")) as JsonSchema;

const MINIMAL_REVIEW = {
  verdict: "pass",
  summary: "ok",
  findings: [],
} satisfies Record<string, unknown>;

const REVIEW_WITH_FINDING = {
  verdict: "needs_changes",
  summary: "one issue",
  findings: [
    {
      title: "missing test",
      severity: "Medium",
      location: "structured-output.ts",
      issue: "no regression test",
      recommendation: "add test",
      rationale: "coverage",
      must_fix: false,
    },
  ],
};

test("parseStructuredOutput parses pure JSON object", () => {
  expect(parseStructuredOutput(JSON.stringify(MINIMAL_REVIEW), REVIEW_SCHEMA)).toEqual({
    value: MINIMAL_REVIEW,
  });
});

test("parseStructuredOutput parses fenced JSON", () => {
  expect(
    parseStructuredOutput(`\`\`\`json\n${JSON.stringify(MINIMAL_REVIEW)}\n\`\`\``, REVIEW_SCHEMA),
  ).toEqual({ value: MINIMAL_REVIEW });
});

test("parseStructuredOutput recovers JSON when agent prepends prose", () => {
  const text = `Analysis complete.\n\n${JSON.stringify(MINIMAL_REVIEW)}`;
  expect(parseStructuredOutput(text, REVIEW_SCHEMA)).toEqual({ value: MINIMAL_REVIEW });
});

test("parseStructuredOutput recovers top-level review when findings contain nested objects", () => {
  const text = `Here is my review.\n\n${JSON.stringify(REVIEW_WITH_FINDING)}`;
  const result = parseStructuredOutput(text, REVIEW_SCHEMA);
  expect(result.value).toEqual(REVIEW_WITH_FINDING);
  expect((result.value as typeof REVIEW_WITH_FINDING).findings).toHaveLength(1);
});

test("parseStructuredOutput prefers last schema-valid object among multiple", () => {
  const draft = { verdict: "pass", summary: "draft", findings: [] };
  const finalReview = MINIMAL_REVIEW;
  const text = `log: ${JSON.stringify(draft)}\nfinal: ${JSON.stringify(finalReview)}`;
  expect(parseStructuredOutput(text, REVIEW_SCHEMA)).toEqual({ value: finalReview });
});

test("parseStructuredOutput parses trailing prose after JSON", () => {
  const text = `${JSON.stringify(MINIMAL_REVIEW)}\n\nDone!`;
  expect(parseStructuredOutput(text, REVIEW_SCHEMA)).toEqual({ value: MINIMAL_REVIEW });
});

test("parseStructuredOutput parses array-root schemas", () => {
  const arraySchema: JsonSchema = {
    type: "array",
    items: { type: "string" },
  };
  expect(parseStructuredOutput('["a","b"]', arraySchema)).toEqual({ value: ["a", "b"] });
});

test("parseStructuredOutput returns schema validation errors for invalid enum values", () => {
  const schema: JsonSchema = {
    type: "object",
    required: ["verdict"],
    properties: {
      verdict: { enum: ["pass", "fail"] },
    },
  };
  expect(parseStructuredOutput('{"verdict":"maybe"}', schema).error).toMatch(/expected one of/);
});

test("parseStructuredOutput returns schema errors for prose-wrapped invalid JSON", () => {
  const schema: JsonSchema = {
    type: "object",
    required: ["verdict"],
    properties: {
      verdict: { enum: ["pass", "fail"] },
    },
  };
  const result = parseStructuredOutput('Here is JSON:\n{"verdict":"maybe"}', schema);
  expect(result.error).toMatch(/did not match schema|expected one of/);
  expect(result.error).not.toMatch(/Unexpected token/i);
});

test("parseStructuredOutput returns schema errors for trailing prose after invalid JSON", () => {
  const schema: JsonSchema = {
    type: "object",
    required: ["verdict"],
    properties: {
      verdict: { enum: ["pass", "fail"] },
    },
  };
  const result = parseStructuredOutput('{"verdict":"maybe"}\n\nDone!', schema);
  expect(result.error).toMatch(/did not match schema|expected one of/);
  expect(result.error).not.toMatch(/Unexpected token/i);
});

test("parseStructuredOutput returns schema validation errors for unexpected properties", () => {
  const schema: JsonSchema = {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "findings"],
    properties: {
      verdict: { enum: ["pass", "needs_changes"] },
      findings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title"],
          properties: {
            title: { type: "string" },
          },
        },
      },
    },
  };

  expect(
    parseStructuredOutput('{"verdict":"pass","findings":[{"title":"ok","extra":"nope"}]}', schema)
      .error,
  ).toMatch(/unexpected property "extra"/);
});

test("parseStructuredOutput returns error when no JSON is present", () => {
  expect(parseStructuredOutput("just prose", REVIEW_SCHEMA).error).toMatch(/not valid JSON/i);
});

test("parseStructuredOutput without schema uses rightmost extraction", () => {
  const text = 'noise {"step":1} tail {"step":2}';
  expect(parseStructuredOutput(text, undefined)).toEqual({ value: { step: 2 } });
});

test("parseStructuredOutput without schema prefers rightmost root across object and array", () => {
  const text = '{"x":1} trailing [1,2,3]';
  expect(parseStructuredOutput(text, undefined)).toEqual({ value: [1, 2, 3] });
});

test("parseStructuredOutput without schema accepts prose finals", () => {
  expect(parseStructuredOutput("Appended `# smoke` to tracked.txt.", undefined)).toEqual({
    value: undefined,
  });
});

test("parseStructuredOutput parses fenced JSON with trailing prose", () => {
  const text = `\`\`\`json\n${JSON.stringify(MINIMAL_REVIEW)}\n\`\`\`\n\nDone!`;
  expect(parseStructuredOutput(text, REVIEW_SCHEMA)).toEqual({ value: MINIMAL_REVIEW });
});

test("parseStructuredOutput parses array-root schemas after prose and draft object", () => {
  const arraySchema: JsonSchema = {
    type: "array",
    items: { type: "string" },
  };
  const text = 'note {"draft":true} final ["a","b"]';
  expect(parseStructuredOutput(text, arraySchema)).toEqual({ value: ["a", "b"] });
});

test("parseStructuredOutput handles braces inside strings in prose-wrapped JSON", () => {
  const payload = { verdict: "pass", summary: "mentions {not real}", findings: [] };
  const text = `prefix ${JSON.stringify(payload)}`;
  expect(parseStructuredOutput(text, REVIEW_SCHEMA)).toEqual({ value: payload });
});

test("parseStructuredOutput reports syntax error before nested-object schema miss", () => {
  const text = `{"verdict":"needs_changes","summary":"issue","findings":[{"title":"bad","severity":"Medium","location":"x","issue":"line1
line2","recommendation":"fix","rationale":"r","must_fix":false}]}`;
  const result = parseStructuredOutput(text, REVIEW_SCHEMA);
  expect(result.error).toMatch(/not valid JSON|Bad control character/i);
  expect(result.error).not.toMatch(/missing required property "verdict"/);
});
