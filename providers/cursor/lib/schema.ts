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

function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;

  const withoutOpen = trimmed.replace(/^```(?:json)?\s*\n?/, "");
  return withoutOpen.replace(/\n?```\s*$/, "").trim();
}

function tryExtractBalancedValue(text: string, start: number): string | null {
  const end = balancedJsonEnd(text, start);
  if (end === undefined) return null;
  const candidate = text.slice(start, end + 1);
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    return null;
  }
}

function tryExtractBalancedObject(text: string, start: number): string | null {
  if (text[start] !== "{") return null;
  return tryExtractBalancedValue(text, start);
}

function extractRightmostParseableJson(
  text: string,
  accepts?: (value: unknown) => boolean,
): string | null {
  let bestStart = -1;
  let bestText: string | null = null;

  const maybeConsider = (start: number, candidate: string | null) => {
    if (candidate === null) return;
    if (accepts) {
      try {
        if (!accepts(JSON.parse(candidate))) return;
      } catch {
        return;
      }
    }
    if (start > bestStart) {
      bestStart = start;
      bestText = candidate;
    }
  };

  let cursor = text.lastIndexOf("{");
  while (cursor >= 0) {
    maybeConsider(cursor, tryExtractBalancedObject(text, cursor));
    cursor = cursor > 0 ? text.lastIndexOf("{", cursor - 1) : -1;
  }

  cursor = text.lastIndexOf("[");
  while (cursor >= 0) {
    maybeConsider(cursor, tryExtractBalancedValue(text, cursor));
    cursor = cursor > 0 ? text.lastIndexOf("[", cursor - 1) : -1;
  }

  return bestText;
}

export function extractJsonFromText(text: string): string {
  const cleaned = stripJsonFences(text);
  if (!cleaned) return cleaned;

  try {
    JSON.parse(cleaned);
    return cleaned;
  } catch {
    // fall through to extraction
  }

  const extracted = extractRightmostParseableJson(cleaned);
  return extracted ?? cleaned;
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

function schemaAccepts(schema: JsonSchema, value: unknown): boolean {
  return validateJsonSchema(value, schema, "$") === undefined;
}

function parseJsonText(jsonText: string): { value?: unknown; error?: string } {
  try {
    return { value: JSON.parse(jsonText) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `Final answer was not valid JSON: ${message}` };
  }
}

function extractStructuredJsonText(resultText: string, schema: JsonSchema): string | null {
  const cleaned = stripJsonFences(resultText);
  if (!cleaned) return null;

  const accepts = (value: unknown) => schemaAccepts(schema, value);

  try {
    const parsed = JSON.parse(cleaned);
    if (accepts(parsed)) return cleaned;
  } catch {
    // fall through to rightmost extraction
  }

  return extractRightmostParseableJson(cleaned, accepts);
}

function extractDiagnosticJsonText(resultText: string): string | null {
  const cleaned = stripJsonFences(resultText);
  if (!cleaned) return null;

  try {
    JSON.parse(cleaned);
    return cleaned;
  } catch {
    // fall through
  }

  return extractRightmostParseableJson(cleaned);
}

function schemaValidationError(
  schema: JsonSchema,
  resultText: string,
): { value?: unknown; error?: string } | null {
  const jsonText = extractDiagnosticJsonText(resultText);
  if (!jsonText) return null;

  const parsed = parseJsonText(jsonText);
  if (parsed.error) return parsed;

  const validationError = validateJsonSchema(parsed.value, schema, "$");
  if (validationError) {
    return { error: `JSON did not match schema: ${validationError}` };
  }

  return { value: parsed.value };
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

  if (schema) {
    const jsonText = extractStructuredJsonText(resultText, schema);
    if (jsonText) {
      const parsed = parseJsonText(jsonText);
      if (parsed.error) return parsed;
      return { value: parsed.value };
    }

    const diagnostic = schemaValidationError(schema, resultText);
    if (diagnostic) return diagnostic;

    return { error: "Final answer was not valid JSON." };
  }

  const jsonText = extractJsonFromText(resultText);
  const parsed = parseJsonText(jsonText);
  if (parsed.error) return parsed;
  return { value: parsed.value };
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
