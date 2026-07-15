import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGrove } from "@ferueda/grove";
import { afterEach, expect, test } from "vitest";
import {
  deriveFactoryGroveWorkspaceIntent,
  ensureFactoryGroveWorkspace,
  FactoryGroveWorkspaceAttentionError,
  releaseFactoryGroveWorkspace,
  repairFactoryGroveWorkspace,
  type FactoryGrovePhase,
  type FactoryGroveTerminalAuthority,
  type FactoryGroveWorkspaceConfig,
  type FactoryGroveWorkspaceIntent,
} from "../lib/factory-grove-workspace.ts";

type Fixture = {
  root: string;
  repository: string;
  pool: string;
  baseSha: string;
  config: FactoryGroveWorkspaceConfig;
};

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function git(cwd: string, args: string[]): string {
  return run("git", args, cwd);
}

function fixture(capacity = 4, setupCommand = "true"): Fixture {
  const root = mkdtempSync(join(tmpdir(), "factory-grove-test-"));
  roots.push(root);
  const repository = join(root, "repository");
  run("mkdir", [repository], root);
  git(repository, ["init", "--initial-branch=main"]);
  git(repository, ["config", "user.email", "factory@example.test"]);
  git(repository, ["config", "user.name", "Factory Test"]);
  writeFileSync(join(repository, "README.md"), "base\n", "utf8");
  git(repository, ["add", "README.md"]);
  git(repository, ["commit", "-m", "base"]);
  const baseSha = git(repository, ["rev-parse", "HEAD"]);
  const pool = join(root, "pool");
  return {
    root,
    repository,
    pool,
    baseSha,
    config: {
      controllerRepository: repository,
      poolDirectory: pool,
      poolCapacity: capacity,
      setupCommand,
    },
  };
}

function intent(
  target: Fixture,
  phase: FactoryGrovePhase,
  generation = "generation-1",
  baseSha = target.baseSha,
): FactoryGroveWorkspaceIntent {
  return deriveFactoryGroveWorkspaceIntent({
    controllerRepository: target.repository,
    workItemKey: "linear:FER-30",
    phase,
    phaseGeneration: generation,
    baseSha,
  });
}

function authority(phase: FactoryGrovePhase): FactoryGroveTerminalAuthority {
  switch (phase) {
    case "triage":
      return { phase, terminalEvent: "triage-terminal", eventId: "event-triage" };
    case "planning":
      return { phase, terminalEvent: "plan-merged", eventId: "event-plan" };
    case "implementation":
      return {
        phase,
        terminalEvent: "implementation-merged",
        eventId: "event-implementation",
      };
  }
}

async function inspect(target: Fixture, leaseId: string) {
  const grove = await createGrove({
    repoRoot: target.repository,
    groveDir: target.pool,
    maxTrees: target.config.poolCapacity,
    fetchOnAcquire: false,
  });
  return grove.inspect(leaseId);
}

test("derives stable pre-run lease identities with isolated phase targets", () => {
  const target = fixture();
  const triage = intent(target, "triage");
  const planning = intent(target, "planning");
  const implementation = intent(target, "implementation");

  expect(intent(target, "planning")).toEqual(planning);
  expect(new Set([triage.leaseId, planning.leaseId, implementation.leaseId]).size).toBe(3);
  expect(triage.target).toEqual({ mode: "detached", ref: target.baseSha });
  expect(planning.target).toMatchObject({ mode: "branch", from: target.baseSha });
  expect(implementation.target).toMatchObject({ mode: "branch", from: target.baseSha });
  expect(planning.target).not.toEqual(implementation.target);
});

test("acquires exact detached and attached phase checkouts", async () => {
  const target = fixture();
  const leases = await Promise.all(
    (["triage", "planning", "implementation"] as const).map(async (phase) => {
      const phaseIntent = intent(target, phase);
      const ensured = await ensureFactoryGroveWorkspace({
        config: target.config,
        intent: phaseIntent,
      });
      return { phase, phaseIntent, ensured };
    }),
  );

  for (const { phase, phaseIntent, ensured } of leases) {
    expect(git(ensured.workspace, ["rev-parse", "HEAD"])).toBe(target.baseSha);
    expect(git(ensured.workspace, ["branch", "--show-current"])).toBe(
      phase === "triage"
        ? ""
        : phaseIntent.target.mode === "branch"
          ? phaseIntent.target.branch
          : "",
    );
    expect((await inspect(target, phaseIntent.leaseId))?.metadata).toEqual(phaseIntent.metadata);
  }
});

test("restart reacquire keeps the same path, branch, commits, and dirty bytes", async () => {
  const target = fixture();
  const phaseIntent = intent(target, "planning");
  const first = await ensureFactoryGroveWorkspace({ config: target.config, intent: phaseIntent });
  git(first.workspace, ["config", "user.email", "factory@example.test"]);
  git(first.workspace, ["config", "user.name", "Factory Test"]);
  writeFileSync(join(first.workspace, "candidate.md"), "candidate\n", "utf8");
  git(first.workspace, ["add", "candidate.md"]);
  git(first.workspace, ["commit", "-m", "candidate"]);
  const committed = git(first.workspace, ["rev-parse", "HEAD"]);
  git(first.workspace, ["switch", "-c", "harness/factory/plan/publication"]);
  writeFileSync(join(first.workspace, "dirty.txt"), "keep me\n", "utf8");

  const reopened = await ensureFactoryGroveWorkspace({
    config: { ...target.config },
    intent: { ...phaseIntent },
  });

  expect(reopened.workspace).toBe(first.workspace);
  expect(git(reopened.workspace, ["rev-parse", "HEAD"])).toBe(committed);
  expect(git(reopened.workspace, ["branch", "--show-current"])).toBe(
    "harness/factory/plan/publication",
  );
  expect(readFileSync(join(reopened.workspace, "dirty.txt"), "utf8")).toBe("keep me\n");
});

test("setup failure retries the same committed lease and path", async () => {
  const marker = join(tmpdir(), `factory-grove-setup-${process.pid}-${Date.now()}`);
  roots.push(marker);
  const setupCommand = `if [ ! -f '${marker}' ]; then touch '${marker}'; exit 17; fi; printf x >> .setup-runs`;
  const target = fixture(2, setupCommand);
  const phaseIntent = intent(target, "planning");

  await expect(
    ensureFactoryGroveWorkspace({ config: target.config, intent: phaseIntent }),
  ).rejects.toMatchObject({ reason: "setup-failed", leaseId: phaseIntent.leaseId });
  const failedLease = await inspect(target, phaseIntent.leaseId);
  expect(failedLease?.state).toBe("leased");

  const retried = await ensureFactoryGroveWorkspace({
    config: { ...target.config },
    intent: phaseIntent,
  });
  expect(retried.workspace).toBe(realpathSync(failedLease!.path));
  expect(readFileSync(join(retried.workspace, ".setup-runs"), "utf8")).toBe("x");
});

test("conflicting immutable intent is rejected without another worktree", async () => {
  const target = fixture();
  const firstIntent = intent(target, "planning");
  const first = await ensureFactoryGroveWorkspace({ config: target.config, intent: firstIntent });
  writeFileSync(join(target.repository, "second.txt"), "second\n", "utf8");
  git(target.repository, ["add", "second.txt"]);
  git(target.repository, ["commit", "-m", "second"]);
  const conflicting = intent(
    target,
    "planning",
    "generation-1",
    git(target.repository, ["rev-parse", "HEAD"]),
  );

  expect(conflicting.leaseId).toBe(firstIntent.leaseId);
  await expect(
    ensureFactoryGroveWorkspace({ config: target.config, intent: conflicting }),
  ).rejects.toMatchObject({ reason: "identity-mismatch" });

  const grove = await createGrove({
    repoRoot: target.repository,
    groveDir: target.pool,
    maxTrees: 4,
    fetchOnAcquire: false,
  });
  expect(await grove.list()).toHaveLength(1);
  expect(realpathSync((await grove.list())[0]!.path)).toBe(first.workspace);
});

test("waiting leases stay allocated until phase-matched terminal release", async () => {
  const target = fixture(1);
  const phaseIntent = intent(target, "implementation");
  const active = await ensureFactoryGroveWorkspace({ config: target.config, intent: phaseIntent });
  writeFileSync(join(active.workspace, "candidate.txt"), "recoverable\n", "utf8");

  const wrong = { phase: "planning", terminalEvent: "plan-merged", eventId: "wrong" } as const;
  await expect(
    releaseFactoryGroveWorkspace({ config: target.config, intent: phaseIntent, authority: wrong }),
  ).rejects.toMatchObject({ reason: "identity-mismatch" });
  expect(readFileSync(join(active.workspace, "candidate.txt"), "utf8")).toBe("recoverable\n");
  expect((await inspect(target, phaseIntent.leaseId))?.state).toBe("leased");

  const waitingGrove = await createGrove({
    repoRoot: target.repository,
    groveDir: target.pool,
    maxTrees: 1,
    fetchOnAcquire: false,
  });
  await expect(
    waitingGrove.release(phaseIntent.leaseId, { cleanup: "preserve" }),
  ).resolves.toMatchObject({ status: "preserved", leaseId: phaseIntent.leaseId });
  expect(readFileSync(join(active.workspace, "candidate.txt"), "utf8")).toBe("recoverable\n");

  await expect(
    releaseFactoryGroveWorkspace({
      config: target.config,
      intent: phaseIntent,
      authority: authority("implementation"),
    }),
  ).resolves.toEqual({ status: "released", leaseId: phaseIntent.leaseId });
  const grove = await createGrove({
    repoRoot: target.repository,
    groveDir: target.pool,
    maxTrees: 1,
    fetchOnAcquire: false,
  });
  expect(await grove.inspect(phaseIntent.leaseId)).toBeNull();
  expect((await grove.stats()).count).toBe(0);
  const replacement = await ensureFactoryGroveWorkspace({
    config: target.config,
    intent: intent(target, "implementation", "generation-2"),
  });
  expect(replacement.workspace).toBe(active.workspace);
});

test("repair resumes matching interrupted acquire and can quarantine an active lease", async () => {
  const target = fixture(2);
  const acquireIntent = intent(target, "planning");
  if (acquireIntent.target.mode !== "branch") throw new Error("planning target must be attached");
  git(target.repository, ["branch", acquireIntent.target.branch, target.baseSha]);
  const raw = await createGrove({
    repoRoot: target.repository,
    groveDir: target.pool,
    maxTrees: 2,
    fetchOnAcquire: false,
  });
  await expect(
    raw.acquire({
      leaseId: acquireIntent.leaseId,
      mode: "branch",
      branch: acquireIntent.target.branch,
      createBranch: { from: acquireIntent.baseSha, ifExists: "fail" },
      metadata: { ...acquireIntent.metadata },
      fetchOnAcquire: false,
    }),
  ).rejects.toBeTruthy();
  expect((await raw.inspect(acquireIntent.leaseId))?.state).toBe("quarantined");
  await expect(
    ensureFactoryGroveWorkspace({ config: target.config, intent: acquireIntent }),
  ).rejects.toMatchObject({ reason: "lease-quarantined" });
  git(target.repository, ["branch", "-D", acquireIntent.target.branch]);

  const resumed = await repairFactoryGroveWorkspace({
    config: target.config,
    intent: acquireIntent,
    request: { action: "resume-acquire" },
  });
  expect(resumed.status).toBe("leased");

  const quarantineIntent = intent(target, "implementation");
  await ensureFactoryGroveWorkspace({ config: target.config, intent: quarantineIntent });
  await expect(
    repairFactoryGroveWorkspace({
      config: target.config,
      intent: quarantineIntent,
      request: { action: "quarantine" },
    }),
  ).resolves.toEqual({ status: "quarantined", leaseId: quarantineIntent.leaseId });
  expect((await inspect(target, quarantineIntent.leaseId))?.state).toBe("quarantined");
});

test("repair resumes only the exact authorized pending cleanup", async () => {
  const target = fixture();
  const phaseIntent = intent(target, "planning");
  await ensureFactoryGroveWorkspace({ config: target.config, intent: phaseIntent });
  const active = await createGrove({
    repoRoot: target.repository,
    groveDir: target.pool,
    maxTrees: 4,
    fetchOnAcquire: false,
  });
  await active.release(phaseIntent.leaseId, { cleanup: "preserve" });
  const failingRelease = await createGrove({
    repoRoot: target.repository,
    groveDir: target.pool,
    maxTrees: 4,
    fetchOnAcquire: false,
    hooks: { preRelease: ["exit 19"] },
    onHookFailure: "fail",
  });
  await expect(
    failingRelease.release(phaseIntent.leaseId, {
      cleanup: "reset",
      resetTo: phaseIntent.baseSha,
    }),
  ).rejects.toBeTruthy();
  expect((await failingRelease.inspect(phaseIntent.leaseId))?.state).toBe("quarantined");

  await expect(
    repairFactoryGroveWorkspace({
      config: target.config,
      intent: phaseIntent,
      request: {
        action: "resume-cleanup",
        authority: { phase: "triage", terminalEvent: "triage-terminal", eventId: "wrong" },
      },
    }),
  ).rejects.toMatchObject({ reason: "identity-mismatch" });
  expect(await failingRelease.inspect(phaseIntent.leaseId)).not.toBeNull();

  await expect(
    repairFactoryGroveWorkspace({
      config: target.config,
      intent: phaseIntent,
      request: { action: "resume-cleanup", authority: authority("planning") },
    }),
  ).resolves.toEqual({ status: "released", leaseId: phaseIntent.leaseId });
  expect(await failingRelease.inspect(phaseIntent.leaseId)).toBeNull();

  const mismatchedIntent = intent(target, "implementation");
  await ensureFactoryGroveWorkspace({ config: target.config, intent: mismatchedIntent });
  await active.release(mismatchedIntent.leaseId, { cleanup: "preserve" });
  writeFileSync(join(target.repository, "later.txt"), "later\n", "utf8");
  git(target.repository, ["add", "later.txt"]);
  git(target.repository, ["commit", "-m", "later"]);
  const wrongReset = git(target.repository, ["rev-parse", "HEAD"]);
  await expect(
    failingRelease.release(mismatchedIntent.leaseId, {
      cleanup: "reset",
      resetTo: wrongReset,
    }),
  ).rejects.toBeTruthy();
  await expect(
    repairFactoryGroveWorkspace({
      config: target.config,
      intent: mismatchedIntent,
      request: { action: "resume-cleanup", authority: authority("implementation") },
    }),
  ).rejects.toMatchObject({ reason: "repair-rejected" });
  expect((await failingRelease.inspect(mismatchedIntent.leaseId))?.state).toBe("quarantined");
});

test("invalid inputs fail before Grove state is created", () => {
  const target = fixture();
  expect(() => intent(target, "planning", " generation ")).toThrow(/phaseGeneration/);
  expect(() =>
    deriveFactoryGroveWorkspaceIntent({
      controllerRepository: target.repository,
      workItemKey: "linear:FER-30",
      phase: "planning",
      phaseGeneration: "generation",
      baseSha: target.baseSha.slice(0, 12),
    }),
  ).toThrow(/full authoritative/);
  expect(existsSync(target.pool)).toBe(false);
  expect(FactoryGroveWorkspaceAttentionError).toBeTypeOf("function");
});
