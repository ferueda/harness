import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type * as NodeFs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

afterEach(() => {
  vi.doUnmock("node:fs");
  vi.resetModules();
});

function listFiles(root: string): string[] {
  return readdirSync(root, { recursive: true })
    .map((entry) => String(entry))
    .filter((entry) => statSync(join(root, entry)).isFile())
    .sort();
}

function normalizedProse(content: string): string {
  return content.replace(/\s+/g, " ");
}

test("installPackagedSkill restores existing skill when forced replace fails", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-skills-"));
  const skillPath = join(workspace, ".agents/skills/change-review-workflow/SKILL.md");
  mkdirSync(join(workspace, ".agents/skills/change-review-workflow"), { recursive: true });
  writeFileSync(skillPath, "# Original local skill\n", "utf8");

  let renameCalls = 0;
  vi.doMock("node:fs", async () => {
    const actual = await vi.importActual<typeof NodeFs>("node:fs");
    return {
      ...actual,
      renameSync: vi.fn<(oldPath: string, newPath: string) => void>((oldPath, newPath) => {
        renameCalls += 1;
        if (renameCalls === 2) {
          throw new Error("simulated replace failure");
        }
        return actual.renameSync(oldPath, newPath);
      }),
    };
  });

  const { installPackagedSkill } = await import("../lib/skills.ts");

  expect(() => installPackagedSkill("change-review-workflow", { workspace, force: true })).toThrow(
    /simulated replace failure/,
  );
  expect(readFileSync(skillPath, "utf8")).toBe("# Original local skill\n");
});

test("local change review skill stays in sync with packaged skill", () => {
  const packagedRoot = join(REPO_ROOT, "skills/change-review-workflow");
  const localRoot = join(REPO_ROOT, ".agents/skills/change-review-workflow");
  const files = listFiles(packagedRoot);

  expect(files).toEqual(listFiles(localRoot));
  for (const file of files) {
    expect(readFileSync(join(localRoot, file), "utf8")).toBe(
      readFileSync(join(packagedRoot, file), "utf8"),
    );
  }
});

test("sessions skill stays extraction-focused", () => {
  const skill = readFileSync(join(REPO_ROOT, "skills/sessions/SKILL.md"), "utf8");

  expect(skill).toContain("name: sessions");
  expect(skill).toMatch(/install\.sh|Install launcher/i);
  expect(skill).toContain("--extract-only");
  expect(skill).toContain("--turn-query");
  expect(skill).toContain("--evidence-limit");
  expect(skill).toContain("matchedQueries");
  expect(skill).toContain("~/.sessions/index");
  expect(skill.toLowerCase()).not.toMatch(
    /workflow proposal|skill candidate|self-improvement|recommended next plan/,
  );
});

const STALE_SESSIONS_PATTERNS = [/session-evidence/, /\bbin\/sessions/, /\blib\/sessions/] as const;

test("harness docs do not reference removed sessions harness paths", () => {
  const docPaths = [
    "README.md",
    "AGENTS.md",
    "skills/planning-workflow/SKILL.md",
    "skills/planning-workflow/references/routing.md",
    "skills/sessions/references/audit-examples.md",
    "skills/sessions/references/turn-queries.md",
  ];

  for (const relativePath of docPaths) {
    const content = readFileSync(join(REPO_ROOT, relativePath), "utf8");
    for (const pattern of STALE_SESSIONS_PATTERNS) {
      expect(content, relativePath).not.toMatch(pattern);
    }
  }
});

test("sessions CLI lives under skills/sessions only", () => {
  const removedPaths = [
    "bin/sessions.ts",
    "lib/sessions",
    "skills/session-evidence",
    "test/sessions",
    "test/fixtures/sessions",
  ];
  for (const relativePath of removedPaths) {
    expect(existsSync(join(REPO_ROOT, relativePath)), relativePath).toBe(false);
  }
  expect(statSync(join(REPO_ROOT, "skills/sessions/scripts/sessions.ts")).isFile()).toBe(true);
  expect(statSync(join(REPO_ROOT, "skills/sessions/scripts/install.sh")).isFile()).toBe(true);
});

test("planning skills use the compact capable-executor contract", () => {
  const createPlan = readFileSync(join(REPO_ROOT, "skills/create-plan/SKILL.md"), "utf8");
  const template = readFileSync(
    join(REPO_ROOT, "skills/create-plan/references/plan-template.md"),
    "utf8",
  );
  const coordinator = readFileSync(join(REPO_ROOT, "skills/planning-workflow/SKILL.md"), "utf8");
  const audit = readFileSync(join(REPO_ROOT, "skills/audit/SKILL.md"), "utf8");
  const auditTemplate = readFileSync(
    join(REPO_ROOT, "skills/audit/references/plan-template.md"),
    "utf8",
  );

  for (const content of [createPlan, template, coordinator, audit, auditTemplate]) {
    expect(content).toMatch(/capable, context-limited\s+executors?/);
    expect(content).toMatch(/highest existing\s+stable test seam/);
    expect(content).not.toContain("weakest plausible executor");
  }

  for (const content of [createPlan, template, audit, auditTemplate]) {
    expect(normalizedProse(content)).toContain("without prior context about the task at hand");
    expect(content).not.toContain("no prior conversation");
  }

  expect(template).toContain("## Goal");
  expect(template).toContain("## Changes");
  expect(template).toContain("## Verify");
  expect(template).toContain("## Boundaries");
  expect(template).toContain("Do not add a skills table by default");
  expect(template).not.toContain("## Status");
  expect(template).not.toContain("## Maintenance notes");
  expect(createPlan).not.toContain("less capable model with zero context");
  expect(auditTemplate).toContain("Planned at");
  expect(auditTemplate).toContain("## Index file: `dev/plans/README.md`");
  expect(auditTemplate).not.toContain("## Commands you will need");
});

test("architect prefers the smallest intent-aligned design", () => {
  const architect = readFileSync(join(REPO_ROOT, "skills/architect/SKILL.md"), "utf8");
  const prose = normalizedProse(architect);

  expect(prose).toContain("Repository invariants and documented project intent");
  expect(prose).toContain("Recommend no change when it already satisfies the goal");
  expect(prose).toContain("smallest repo-native change");
  expect(prose).toContain("Do not manufacture an option count");
  expect(prose).toContain("highest existing stable test seam");
  expect(prose).toContain("only when its answer could change the recommendation");
  expect(prose).toContain("challenge the smallest proposed design");
  expect(prose).toContain("Name the task `architect-advisor`");
  expect(prose).toContain("Only materially different viable choices");
  expect(prose).toContain("Omit when one direction is clear");
  expect(architect).not.toContain("Use an alternate model");
  expect(architect).not.toMatch(/gpt-5\.6-(terra|luna)/);
  expect(architect).not.toContain("Generate two to four viable designs");
  expect(architect).not.toContain("bolder architecture");
  expect(architect).not.toContain("## Current-State Anchors");
  expect(architect).not.toContain("## Locked For Planning");
});
