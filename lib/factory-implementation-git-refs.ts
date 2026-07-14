import type { AgentProviderName } from "./agents.ts";

export function sameFactoryImplementationRefs(
  before: string,
  after: string,
  provider: AgentProviderName,
): boolean {
  return comparableRefs(before, provider) === comparableRefs(after, provider);
}

function comparableRefs(refs: string, provider: AgentProviderName): string {
  if (provider !== "codex") return refs;
  return refs
    .split("\n")
    .filter((line) => !line.startsWith("refs/codex/"))
    .join("\n");
}
