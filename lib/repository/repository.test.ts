import {
  createGrove,
  readLeaseFirstState,
  transitionLease,
  transitionSlot,
  writeLeaseFirstState,
} from "@ferueda/grove";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { RepositoryError } from "./error.ts";
import { createRepository } from "./repository.ts";
import { repositorySetupEnvironment } from "./setup.ts";
import type { CreateRepositoryOptions, RepositoryRun } from "./types.ts";

const roots: string[] = [];
const SETUP_STATE = "node_modules/.harness-setup.json";
const SETUP_SCRIPT = [
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  'const cp = require("node:child_process");',
  `const target = path.join(process.cwd(), ${JSON.stringify(SETUP_STATE)});`,
  "fs.mkdirSync(path.dirname(target), { recursive: true });",
  "let previous = { calls: 0 };",
  'try { previous = JSON.parse(fs.readFileSync(target, "utf8")); } catch {}',
  'const branch = cp.execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim();',
  "const forbidden = Object.keys(process.env).filter((key) => /^(?:LINEAR|INNGEST|GITHUB|CODEX)_/.test(key));",
  "fs.writeFileSync(target, JSON.stringify({ calls: previous.calls + 1, branch, forbidden, ci: process.env.CI }));",
].join("\n");

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repository runs resolve an exact base, reacquire dirty work, and inspect plain changes", async () => {
  const fixture = createFixture();
  const repository = createTestRepository(fixture);
  const base = await repository.resolveBase({ baseRef: "main" });
  await expect(repository.resolveBase({ baseRef: "origin/main" })).resolves.toEqual({
    ...base,
    baseRef: "origin/main",
  });
  await expect(repository.resolveBase({ baseRef: "refs/remotes/origin/main" })).resolves.toEqual({
    ...base,
    baseRef: "refs/remotes/origin/main",
  });
  await expect(repository.resolveBase({ baseRef: base.baseSha })).resolves.toEqual({
    ...base,
    baseRef: base.baseSha,
  });
  for (const baseRef of ["main~1", "origin/main^", "refs/remotes/origin/main~1"]) {
    await expect(repository.resolveBase({ baseRef })).rejects.toMatchObject({
      code: "invalid_input",
    });
  }
  const run = await repository.prepareRun({
    id: "run-inspect",
    base,
    branch: "codex/inspect",
  });

  expect(run).toEqual({
    version: 1,
    id: "run-inspect",
    workspace: run.workspace,
    remote: fixture.remote,
    baseRef: "main",
    baseSha: base.baseSha,
    branch: "codex/inspect",
  });
  expect(git(run.workspace, ["rev-parse", "HEAD"])).toBe(base.baseSha);
  expect(readSetup(run)).toEqual({
    calls: 1,
    branch: "codex/inspect",
    forbidden: [],
    ci: "1",
  });
  expect(existsSync(join(fixture.source, "node_modules"))).toBe(false);

  writeFileSync(join(run.workspace, "README.md"), "# changed\n", "utf8");
  unlinkSync(join(run.workspace, "delete-me.txt"));
  renameSync(join(run.workspace, "rename-me.txt"), join(run.workspace, "renamed.txt"));
  git(run.workspace, ["add", "-A"]);
  writeFileSync(join(run.workspace, "untracked.txt"), "new\n", "utf8");

  expect(await repository.inspectChanges(run)).toEqual(
    expect.arrayContaining([
      { path: "README.md", status: "modified" },
      { path: "delete-me.txt", status: "deleted" },
      { path: "renamed.txt", previousPath: "rename-me.txt", status: "renamed" },
      { path: "untracked.txt", status: "untracked" },
    ]),
  );

  const reacquired = await repository.prepareRun({
    id: run.id,
    base,
    branch: run.branch,
  });
  expect(reacquired.workspace).toBe(run.workspace);
  expect(readFileSync(join(reacquired.workspace, "README.md"), "utf8")).toBe("# changed\n");
  expect(readSetup(reacquired).calls).toBe(2);

  await expect(
    repository.prepareRun({
      id: run.id,
      base,
      branch: "codex/a-different-target",
    }),
  ).rejects.toMatchObject({ code: "run_conflict" });

  advanceRemote(fixture);
  expect(git(run.workspace, ["rev-parse", "HEAD"])).toBe(base.baseSha);
  const newerBase = await repository.resolveBase({ baseRef: "main" });
  expect(newerBase.baseSha).not.toBe(base.baseSha);

  git(fixture.source, ["branch", "stale", "main"]);
  git(fixture.source, ["push", "origin", "stale"]);
  await repository.resolveBase({ baseRef: "stale" });
  git(fixture.controller, ["branch", "stale", "refs/remotes/origin/stale"]);
  git(fixture.source, ["push", "origin", "--delete", "stale"]);
  await expect(repository.resolveBase({ baseRef: "stale" })).rejects.toMatchObject({
    code: "controller_failed",
  });
});

test("repository cleanup reuses a bounded warm pool while preserving ignored dependencies", async () => {
  const fixture = createFixture();
  const repository = createTestRepository(fixture, { maxTrees: 2 });
  const base = await repository.resolveBase({ baseRef: "main" });
  const first = await repository.prepareRun({
    id: "run-first",
    base,
    branch: "codex/first",
  });
  const second = await repository.prepareRun({
    id: "run-second",
    base,
    branch: "codex/second",
  });
  expect(second.workspace).not.toBe(first.workspace);

  await expect(
    repository.prepareRun({
      id: "run-over-capacity",
      base,
      branch: "codex/over-capacity",
    }),
  ).rejects.toMatchObject({ code: "pool_exhausted" });

  writeFileSync(join(first.workspace, "README.md"), "# disposable\n", "utf8");
  writeFileSync(join(first.workspace, "agent-output.txt"), "remove me\n", "utf8");
  const active = spawn(
    process.execPath,
    ["-e", 'process.stdout.write("ready"); setInterval(() => {}, 1_000);'],
    {
      cwd: first.workspace,
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const activeExit = once(active, "exit");
  try {
    await once(active.stdout, "data");
    await expect(repository.cleanupRun(first)).rejects.toMatchObject({
      code: "cleanup_failed",
    });
    expect(readFileSync(join(first.workspace, "agent-output.txt"), "utf8")).toBe("remove me\n");
  } finally {
    if (active.exitCode === null) active.kill("SIGTERM");
    await activeExit;
  }

  expect(await repository.cleanupRun(first)).toEqual({ status: "released" });
  expect(await repository.cleanupRun(first)).toEqual({ status: "already-clean" });

  const afterRestart = createTestRepository(fixture, { maxTrees: 2 });
  const reused = await afterRestart.prepareRun({
    id: "run-reused",
    base,
    branch: "codex/reused",
  });
  expect(reused.workspace).toBe(first.workspace);
  expect(readFileSync(join(reused.workspace, "README.md"), "utf8")).toBe("# Fixture\n");
  expect(existsSync(join(reused.workspace, "agent-output.txt"))).toBe(false);
  expect(readSetup(reused).calls).toBe(2);

  expect(await afterRestart.cleanupRun(reused)).toEqual({ status: "released" });
  expect(await afterRestart.cleanupRun(second)).toEqual({ status: "released" });
});

test("setup failure keeps the same lease and retries with a secret-free environment", async () => {
  const fixture = createFixture();
  const failOnceScript = [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const marker = path.join(process.cwd(), "node_modules/.failed-once");',
    "fs.mkdirSync(path.dirname(marker), { recursive: true });",
    'if (!fs.existsSync(marker)) { fs.writeFileSync(marker, "failed"); process.exit(23); }',
    'fs.writeFileSync(path.join(process.cwd(), "node_modules/.ready"), "ready");',
  ].join("\n");
  const options = repositoryOptions(fixture, {
    setup: {
      command: [process.execPath, "-e", failOnceScript],
      timeoutMs: 10_000,
    },
  });
  const repository = createRepository(options);
  const base = await repository.resolveBase({ baseRef: "main" });
  const input = { id: "run-setup-retry", base, branch: "codex/setup-retry" };

  await expect(repository.prepareRun(input)).rejects.toMatchObject({ code: "setup_failed" });
  const grove = await createGrove({
    repoRoot: fixture.controller,
    groveDir: fixture.pool,
    maxTrees: 2,
    fetchOnAcquire: false,
  });
  const retained = await grove.inspect(input.id);
  expect(retained?.state).toBe("leased");

  const run = await repository.prepareRun(input);
  expect(run.workspace).toBe(retained?.path);
  expect(readFileSync(join(run.workspace, "node_modules/.ready"), "utf8")).toBe("ready");
  expect(await repository.cleanupRun(run)).toEqual({ status: "released" });

  expect(
    repositorySetupEnvironment({
      PATH: "/usr/bin",
      HOME: "/tmp/home",
      LINEAR_API_KEY: "linear-secret",
      INNGEST_SIGNING_KEY: "inngest-secret",
      GITHUB_TOKEN: "github-secret",
      CODEX_API_KEY: "codex-secret",
    }),
  ).toEqual({
    CI: "1",
    GIT_TERMINAL_PROMPT: "0",
    HOME: "/tmp/home",
    PATH: "/usr/bin",
  });
});

test("interrupted Grove acquire and cleanup resume through matching repair intents", async () => {
  const fixture = createFixture();
  const repository = createTestRepository(fixture);
  const base = await repository.resolveBase({ baseRef: "main" });
  const first = await repository.prepareRun({
    id: "run-repair-acquire",
    base,
    branch: "codex/repair-acquire",
  });
  const state = await readLeaseFirstState(fixture.pool, { repoRoot: fixture.controller });
  const leaseIndex = state.leases.findIndex((lease) => lease.leaseId === first.id);
  const leased = state.leases[leaseIndex];
  if (!leased?.target) throw new Error("expected acquired Grove target");
  state.leases[leaseIndex] = {
    ...leased,
    state: "preparing",
    target: undefined,
    acquiredHeadSha: undefined,
    currentHeadSha: undefined,
    pendingAcquire: {
      target: leased.target,
      startedAt: new Date().toISOString(),
      postCreatePending: false,
    },
  };
  await writeLeaseFirstState(fixture.pool, state);

  const repairedAcquire = await repository.prepareRun({
    id: first.id,
    base,
    branch: first.branch,
  });
  expect(repairedAcquire.workspace).toBe(first.workspace);

  const cleanupState = await readLeaseFirstState(fixture.pool, {
    repoRoot: fixture.controller,
  });
  const cleanupLeaseIndex = cleanupState.leases.findIndex(
    (lease) => lease.leaseId === repairedAcquire.id,
  );
  const cleanupLease = cleanupState.leases[cleanupLeaseIndex];
  if (!cleanupLease) throw new Error("expected Grove cleanup lease");
  cleanupState.leases[cleanupLeaseIndex] = transitionLease(cleanupLease, {
    type: "RELEASE_START",
    cleanup: { cleanup: "reset", resetTo: base.baseSha, force: true },
  })!;
  await writeLeaseFirstState(fixture.pool, cleanupState);

  expect(await repository.cleanupRun(repairedAcquire)).toEqual({ status: "released" });

  const quarantined = await repository.prepareRun({
    id: "run-repair-quarantine",
    base,
    branch: "codex/repair-quarantine",
  });
  const quarantineState = await readLeaseFirstState(fixture.pool, {
    repoRoot: fixture.controller,
  });
  const quarantineLeaseIndex = quarantineState.leases.findIndex(
    (lease) => lease.leaseId === quarantined.id,
  );
  const quarantineLease = quarantineState.leases[quarantineLeaseIndex];
  const quarantineSlotIndex = quarantineState.slots.findIndex(
    (slot) => slot.slotName === quarantineLease?.slotName,
  );
  const quarantineSlot = quarantineState.slots[quarantineSlotIndex];
  if (!quarantineLease || !quarantineSlot) throw new Error("expected Grove quarantine state");
  const releasing = transitionLease(quarantineLease, {
    type: "RELEASE_START",
    cleanup: { cleanup: "reset", resetTo: base.baseSha, force: true },
  });
  if (!releasing) throw new Error("expected releasing lease");
  quarantineState.leases[quarantineLeaseIndex] = transitionLease(releasing, {
    type: "RELEASE_FAILED",
    reason: "simulated interruption",
    failedPhase: "reset",
  })!;
  const quarantinedSlot = transitionSlot(quarantineSlot, {
    type: "QUARANTINE",
    reason: "simulated interruption",
  });
  if (!quarantinedSlot) throw new Error("expected quarantined Grove slot");
  quarantineState.slots[quarantineSlotIndex] = quarantinedSlot;
  await writeLeaseFirstState(fixture.pool, quarantineState);

  expect(await repository.cleanupRun(quarantined)).toEqual({ status: "released" });
});

test("repository rejects credential-bearing remotes and overlapping storage", async () => {
  const fixture = createFixture();
  const credentialed = createRepository({
    ...repositoryOptions(fixture),
    remote: "https://token@example.com/repository.git",
  });
  await expect(credentialed.resolveBase({ baseRef: "main" })).rejects.toMatchObject({
    code: "invalid_input",
  });

  expect(() =>
    createRepository({
      ...repositoryOptions(fixture),
      poolDirectory: join(fixture.controller, "pool"),
    }),
  ).toThrow(RepositoryError);
});

test("failed Git inspection reports the inspection boundary", async () => {
  const fixture = createFixture();
  const repository = createTestRepository(fixture);
  const base = await repository.resolveBase({ baseRef: "main" });
  const run = await repository.prepareRun({
    id: "run-inspection-error",
    base,
    branch: "codex/inspection-error",
  });
  const unavailable = `${run.workspace}-unavailable`;
  renameSync(run.workspace, unavailable);
  try {
    await expect(repository.inspectChanges(run)).rejects.toMatchObject({
      code: "inspect_failed",
    });
  } finally {
    renameSync(unavailable, run.workspace);
  }
  expect(await repository.cleanupRun(run)).toEqual({ status: "released" });
});

type Fixture = Readonly<{
  root: string;
  remote: string;
  source: string;
  controller: string;
  pool: string;
}>;

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "harness-repository-"));
  roots.push(root);
  const remote = join(root, "remote.git");
  const source = join(root, "source");
  const controller = join(root, "storage", "controller");
  const pool = join(root, "storage", "grove");

  git(root, ["init", "--bare", remote]);
  git(root, ["clone", remote, source]);
  git(source, ["config", "user.email", "harness@example.com"]);
  git(source, ["config", "user.name", "Harness Test"]);
  writeFileSync(join(source, ".gitignore"), "node_modules/\n", "utf8");
  writeFileSync(join(source, "README.md"), "# Fixture\n", "utf8");
  writeFileSync(join(source, "delete-me.txt"), "delete\n", "utf8");
  writeFileSync(join(source, "rename-me.txt"), "rename\n", "utf8");
  git(source, ["add", "."]);
  git(source, ["commit", "-m", "Initialize fixture"]);
  git(source, ["branch", "-M", "main"]);
  git(source, ["push", "--set-upstream", "origin", "main"]);
  git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);

  return Object.freeze({ root, remote, source, controller, pool });
}

function createTestRepository(fixture: Fixture, overrides: Partial<CreateRepositoryOptions> = {}) {
  return createRepository(repositoryOptions(fixture, overrides));
}

function repositoryOptions(
  fixture: Fixture,
  overrides: Partial<CreateRepositoryOptions> = {},
): CreateRepositoryOptions {
  return {
    remote: fixture.remote,
    controllerWorkspace: fixture.controller,
    poolDirectory: fixture.pool,
    maxTrees: 2,
    setup: {
      command: [process.execPath, "-e", SETUP_SCRIPT],
      timeoutMs: 10_000,
    },
    setupEnvironment: {
      ...process.env,
      LINEAR_API_KEY: "linear-secret",
      INNGEST_SIGNING_KEY: "inngest-secret",
      GITHUB_TOKEN: "github-secret",
      CODEX_API_KEY: "codex-secret",
    },
    ...overrides,
  };
}

function readSetup(run: RepositoryRun): {
  calls: number;
  branch: string;
  forbidden: string[];
  ci: string;
} {
  return JSON.parse(readFileSync(join(run.workspace, SETUP_STATE), "utf8")) as {
    calls: number;
    branch: string;
    forbidden: string[];
    ci: string;
  };
}

function advanceRemote(fixture: Fixture): void {
  writeFileSync(join(fixture.source, "newer.txt"), "newer\n", "utf8");
  git(fixture.source, ["add", "newer.txt"]);
  git(fixture.source, ["commit", "-m", "Advance fixture"]);
  git(fixture.source, ["push", "origin", "main"]);
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
