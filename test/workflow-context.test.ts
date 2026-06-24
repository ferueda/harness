import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { cleanupOrphanedRunDir, resolveSkillPath } from "../lib/workflow-context.ts";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
test("cleanupOrphanedRunDir removes incomplete run directories", () => {
  const runDir = mkdtempSync(join(tmpdir(), "harness-orphaned-run-"));
  mkdirSync(join(runDir, "context"));
  expect(cleanupOrphanedRunDir(runDir)).toBe(true);
  expect(existsSync(runDir)).toBe(false);
});
test("cleanupOrphanedRunDir preserves runs with metadata", () => {
  const runDir = mkdtempSync(join(tmpdir(), "harness-run-"));
  writeFileSync(join(runDir, "meta.json"), "{}\n", "utf8");
  expect(cleanupOrphanedRunDir(runDir)).toBe(false);
  expect(existsSync(runDir)).toBe(true);
});
test("resolveSkillPath prefers workspace agent skills over bundled skills", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-workspace-"));
  const skillPath = join(workspace, ".agents/skills/review-implementation/SKILL.md");
  mkdirSync(join(workspace, ".agents/skills/review-implementation"), { recursive: true });
  writeFileSync(skillPath, "# Workspace review implementation\n", "utf8");
  expect(resolveSkillPath("review-implementation", workspace)).toBe(skillPath);
});
test("resolveSkillPath falls back to user agent skills before bundled skills", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-workspace-"));
  const homeDir = mkdtempSync(join(tmpdir(), "harness-home-"));
  const skillPath = join(homeDir, ".agents/skills/review-implementation/SKILL.md");
  mkdirSync(join(homeDir, ".agents/skills/review-implementation"), { recursive: true });
  writeFileSync(skillPath, "# User review implementation\n", "utf8");
  expect(resolveSkillPath("review-implementation", workspace, homeDir)).toBe(skillPath);
});
test("resolveSkillPath falls back to bundled workflow skills", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-workspace-"));
  const devSkillPath = join(workspace, ".agents/skills/simplify/SKILL.md");
  mkdirSync(join(workspace, ".agents/skills/simplify"), { recursive: true });
  writeFileSync(devSkillPath, "# Dev simplify\n", "utf8");
  const skillPath = resolveSkillPath("simplify-review", workspace, workspace);
  expect(skillPath).toBe(join(REPO_ROOT, "skills/simplify-review/SKILL.md"));
  expect(readFileSync(skillPath, "utf8")).toContain("name: simplify-review");
});
