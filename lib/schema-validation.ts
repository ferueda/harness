// Harness JSON Schema subset — not a full JSON Schema validator.
// Supports: type, enum, required, properties, additionalProperties, items.

import { readFileSync } from "node:fs";

type JsonTypeName = "string" | "number" | "boolean" | "object" | "array" | "null";

export type JsonSchema = {
  type?: JsonTypeName | JsonTypeName[];
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
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

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return `${path}: expected one of ${JSON.stringify(schema.enum)}`;
  }

  const types = schema.type
    ? Array.isArray(schema.type)
      ? schema.type
      : [schema.type]
    : undefined;

  if (types && !types.includes(jsonTypeOf(value))) {
    return `${path}: expected ${types.join("|")}, got ${jsonTypeOf(value)}`;
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
