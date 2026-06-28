import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { applyWorkspaceGuard, readWorkspaceStatus, withWorkspaceGuard } from "./review-guard.ts";

function createGitWorkspace() {
  const workspace = mkdtempSync(join(tmpdir(), "harness-review-guard-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "harness@example.com"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "Harness Test"], { cwd: workspace });
  writeFileSync(join(workspace, "README.md"), "# Test\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: workspace, stdio: "ignore" });
  return workspace;
}

test("applyWorkspaceGuard preserves successful result when post-run status is unreadable", () => {
  const result = applyWorkspaceGuard(
    {
      ok: true,
      structuredOutput: { verdict: "pass" },
      raw: { status: "finished" },
    },
    "",
    {
      ok: false,
      error: {
        ok: false,
        error: "git unavailable",
        exitCode: 1,
      },
    },
  );

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.structuredOutput).toEqual({ verdict: "pass" });
  expect(result.raw).toMatchObject({
    status: "finished",
    workspaceStatus: {
      before: "",
      guard: "unverified",
    },
  });
});

test("applyWorkspaceGuard preserves aborted failure when post-run status is unreadable", () => {
  const result = applyWorkspaceGuard(
    {
      ok: false,
      error: "Agent was aborted",
      exitCode: 130,
      aborted: true,
      raw: { aborted: true },
    },
    "",
    {
      ok: false,
      error: {
        ok: false,
        error: "git unavailable",
        exitCode: 1,
      },
    },
  );

  expect(result).toMatchObject({
    ok: false,
    error: "Agent was aborted",
    exitCode: 130,
    aborted: true,
  });
  expect(result.raw).toMatchObject({
    aborted: true,
    workspaceStatus: {
      before: "",
      guard: "unverified",
    },
  });
});

test("withWorkspaceGuard fails when workspace porcelain changes", () => {
  const workspace = createGitWorkspace();
  const before = readWorkspaceStatus(workspace);
  expect(before.ok).toBe(true);
  if (!before.ok) return;

  writeFileSync(join(workspace, "dirty.txt"), "changed\n", "utf8");

  const result = withWorkspaceGuard(
    {
      ok: true,
      structuredOutput: { verdict: "pass" },
      raw: { status: "finished" },
    },
    workspace,
    before.value,
  );

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toMatch(/modified the workspace/);
  expect(result.raw).toMatchObject({
    workspaceStatus: {
      before: before.value,
    },
  });
  expect(result.raw).not.toHaveProperty("underlyingFailure");
});

test("withWorkspaceGuard passes when workspace is unchanged", () => {
  const workspace = createGitWorkspace();
  const before = readWorkspaceStatus(workspace);
  expect(before.ok).toBe(true);
  if (!before.ok) return;

  const result = withWorkspaceGuard(
    {
      ok: true,
      structuredOutput: { verdict: "pass" },
      raw: { status: "finished" },
    },
    workspace,
    before.value,
  );

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.raw).toMatchObject({
    workspaceStatus: {
      before: before.value,
      after: before.value,
    },
  });
});
