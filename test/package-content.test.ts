import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SESSIONS_NODE_MODULES = "skills/sessions/node_modules/";
const SESSIONS_PACKAGE_POLICY = "skills/sessions/.npmignore";
const REQUIRED_PACKAGE_FILES = [
  "schemas/review-output.schema.json",
  "skills/sessions/SKILL.md",
  "skills/sessions/agents/openai.yaml",
  "skills/sessions/lib/core/analyze.ts",
  "skills/sessions/package.json",
  "skills/sessions/pnpm-lock.yaml",
  "skills/sessions/scripts/install.sh",
  "skills/sessions/scripts/sessions.ts",
] as const;

test("package excludes generated Sessions dependencies and keeps installable source", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-package-content-"));

  try {
    for (const path of ["package.json", "README.md", "LICENSE"] as const) {
      cpSync(join(REPO_ROOT, path), join(workspace, path));
    }
    cpSync(join(REPO_ROOT, "schemas"), join(workspace, "schemas"), { recursive: true });
    cpSync(join(REPO_ROOT, "skills/sessions"), join(workspace, "skills/sessions"), {
      recursive: true,
      filter: (source) => basename(source) !== "node_modules",
    });

    const generatedDependency = join(workspace, SESSIONS_NODE_MODULES, "generated.js");
    mkdirSync(dirname(generatedDependency), { recursive: true });
    writeFileSync(generatedDependency, "throw new Error('must not be packed');\n");

    expect(readFileSync(join(workspace, SESSIONS_PACKAGE_POLICY), "utf8").split(/\r?\n/)).toContain(
      "node_modules/",
    );

    const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: workspace,
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: join(workspace, ".npm-cache") },
    });
    const result: unknown = JSON.parse(output);
    expect(Array.isArray(result) && result.length === 1).toBe(true);
    if (!Array.isArray(result) || result.length !== 1) return;

    const packageResult: unknown = result[0];
    expect(
      typeof packageResult === "object" &&
        packageResult !== null &&
        "files" in packageResult &&
        Array.isArray(packageResult.files),
    ).toBe(true);
    if (
      typeof packageResult !== "object" ||
      packageResult === null ||
      !("files" in packageResult) ||
      !Array.isArray(packageResult.files)
    ) {
      return;
    }

    const paths = packageResult.files.flatMap((file: unknown) =>
      typeof file === "object" && file !== null && "path" in file && typeof file.path === "string"
        ? [file.path]
        : [],
    );
    expect(paths.filter((path) => path.startsWith(SESSIONS_NODE_MODULES))).toEqual([]);
    for (const path of REQUIRED_PACKAGE_FILES) expect(paths).toContain(path);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
