import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  createFactoryOperationRef,
  FactoryOperationReceiptSchema,
} from "../lib/factory-operation.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(
  readFileSync(join(root, "schemas/factory-operation-receipt.schema.json"), "utf8"),
) as {
  $defs: Record<
    "operation" | "request",
    { additionalProperties: boolean; required: string[]; properties: Record<string, unknown> }
  >;
  oneOf: Array<{
    additionalProperties: boolean;
    required: string[];
    properties: Record<string, unknown> & {
      outcome: { const?: string; enum?: string[] };
    };
  }>;
};
const operation = createFactoryOperationRef({
  phaseRunId: "phase-1",
  handler: "triageWorkItem",
  attempt: 1,
  causationEventId: "requested-1",
});
const common = { version: 1, projectId: "project-1", workItemKey: "linear:ITEM-1", operation };

test("JSON Schema declares the same closed receipt outcomes", () => {
  expect(schema.oneOf).toHaveLength(3);
  expect(schema.oneOf.every((variant) => variant.additionalProperties === false)).toBe(true);
  expect(
    schema.oneOf.flatMap(
      (variant) => variant.properties.outcome.enum ?? [variant.properties.outcome.const!],
    ),
  ).toEqual(["executed", "recovered", "stale", "waiting"]);
  expect(
    schema.oneOf.map((variant) => ({
      outcomes: variant.properties.outcome.enum ?? [variant.properties.outcome.const!],
      required: [...variant.required].sort(),
      properties: Object.keys(variant.properties).sort(),
    })),
  ).toEqual([
    {
      outcomes: ["executed", "recovered"],
      required: ["operation", "outcome", "projectId", "resultEventId", "version", "workItemKey"],
      properties: [
        "next",
        "operation",
        "outcome",
        "projectId",
        "resultEventId",
        "version",
        "workItemKey",
      ],
    },
    {
      outcomes: ["stale"],
      required: ["observedEventId", "operation", "outcome", "projectId", "version", "workItemKey"],
      properties: [
        "observedEventId",
        "operation",
        "outcome",
        "projectId",
        "version",
        "workItemKey",
      ],
    },
    {
      outcomes: ["waiting"],
      required: [
        "observedEventId",
        "operation",
        "outcome",
        "projectId",
        "reason",
        "version",
        "workItemKey",
      ],
      properties: [
        "observedEventId",
        "operation",
        "outcome",
        "projectId",
        "reason",
        "version",
        "workItemKey",
      ],
    },
  ]);
  expect(schema.$defs.request.additionalProperties).toBe(false);
  expect(Object.keys(schema.$defs.request.properties).sort()).toEqual([
    "operation",
    "projectId",
    "workItemKey",
  ]);
  expect(schema.$defs.operation.additionalProperties).toBe(false);
});

test.each([
  {
    ...common,
    outcome: "executed",
    resultEventId: "result-1",
    next: { projectId: "project-1", workItemKey: "linear:ITEM-1", operation },
  },
  {
    ...common,
    outcome: "recovered",
    resultEventId: "result-1",
  },
  { ...common, outcome: "stale", observedEventId: "observed-1" },
  { ...common, outcome: "waiting", observedEventId: "observed-1", reason: "human" },
])("JSON Schema and Zod accept $outcome receipts", (receipt) => {
  expect(FactoryOperationReceiptSchema.safeParse(receipt).success).toBe(true);
});

test.each(["workspace", "credential", "baseSha", "lifecycleState", "evidence"])(
  "receipt contracts reject forbidden field %s",
  (field) => {
    const receipt = { ...common, outcome: "stale", observedEventId: "observed-1", [field]: "leak" };
    expect(FactoryOperationReceiptSchema.safeParse(receipt).success).toBe(false);
  },
);

test("stale and waiting receipts cannot carry next", () => {
  for (const receipt of [
    { ...common, outcome: "stale", observedEventId: "observed-1", next: common },
    { ...common, outcome: "waiting", observedEventId: "observed-1", reason: "human", next: common },
  ]) {
    expect(FactoryOperationReceiptSchema.safeParse(receipt).success).toBe(false);
  }
});

test("JSON Schema and Zod reject the same unsafe phase-run ID", () => {
  const phaseRunId = schema.$defs.operation.properties.phaseRunId as { pattern: string };
  expect(new RegExp(phaseRunId.pattern).test("unsafe/phase")).toBe(false);
  expect(
    FactoryOperationReceiptSchema.safeParse({
      ...common,
      operation: { ...operation, phaseRunId: "unsafe/phase" },
      outcome: "stale",
      observedEventId: "observed-1",
    }).success,
  ).toBe(false);
});
