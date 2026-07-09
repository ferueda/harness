import { expect } from "vitest";

export function parseFactoryRunStartedProgress(stderr: string) {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as { harnessFactory?: string };
        return parsed.harnessFactory === "run-started" ? [parsed] : [];
      } catch {
        return [];
      }
    });
  expect(lines).toHaveLength(1);
  return lines[0];
}
