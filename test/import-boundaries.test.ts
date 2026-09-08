import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OXLINT = join(
  ROOT,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "oxlint.cmd" : "oxlint",
);
const CONFIG = JSON.parse(readFileSync(join(ROOT, ".oxlintrc.json"), "utf8")) as Record<
  string,
  unknown
>;

type LintResult = {
  output: string;
  status: number | null;
};

function lintFixture(relativePath: string, source: string): LintResult {
  const workspace = mkdtempSync(join(tmpdir(), "harness-import-boundaries-"));
  const fixturePath = join(workspace, relativePath);
  const configPath = join(workspace, ".oxlintrc.json");

  try {
    mkdirSync(dirname(fixturePath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ ...CONFIG, $schema: undefined }));
    writeFileSync(fixturePath, source);

    const result = spawnSync(OXLINT, ["-c", configPath, "--format=default", fixturePath], {
      cwd: workspace,
      encoding: "utf8",
    });

    if (result.error) {
      throw result.error;
    }

    return {
      output: `${result.stdout}${result.stderr}`,
      status: result.status,
    };
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
}

function expectAllowed(relativePath: string, source: string): void {
  const result = lintFixture(relativePath, source);
  expect(result).toMatchObject({ status: 0 });
  expect(result.output).not.toContain("no-restricted-imports");
}

function expectBoundaryViolation(relativePath: string, source: string, message: string): void {
  const result = lintFixture(relativePath, source);
  expect(result.status).toBe(1);
  expect(result.output).toContain("no-restricted-imports");
  expect(result.output).toContain(message);
}

describe("review and provider import boundaries", () => {
  it("keeps shared Agent support independent of reviews and providers", () => {
    expect.hasAssertions();
    expectAllowed(
      "lib/agent/allowed.ts",
      'import { readFile } from "node:fs/promises";\nvoid readFile;',
    );
    expectBoundaryViolation(
      "lib/agent/forbidden.ts",
      'import type { ReviewOutput } from "../review/schema.ts";',
      "must remain independent of reviews and concrete providers",
    );
    expectBoundaryViolation(
      "lib/agent/forbidden.ts",
      'import { createAgentProvider } from "../../providers/registry.ts";',
      "must remain independent of reviews and concrete providers",
    );
    expectBoundaryViolation(
      "lib/agent/forbidden.ts",
      'import { Codex } from "@openai/codex-sdk";',
      "must not depend on a concrete provider SDK",
    );
  });

  it("keeps review execution behind the shared Agent interface", () => {
    expect.hasAssertions();
    expectAllowed(
      "lib/review/allowed.ts",
      'import type { Agent } from "../agent/contract.ts";\nexport type { Agent };',
    );
    expectBoundaryViolation(
      "lib/review/forbidden.ts",
      'import { createAgentProvider } from "../../providers/registry.ts";',
      "must remain independent of concrete providers",
    );
    expectBoundaryViolation(
      "lib/review/forbidden.ts",
      'import { Codex } from "@openai/codex-sdk";',
      "depends on the shared Agent interface",
    );
  });

  it("keeps provider adapters independent of review policy", () => {
    expect.hasAssertions();
    expectAllowed(
      "providers/codex/allowed.ts",
      'import type { Agent } from "../../lib/agent/contract.ts";\nexport type { Agent };',
    );
    expectBoundaryViolation(
      "providers/codex/forbidden.ts",
      'import { SPEC_REVIEW_PROMPT } from "../../lib/review/prompts/spec-review.ts";',
      "must remain independent of review policy and workflows",
    );
    expectBoundaryViolation(
      "providers/codex/forbidden.ts",
      'import { run } from "../../workflows/plan-review.workflow.ts";',
      "must remain independent of review policy and workflows",
    );
  });
});
