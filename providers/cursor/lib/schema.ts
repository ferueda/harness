import { readFileSync } from "node:fs";

type JsonTypeName = "string" | "number" | "boolean" | "object" | "array" | "null";

export type JsonSchema = {
  type?: JsonTypeName | JsonTypeName[];
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
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

export function wrapPrompt(prompt: string, schema: JsonSchema | undefined): string {
  if (!schema) return prompt;

  return [
    "You are running as an automated worker invoked by another agent.",
    "",
    "Hard requirements for your FINAL answer:",
    "- Return ONLY valid JSON. No markdown fences, no prose before or after.",
    "- The JSON must conform to this JSON Schema:",
    JSON.stringify(schema, null, 2),
    "",
    "Original task:",
    prompt,
  ].join("\n");
}

export function extractJsonFromText(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fenced?.[1]) return fenced[1].trim();
  return firstParseableJsonValue(trimmed) ?? trimmed;
}

function firstParseableJsonValue(text: string): string | undefined {
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char !== "{" && char !== "[") continue;
    const end = balancedJsonEnd(text, index);
    if (end === undefined) continue;
    const candidate = text.slice(index, end + 1).trim();
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

function balancedJsonEnd(text: string, start: number): number | undefined {
  const first = text[start];
  const stack = first === "{" ? ["}"] : first === "[" ? ["]"] : [];
  if (stack.length === 0) return undefined;

  let inString = false;
  let escaped = false;

  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") stack.push("}");
    else if (char === "[") stack.push("]");
    else if (char === "}" || char === "]") {
      if (stack.at(-1) !== char) return undefined;
      stack.pop();
      if (stack.length === 0) return index;
    }
  }
  return undefined;
}

export function parseStructuredOutput(
  resultText: string | undefined,
  schema: JsonSchema | undefined,
): {
  value?: unknown;
  error?: string;
} {
  if (!resultText) {
    return { error: "Agent returned no final text to parse as JSON." };
  }

  const jsonText = extractJsonFromText(resultText);
  let value: unknown;
  try {
    value = JSON.parse(jsonText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `Final answer was not valid JSON: ${message}` };
  }

  if (schema) {
    const validationError = validateJsonSchema(value, schema, "$");
    if (validationError) {
      return { error: `JSON did not match schema: ${validationError}` };
    }
  }

  return { value };
}

function validateJsonSchema(value: unknown, schema: JsonSchema, path: string): string | undefined {
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
