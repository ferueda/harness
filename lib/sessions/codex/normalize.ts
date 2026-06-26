export function cleanCodexUserMessage(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = stripInjectedCodexContext(value).trim();
  return cleaned ? cleaned : undefined;
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
