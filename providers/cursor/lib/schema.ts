import type { JsonSchema } from "../../../lib/agent/json-schema.ts";

export { extractJsonFromText } from "../../../lib/agent/json-extract.ts";
export {
  loadSchema,
  parseStructuredOutput,
  type JsonSchema,
} from "../../../lib/agent/structured-output.ts";

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
