import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type * as NodeFs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SKILLS = join(ROOT, "skills");
const workspaces: string[] = [];
const expectedNames = [
  "adversarial-review", "architect", "change-review-workflow", "code-quality-review",
  "create-plan", "diagnose-issue", "explain-change", "handoff-work", "planning-workflow",
  "review-implementation", "review-spec", "shape-requirements",
];

afterEach(() => {
  vi.doUnmock("node:fs");
  vi.resetModules();
  for (const workspace of workspaces.splice(0)) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

function workspace(): string {
  const path = mkdtempSync(join(tmpdir(), "harness-skills-"));
  workspaces.push(path);
  return path;
}

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

function skillNames(): string[] {
  return readdirSync(SKILLS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function packageFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? packageFiles(path) : [path];
  });
}

test("the supported distributable catalogue excludes retired packages", () => {
  expect(skillNames()).toEqual(expectedNames);
  for (const path of [
    "skills/audit", "skills/docs-drift-review", "automations/harness-doc-drift.md",
    "skills/sessions", "skills/session-evidence", "skills/simplify-review",
    "bin/sessions.ts", "lib/sessions", "test/sessions", "test/fixtures/sessions",
  ]) {
    expect(existsSync(join(ROOT, path)), path).toBe(false);
  }
});

test.each(expectedNames)("%s has valid discovery metadata and local references", (name) => {
  const root = join(SKILLS, name);
  const source = readFileSync(join(root, "SKILL.md"), "utf8");
  const metadata = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(source)?.[1];
  expect(metadata).toBeDefined();
  expect(metadata).toMatch(new RegExp(`^name: ${name}$`, "m"));
  expect(metadata).toMatch(/^description: \S.+$/m);
  for (const match of source.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1].split("#")[0];
    if (!target || /^[a-z]+:/i.test(target)) continue;
    const resolved = resolve(root, target);
    expect(relative(root, resolved)).not.toMatch(/^\.\.(?:[/\\]|$)/);
    expect(isAbsolute(target)).toBe(false);
    expect(existsSync(resolved), `${name}: ${target}`).toBe(true);
  }
});

test.each(expectedNames)("installing %s copies its complete package only", async (name) => {
  const target = workspace();
  const { installPackagedSkill } = await import("../lib/skills/install.ts");
  const result = installPackagedSkill(name, { workspace: target });
  expect(result.status).toBe("installed");
  expect(readdirSync(join(target, ".agents/skills"))).toEqual([name]);
  for (const path of packageFiles(join(SKILLS, name))) {
    const copied = join(target, ".agents/skills", name, relative(join(SKILLS, name), path));
    expect(readFileSync(copied)).toEqual(readFileSync(path));
  }
});

test.each(["audit", "docs-drift-review"])("retired %s cannot be installed", async (name) => {
  const target = workspace();
  const { installPackagedSkill } = await import("../lib/skills/install.ts");
  expect(() => installPackagedSkill(name, { workspace: target })).toThrow(
    `Packaged skill not found: ${name}`,
  );
  expect(existsSync(join(target, ".agents/skills"))).toBe(false);
});

test("a forced replacement failure restores the existing installed skill", async () => {
  const target = workspace();
  const skillPath = join(target, ".agents/skills/change-review-workflow/SKILL.md");
  mkdirSync(dirname(skillPath), { recursive: true });
  writeFileSync(skillPath, "# Original local skill\n", "utf8");
  let renames = 0;
  vi.doMock("node:fs", async () => {
    const actual = await vi.importActual<typeof NodeFs>("node:fs");
    return {
      ...actual,
      renameSync: vi.fn<(oldPath: string, newPath: string) => void>((oldPath, newPath) => {
        renames += 1;
        if (renames === 2) throw new Error("simulated replace failure");
        return actual.renameSync(oldPath, newPath);
      }),
    };
  });
  const { installPackagedSkill } = await import("../lib/skills/install.ts");
  expect(() => installPackagedSkill("change-review-workflow", {
    workspace: target, force: true,
  })).toThrow(/simulated replace failure/);
  expect(readFileSync(skillPath, "utf8")).toBe("# Original local skill\n");
});

test("architect stays explicit-only and defaults name available skills", () => {
  for (const name of expectedNames) {
    const path = join(SKILLS, name, "agents/openai.yaml");
    if (!existsSync(path)) continue;
    const metadata = readFileSync(path, "utf8");
    expect(metadata).toContain(`$${name}`);
    if (name === "architect") expect(metadata).toMatch(/allow_implicit_invocation:\s*false/);
  }
});

test("removed workflow routes are absent from active instructions", () => {
  const paths = ["AGENTS.md", ...expectedNames.map((name) => `skills/${name}/SKILL.md`)];
  for (const path of paths) {
    expect(read(path), path).not.toMatch(/skills\/(?:audit|docs-drift-review)|`(?:audit|docs-drift-review)`/);
  }
});

test("behavioral forward-evaluation fixtures retain representative decision cases", () => {
  const fixture: unknown = JSON.parse(read("test/fixtures/skill-routing-eval.json"));
  expect(Array.isArray(fixture)).toBe(true);
  if (!Array.isArray(fixture)) return;
  const ids = fixture.map((item: unknown) => {
    if (!item || typeof item !== "object" || !("id" in item)) return undefined;
    return item.id;
  });
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of [
    "direct-fix", "authorized-defaults", "document-edit", "review-only",
    "full-workflow", "delegated-author", "missing-child", "new-review-evidence",
  ]) {
    expect(ids).toContain(id);
  }
  const proof = read("test/fixtures/outcome-proof-eval.md");
  expect(proof.match(/\*\*Reviewer fixture:\*\*/g)).toHaveLength(5);
  expect(proof.match(/\*\*Revision expectation:\*\*/g)).toHaveLength(5);
});

// Package/wiring checks do not establish model-level routing or execution quality.
// Run authorized fresh-session forward evaluations separately; do not pin prose.
