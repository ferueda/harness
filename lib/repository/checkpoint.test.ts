import {
  createGrove,
  readLeaseFirstState,
  transitionLease,
  writeLeaseFirstState,
} from "@ferueda/grove";
import { execFileSync } from "node:child_process";
import { mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createRepository } from "./repository.ts";
import type { RepositoryBase, RepositoryRun, RepositoryService } from "./types.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkpoint creates one path-free immutable revision and recovers the same result", async () => {
  const fixture = createFixture();
  const repository = createTestRepository(fixture);
  const { base, run } = await prepareRun(repository, "checkpoint-first", "codex/checkpoint-first");
  writeFileSync(join(run.workspace, "spec.md"), "# Spec\n", "utf8");
  const expectedChanges = await repository.inspectChanges(run);

  const input = {
    id: "checkpoint:first",
    run,
    expectedParentRevision: base.baseSha,
    expectedChanges,
    message: "Add immutable Spec",
  };
  const first = await repository.checkpointRun(input);
  const retried = await repository.checkpointRun(input);

  expect(retried).toEqual(first);
  expect(first).toEqual({
    version: 1,
    id: input.id,
    runId: run.id,
    baseSha: base.baseSha,
    parentRevision: base.baseSha,
    revision: first.revision,
    branch: run.branch,
    changes: [{ path: "spec.md", status: "untracked" }],
  });
  expect(git(run.workspace, ["rev-parse", "HEAD"])).toBe(first.revision);
  expect(git(run.workspace, ["show", "-s", "--format=%an <%ae>", first.revision])).toBe(
    "Harness <harness@localhost>",
  );
  expect(git(run.workspace, ["show", "-s", "--format=%B", first.revision])).toContain(
    `Harness-Checkpoint-ID: ${input.id}`,
  );
  expect(await repository.inspectChanges(run)).toEqual([]);
  expect(JSON.stringify(first)).not.toContain(run.workspace);
  expect(JSON.parse(JSON.stringify(first))).toEqual(first);

  const checkpointRef = git(run.workspace, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/harness/checkpoints/v1",
  ]);
  git(run.workspace, ["update-ref", "-d", checkpointRef]);
  expect(await repository.checkpointRun(input)).toEqual(first);
  expect(git(run.workspace, ["rev-parse", "--verify", checkpointRef])).toBe(first.revision);

  const grove = await createGrove({
    repoRoot: fixture.controller,
    groveDir: fixture.pool,
    maxTrees: 3,
    fetchOnAcquire: false,
  });
  expect((await grove.inspect(run.id))?.state).toBe("leased");
  await expect(repository.cleanupRun(run)).resolves.toEqual({ status: "released" });
});

test("checkpoint chains a later revision from the prior reviewed revision", async () => {
  const fixture = createFixture();
  const repository = createTestRepository(fixture);
  const { base, run } = await prepareRun(repository, "checkpoint-chain", "codex/checkpoint-chain");
  writeFileSync(join(run.workspace, "spec.md"), "# First\n", "utf8");
  const firstChanges = await repository.inspectChanges(run);
  const firstInput = {
    id: "checkpoint:chain:first",
    run,
    expectedParentRevision: base.baseSha,
    expectedChanges: firstChanges,
    message: "Add first Spec",
  };
  const first = await repository.checkpointRun(firstInput);

  writeFileSync(join(run.workspace, "spec.md"), "# Revised\n", "utf8");
  const secondChanges = await repository.inspectChanges(run);
  const second = await repository.checkpointRun({
    id: "checkpoint:chain:second",
    run,
    expectedParentRevision: first.revision,
    expectedChanges: secondChanges,
    message: "Revise Spec",
  });

  expect(second.parentRevision).toBe(first.revision);
  expect(second.revision).not.toBe(first.revision);
  expect(git(run.workspace, ["rev-parse", `${second.revision}^`])).toBe(first.revision);
  expect(await repository.checkpointRun(firstInput)).toEqual(first);
  await repository.cleanupRun(run);
});

test("checkpoint rejects incomplete or stale change authority before committing", async () => {
  const fixture = createFixture();
  const repository = createTestRepository(fixture);
  const { base, run } = await prepareRun(repository, "checkpoint-stale", "codex/checkpoint-stale");
  writeFileSync(join(run.workspace, "one.txt"), "one\n", "utf8");
  writeFileSync(join(run.workspace, "two.txt"), "two\n", "utf8");

  await expect(
    repository.checkpointRun({
      id: "checkpoint:invalid-parent",
      run,
      expectedParentRevision: "a".repeat(41),
      expectedChanges: [{ path: "one.txt", status: "untracked" }],
      message: "Reject truncated parent",
    }),
  ).rejects.toMatchObject({ code: "invalid_input" });

  await expect(
    repository.checkpointRun({
      id: "checkpoint:incomplete",
      run,
      expectedParentRevision: base.baseSha,
      expectedChanges: [{ path: "one.txt", status: "untracked" }],
      message: "Commit one file",
    }),
  ).rejects.toMatchObject({ code: "run_conflict" });
  expect(git(run.workspace, ["rev-parse", "HEAD"])).toBe(base.baseSha);
  expect(git(run.workspace, ["diff", "--cached", "--name-only"])).toBe("");
  await expect(
    repository.checkpointRun({
      id: "checkpoint:duplicate",
      run,
      expectedParentRevision: base.baseSha,
      expectedChanges: [
        { path: "one.txt", status: "untracked" },
        { path: "one.txt", status: "untracked" },
      ],
      message: "Commit duplicate authority",
    }),
  ).rejects.toMatchObject({ code: "invalid_input" });

  const changes = await repository.inspectChanges(run);
  const first = await repository.checkpointRun({
    id: "checkpoint:complete",
    run,
    expectedParentRevision: base.baseSha,
    expectedChanges: changes,
    message: "Commit both files",
  });
  writeFileSync(join(run.workspace, "three.txt"), "three\n", "utf8");

  await expect(
    repository.checkpointRun({
      id: "checkpoint:stale-parent",
      run,
      expectedParentRevision: base.baseSha,
      expectedChanges: await repository.inspectChanges(run),
      message: "Use stale parent",
    }),
  ).rejects.toMatchObject({ code: "run_conflict" });
  expect(git(run.workspace, ["rev-parse", "HEAD"])).toBe(first.revision);
  expect(await repository.inspectChanges(run)).toEqual([
    { path: "three.txt", status: "untracked" },
  ]);
  await repository.cleanupRun(run);
});

test("checkpoint fails closed for reused IDs and mismatched run identity", async () => {
  const fixture = createFixture();
  const repository = createTestRepository(fixture);
  const { base, run } = await prepareRun(
    repository,
    "checkpoint-identity",
    "codex/checkpoint-identity",
  );
  writeFileSync(join(run.workspace, "spec.md"), "# Spec\n", "utf8");
  const expectedChanges = await repository.inspectChanges(run);
  const checkpoint = await repository.checkpointRun({
    id: "checkpoint:identity",
    run,
    expectedParentRevision: base.baseSha,
    expectedChanges,
    message: "Add Spec",
  });

  await expect(
    repository.checkpointRun({
      id: checkpoint.id,
      run,
      expectedParentRevision: base.baseSha,
      expectedChanges,
      message: "A different request",
    }),
  ).rejects.toMatchObject({ code: "run_conflict" });
  await expect(
    repository.checkpointRun({
      id: "checkpoint:different",
      run: { ...run, branch: "codex/replaced" },
      expectedParentRevision: checkpoint.revision,
      expectedChanges: [{ path: "spec.md", status: "modified" }],
      message: "Wrong branch",
    }),
  ).rejects.toMatchObject({ code: "run_conflict" });

  const second = await repository.prepareRun({
    id: "checkpoint-other-run",
    base,
    branch: "codex/checkpoint-other-run",
  });
  await expect(
    repository.checkpointRun({
      id: checkpoint.id,
      run: second,
      expectedParentRevision: base.baseSha,
      expectedChanges,
      message: "Add Spec",
    }),
  ).rejects.toMatchObject({ code: "run_conflict" });

  writeFileSync(join(run.workspace, "unaccepted.txt"), "unaccepted\n", "utf8");
  git(run.workspace, ["add", "unaccepted.txt"]);
  git(run.workspace, [
    "-c",
    "user.name=Other",
    "-c",
    "user.email=other@example.com",
    "commit",
    "-m",
    "Unaccepted commit",
  ]);
  await expect(
    repository.checkpointRun({
      id: checkpoint.id,
      run,
      expectedParentRevision: base.baseSha,
      expectedChanges,
      message: "Add Spec",
    }),
  ).rejects.toMatchObject({ code: "run_conflict" });

  const unacceptedRevision = git(run.workspace, ["rev-parse", "HEAD"]);
  writeFileSync(join(run.workspace, "after-unaccepted.txt"), "next\n", "utf8");
  await expect(
    repository.checkpointRun({
      id: "checkpoint:after-unaccepted",
      run,
      expectedParentRevision: unacceptedRevision,
      expectedChanges: await repository.inspectChanges(run),
      message: "Continue from unaccepted commit",
    }),
  ).rejects.toMatchObject({ code: "run_conflict" });
  await repository.cleanupRun(run);
  await repository.cleanupRun(second);
});

test("checkpoint retry preserves and rejects unrelated dirty work", async () => {
  const fixture = createFixture();
  const repository = createTestRepository(fixture);
  const { base, run } = await prepareRun(repository, "checkpoint-dirty", "codex/checkpoint-dirty");
  writeFileSync(join(run.workspace, "spec.md"), "# Spec\n", "utf8");
  const expectedChanges = await repository.inspectChanges(run);
  const input = {
    id: "checkpoint:dirty",
    run,
    expectedParentRevision: base.baseSha,
    expectedChanges,
    message: "Add Spec",
  };
  const checkpoint = await repository.checkpointRun(input);
  writeFileSync(join(run.workspace, "unrelated.txt"), "keep me\n", "utf8");

  await expect(repository.checkpointRun(input)).rejects.toMatchObject({
    code: "run_conflict",
  });
  expect(git(run.workspace, ["rev-parse", "HEAD"])).toBe(checkpoint.revision);
  expect(await repository.inspectChanges(run)).toEqual([
    { path: "unrelated.txt", status: "untracked" },
  ]);
  await repository.cleanupRun(run);
});

test("checkpoint rejects a Grove lease that is no longer active", async () => {
  const fixture = createFixture();
  const repository = createTestRepository(fixture);
  const { base, run } = await prepareRun(
    repository,
    "checkpoint-releasing",
    "codex/checkpoint-releasing",
  );
  writeFileSync(join(run.workspace, "spec.md"), "# Spec\n", "utf8");
  const expectedChanges = await repository.inspectChanges(run);

  const state = await readLeaseFirstState(fixture.pool, {
    repoRoot: fixture.controller,
  });
  const leaseIndex = state.leases.findIndex((lease) => lease.leaseId === run.id);
  const lease = state.leases[leaseIndex];
  if (!lease) throw new Error("expected active Grove lease");
  const releasing = transitionLease(lease, {
    type: "RELEASE_START",
    cleanup: { cleanup: "reset", resetTo: base.baseSha, force: true },
  });
  if (!releasing) throw new Error("expected releasing Grove lease");
  state.leases[leaseIndex] = releasing;
  await writeLeaseFirstState(fixture.pool, state);

  await expect(
    repository.checkpointRun({
      id: "checkpoint:releasing",
      run,
      expectedParentRevision: base.baseSha,
      expectedChanges,
      message: "Must not commit during cleanup",
    }),
  ).rejects.toMatchObject({ code: "run_conflict" });
  expect(git(run.workspace, ["rev-parse", "HEAD"])).toBe(base.baseSha);
  expect(git(run.workspace, ["diff", "--cached", "--name-only"])).toBe("");
  expect(await repository.inspectChanges(run)).toEqual(expectedChanges);
});

test("checkpoint preserves approved rename and delete changes", async () => {
  const fixture = createFixture();
  const repository = createTestRepository(fixture);
  const { base, run } = await prepareRun(
    repository,
    "checkpoint-rename",
    "codex/checkpoint-rename",
  );
  renameSync(join(run.workspace, "rename-me.txt"), join(run.workspace, "renamed.txt"));
  unlinkSync(join(run.workspace, "delete-me.txt"));
  git(run.workspace, ["add", "-A"]);
  const expectedChanges = await repository.inspectChanges(run);
  expect(expectedChanges).toEqual(
    expect.arrayContaining([
      { path: "renamed.txt", previousPath: "rename-me.txt", status: "renamed" },
      { path: "delete-me.txt", status: "deleted" },
    ]),
  );

  const checkpoint = await repository.checkpointRun({
    id: "checkpoint:rename",
    run,
    expectedParentRevision: base.baseSha,
    expectedChanges,
    message: "Rename and delete files",
  });

  expect(git(run.workspace, ["diff", "--name-status", "-M", `${base.baseSha}..HEAD`])).toContain(
    "R100\trename-me.txt\trenamed.txt",
  );
  expect(checkpoint.changes).toEqual(expectedChanges);
  await repository.cleanupRun(run);
});

type Fixture = Readonly<{
  root: string;
  remote: string;
  source: string;
  controller: string;
  pool: string;
}>;

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "harness-checkpoint-"));
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

  return Object.freeze({ root, remote, source, controller, pool });
}

function createTestRepository(fixture: Fixture): RepositoryService {
  return createRepository({
    remote: fixture.remote,
    controllerWorkspace: fixture.controller,
    poolDirectory: fixture.pool,
    maxTrees: 3,
    setup: {
      command: [process.execPath, "-e", "void 0"],
      timeoutMs: 10_000,
    },
  });
}

async function prepareRun(
  repository: RepositoryService,
  id: string,
  branch: string,
): Promise<{ base: RepositoryBase; run: RepositoryRun }> {
  const base = await repository.resolveBase({ baseRef: "main" });
  const run = await repository.prepareRun({ id, base, branch });
  return { base, run };
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
