// Harness JSON Schema subset — not a full JSON Schema validator.
// Supports: type, enum, anyOf, required, properties, additionalProperties,
// items, minLength, maxLength, pattern, minItems, maxItems, minimum, maximum.

import { readFileSync } from "node:fs";

type JsonTypeName = "string" | "number" | "integer" | "boolean" | "object" | "array" | "null";

export type JsonSchema = {
  type?: JsonTypeName | JsonTypeName[];
  enum?: readonly unknown[];
  anyOf?: readonly JsonSchema[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
};

export function loadSchema(options: {
  schemaJson?: string;
  schemaPath?: string;
}): JsonSchema | undefined {
  if (options.schemaJson) {
    return JSON.parse(options.schemaJson);
  }
  if (options.schemaPath) {
    return JSON.parse(readFileSync(options.schemaPath, "utf8"));
  }
  return undefined;
}

export function validateJsonSchema(
  value: unknown,
  schema: JsonSchema,
  path: string,
): string | undefined {
  if (!schema || typeof schema !== "object") return undefined;

  if (
    schema.anyOf &&
    !schema.anyOf.some((variant) => validateJsonSchema(value, variant, path) === undefined)
  ) {
    return `${path}: did not match any allowed schema`;
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return `${path}: expected one of ${JSON.stringify(schema.enum)}`;
  }

  const types = schema.type
    ? Array.isArray(schema.type)
      ? schema.type
      : [schema.type]
    : undefined;

  if (types && !types.some((type) => jsonTypeMatches(type, value))) {
    return `${path}: expected ${types.join("|")}, got ${jsonTypeOf(value)}`;
  }

  if (
    typeof value === "string" &&
    schema.minLength !== undefined &&
    value.length < schema.minLength
  ) {
    return `${path}: expected string length >= ${schema.minLength}`;
  }
  if (
    typeof value === "string" &&
    schema.maxLength !== undefined &&
    value.length > schema.maxLength
  ) {
    return `${path}: expected string length <= ${schema.maxLength}`;
  }
  if (typeof value === "string" && schema.pattern !== undefined) {
    const expression = new RegExp(schema.pattern);
    if (!expression.test(value)) {
      return `${path}: expected string to match ${schema.pattern}`;
    }
  }

  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    return `${path}: expected number >= ${schema.minimum}`;
  }
  if (typeof value === "number" && schema.maximum !== undefined && value > schema.maximum) {
    return `${path}: expected number <= ${schema.maximum}`;
  }

  if (schema.type === "object" || (types && types.includes("object"))) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return `${path}: expected object`;
    }
    const objectValue = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in objectValue)) return `${path}: missing required property "${key}"`;
    }
    for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
      if (key in objectValue) {
        const childError = validateJsonSchema(objectValue[key], propSchema, `${path}.${key}`);
        if (childError) return childError;
      }
    }
    const propertySchemas = schema.properties ?? {};
    for (const key of Object.keys(objectValue)) {
      if (key in propertySchemas) continue;
      if (schema.additionalProperties === false) {
        return `${path}: unexpected property "${key}"`;
      }
      if (typeof schema.additionalProperties === "object") {
        const childError = validateJsonSchema(
          objectValue[key],
          schema.additionalProperties,
          `${path}.${key}`,
        );
        if (childError) return childError;
      }
    }
  }

  if (schema.type === "array" || (types && types.includes("array"))) {
    if (!Array.isArray(value)) return `${path}: expected array`;
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      return `${path}: expected array length >= ${schema.minItems}`;
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      return `${path}: expected array length <= ${schema.maxItems}`;
    }
    if (schema.items) {
      for (let index = 0; index < value.length; index += 1) {
        const childError = validateJsonSchema(value[index], schema.items, `${path}[${index}]`);
        if (childError) return childError;
      }
    }
  }

  return undefined;
}

export function schemaAccepts(schema: JsonSchema, value: unknown): boolean {
  return validateJsonSchema(value, schema, "$") === undefined;
}

export function assertCodexStrictSchema(schema: JsonSchema, path = "$"): void {
  const properties = schema.properties ?? {};
  if (isObjectSchema(schema) && Object.keys(properties).length > 0) {
    if (schema.additionalProperties !== false) {
      throw new Error(`${path}: object schemas must set additionalProperties=false`);
    }

    const required = new Set(schema.required ?? []);
    const missing = Object.keys(properties).filter((key) => !required.has(key));
    if (missing.length > 0) {
      throw new Error(`${path}: properties missing from required: ${missing.join(", ")}`);
    }
  }

  for (const [key, propertySchema] of Object.entries(properties)) {
    assertCodexStrictSchema(propertySchema, `${path}.${key}`);
  }

  if (schema.items) {
    assertCodexStrictSchema(schema.items, `${path}[]`);
  }

  for (const [index, variant] of (schema.anyOf ?? []).entries()) {
    assertCodexStrictSchema(variant, `${path}.anyOf[${index}]`);
  }

  if (typeof schema.additionalProperties === "object") {
    assertCodexStrictSchema(schema.additionalProperties, `${path}.*`);
  }
}

function jsonTypeOf(value: unknown): JsonTypeName {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    default:
      return "object";
  }
}

function jsonTypeMatches(type: JsonTypeName, value: unknown): boolean {
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  return type === jsonTypeOf(value);
}

function isObjectSchema(schema: JsonSchema): boolean {
  const types = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : [];
  return types.includes("object") || schema.properties !== undefined;
}
