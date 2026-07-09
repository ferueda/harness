import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { ReviewOutputSchema } from "../lib/schemas.ts";
import { assertCodexStrictSchema, loadSchema, schemaAccepts } from "../lib/schema-validation.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REVIEW_SCHEMA_PATH = join(REPO_ROOT, "schemas/review-output.schema.json");
// Parity uses schemaAccepts — subset validator only (see lib/schema-validation.ts header).
const REVIEW_SCHEMA = loadSchema({ schemaPath: REVIEW_SCHEMA_PATH })!;

const FINDING_REQUIRED = [
  "title",
  "severity",
  "location",
  "issue",
  "recommendation",
  "rationale",
  "must_fix",
] as const;

const SEVERITIES = ["Critical", "High", "Medium", "Low"] as const;

const MINIMAL_PASS = {
  verdict: "pass",
  summary: "ok",
  findings: [],
};

function finding(overrides: Partial<Record<(typeof FINDING_REQUIRED)[number], unknown>> = {}) {
  return {
    title: "issue title",
    severity: "Medium",
    location: "file.ts",
    issue: "problem",
    recommendation: "fix it",
    rationale: "because",
    must_fix: false,
    ...overrides,
  };
}

test("review-output JSON schema file defines expected root shape", () => {
  expect(() => assertCodexStrictSchema(REVIEW_SCHEMA)).not.toThrow();
  expect(REVIEW_SCHEMA.required).toEqual(
    expect.arrayContaining(["verdict", "summary", "findings"]),
  );
  expect(REVIEW_SCHEMA.required).toHaveLength(3);
  expect(REVIEW_SCHEMA.additionalProperties).toBe(false);
  expect(REVIEW_SCHEMA.properties?.verdict?.enum).toEqual(["pass", "needs_changes", "blocked"]);
});

test("review-output JSON schema file defines expected finding item shape", () => {
  const item = REVIEW_SCHEMA.properties?.findings?.items;
  expect(item?.additionalProperties).toBe(false);
  expect(item?.required).toEqual(expect.arrayContaining([...FINDING_REQUIRED]));
  expect(item?.required).toHaveLength(FINDING_REQUIRED.length);
  expect(item?.properties?.severity?.enum).toEqual([...SEVERITIES]);

  for (const field of [
    "title",
    "severity",
    "location",
    "issue",
    "recommendation",
    "rationale",
  ] as const) {
    expect(item?.properties?.[field]?.type).toBe("string");
  }
  expect(item?.properties?.must_fix?.type).toBe("boolean");
});

// Inline dual-validator asserts — helpers trigger oxlint vitest(expect-expect).
test("minimal pass payload passes JSON schema and Zod", () => {
  expect(schemaAccepts(REVIEW_SCHEMA, MINIMAL_PASS)).toBe(true);
  expect(ReviewOutputSchema.safeParse(MINIMAL_PASS).success).toBe(true);
});

test("needs_changes verdict passes both validators", () => {
  const payload = { verdict: "needs_changes", summary: "changes required", findings: [] };
  expect(schemaAccepts(REVIEW_SCHEMA, payload)).toBe(true);
  expect(ReviewOutputSchema.safeParse(payload).success).toBe(true);
});

test("blocked verdict passes both validators", () => {
  const payload = { verdict: "blocked", summary: "blocked", findings: [] };
  expect(schemaAccepts(REVIEW_SCHEMA, payload)).toBe(true);
  expect(ReviewOutputSchema.safeParse(payload).success).toBe(true);
});

test("each severity enum passes both validators", () => {
  for (const severity of SEVERITIES) {
    const payload = {
      verdict: "needs_changes",
      summary: `severity ${severity}`,
      findings: [finding({ severity })],
    };
    expect(schemaAccepts(REVIEW_SCHEMA, payload)).toBe(true);
    expect(ReviewOutputSchema.safeParse(payload).success).toBe(true);
  }
});

test("extra top-level property fails both validators", () => {
  const payload = { ...MINIMAL_PASS, extra: "nope" };
  expect(schemaAccepts(REVIEW_SCHEMA, payload)).toBe(false);
  expect(ReviewOutputSchema.safeParse(payload).success).toBe(false);
});

test("extra finding property fails both validators", () => {
  const payload = {
    verdict: "needs_changes",
    summary: "extra field",
    findings: [{ ...finding(), extra: "nope" }],
  };
  expect(schemaAccepts(REVIEW_SCHEMA, payload)).toBe(false);
  expect(ReviewOutputSchema.safeParse(payload).success).toBe(false);
});

test("invalid verdict enum fails both validators", () => {
  const payload = { verdict: "maybe", summary: "bad verdict", findings: [] };
  expect(schemaAccepts(REVIEW_SCHEMA, payload)).toBe(false);
  expect(ReviewOutputSchema.safeParse(payload).success).toBe(false);
});

test("missing summary fails both validators", () => {
  const payload = { verdict: "pass", findings: [] };
  expect(schemaAccepts(REVIEW_SCHEMA, payload)).toBe(false);
  expect(ReviewOutputSchema.safeParse(payload).success).toBe(false);
});

test("must_fix as string fails both validators", () => {
  const payload = {
    verdict: "needs_changes",
    summary: "wrong type",
    findings: [finding({ must_fix: "false" })],
  };
  expect(schemaAccepts(REVIEW_SCHEMA, payload)).toBe(false);
  expect(ReviewOutputSchema.safeParse(payload).success).toBe(false);
});

test("invalid severity enum fails both validators", () => {
  const payload = {
    verdict: "needs_changes",
    summary: "bad severity",
    findings: [finding({ severity: "Urgent" })],
  };
  expect(schemaAccepts(REVIEW_SCHEMA, payload)).toBe(false);
  expect(ReviewOutputSchema.safeParse(payload).success).toBe(false);
});

test("numeric title fails both validators", () => {
  const payload = {
    verdict: "needs_changes",
    summary: "wrong finding type",
    findings: [finding({ title: 42 })],
  };
  expect(schemaAccepts(REVIEW_SCHEMA, payload)).toBe(false);
  expect(ReviewOutputSchema.safeParse(payload).success).toBe(false);
});
