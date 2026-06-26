export function cleanCodexUserMessage(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = stripInjectedCodexContext(value).trim();
  return cleaned ? cleaned : undefined;
}

export function looksLikeInjectedCodexContext(text: string): boolean {
  const prefix = text.trimStart().slice(0, 2_000).toLowerCase();
  return (
    prefix.startsWith("# agents.md instructions for ") ||
    (prefix.startsWith("<instructions>") && prefix.includes("# agents.md")) ||
    prefix.startsWith("<system_instruction>")
  );
}

function stripInjectedCodexContext(text: string): string {
  let cleaned = text;
  while (true) {
    const next = cleaned
      .replace(/^\s*#\s*AGENTS\.md instructions for [^\n]*(?:\r?\n){1,2}/i, "")
      .replace(/^\s*<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>\s*/i, "")
      .replace(/^\s*<SYSTEM_INSTRUCTION>[\s\S]*?<\/SYSTEM_INSTRUCTION>\s*/i, "")
      .trim();
    if (next === cleaned.trim()) return next;
    cleaned = next;
  }
}
