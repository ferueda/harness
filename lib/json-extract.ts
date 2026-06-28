// Pure text → JSON string extraction. No schema validation.

export function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;

  const withoutOpen = trimmed.replace(/^```(?:json)?\s*\n?/, "");
  return withoutOpen.replace(/\n?```\s*$/, "").trim();
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

export function leadingBalancedJsonValue(text: string): { start: number; value: string } | null {
  const start = text.length - text.trimStart().length;
  const first = text[start];
  if (first !== "{" && first !== "[") return null;
  const value = tryExtractBalancedValue(text, start);
  if (!value) return null;
  return { start, value };
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
    maybeConsider(cursor, tryExtractBalancedValue(text, cursor));
    cursor = cursor > 0 ? text.lastIndexOf("{", cursor - 1) : -1;
  }

  cursor = text.lastIndexOf("[");
  while (cursor >= 0) {
    maybeConsider(cursor, tryExtractBalancedValue(text, cursor));
    cursor = cursor > 0 ? text.lastIndexOf("[", cursor - 1) : -1;
  }

  return bestText;
}

// Schema-aware acceptance avoids selecting a nested finding object when prose precedes
// a valid top-level review payload (rightmost `{` alone is not enough).
export function extractJsonText(
  text: string,
  options?: {
    accepts?: (value: unknown) => boolean;
    fallbackToCleaned?: boolean;
  },
): string | null {
  const cleaned = stripJsonFences(text);
  if (!cleaned) return options?.fallbackToCleaned ? cleaned : null;

  try {
    const parsed = JSON.parse(cleaned);
    if (!options?.accepts || options.accepts(parsed)) return cleaned;
  } catch {
    // fall through to rightmost extraction
  }

  const extracted = extractRightmostParseableJson(cleaned, options?.accepts);
  if (extracted !== null) return extracted;
  return options?.fallbackToCleaned ? cleaned : null;
}

export function extractJsonFromText(text: string): string {
  return extractJsonText(text, { fallbackToCleaned: true }) ?? stripJsonFences(text);
}
