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

  for (const content of [template, auditTemplate]) {
    const prose = normalizedProse(content);
    expect(prose).toContain(
      "replaces, redirects, splits, deprecates, or removes an existing behavior",
    );
    expect(prose).toContain("post-change owner, exact removals and cutover order");
    expect(prose).toContain("required compatibility beside the change");
    expect(prose).toContain("Omit this lifecycle detail for ordinary additive work");
  }

  const coordinatorProse = normalizedProse(coordinator);
  expect(coordinatorProse).toContain("repository guidance constrains the work");
  expect(coordinatorProse).toContain(
    "the original request or approved plan defines the intended outcome",
  );
  expect(coordinatorProse).toContain("verified current code is the implementation baseline");
  expect(coordinatorProse).toContain(
    "Historical branches and superseded implementations are context only",
  );
  expect(coordinatorProse).toContain(
    "Carry forward named ownership, removal, cutover, and compatibility decisions",
  );
  expect(coordinatorProse).toContain("Before review or handoff, reconcile the resulting diff");
  expect(coordinatorProse).toContain("Perform both checks in session");
  expect(coordinatorProse).toContain("the accepted outcome is implemented");
  expect(coordinatorProse).toContain("relevant non-destructive validation is complete");
  expect(coordinatorProse).toContain("the exact unavailable checks are reported");
  expect(coordinatorProse).toContain("the resulting diff is reconciled with accepted decisions");
  expect(coordinatorProse).toContain(
    "A material conflict or required scope expansion stops implementation and returns to planning or the user",
  );
  expect(coordinator).not.toContain("**Done when:** plan phases complete or scoped change landed.");
});

test("handoffs preserve accepted authority without duplicating inspectable sources", () => {
  const handoff = readFileSync(join(REPO_ROOT, "skills/handoff-work/SKILL.md"), "utf8");
  const prose = normalizedProse(handoff);

  expect(prose).toContain(
    "follows repository guidance and the original task or accepted plan as its authority",
  );
  expect(prose).toContain("Point to inspectable sources");
  expect(prose).toContain(
    "Repeat only session-only or otherwise load-bearing constraints and decisions",
  );
  expect(prose).toContain("Use when the user asks to hand off work");
  expect(handoff).toContain("## Required core");
  expect(handoff).toContain("**Status**");
  expect(handoff).toContain("**Authority and goal**");
  expect(handoff).toContain("**Current state**");
  expect(handoff).toContain("**Verification**");
  expect(handoff).toContain("### Authority and goal");
  expect(handoff).toContain("### Current state");
  expect(handoff).toContain("### Verification");
  expect(handoff).toContain("## Add only when relevant");
  expect(handoff).toContain("**Material adaptations**");
  expect(handoff).toContain("**Important files**");
  expect(handoff).toContain("**Next steps**");
  expect(handoff).toContain("**Open items**");
  expect(handoff).toContain("Return the handoff inline");
  expect(handoff).not.toContain("### How it was done");
  expect(handoff).not.toContain("### Why it was done");
  expect(handoff).not.toContain("### What was worked on");
  expect(handoff).not.toContain("### Files referenced");
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

test("change review converges within the original task scope", () => {
  const skill = readFileSync(join(REPO_ROOT, "skills/change-review-workflow/SKILL.md"), "utf8");
  const implementation = readFileSync(
    join(REPO_ROOT, "skills/review-implementation/SKILL.md"),
    "utf8",
  );
  const quality = readFileSync(join(REPO_ROOT, "skills/code-quality-review/SKILL.md"), "utf8");
  const handoff = readFileSync(
    join(REPO_ROOT, "skills/change-review-workflow/references/review-handoff.md"),
    "utf8",
  );
  const prose = normalizedProse(skill);

  expect(prose).toContain("Use at most three total runs");
  expect(prose).toContain("After any code edit, always rerun `implementation`");
  expect(prose).toContain("A partial run passes only its requested roles");
  expect(prose).toContain("Advisories remain evidence by default");
  expect(prose).toContain("material scope expansion or a new product decision");
  expect(prose).toContain("made it newly observable");
  expect(prose).toContain("clarity, simplicity, conventions");
  expect(prose).toContain("retaining reviewer provenance");
  expect(prose).toContain(
    "Reconcile conflicts among findings, the original task or accepted plan, handoff context, and the diff",
  );
  expect(prose).toContain(
    "each underlying issue an evidence-backed `Implement`, `Adapt`, or `Decline`",
  );
  expect(prose).toContain("Decisions are issue-local");
  expect(prose).toContain("entire reviewer, run, or finding set");
  expect(prose).not.toContain("`simplify`");
  const implementationProse = normalizedProse(implementation);
  expect(implementationProse).toContain(
    "authoritative task or plan names a post-change owner, removal, cutover, or compatibility commitment",
  );
  expect(implementationProse).toContain("verify it against the diff and directly affected paths");
  expect(implementationProse).toContain("Handoffs provide context, not authority");
  expect(implementationProse).toContain("invent no migration work absent such a commitment");
  expect(quality).toContain("materially smaller equivalent shape");
  expect(quality).toContain("verified correctness, contract, or");
  expect(existsSync(join(REPO_ROOT, "skills/simplify-review/SKILL.md"))).toBe(false);

  expect(handoff).toContain("## Goal");
  expect(handoff).toContain("## Decisions and boundaries");
  expect(handoff).toContain("## Verification");
  expect(handoff).toContain("## Scrutiny");
  expect(handoff).toContain("## Follow-up focus");
  expect(handoff).not.toContain("### Files changed");
  expect(handoff).not.toContain("Provider session");
});
