import {
  createGrove,
  isReleaseResult,
  type Grove,
  type GroveLease,
  type GroveLeaseTarget,
  type ReleaseResult,
} from "@ferueda/grove";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { RepositoryRunsConfigSchema } from "./config-schema.ts";
import { normalizeRepositoryError, RepositoryError } from "./error.ts";
import { ensureController, inspectGitChanges, resolveRemoteBase } from "./git.ts";
import { runRepositorySetup } from "./setup.ts";
import type {
  CreateRepositoryOptions,
  RepositoryBase,
  RepositoryCleanupResult,
  RepositoryRun,
  RepositoryService,
} from "./types.ts";

const RUN_VERSION = 1;
const DEFAULT_OWNER_ID = "harness-linear-automation";
const METADATA_KEYS = Object.freeze({
  version: "harness.repository-run.version",
  remote: "harness.repository-run.remote",
  baseRef: "harness.repository-run.base-ref",
  baseSha: "harness.repository-run.base-sha",
  branch: "harness.repository-run.branch",
});

export function createRepository(options: CreateRepositoryOptions): RepositoryService {
  const config = RepositoryRunsConfigSchema.parse({
    remote: options.remote,
    maxTrees: options.maxTrees,
    setup: options.setup,
  });
  const controllerWorkspace = assertAbsolutePath(
    "controllerWorkspace",
    options.controllerWorkspace,
  );
  const poolDirectory = assertAbsolutePath("poolDirectory", options.poolDirectory);
  assertSeparatePaths(controllerWorkspace, poolDirectory);
  const setupEnvironment = options.setupEnvironment ?? process.env;
  const ownerId = options.ownerId?.trim() || DEFAULT_OWNER_ID;
  let grovePromise: Promise<Grove> | undefined;

  async function getGrove(): Promise<Grove> {
    grovePromise ??= createGrove({
      repoRoot: controllerWorkspace,
      groveDir: poolDirectory,
      maxTrees: config.maxTrees,
      fetchOnAcquire: false,
    });
    return grovePromise;
  }

  async function resolveBase(input: { baseRef: string }): Promise<RepositoryBase> {
    try {
      const baseRef = input.baseRef.trim();
      const baseSha = await resolveRemoteBase({
        remote: config.remote,
        controllerWorkspace,
        baseRef,
      });
      return Object.freeze({ remote: config.remote, baseRef, baseSha });
    } catch (error) {
      throw normalizeRepositoryError("prepare", error);
    }
  }

  async function prepareRun(input: {
    id: string;
    base: RepositoryBase;
    branch: string;
  }): Promise<RepositoryRun> {
    try {
      assertBase(input.base, config.remote);
      const identity = runIdentity(input);
      await ensureController({ remote: config.remote, workspace: controllerWorkspace });
      const grove = await getGrove();
      const existing = await grove.inspect(identity.id);
      if (existing)
        assertRecoverableAcquire(existing, identity, controllerWorkspace, poolDirectory);

      const lease =
        existing?.state === "preparing" ||
        (existing?.state === "quarantined" && existing.pendingAcquire)
          ? await grove.repair({ leaseId: identity.id, action: "resume-acquire" })
          : await grove.acquire({
              leaseId: identity.id,
              ownerId,
              mode: "branch",
              branch: identity.branch,
              createBranch: { from: identity.base.baseSha, ifExists: "fail" },
              ifLeased: "return-existing",
              fetchOnAcquire: false,
              metadata: metadataFor(identity),
            });

      if (!isGroveLease(lease)) {
        throw new RepositoryError(
          `Grove did not return a lease while preparing ${identity.id}.`,
          "run_conflict",
        );
      }
      assertPreparedLease(lease, identity, controllerWorkspace, poolDirectory);
      await runRepositorySetup({
        workspace: lease.path,
        command: config.setup.command,
        timeoutMs: config.setup.timeoutMs,
        environment: setupEnvironment,
      });

      return Object.freeze({
        version: RUN_VERSION,
        id: identity.id,
        workspace: lease.path,
        remote: identity.base.remote,
        baseRef: identity.base.baseRef,
        baseSha: identity.base.baseSha,
        branch: identity.branch,
      });
    } catch (error) {
      throw normalizeRepositoryError("prepare", error);
    }
  }

  async function inspectChanges(run: RepositoryRun) {
    try {
      const grove = await getGrove();
      const lease = await grove.inspect(run.id);
      if (!lease) {
        throw new RepositoryError(`Repository run is not leased: ${run.id}`, "run_conflict");
      }
      assertRunLease(lease, run, controllerWorkspace, poolDirectory);
      return await inspectGitChanges(run.workspace);
    } catch (error) {
      throw normalizeRepositoryError("inspect", error);
    }
  }

  async function cleanupRun(run: RepositoryRun): Promise<RepositoryCleanupResult> {
    try {
      const grove = await getGrove();
      const lease = await grove.inspect(run.id);
      if (!lease) return Object.freeze({ status: "already-clean" });
      assertRunLease(lease, run, controllerWorkspace, poolDirectory);

      // Grove reserves a lease to the acquiring PID. A daemon remains alive between
      // acquire and release, so verify Grove's own process scan before bypassing only
      // that owner reservation with force.
      const cleanup = { cleanup: "reset" as const, resetTo: run.baseSha, force: true };
      let result: ReleaseResult;
      if (lease.state === "leased") {
        await assertNoActiveWorktreeProcesses(grove, run.id);
        result = await grove.release(run.id, cleanup);
      } else if (
        (lease.state === "releasing" || lease.state === "quarantined") &&
        matchesCleanup(lease, run.baseSha)
      ) {
        await assertNoActiveWorktreeProcesses(grove, run.id);
        const repaired = await grove.repair({ leaseId: run.id, action: "resume-cleanup" });
        if (!isReleaseResult(repaired)) {
          throw new RepositoryError(
            `Grove did not finish cleanup for ${run.id}.`,
            "cleanup_failed",
          );
        }
        result = repaired;
      } else {
        throw new RepositoryError(
          `Repository run ${run.id} cannot be cleaned from Grove state ${lease.state}.`,
          "run_conflict",
        );
      }

      if (result.status !== "released") {
        throw new RepositoryError(
          `Repository run ${run.id} was not released after reset.`,
          "cleanup_failed",
        );
      }
      return Object.freeze({ status: "released" });
    } catch (error) {
      throw normalizeRepositoryError("cleanup", error);
    }
  }

  return Object.freeze({ resolveBase, prepareRun, inspectChanges, cleanupRun });
}

type RunIdentity = Readonly<{
  id: string;
  base: RepositoryBase;
  branch: string;
}>;

function runIdentity(input: { id: string; base: RepositoryBase; branch: string }): RunIdentity {
  const id = input.id.trim();
  const branch = input.branch.trim();
  if (!id) throw new RepositoryError("Repository run ID must not be empty.", "invalid_input");
  if (!branch) {
    throw new RepositoryError("Repository run branch must not be empty.", "invalid_input");
  }
  return Object.freeze({ id, base: input.base, branch });
}

function metadataFor(identity: RunIdentity): Record<string, string> {
  return {
    [METADATA_KEYS.version]: String(RUN_VERSION),
    [METADATA_KEYS.remote]: identity.base.remote,
    [METADATA_KEYS.baseRef]: identity.base.baseRef,
    [METADATA_KEYS.baseSha]: identity.base.baseSha,
    [METADATA_KEYS.branch]: identity.branch,
  };
}

function assertRecoverableAcquire(
  lease: GroveLease,
  identity: RunIdentity,
  controllerWorkspace: string,
  poolDirectory: string,
): void {
  assertLeaseIdentity(lease, identity, controllerWorkspace, poolDirectory);
  if (lease.state === "leased") {
    assertTarget(lease.target, identity);
    return;
  }
  if (
    (lease.state === "preparing" || lease.state === "quarantined") &&
    lease.pendingAcquire &&
    matchesTarget(lease.pendingAcquire.target, identity)
  ) {
    return;
  }
  throw new RepositoryError(
    `Repository run ${identity.id} cannot resume from Grove state ${lease.state}.`,
    "run_conflict",
  );
}

function assertPreparedLease(
  lease: GroveLease,
  identity: RunIdentity,
  controllerWorkspace: string,
  poolDirectory: string,
): void {
  assertLeaseIdentity(lease, identity, controllerWorkspace, poolDirectory);
  if (lease.state !== "leased") {
    throw new RepositoryError(
      `Repository run ${identity.id} was not fully acquired.`,
      "run_conflict",
    );
  }
  assertTarget(lease.target, identity);
}

function assertRunLease(
  lease: GroveLease,
  run: RepositoryRun,
  controllerWorkspace: string,
  poolDirectory: string,
): void {
  if (run.version !== RUN_VERSION) {
    throw new RepositoryError(
      `Unsupported repository run version: ${String(run.version)}`,
      "run_conflict",
    );
  }
  if (resolve(run.workspace) !== resolve(lease.path)) {
    throw new RepositoryError(`Repository run path mismatch for ${run.id}.`, "run_conflict");
  }
  const identity = runIdentity({
    id: run.id,
    branch: run.branch,
    base: {
      remote: run.remote,
      baseRef: run.baseRef,
      baseSha: run.baseSha,
    },
  });
  assertLeaseIdentity(lease, identity, controllerWorkspace, poolDirectory);
  if (lease.target) assertTarget(lease.target, identity);
}

function assertLeaseIdentity(
  lease: GroveLease,
  identity: RunIdentity,
  controllerWorkspace: string,
  poolDirectory: string,
): void {
  if (lease.leaseId !== identity.id || resolve(lease.repoRoot) !== controllerWorkspace) {
    throw new RepositoryError(
      `Repository lease identity mismatch for ${identity.id}.`,
      "run_conflict",
    );
  }
  assertPathWithin(poolDirectory, lease.path);
  const expected = metadataFor(identity);
  for (const [key, value] of Object.entries(expected)) {
    if (lease.metadata?.[key] !== value) {
      throw new RepositoryError(
        `Repository lease metadata mismatch for ${identity.id}.`,
        "run_conflict",
      );
    }
  }
}

function assertTarget(target: GroveLeaseTarget | undefined, identity: RunIdentity): void {
  if (!target || !matchesTarget(target, identity)) {
    throw new RepositoryError(
      `Repository lease target mismatch for ${identity.id}.`,
      "run_conflict",
    );
  }
}

function matchesTarget(target: GroveLeaseTarget, identity: RunIdentity): boolean {
  return (
    target.mode === "branch" &&
    target.branch === identity.branch &&
    target.createFromRef === identity.base.baseSha &&
    target.createFromSha === identity.base.baseSha
  );
}

function matchesCleanup(lease: GroveLease, baseSha: string): boolean {
  return (
    lease.pendingCleanup?.cleanup === "reset" &&
    lease.pendingCleanup.resetTo === baseSha &&
    lease.pendingCleanup.force === true &&
    lease.pendingCleanup.cleanIgnored !== true
  );
}

async function assertNoActiveWorktreeProcesses(grove: Grove, leaseId: string): Promise<void> {
  const leases = await grove.list({ includeProcesses: true });
  const lease = leases.find((candidate) => candidate.leaseId === leaseId);
  const safety = lease?.diagnostics?.lastProcessSafetyCheck;
  if (
    !lease ||
    lease.processSafety !== "verified" ||
    safety?.status !== "verified" ||
    (safety.processes?.length ?? 0) > 0
  ) {
    throw new RepositoryError(
      `Repository run ${leaseId} has active processes or unverified cleanup safety.`,
      "cleanup_failed",
    );
  }
}

function assertBase(base: RepositoryBase, remote: string): void {
  if (base.remote !== remote) {
    throw new RepositoryError(
      "Repository base remote does not match this repository.",
      "run_conflict",
    );
  }
  if (!/^[0-9a-f]{40,64}$/.test(base.baseSha)) {
    throw new RepositoryError("Repository base SHA is invalid.", "invalid_input");
  }
  if (!base.baseRef.trim()) {
    throw new RepositoryError("Repository base ref must not be empty.", "invalid_input");
  }
}

function assertAbsolutePath(name: string, value: string): string {
  if (!isAbsolute(value)) {
    throw new RepositoryError(`${name} must be an absolute path.`, "invalid_input");
  }
  return resolve(value);
}

function assertSeparatePaths(controllerWorkspace: string, poolDirectory: string): void {
  if (
    controllerWorkspace === poolDirectory ||
    isWithin(controllerWorkspace, poolDirectory) ||
    isWithin(poolDirectory, controllerWorkspace)
  ) {
    throw new RepositoryError(
      "Repository controller and pool directories must not overlap.",
      "invalid_input",
    );
  }
}

function assertPathWithin(parent: string, child: string): void {
  if (!isWithin(parent, resolve(child))) {
    throw new RepositoryError("Grove returned a path outside the repository pool.", "run_conflict");
  }
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`);
}

function isGroveLease(value: unknown): value is GroveLease {
  return typeof value === "object" && value !== null && "leaseId" in value && "state" in value;
}

export type {
  CreateRepositoryOptions,
  RepositoryBase,
  RepositoryChange,
  RepositoryChangeStatus,
  RepositoryCleanupResult,
  RepositoryRun,
  RepositoryService,
} from "./types.ts";
