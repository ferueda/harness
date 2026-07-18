import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test("provider-shaped repeated setup keeps the prepared shared pnpm store offline", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-setup-worktree-"));
  const workspace = join(root, "workspace");
  const dependency = join(workspace, "dependency");
  const sharedStore = join(root, "shared-store/v11");
  const fakeBin = join(root, "bin");
  const pnpmLog = join(root, "pnpm.jsonl");
  mkdirSync(dependency, { recursive: true });
  mkdirSync(fakeBin);
  writeFileSync(
    join(workspace, "package.json"),
    `${JSON.stringify(
      {
        name: "setup-worktree-fixture",
        private: true,
        dependencies: { "fixture-dependency": "file:dependency" },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(dependency, "package.json"),
    `${JSON.stringify({ name: "fixture-dependency", version: "1.0.0" }, null, 2)}\n`,
  );
  writeFileSync(join(dependency, "index.js"), "export const fixture = true;\n");
  writeFileSync(join(workspace, ".gitignore"), readFileSync(join(REPO_ROOT, ".gitignore")));

  const realPnpm = realpathSync(
    execFileSync("sh", ["-c", "command -v pnpm"], { encoding: "utf8" }).trim(),
  );
  const fakePnpm = join(fakeBin, "pnpm");
  writeFileSync(
    fakePnpm,
    `#!/usr/bin/env node
const { appendFileSync, realpathSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
appendFileSync(process.env.PNPM_LOG, JSON.stringify({
  args,
  storeOverride: process.env.PNPM_CONFIG_STORE_DIR ?? null,
}) + "\\n");
if (args[0] === "store" && args[1] === "path") {
  if (process.env.PNPM_CONFIG_STORE_DIR || process.env.pnpm_config_store_dir) process.exit(86);
  process.stdout.write(realpathSync(process.env.EXPECTED_STORE) + "\\n");
  process.exit(0);
}
const result = spawnSync(process.env.REAL_PNPM, args, {
  env: process.env,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
`,
    { mode: 0o755 },
  );

  try {
    const seedEnv = { ...process.env };
    delete seedEnv.PNPM_CONFIG_STORE_DIR;
    delete seedEnv.pnpm_config_store_dir;
    delete seedEnv.NPM_CONFIG_STORE_DIR;
    delete seedEnv.npm_config_store_dir;
    execFileSync(realPnpm, ["install", "--lockfile-only", "--offline", "--ignore-scripts"], {
      cwd: workspace,
      env: seedEnv,
      stdio: "ignore",
    });
    rmSync(join(workspace, "node_modules"), { recursive: true, force: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: workspace });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: workspace });
    execFileSync("git", ["add", "."], { cwd: workspace });
    execFileSync("git", ["commit", "-m", "fixture"], { cwd: workspace, stdio: "ignore" });
    mkdirSync(sharedStore, { recursive: true });

    const baseEnv = {
      ...process.env,
      EXPECTED_STORE: sharedStore,
      PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
      PNPM_LOG: pnpmLog,
      REAL_PNPM: realPnpm,
    };
    execFileSync("make", ["-f", join(REPO_ROOT, "Makefile"), "setup-worktree"], {
      cwd: workspace,
      env: baseEnv,
      stdio: "ignore",
    });
    const dependencyInode = lstatSync(join(workspace, "node_modules/fixture-dependency")).ino;

    const providerEnv = {
      ...baseEnv,
      PNPM_CONFIG_STORE_DIR: ".pnpm-store",
      pnpm_config_store_dir: ".lowercase-pnpm-store",
    };
    execFileSync("make", ["-f", join(REPO_ROOT, "Makefile"), "setup-worktree"], {
      cwd: workspace,
      env: providerEnv,
      stdio: "ignore",
    });
    execFileSync("make", ["-f", join(REPO_ROOT, "Makefile"), "setup-worktree"], {
      cwd: workspace,
      env: providerEnv,
      stdio: "ignore",
    });

    const modules = JSON.parse(
      readFileSync(join(workspace, "node_modules/.modules.yaml"), "utf8"),
    ) as { storeDir?: string };
    expect(modules.storeDir).toBe(realpathSync(sharedStore));
    expect(lstatSync(join(workspace, "node_modules/fixture-dependency")).ino).toBe(dependencyInode);
    expect(existsSync(join(workspace, ".pnpm-store"))).toBe(false);

    const calls = readFileSync(pnpmLog, "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            args: string[];
            storeOverride: string | null;
          },
      );
    expect(calls.filter(({ args }) => args[0] === "store")).toEqual(
      Array.from({ length: 3 }, () => ({
        args: ["store", "path"],
        storeOverride: null,
      })),
    );
    const installs = calls.filter(({ args }) => args[0] === "install");
    expect(installs).toHaveLength(3);
    for (const call of installs) {
      expect(call.args).toEqual(["install", "--frozen-lockfile", "--offline"]);
      expect(call.storeOverride).toBe(realpathSync(sharedStore));
    }

    mkdirSync(join(workspace, ".pnpm-store/v11"), { recursive: true });
    writeFileSync(join(workspace, ".pnpm-store/v11/index.db"), "transient cache\n");
    expect(
      execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
        cwd: workspace,
        encoding: "utf8",
      }),
    ).toBe("");

    const blocked = spawnSync("make", ["-f", join(REPO_ROOT, "Makefile"), "setup-worktree"], {
      cwd: workspace,
      env: { ...providerEnv, REAL_PNPM: join(root, "missing-pnpm") },
      encoding: "utf8",
    });
    expect(blocked.status).not.toBe(0);
    expect(
      execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
        cwd: workspace,
        encoding: "utf8",
      }),
    ).toBe("");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
