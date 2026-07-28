import { readLeaseFirstState, transitionLease, writeLeaseFirstState } from "@ferueda/grove";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createRepository } from "./repository.ts";
import type {
  RepositoryBase,
  RepositoryCheckpoint,
  RepositoryRun,
  RepositoryService,
} from "./types.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("opens an exact checkpoint from a new repository service without rerunning setup", async () => {
  const fixture = createFixture();
  const created = await createCheckpoint(fixture, "open-success");
  const setupCalls = join(created.run.workspace, "node_modules/.setup-calls");
  expect(readFile(setupCalls)).toBe("1");

  const afterRestart = createTestRepository(fixture);
  const opened = await afterRestart.openCheckpoint({
    checkpoint: JSON.parse(JSON.stringify(created.checkpoint)) as RepositoryCheckpoint,
    baseRef: created.base.baseRef,
  });

  expect(opened).toEqual(created.run);
  expect(readFile(setupCalls)).toBe("1");
  expect(JSON.stringify(created.checkpoint)).not.toContain(created.run.workspace);
  await expect(afterRestart.cleanupRun(opened)).resolves.toEqual({ status: "released" });
});

test("rejects a checkpoint when HEAD has advanced and leaves the newer checkpoint untouched", async () => {
  const fixture = createFixture();
  const created = await createCheckpoint(fixture, "open-newer");
  writeFileSync(join(created.run.workspace, "second.md"), "# Second\n", "utf8");
  const second = await created.repository.checkpointRun({
    id: "checkpoint:open-newer:second",
    run: created.run,
    expectedParentRevision: created.checkpoint.revision,
    expectedChanges: await created.repository.inspectChanges(created.run),
    message: "Add second checkpoint",
  });
  const before = repositoryState(created.run.workspace);

  await expect(
    createTestRepository(fixture).openCheckpoint({
      checkpoint: created.checkpoint,
      baseRef: created.base.baseRef,
    }),
  ).rejects.toMatchObject({ code: "run_conflict" });

  expect(repositoryState(created.run.workspace)).toEqual(before);
  expect(before.head).toBe(second.revision);
});

test("rejects every dirty workspace category without changing the workspace", async () => {
  const fixture = createFixture();
  const created = await createCheckpoint(fixture, "open-dirty");
  const repository = createTestRepository(fixture);
  const mutations: ReadonlyArray<Readonly<{ name: string; apply(): void }>> = [
    {
      name: "tracked",
      apply: () => writeFileSync(join(created.run.workspace, "README.md"), "# Changed\n", "utf8"),
    },
    {
      name: "staged",
      apply: () => {
        writeFileSync(join(created.run.workspace, "README.md"), "# Staged\n", "utf8");
        git(created.run.workspace, ["add", "README.md"]);
      },
    },
    {
      name: "untracked",
      apply: () => writeFileSync(join(created.run.workspace, "untracked.md"), "keep\n", "utf8"),
    },
    {
      name: "renamed",
      apply: () =>
        renameSync(
          join(created.run.workspace, "rename-me.txt"),
          join(created.run.workspace, "renamed.txt"),
        ),
    },
    {
      name: "deleted",
      apply: () => unlinkSync(join(created.run.workspace, "delete-me.txt")),
    },
  ];

  for (const mutation of mutations) {
    mutation.apply();
    const before = repositoryState(created.run.workspace);
    await expect(
      repository.openCheckpoint({
        checkpoint: created.checkpoint,
        baseRef: created.base.baseRef,
      }),
    ).rejects.toMatchObject({ code: "run_conflict" });
    expect(repositoryState(created.run.workspace)).toEqual(before);
    git(created.run.workspace, ["reset", "--hard", "HEAD"]);
    git(created.run.workspace, ["clean", "-fd"]);
  }
});

test("rejects lease, owner, base, branch, and origin mismatches without repairing them", async () => {
  const fixture = createFixture();
  const created = await createCheckpoint(fixture, "open-identity");

  await expect(
    createTestRepository(fixture, "another-owner").openCheckpoint({
      checkpoint: created.checkpoint,
      baseRef: created.base.baseRef,
    }),
  ).rejects.toMatchObject({ code: "run_conflict" });
  await expect(
    createTestRepository(fixture).openCheckpoint({
      checkpoint: created.checkpoint,
      baseRef: "another-base",
    }),
  ).rejects.toMatchObject({ code: "run_conflict" });
  await expect(
    createTestRepository(fixture).openCheckpoint({
      checkpoint: { ...created.checkpoint, runId: "missing-run" },
      baseRef: created.base.baseRef,
    }),
  ).rejects.toMatchObject({ code: "run_conflict" });

  git(created.run.workspace, ["remote", "set-url", "origin", `${fixture.remote}-changed`]);
  await expect(
    createTestRepository(fixture).openCheckpoint({
      checkpoint: created.checkpoint,
      baseRef: created.base.baseRef,
    }),
  ).rejects.toMatchObject({ code: "run_conflict" });
  expect(git(created.run.workspace, ["remote", "get-url", "origin"])).toBe(
    `${fixture.remote}-changed`,
  );
  git(created.run.workspace, ["remote", "set-url", "origin", fixture.remote]);

  git(created.run.workspace, ["branch", "-m", "codex/open-identity-moved"]);
  await expect(
    createTestRepository(fixture).openCheckpoint({
      checkpoint: created.checkpoint,
      baseRef: created.base.baseRef,
    }),
  ).rejects.toMatchObject({ code: "run_conflict" });
  expect(git(created.run.workspace, ["branch", "--show-current"])).toBe(
    "codex/open-identity-moved",
  );
});

test("rejects inactive Grove leases without changing their state", async () => {
  const fixture = createFixture();
  const created = await createCheckpoint(fixture, "open-inactive");
  const state = await readLeaseFirstState(fixture.pool, { repoRoot: fixture.controller });
  const leaseIndex = state.leases.findIndex((lease) => lease.leaseId === created.run.id);
  const lease = state.leases[leaseIndex];
  if (!lease) throw new Error("expected active Grove lease");
  const releasing = transitionLease(lease, {
    type: "RELEASE_START",
    cleanup: { cleanup: "reset", resetTo: created.base.baseSha, force: true },
  });
  if (!releasing) throw new Error("expected releasing Grove lease");
  state.leases[leaseIndex] = releasing;
  await writeLeaseFirstState(fixture.pool, state);

  await expect(
    createTestRepository(fixture).openCheckpoint({
      checkpoint: created.checkpoint,
      baseRef: created.base.baseRef,
    }),
  ).rejects.toMatchObject({ code: "run_conflict" });

  const unchanged = await readLeaseFirstState(fixture.pool, { repoRoot: fixture.controller });
  expect(unchanged.leases[leaseIndex]?.state).toBe("releasing");
  expect(repositoryState(created.run.workspace).head).toBe(created.checkpoint.revision);
});

test("rejects missing refs and altered durable checkpoint fields without restoring them", async () => {
  const fixture = createFixture();
  const created = await createCheckpoint(fixture, "open-record");
  const repository = createTestRepository(fixture);
  const checkpointRef = git(created.run.workspace, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/harness/checkpoints/v1",
  ]);
  git(created.run.workspace, ["update-ref", "-d", checkpointRef]);

  await expect(
    repository.openCheckpoint({
      checkpoint: created.checkpoint,
      baseRef: created.base.baseRef,
    }),
  ).rejects.toMatchObject({ code: "run_conflict" });
  expect(git(created.run.workspace, ["rev-parse", "--verify", "--quiet", checkpointRef], [1])).toBe(
    "",
  );

  git(created.run.workspace, ["update-ref", checkpointRef, created.checkpoint.revision]);
  await expect(
    repository.openCheckpoint({
      checkpoint: {
        ...created.checkpoint,
        parentRevision: created.checkpoint.revision,
      },
      baseRef: created.base.baseRef,
    }),
  ).rejects.toMatchObject({ code: "run_conflict" });
  await expect(
    repository.openCheckpoint({
      checkpoint: {
        ...created.checkpoint,
        changes: [{ path: "different.md", status: "added" }],
      },
      baseRef: created.base.baseRef,
    }),
  ).rejects.toMatchObject({ code: "run_conflict" });
  await expect(
    repository.openCheckpoint({
      checkpoint: {
        ...created.checkpoint,
        revision: "a".repeat(41),
      },
      baseRef: created.base.baseRef,
    }),
  ).rejects.toMatchObject({ code: "invalid_input" });
  await expect(
    repository.openCheckpoint({
      checkpoint: {
        ...created.checkpoint,
        version: 2 as 1,
      },
      baseRef: created.base.baseRef,
    }),
  ).rejects.toMatchObject({ code: "invalid_input" });
  expect(repositoryState(created.run.workspace)).toEqual({
    head: created.checkpoint.revision,
    status: "",
  });
});

test("rejects altered checkpoint trailers and preserves the altered commit", async () => {
  const fixture = createFixture();
  const created = await createCheckpoint(fixture, "open-trailers");
  const message = git(created.run.workspace, [
    "show",
    "-s",
    "--format=%B",
    created.checkpoint.revision,
  ]).replace(`Harness-Run-ID: ${created.run.id}`, "Harness-Run-ID: another-run");
  git(created.run.workspace, [
    "-c",
    "user.name=Harness",
    "-c",
    "user.email=harness@localhost",
    "commit",
    "--amend",
    "--no-gpg-sign",
    "--no-verify",
    "--cleanup=verbatim",
    "--author=Harness <harness@localhost>",
    "-m",
    message,
  ]);
  const alteredRevision = git(created.run.workspace, ["rev-parse", "HEAD"]);
  git(created.run.workspace, [
    "update-ref",
    checkpointRefFor(created.run.workspace),
    alteredRevision,
  ]);

  await expect(
    createTestRepository(fixture).openCheckpoint({
      checkpoint: { ...created.checkpoint, revision: alteredRevision },
      baseRef: created.base.baseRef,
    }),
  ).rejects.toMatchObject({ code: "run_conflict" });
  expect(repositoryState(created.run.workspace)).toEqual({
    head: alteredRevision,
    status: "",
  });
});

test("rejects annotated-tag and symbolic checkpoint refs without rewriting them", async () => {
  const fixture = createFixture();
  const created = await createCheckpoint(fixture, "open-indirect-ref");
  const repository = createTestRepository(fixture);
  const checkpointRef = checkpointRefFor(created.run.workspace);
  git(created.run.workspace, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "tag",
    "-a",
    "indirect-checkpoint",
    created.checkpoint.revision,
    "-m",
    "Indirect checkpoint ref",
  ]);
  const tagObject = git(created.run.workspace, ["rev-parse", "refs/tags/indirect-checkpoint"]);
  git(created.run.workspace, ["update-ref", checkpointRef, tagObject]);

  await expect(
    repository.openCheckpoint({
      checkpoint: created.checkpoint,
      baseRef: created.base.baseRef,
    }),
  ).rejects.toMatchObject({ code: "run_conflict" });
  expect(git(created.run.workspace, ["rev-parse", checkpointRef])).toBe(tagObject);
  expect(git(created.run.workspace, ["cat-file", "-t", checkpointRef])).toBe("tag");
  expect(repositoryState(created.run.workspace)).toEqual({
    head: created.checkpoint.revision,
    status: "",
  });

  git(created.run.workspace, ["update-ref", "-d", checkpointRef]);
  git(created.run.workspace, ["symbolic-ref", checkpointRef, `refs/heads/${created.run.branch}`]);
  await expect(
    repository.openCheckpoint({
      checkpoint: created.checkpoint,
      baseRef: created.base.baseRef,
    }),
  ).rejects.toMatchObject({ code: "run_conflict" });
  expect(git(created.run.workspace, ["symbolic-ref", checkpointRef])).toBe(
    `refs/heads/${created.run.branch}`,
  );
  expect(repositoryState(created.run.workspace)).toEqual({
    head: created.checkpoint.revision,
    status: "",
  });
});

type Fixture = Readonly<{
  root: string;
  remote: string;
  controller: string;
  pool: string;
}>;

async function createCheckpoint(
  fixture: Fixture,
  suffix: string,
): Promise<{
  repository: RepositoryService;
  base: RepositoryBase;
  run: RepositoryRun;
  checkpoint: RepositoryCheckpoint;
}> {
  const repository = createTestRepository(fixture);
  const base = await repository.resolveBase({ baseRef: "main" });
  const run = await repository.prepareRun({
    id: `run-${suffix}`,
    base,
    branch: `codex/${suffix}`,
  });
  writeFileSync(join(run.workspace, "spec.md"), "# Spec\n", "utf8");
  const checkpoint = await repository.checkpointRun({
    id: `checkpoint:${suffix}`,
    run,
    expectedParentRevision: base.baseSha,
    expectedChanges: await repository.inspectChanges(run),
    message: "Add Spec",
  });
  return { repository, base, run, checkpoint };
}

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "harness-open-checkpoint-"));
  roots.push(root);
  const remote = join(root, "remote.git");
  const source = join(root, "source");
  const controller = join(root, "storage", "controller");
  const pool = join(root, "storage", "grove");

  git(root, ["init", "--bare", remote]);
  git(root, ["clone", remote, source]);
  git(source, ["config", "user.email", "fixture@example.com"]);
  git(source, ["config", "user.name", "Fixture"]);
  writeFileSync(join(source, ".gitignore"), "node_modules/\n", "utf8");
  writeFileSync(join(source, "README.md"), "# Fixture\n", "utf8");
  writeFileSync(join(source, "delete-me.txt"), "delete\n", "utf8");
  writeFileSync(join(source, "rename-me.txt"), "rename\n", "utf8");
  git(source, ["add", "."]);
  git(source, ["commit", "-m", "Initialize fixture"]);
  git(source, ["branch", "-M", "main"]);
  git(source, ["push", "--set-upstream", "origin", "main"]);
  git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);

  return Object.freeze({ root, remote, controller, pool });
}

function createTestRepository(fixture: Fixture, ownerId?: string): RepositoryService {
  return createRepository({
    remote: fixture.remote,
    controllerWorkspace: fixture.controller,
    poolDirectory: fixture.pool,
    maxTrees: 2,
    setup: {
      command: [
        process.execPath,
        "-e",
        [
          'const fs = require("node:fs");',
          'const path = "node_modules/.setup-calls";',
          'fs.mkdirSync("node_modules", { recursive: true });',
          'const calls = fs.existsSync(path) ? Number(fs.readFileSync(path, "utf8")) : 0;',
          "fs.writeFileSync(path, String(calls + 1));",
        ].join("\n"),
      ],
      timeoutMs: 10_000,
    },
    ...(ownerId ? { ownerId } : {}),
  });
}

function repositoryState(workspace: string): { head: string; status: string } {
  return {
    head: git(workspace, ["rev-parse", "HEAD"]),
    status: git(workspace, ["status", "--short"]),
  };
}

function checkpointRefFor(workspace: string): string {
  return git(workspace, ["for-each-ref", "--format=%(refname)", "refs/harness/checkpoints/v1"]);
}

function readFile(path: string): string {
  return readFileSync(path, "utf8");
}

function git(
  cwd: string,
  args: readonly string[],
  acceptedExitCodes: readonly number[] = [0],
): string {
  const result = spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!acceptedExitCodes.includes(result.status ?? -1)) {
    throw new Error(result.stderr || result.error?.message || "Git failed.");
  }
  return result.stdout.trim();
}
