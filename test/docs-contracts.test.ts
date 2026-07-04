import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ARCHITECTURE_DOC = "docs/contributing/architecture.md";
const SCRIPT_COMMAND_SURFACE = "docs/contributing/script-command-surface.md";
const SETUP_MANIFEST = "docs/contributing/setup-manifest.md";
const TESTING_DOC = "docs/contributing/testing.md";
const DEVELOPER_CHECKOUT_PATH_PATTERNS = [
  /\/Users\/[^/\s`)"]+\/dev\/(?:clones\/)?[^/\s`)"]+/i,
] as const;
const REQUIRED_INVENTORY_CONCRETE = ["install", "bin/harness.ts"] as const;
const REQUIRED_INVENTORY_GLOBS = ["scripts/*", "workflows/*.ts", "skills/*/scripts/*"] as const;
const INVENTORY_EXCLUSIONS = [
  "skills/**/node_modules/**",
  "skills/**/fixtures/**",
  "skills/**/test/**",
  "**/*.test.ts",
  "skills/**/lib/**",
] as const;

type DocumentedCommands = {
  makeTargets: string[];
  pnpmScripts: string[];
};

type InventoryRules = {
  concrete: string[];
  globs: string[];
};

function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

function repoPath(path: string): string {
  return path.split(sep).join("/");
}

function listFiles(root: string): string[] {
  if (!existsSync(root)) return [];

  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(repoPath(relative(REPO_ROOT, entryPath)));
    }
  }
  return files.sort();
}

function readMakeTargets(): string[] {
  const targets = new Set<string>();
  for (const line of readRepoFile("Makefile").split(/\r?\n/)) {
    const match = /^([a-zA-Z_-]+):.*?##/.exec(line);
    if (match) targets.add(match[1]);
  }
  return [...targets].sort();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPackageScripts(): string[] {
  const parsed: unknown = JSON.parse(readRepoFile("package.json"));
  if (!isObject(parsed) || !isObject(parsed.scripts)) return [];
  return Object.keys(parsed.scripts).sort();
}

function splitMarkdownRow(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isSeparatorRow(row: string): boolean {
  return splitMarkdownRow(row).every((cell) => /^:?-{3,}:?$/.test(cell));
}

function findCommandOwnershipRows(markdown: string): { header: string[]; rows: string[][] } {
  const lines = markdown.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => /^#{1,6}\s+Command ownership\b/i.test(line));
  if (headingIndex === -1) {
    throw new Error(`${SCRIPT_COMMAND_SURFACE} is missing a Command ownership heading`);
  }

  const tableStart = lines.findIndex(
    (line, index) => index > headingIndex && line.trim().startsWith("|"),
  );
  if (tableStart === -1) {
    throw new Error(`${SCRIPT_COMMAND_SURFACE} is missing a table after Command ownership`);
  }

  const tableLines: string[] = [];
  for (let index = tableStart; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim().startsWith("|")) break;
    tableLines.push(line);
  }
  const [headerLine, separatorLine, ...bodyLines] = tableLines;
  if (!headerLine || !separatorLine || !isSeparatorRow(separatorLine)) {
    throw new Error(`${SCRIPT_COMMAND_SURFACE} has an invalid Command ownership table`);
  }

  return {
    header: splitMarkdownRow(headerLine),
    rows: bodyLines.filter((line) => !isSeparatorRow(line)).map(splitMarkdownRow),
  };
}

function commandCandidates(cell: string): string[] {
  const codeSpans = [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
  const candidates = codeSpans.length > 0 ? codeSpans : cell.split(/<br\s*\/?>|[,;]/i);
  return candidates.flatMap((candidate) =>
    candidate
      .split(/<br\s*\/?>|[,;]/i)
      .map((part) => part.trim())
      .filter(Boolean),
  );
}

function parseDocumentedCommands(markdown: string): DocumentedCommands {
  const { header, rows } = findCommandOwnershipRows(markdown);
  const commandColumn = header.findIndex((cell) =>
    ["public commands", "command", "commands"].includes(cell.trim().toLowerCase()),
  );
  if (commandColumn === -1) {
    throw new Error(`${SCRIPT_COMMAND_SURFACE} Command ownership table is missing Public commands`);
  }

  const makeTargets = new Set<string>();
  const pnpmScripts = new Set<string>();

  for (const row of rows) {
    const cell = row[commandColumn] ?? "";
    for (const candidate of commandCandidates(cell)) {
      const make = /^make\s+(\S+)/.exec(candidate);
      if (make && make[1] !== "...") {
        makeTargets.add(make[1]);
        continue;
      }

      const pnpm = /^pnpm\s+(\S+)/.exec(candidate);
      if (pnpm && pnpm[1] !== "...") {
        pnpmScripts.add(pnpm[1]);
      }
    }
  }

  return {
    makeTargets: [...makeTargets].sort(),
    pnpmScripts: [...pnpmScripts].sort(),
  };
}

function segmentMatches(pathSegment: string, ruleSegment: string): boolean {
  const pattern = ruleSegment.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*");
  return new RegExp(`^${pattern}$`).test(pathSegment);
}

function matchesGlob(path: string, rule: string): boolean {
  // Supports the small glob subset used by the command inventory docs contract.
  const pathParts = path.split("/");
  const ruleParts = rule.split("/");

  function matchesAt(pathIndex: number, ruleIndex: number): boolean {
    if (ruleIndex === ruleParts.length) return pathIndex === pathParts.length;
    const rulePart = ruleParts[ruleIndex];
    if (rulePart === "**") {
      for (let nextPathIndex = pathIndex; nextPathIndex <= pathParts.length; nextPathIndex += 1) {
        if (matchesAt(nextPathIndex, ruleIndex + 1)) return true;
      }
      return false;
    }
    const pathPart = pathParts[pathIndex];
    return (
      Boolean(pathPart) &&
      segmentMatches(pathPart, rulePart) &&
      matchesAt(pathIndex + 1, ruleIndex + 1)
    );
  }

  return matchesAt(0, 0);
}

function isExcludedInventoryPath(path: string): boolean {
  return INVENTORY_EXCLUSIONS.some((rule) => matchesGlob(path, rule));
}

function sourceInventoryPaths(): string[] {
  const paths = new Set<string>();
  for (const path of REQUIRED_INVENTORY_CONCRETE) {
    if (existsSync(join(REPO_ROOT, path))) paths.add(path);
  }

  for (const path of listFiles(join(REPO_ROOT, "scripts"))) paths.add(path);
  for (const path of listFiles(join(REPO_ROOT, "workflows"))) paths.add(path);

  const skillsRoot = join(REPO_ROOT, "skills");
  for (const skill of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!skill.isDirectory()) continue;
    for (const path of listFiles(join(skillsRoot, skill.name, "scripts"))) paths.add(path);
  }

  return [...paths].filter((path) => !isExcludedInventoryPath(path)).sort();
}

function normalizeInventoryToken(token: string): string | null {
  const trimmed = token.trim();
  const normalized = trimmed === "./install" ? "install" : trimmed;
  if (normalized === "install" || normalized === "bin/harness.ts") return normalized;
  if (/^scripts\/(?:\*|[^/\s`]+)$/.test(normalized)) return normalized;
  if (/^workflows\/(?:\*\.ts|[^/\s`]+\.ts)$/.test(normalized)) return normalized;
  if (/^skills\/(?:\*|[^/\s`]+)\/scripts\/(?:\*|[^/\s`]+)$/.test(normalized)) return normalized;
  return null;
}

function inventoryRulesFromMarkdown(markdown: string): InventoryRules {
  const lines = markdown.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => /^#{1,6}\s+Inventory rules\b/i.test(line));
  if (headingIndex === -1) {
    throw new Error(`${SCRIPT_COMMAND_SURFACE} is missing an Inventory rules heading`);
  }
  const nextHeadingIndex = lines.findIndex(
    (line, index) => index > headingIndex && /^#{1,6}\s+/.test(line),
  );
  const section = lines
    .slice(headingIndex, nextHeadingIndex === -1 ? undefined : nextHeadingIndex)
    .join("\n");

  const concrete = new Set<string>();
  const globs = new Set<string>();
  for (const match of section.matchAll(/`([^`]+)`/g)) {
    const token = normalizeInventoryToken(match[1]);
    if (!token) continue;
    if (token.includes("*")) {
      globs.add(token);
    } else {
      concrete.add(token);
    }
  }
  return {
    concrete: [...concrete].sort(),
    globs: [...globs].sort(),
  };
}

function documentedInventoryRules(): InventoryRules {
  return inventoryRulesFromMarkdown(readRepoFile(SCRIPT_COMMAND_SURFACE));
}

function isCoveredByInventoryRule(path: string, rules: InventoryRules): boolean {
  return rules.concrete.includes(path) || rules.globs.some((rule) => matchesGlob(path, rule));
}

function durableDocPaths(): string[] {
  const paths = new Set(["README.md", "AGENTS.md"]);
  for (const path of listFiles(join(REPO_ROOT, "docs"))) {
    if (path.endsWith(".md")) paths.add(path);
  }
  const automationsRoot = join(REPO_ROOT, "automations");
  if (existsSync(automationsRoot)) {
    for (const entry of readdirSync(automationsRoot, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        paths.add(repoPath(join("automations", entry.name)));
      }
    }
  }
  return [...paths].sort();
}

test("testing taxonomy documents required proof layers", () => {
  expect(existsSync(join(REPO_ROOT, TESTING_DOC)), TESTING_DOC).toBe(true);
  const content = readRepoFile(TESTING_DOC);
  for (const heading of [
    "# Testing",
    "## Principles",
    "## Layers",
    "## Where to Put New Tests",
    "## Verification Commands",
    "## Drift Checks",
    "## Maintenance Notes",
  ]) {
    expect(content, `${TESTING_DOC} missing ${heading}`).toContain(heading);
  }
  for (const layer of [
    "lib/",
    "providers/",
    "workflows",
    "test/cli.test.ts",
    "scripts/smoke-dist.ts",
    "test/gate-output.test.ts",
    "skills/sessions/test",
    "target-repo",
  ]) {
    expect(content, `${TESTING_DOC} missing ${layer}`).toContain(layer);
  }
  expect(content).toContain("Pre-commit hooks provide cheap commit hygiene");
  expect(content).toContain("format/lint staged files");
  expect(content).toContain("pnpm typecheck");
  expect(content).toContain("do not replace `pnpm check`");
});

test("hook docs document activation and gate boundaries", () => {
  const setup = readRepoFile(SETUP_MANIFEST);
  expect(setup).toContain("## Hook activation");
  expect(setup).toContain("package `prepare` script");
  expect(setup).toContain(".git/hooks/pre-commit");
  expect(setup).toContain("simple-git-hooks");
  expect(setup).toContain("pnpm-workspace.yaml");
  expect(setup).toContain("--ignore-workspace");
  expect(setup).toContain("pnpm exec simple-git-hooks");
  expect(setup).toContain("Hooks do not replace `pnpm check`");
  expect(setup).toContain("CI uses `pnpm check:ci`");

  const commandSurface = readRepoFile(SCRIPT_COMMAND_SURFACE);
  expect(commandSurface).toContain("## Commit hygiene hooks");
  expect(commandSurface).toContain("lint-staged");
  expect(commandSurface).toContain("pnpm typecheck");
  expect(commandSurface).toMatch(/They do not run\s+`pnpm check`, tests, smoke-dist/);
  expect(commandSurface).toMatch(/does\s+not depend on local Git hooks/);
});

test("gate output docs document runner wiring and local logs", () => {
  const makefile = readRepoFile("Makefile");
  expect(makefile).toContain("scripts/run-gate-step.ts");
  expect(makefile).toContain("GATE_STEP_COMMAND");
  expect(makefile).toContain("GATE_STEP_NAME");
  expect(makefile).toContain("GATE_STEP_RERUN");

  const harnessEngineering = readRepoFile("docs/contributing/harness-engineering.md");
  expect(harnessEngineering).toContain("## Gate output contract");
  expect(harnessEngineering).toContain("PASS");
  expect(harnessEngineering).toContain("FAIL");
  expect(harnessEngineering).toContain("log path");
  expect(harnessEngineering).toContain("Log:");
  expect(harnessEngineering).toContain("--- last");
  expect(harnessEngineering).toContain("Rerun with full logs:");
  expect(harnessEngineering).toContain("bounded");
  expect(harnessEngineering).toContain("rerun hint");

  const commandSurface = readRepoFile(SCRIPT_COMMAND_SURFACE);
  expect(commandSurface).toContain("## Gate output runner");
  expect(commandSurface).toContain("scripts/run-gate-step.ts");
  expect(commandSurface).toMatch(/implementation detail behind Make-owned public targets/);

  const setup = readRepoFile(SETUP_MANIFEST);
  expect(setup).toContain("harness-gate-");
  expect(setup).toContain("GATE_LOG_DIR");
  expect(setup).toContain("KEEP_GATE_LOGS");

  const testing = readRepoFile(TESTING_DOC);
  expect(testing).toContain("test/gate-output.test.ts");
  expect(testing).toContain("scripts/run-gate-step.ts");

  const architecture = readRepoFile(ARCHITECTURE_DOC);
  expect(architecture).toContain("scripts/run-gate-step.ts");
});

test("pre-commit hook config stays scoped to staged hygiene", () => {
  const parsed: unknown = JSON.parse(readRepoFile("package.json"));
  expect(isObject(parsed), "package.json must parse to object").toBe(true);
  if (!isObject(parsed)) return;

  const scripts = isObject(parsed.scripts) ? parsed.scripts : {};
  expect(scripts.prepare).toBe("simple-git-hooks");

  const hooks = isObject(parsed["simple-git-hooks"]) ? parsed["simple-git-hooks"] : {};
  expect(hooks["pre-commit"]).toBe("pnpm exec lint-staged && pnpm typecheck");

  const lintStaged = isObject(parsed["lint-staged"]) ? parsed["lint-staged"] : {};
  expect(Object.keys(lintStaged)).toContain(
    "./{package.json,tsconfig.json,tsconfig.build.json,vitest.config.ts,.oxlintrc.json,.oxfmtrc.json}",
  );
  expect(Object.keys(lintStaged)).toContain(
    "./{package.json,tsconfig.json,tsconfig.build.json,vitest.config.ts}",
  );
  expect(Object.keys(lintStaged)).not.toContain(
    "{package,tsconfig,tsconfig.build,vitest.config,.oxlintrc,.oxfmtrc}.{json,ts}",
  );
  expect(Object.keys(lintStaged)).not.toContain(
    "{package,tsconfig,tsconfig.build,vitest.config}.{json,ts}",
  );
  const lintStagedConfig = JSON.stringify(lintStaged);
  expect(lintStagedConfig).toContain("pnpm exec oxfmt --write");
  expect(lintStagedConfig).toContain("pnpm exec oxlint -c .oxlintrc.json --fix");
  expect(lintStagedConfig).not.toContain("pnpm check");
  expect(lintStagedConfig).not.toContain("pnpm test");
  expect(lintStagedConfig).not.toContain("smoke:dist");
  expect(lintStagedConfig).not.toContain("harness run");

  const workspace = readRepoFile("pnpm-workspace.yaml");
  expect(workspace).toContain('  - "."');
  expect(workspace).toContain('  - "!skills/sessions"');
  expect(workspace).toContain("allowBuilds:");
  expect(workspace).toContain("  simple-git-hooks: true");

  const sessionsInstaller = readRepoFile("skills/sessions/scripts/install.sh");
  expect(sessionsInstaller).toContain("pnpm install --ignore-workspace --prod --frozen-lockfile");
  expect(sessionsInstaller).toContain(
    "corepack pnpm install --ignore-workspace --prod --frozen-lockfile",
  );

  const sessionsSkill = readRepoFile("skills/sessions/SKILL.md");
  expect(sessionsSkill).toContain("pnpm install --ignore-workspace --prod --frozen-lockfile");
  const setup = readRepoFile(SETUP_MANIFEST);
  expect(setup).toContain("skill-local `pnpm install --ignore-workspace --prod --frozen-lockfile`");
});

test("command parser extracts Make and pnpm commands from ownership table", () => {
  const fixture = [
    "## Command ownership",
    "",
    "| Surface | Owner file | Public commands | Mutability | Use when |",
    "|---------|------------|-----------------|------------|----------|",
    "| Make | `Makefile` | `make check`, `make check-v` | read-only | local gate |",
    "| pnpm | `package.json` | `pnpm test -- test/skills.test.ts`; `pnpm smoke:dist`; `pnpm check:ci`; `pnpm format:check` | read-only | package scripts |",
    "| CLI | `bin/harness.ts` | `harness run change-review --verbose`, `node bin/harness.ts init` | writes artifacts | generated help owns flags |",
    "| Install | `install` | `./install` | mutating | install shim |",
    "",
    "## Read-only vs mutating commands",
    "",
    "| Class | Commands | Notes |",
    "|-------|----------|-------|",
    "| Extra | `make missing`, `pnpm missing` | ignored because this is not the ownership table |",
  ].join("\n");

  expect(parseDocumentedCommands(fixture)).toEqual({
    makeTargets: ["check", "check-v"],
    pnpmScripts: ["check:ci", "format:check", "smoke:dist", "test"],
  });
});

test("documented Make and pnpm commands exist in source truth", () => {
  const documented = parseDocumentedCommands(readRepoFile(SCRIPT_COMMAND_SURFACE));
  const makeTargets = new Set(readMakeTargets());
  const packageScripts = new Set(readPackageScripts());

  for (const target of documented.makeTargets) {
    expect(
      makeTargets.has(target),
      `${SCRIPT_COMMAND_SURFACE} documents missing make target: ${target}`,
    ).toBe(true);
  }
  for (const script of documented.pnpmScripts) {
    expect(
      packageScripts.has(script),
      `${SCRIPT_COMMAND_SURFACE} documents missing pnpm script: ${script}`,
    ).toBe(true);
  }
});

test.each([
  ["scripts/smoke-dist.ts", "scripts/*"],
  ["workflows/review-steps.ts", "workflows/*.ts"],
  ["skills/sessions/scripts/sessions.ts", "skills/*/scripts/*"],
])("inventory matcher covers %s with %s", (path, rule) => {
  expect(matchesGlob(path, rule)).toBe(true);
});

test.each(["skills/cursor-cli/scripts/cursor-cli.test.ts", "skills/sessions/node_modules/foo.js"])(
  "inventory exclusions cover %s",
  (path) => {
    expect(isExcludedInventoryPath(path)).toBe(true);
  },
);

test("inventory parser ignores tokens outside inventory rules", () => {
  const fixture = [
    "# Commands",
    "",
    "## Inventory rules",
    "",
    "- Treat `install`, `bin/harness.ts`, `scripts/*`, `workflows/*.ts`, and `skills/*/scripts/*` as executable command surfaces.",
    "",
    "## Later section",
    "",
    "- Ignore `scripts/not-a-contract.ts` and `workflows/not-a-contract.ts` here.",
  ].join("\n");

  expect(inventoryRulesFromMarkdown(fixture)).toEqual({
    concrete: ["bin/harness.ts", "install"],
    globs: ["scripts/*", "skills/*/scripts/*", "workflows/*.ts"],
  });
});

test("script command surface covers executable inventory", () => {
  const rules = documentedInventoryRules();
  for (const path of REQUIRED_INVENTORY_CONCRETE) {
    expect(rules.concrete, `${SCRIPT_COMMAND_SURFACE} must document ${path}`).toContain(path);
  }
  for (const rule of REQUIRED_INVENTORY_GLOBS) {
    expect(rules.globs, `${SCRIPT_COMMAND_SURFACE} must document ${rule}`).toContain(rule);
  }
  for (const path of sourceInventoryPaths()) {
    expect(
      isCoveredByInventoryRule(path, rules),
      `${SCRIPT_COMMAND_SURFACE} does not cover ${path}`,
    ).toBe(true);
  }
  for (const path of rules.concrete) {
    expect(
      existsSync(join(REPO_ROOT, path)),
      `${SCRIPT_COMMAND_SURFACE} documents missing path: ${path}`,
    ).toBe(true);
  }
});

test("durable docs do not reference developer-local checkout paths", () => {
  for (const relativePath of durableDocPaths()) {
    const content = readRepoFile(relativePath);
    for (const pattern of DEVELOPER_CHECKOUT_PATH_PATTERNS) {
      const match = pattern.exec(content);
      expect(
        match,
        `${relativePath} contains developer-local checkout path: ${match?.[0] ?? pattern.source}`,
      ).toBeNull();
    }
  }
});

test("readme stays a concise entrypoint", () => {
  const readme = readRepoFile("README.md");
  const lines = readme.trimEnd().split(/\r?\n/);
  // Keep the root README near entrypoint size; deep details belong in docs/contributing.
  expect(lines.length, "README.md should stay a concise user entrypoint").toBeLessThanOrEqual(250);
  expect(readme).toContain("docs/contributing/index.md");
  expect(readme).toContain("~/.harness/install");
  expect(readme).toContain("./install");
  expect(readme).toContain("path/to/implementation-plan.md");
  expect(readme).toContain("npx skills add ferueda/harness");
  expect(readme).toContain("harness skills install");
  expect(readme).toContain("skills/change-review-workflow/SKILL.md");
  expect(readme).toContain("docs/contributing/script-command-surface.md");
  expect(readme).toContain("docs/contributing/setup-manifest.md");
  expect(readme).toContain("skills/sessions/SKILL.md");
  expect(readme).not.toContain("## Available Skills");
  expect(readme).not.toContain("## Session Extraction");
  expect(readme).not.toContain("dev/plans/");
  expect(readme).not.toContain("harness run review");
  expect(readme).not.toMatch(/^### [a-z0-9]+(?:-[a-z0-9]+)+$/m);
});

test("docs are covered by format and format check scripts", () => {
  const parsed: unknown = JSON.parse(readRepoFile("package.json"));
  expect(isObject(parsed) && isObject(parsed.scripts), "package.json scripts missing").toBe(true);
  if (!isObject(parsed) || !isObject(parsed.scripts)) return;
  const { scripts } = parsed;
  expect(String(scripts.format ?? ""), "package.json format script must include docs").toMatch(
    /\bdocs\b/,
  );
  expect(
    String(scripts["format:check"] ?? ""),
    "package.json format:check script must include docs",
  ).toMatch(/\bdocs\b/);
});
