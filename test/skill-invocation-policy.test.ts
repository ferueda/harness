import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SKILLS = join(ROOT, "skills");
const automatic = new Set(["change-review-workflow", "review-spec"]);
const names = [
  "adversarial-review",
  "architect",
  "change-review-workflow",
  "code-quality-review",
  "create-plan",
  "diagnose-issue",
  "explain-change",
  "handoff-work",
  "planning-workflow",
  "review-implementation",
  "review-spec",
  "shape-requirements",
  "triage",
];

test.each(names)("%s declares its Codex and ChatGPT invocation policy", (name) => {
  const path = join(SKILLS, name, "agents/openai.yaml");
  expect(existsSync(path), `${name} is missing agents/openai.yaml`).toBe(true);
  const metadata = readFileSync(path, "utf8");
  expect(metadata).toContain(`$${name}`);
  expect(metadata).toMatch(
    new RegExp(`allow_implicit_invocation:\\s*${automatic.has(name) ? "true" : "false"}`),
  );
});
