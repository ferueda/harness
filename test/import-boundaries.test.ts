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

    const result = spawnSync(OXLINT, ["-c", configPath, fixturePath], {
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
  expect(result).toEqual({ output: "", status: 0 });
}

function expectBoundaryViolation(relativePath: string, source: string, message: string): void {
  const result = lintFixture(relativePath, source);
  expect(result.status).toBe(1);
  expect(result.output).toContain("no-restricted-imports");
  expect(result.output).toContain(message);
}

describe("automation import boundaries", () => {
  it("keeps Linear primitives independent of domain and delivery code", () => {
    expect.hasAssertions();
    expectAllowed(
      "lib/linear/allowed.ts",
      'import { LinearError } from "./error.ts";\nvoid LinearError;',
    );
    expectBoundaryViolation(
      "lib/linear/forbidden.ts",
      'import { triageIssue } from "../triage/triage.ts";',
      "domain and delivery policy belong outside lib/linear",
    );
    expectBoundaryViolation(
      "lib/linear/forbidden.ts",
      'import { Inngest } from "inngest";',
      "Linear service primitives must not depend on delivery code",
    );
  });

  it("keeps domain operations independent of systems and concrete providers", () => {
    expect.hasAssertions();
    expectAllowed(
      "lib/spec/allowed.ts",
      'import type { Agent } from "../agents.ts";\ntype AgentContract = Agent;\nexport type { AgentContract };',
    );
    expectBoundaryViolation(
      "lib/spec/forbidden.ts",
      'import type { LinearService } from "../linear/client.ts";',
      "use injected service, provider, and repository interfaces",
    );
    expectBoundaryViolation(
      "lib/spec/forbidden.ts",
      'import { LinearWebhookClient } from "@linear/sdk/webhooks";',
      "receive normalized input instead of importing Linear",
    );
    expectBoundaryViolation(
      "lib/spec/forbidden.ts",
      'import { createAgentProvider } from "../../providers/registry.ts";',
      "use injected service, provider, and repository interfaces",
    );
  });

  it("keeps repository primitives independent of tracker and domain policy", () => {
    expect.hasAssertions();
    expectAllowed(
      "lib/repository/allowed.ts",
      'import { mkdir } from "node:fs/promises";\nvoid mkdir;',
    );
    expectBoundaryViolation(
      "lib/repository/forbidden.ts",
      'import type { LinearService } from "../linear/client.ts";',
      "not tracker or domain policy",
    );
  });

  it("keeps provider adapters independent of tracker and domain operations", () => {
    expect.hasAssertions();
    expectAllowed(
      "providers/codex/allowed.ts",
      'import type { Agent } from "../../lib/agents.ts";\ntype AgentContract = Agent;\nexport type { AgentContract };',
    );
    expectBoundaryViolation(
      "providers/codex/forbidden.ts",
      'import { triageIssue } from "../../lib/triage/triage.ts";',
      "must not import tracker or domain operations",
    );
  });
});
