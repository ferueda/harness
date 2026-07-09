import { extractJsonText, leadingBalancedJsonValue, stripJsonFences } from "./json-extract.ts";
import { schemaAccepts, type JsonSchema, validateJsonSchema } from "./schema-validation.ts";

export type { JsonSchema } from "./schema-validation.ts";
export { loadSchema } from "./schema-validation.ts";

function parseJsonText(jsonText: string): { value?: unknown; error?: string } {
  try {
    return { value: JSON.parse(jsonText) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `Final answer was not valid JSON: ${message}` };
  }
}

function fullDocumentSyntaxError(resultText: string): string | null {
  const cleaned = stripJsonFences(resultText);
  if (!cleaned) return null;
  return parseJsonText(cleaned).error ?? null;
}

// Prefer whole-document syntax errors only for JSON-rooted output without recoverable
// trailing prose; prose-prefixed or JSON+suffix cases should surface schema diagnostics.
function shouldPreferFullDocumentSyntaxError(cleaned: string): boolean {
  const leading = leadingBalancedJsonValue(cleaned);
  if (!leading) {
    const trimmed = cleaned.trimStart();
    return trimmed.startsWith("{") || trimmed.startsWith("[");
  }
  const suffix = cleaned.slice(leading.start + leading.value.length).trim();
  return suffix.length === 0;
}

function extractStructuredJsonText(resultText: string, schema: JsonSchema): string | null {
  return extractJsonText(resultText, {
    accepts: (value) => schemaAccepts(schema, value),
  });
}

function schemaValidationError(schema: JsonSchema, resultText: string): string | null {
  const jsonText = extractJsonText(resultText);
  if (!jsonText) return null;

  const parsed = parseJsonText(jsonText);
  if (parsed.error) return parsed.error;

  const validationError = validateJsonSchema(parsed.value, schema, "$");
  if (validationError) return `JSON did not match schema: ${validationError}`;
  return null;
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

    const cleaned = stripJsonFences(resultText);
    if (shouldPreferFullDocumentSyntaxError(cleaned)) {
      const syntaxError = fullDocumentSyntaxError(resultText);
      if (syntaxError) return { error: syntaxError };
    }

    const diagnosticError = schemaValidationError(schema, resultText);
    if (diagnosticError) return { error: diagnosticError };

    return { error: "Final answer was not valid JSON." };
  }

  // No schema: JSON is optional. Prefer extractable JSON; accept prose finals.
  const jsonText = extractJsonText(resultText, { fallbackToCleaned: false });
  if (!jsonText) {
    return { value: undefined };
  }
  const parsed = parseJsonText(jsonText);
  if (parsed.error) {
    return { value: undefined };
  }
  return { value: parsed.value };
}
