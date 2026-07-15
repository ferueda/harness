import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  createGrove,
  GroveError,
  isReleaseResult,
  type Grove,
  type GroveLease,
  type GroveLeaseTarget,
} from "@ferueda/grove";
import { deriveFactoryRepoIdentity } from "./factory-store.ts";

const FACTORY_GROVE_INTENT_VERSION = "1";
const FACTORY_GROVE_OWNER = "harness-factory";

export const FACTORY_GROVE_PHASES = ["triage", "planning", "implementation"] as const;

export type FactoryGrovePhase = (typeof FACTORY_GROVE_PHASES)[number];

type FactoryGroveAttachedPhase = Exclude<FactoryGrovePhase, "triage">;

export type FactoryGroveWorkspaceIntent = {
  readonly version: typeof FACTORY_GROVE_INTENT_VERSION;
  readonly repositoryId: string;
  readonly workItemKey: string;
  readonly phase: FactoryGrovePhase;
  readonly phaseGeneration: string;
  readonly baseSha: string;
  readonly leaseId: string;
  readonly target:
    | { readonly mode: "detached"; readonly ref: string }
    | { readonly mode: "branch"; readonly branch: string; readonly from: string };
  readonly metadata: Readonly<Record<string, string>>;
};

export type FactoryGroveWorkspaceConfig = {
  readonly controllerRepository: string;
  readonly poolDirectory: string;
  readonly poolCapacity: number;
  readonly setupCommand: string;
  readonly hookTimeoutMs?: number;
};

export type FactoryGroveWorkspace = {
  readonly leaseId: string;
  readonly workspace: string;
  readonly intent: FactoryGroveWorkspaceIntent;
};

export type FactoryGroveTerminalAuthority =
  | {
      readonly phase: "triage";
      readonly terminalEvent: "triage-terminal";
      readonly eventId: string;
    }
  | { readonly phase: "planning"; readonly terminalEvent: "plan-merged"; readonly eventId: string }
  | {
      readonly phase: "implementation";
      readonly terminalEvent: "implementation-merged";
      readonly eventId: string;
    };

export type FactoryGroveRepairRequest =
  | { readonly action: "resume-acquire" }
  | { readonly action: "quarantine" }
  | {
      readonly action: "resume-cleanup";
      readonly authority: FactoryGroveTerminalAuthority;
    };

export type FactoryGroveRepairResult =
  | { readonly status: "leased"; readonly leaseId: string; readonly workspace: string }
  | { readonly status: "released"; readonly leaseId: string }
  | { readonly status: "quarantined"; readonly leaseId: string };

export type FactoryGroveWorkspaceAttentionReason =
  | "grove-error"
  | "identity-mismatch"
  | "lease-busy"
  | "lease-conflict"
  | "lease-missing"
  | "lease-quarantined"
  | "release-incomplete"
  | "repair-rejected"
  | "setup-failed";

export class FactoryGroveWorkspaceAttentionError extends Error {
  readonly reason: FactoryGroveWorkspaceAttentionReason;
  readonly leaseId: string;

  constructor(
    reason: FactoryGroveWorkspaceAttentionReason,
    leaseId: string,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "FactoryGroveWorkspaceAttentionError";
    this.reason = reason;
    this.leaseId = leaseId;
  }
}

type IntentInput = {
  readonly controllerRepository: string;
  readonly workItemKey: string;
  readonly phase: FactoryGrovePhase;
  readonly phaseGeneration: string;
  readonly baseSha: string;
};

function requireNonEmpty(value: string, name: string): string {
  if (value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${name} must be non-empty and have no surrounding whitespace`);
  }
  return value;
}

function canonicalRepository(path: string): string {
  return realpathSync(resolve(path));
}

function resolveCommit(repository: string, sha: string): string {
  const expected = requireNonEmpty(sha, "baseSha").toLowerCase();
  const resolved = execFileSync("git", ["rev-parse", "--verify", `${expected}^{commit}`], {
    cwd: repository,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
    .trim()
    .toLowerCase();
  if (resolved !== expected) {
    throw new TypeError("baseSha must be the full authoritative commit SHA");
  }
  return resolved;
}

function attachedBranch(phase: FactoryGroveAttachedPhase, digest: string): string {
  return `harness/factory/workspace/${phase}/${digest}`;
}

export function deriveFactoryGroveWorkspaceIntent(input: IntentInput): FactoryGroveWorkspaceIntent {
  const repository = canonicalRepository(input.controllerRepository);
  const repositoryId = deriveFactoryRepoIdentity(repository).id;
  const workItemKey = requireNonEmpty(input.workItemKey, "workItemKey");
  const phaseGeneration = requireNonEmpty(input.phaseGeneration, "phaseGeneration");
  const baseSha = resolveCommit(repository, input.baseSha);
  const identity = {
    version: FACTORY_GROVE_INTENT_VERSION,
    repositoryId,
    workItemKey,
    phase: input.phase,
    phaseGeneration,
  } as const;
  const digest = createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 32);
  const leaseId = `factory-${input.phase}-${digest}`;
  const target =
    input.phase === "triage"
      ? ({ mode: "detached", ref: baseSha } as const)
      : ({ mode: "branch", branch: attachedBranch(input.phase, digest), from: baseSha } as const);
  const readableIntent = JSON.stringify({ ...identity, baseSha, target });
  const metadata = {
    "factory.intent": readableIntent,
    "factory.intentVersion": FACTORY_GROVE_INTENT_VERSION,
    "factory.repositoryId": repositoryId,
    "factory.workItemKey": workItemKey,
    "factory.phase": input.phase,
    "factory.phaseGeneration": phaseGeneration,
    "factory.baseSha": baseSha,
    "factory.targetMode": target.mode,
    "factory.target": target.mode === "branch" ? target.branch : target.ref,
  } as const;

  return {
    ...identity,
    baseSha,
    leaseId,
    target,
    metadata,
  };
}

async function createFactoryGrove(config: FactoryGroveWorkspaceConfig): Promise<Grove> {
  if (!Number.isSafeInteger(config.poolCapacity) || config.poolCapacity < 1) {
    throw new TypeError("poolCapacity must be a positive integer");
  }
  requireNonEmpty(config.setupCommand, "setupCommand");
  return createGrove({
    repoRoot: canonicalRepository(config.controllerRepository),
    groveDir: resolve(config.poolDirectory),
    maxTrees: config.poolCapacity,
    fetchOnAcquire: false,
    hooks: { postAcquire: [config.setupCommand] },
    onHookFailure: "fail",
    ...(config.hookTimeoutMs === undefined ? {} : { hookTimeoutMs: config.hookTimeoutMs }),
  });
}

function sameMetadata(
  actual: Readonly<Record<string, string>> | undefined,
  expected: Readonly<Record<string, string>>,
): boolean {
  if (!actual) return false;
  const actualEntries = Object.entries(actual).sort(([left], [right]) => left.localeCompare(right));
  const expectedEntries = Object.entries(expected).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return JSON.stringify(actualEntries) === JSON.stringify(expectedEntries);
}

function targetMatches(actual: GroveLeaseTarget | undefined, intent: FactoryGroveWorkspaceIntent) {
  if (!actual || actual.mode !== intent.target.mode) return false;
  if (actual.mode === "detached" && intent.target.mode === "detached") {
    return actual.requestedRef === intent.target.ref && actual.resolvedRefSha === intent.baseSha;
  }
  if (actual.mode === "branch" && intent.target.mode === "branch") {
    return (
      actual.branch === intent.target.branch &&
      actual.createFromRef === intent.baseSha &&
      actual.createFromSha === intent.baseSha
    );
  }
  return false;
}

function pendingTargetMatches(lease: GroveLease, intent: FactoryGroveWorkspaceIntent): boolean {
  return targetMatches(lease.pendingAcquire?.target, intent);
}

function attention(
  reason: FactoryGroveWorkspaceAttentionReason,
  intent: FactoryGroveWorkspaceIntent,
  message: string,
  cause?: unknown,
): FactoryGroveWorkspaceAttentionError {
  return new FactoryGroveWorkspaceAttentionError(reason, intent.leaseId, message, { cause });
}

function validateLeaseIdentity(
  lease: GroveLease,
  repository: string,
  intent: FactoryGroveWorkspaceIntent,
  options: { allowPendingAcquire?: boolean } = {},
): void {
  const matchesTarget =
    targetMatches(lease.target, intent) ||
    (options.allowPendingAcquire === true && pendingTargetMatches(lease, intent));
  if (
    lease.leaseId !== intent.leaseId ||
    canonicalRepository(lease.repoRoot) !== repository ||
    !sameMetadata(lease.metadata, intent.metadata) ||
    !matchesTarget
  ) {
    throw attention(
      "identity-mismatch",
      intent,
      `Grove lease ${intent.leaseId} does not match the Factory workspace intent`,
    );
  }
}

function validateStablePath(
  before: GroveLease | null,
  after: GroveLease,
  intent: FactoryGroveWorkspaceIntent,
): string {
  let workspace: string;
  try {
    workspace = realpathSync(after.path);
  } catch (cause) {
    throw attention(
      "lease-missing",
      intent,
      `Grove lease ${intent.leaseId} has no recoverable workspace path`,
      cause,
    );
  }
  if (before) {
    let previous: string;
    try {
      previous = realpathSync(before.path);
    } catch (cause) {
      throw attention(
        "lease-missing",
        intent,
        `Grove lease ${intent.leaseId} lost its persisted workspace path`,
        cause,
      );
    }
    if (workspace !== previous) {
      throw attention(
        "identity-mismatch",
        intent,
        `Grove lease ${intent.leaseId} changed workspace paths`,
      );
    }
  }
  return workspace;
}

function groveReason(error: GroveError): FactoryGroveWorkspaceAttentionReason {
  switch (error.code) {
    case "LEASE_CONFLICT":
    case "LEASE_ALREADY_EXISTS":
    case "BRANCH_EXISTS":
      return "lease-conflict";
    case "LEASE_BUSY":
    case "ACQUIRE_IN_PROGRESS":
    case "UNSAFE_CLEANUP":
    case "PROCESS_SAFETY_UNVERIFIED":
      return "lease-busy";
    case "LEASE_QUARANTINED":
      return "lease-quarantined";
    case "LEASE_NOT_FOUND":
      return "lease-missing";
    case "HOOK_FAILED":
      return "setup-failed";
    default:
      return "grove-error";
  }
}

function wrapGroveError(error: unknown, intent: FactoryGroveWorkspaceIntent): never {
  if (error instanceof FactoryGroveWorkspaceAttentionError) throw error;
  if (error instanceof GroveError) {
    throw attention(groveReason(error), intent, error.message, error);
  }
  throw error;
}

async function inspectFactoryLease(
  grove: Grove,
  intent: FactoryGroveWorkspaceIntent,
): Promise<GroveLease | null> {
  try {
    return await grove.inspect(intent.leaseId);
  } catch (error) {
    wrapGroveError(error, intent);
  }
}

function validateEnsureState(
  lease: GroveLease,
  repository: string,
  intent: FactoryGroveWorkspaceIntent,
): void {
  validateLeaseIdentity(lease, repository, intent, { allowPendingAcquire: true });
  if (lease.state === "leased") return;
  const reason = lease.state === "quarantined" ? "lease-quarantined" : "lease-busy";
  throw attention(reason, intent, `Grove lease ${intent.leaseId} is ${lease.state}`);
}

function acquireOptions(intent: FactoryGroveWorkspaceIntent) {
  const shared = {
    leaseId: intent.leaseId,
    ownerId: FACTORY_GROVE_OWNER,
    ifLeased: "return-existing" as const,
    fetchOnAcquire: false,
    metadata: { ...intent.metadata },
  };
  return intent.target.mode === "detached"
    ? ({ ...shared, mode: "detached" as const, ref: intent.target.ref } as const)
    : ({
        ...shared,
        mode: "branch" as const,
        branch: intent.target.branch,
        createBranch: { from: intent.target.from, ifExists: "fail" as const },
      } as const);
}

export async function ensureFactoryGroveWorkspace(input: {
  readonly config: FactoryGroveWorkspaceConfig;
  readonly intent: FactoryGroveWorkspaceIntent;
}): Promise<FactoryGroveWorkspace> {
  const repository = canonicalRepository(input.config.controllerRepository);
  const grove = await createFactoryGrove(input.config);
  const before = await inspectFactoryLease(grove, input.intent);
  if (before) validateEnsureState(before, repository, input.intent);

  try {
    const lease = await grove.acquire(acquireOptions(input.intent));
    validateLeaseIdentity(lease, repository, input.intent);
    const workspace = validateStablePath(before, lease, input.intent);
    return { leaseId: input.intent.leaseId, workspace, intent: input.intent };
  } catch (error) {
    wrapGroveError(error, input.intent);
  }
}

function validateAuthority(
  authority: FactoryGroveTerminalAuthority,
  intent: FactoryGroveWorkspaceIntent,
): void {
  requireNonEmpty(authority.eventId, "terminal authority eventId");
  const matches =
    (intent.phase === "triage" &&
      authority.phase === "triage" &&
      authority.terminalEvent === "triage-terminal") ||
    (intent.phase === "planning" &&
      authority.phase === "planning" &&
      authority.terminalEvent === "plan-merged") ||
    (intent.phase === "implementation" &&
      authority.phase === "implementation" &&
      authority.terminalEvent === "implementation-merged");
  if (!matches) {
    throw attention(
      "identity-mismatch",
      intent,
      `Terminal authority does not match ${intent.phase} lease ${intent.leaseId}`,
    );
  }
}

export async function releaseFactoryGroveWorkspace(input: {
  readonly config: FactoryGroveWorkspaceConfig;
  readonly intent: FactoryGroveWorkspaceIntent;
  readonly authority: FactoryGroveTerminalAuthority;
}): Promise<{ readonly status: "released"; readonly leaseId: string }> {
  validateAuthority(input.authority, input.intent);
  const repository = canonicalRepository(input.config.controllerRepository);
  const grove = await createFactoryGrove(input.config);
  const lease = await inspectFactoryLease(grove, input.intent);
  if (!lease)
    throw attention("lease-missing", input.intent, `Lease ${input.intent.leaseId} is absent`);
  validateLeaseIdentity(lease, repository, input.intent);

  try {
    const result = await grove.release(input.intent.leaseId, {
      cleanup: "reset",
      resetTo: input.intent.baseSha,
    });
    const inspected = await inspectFactoryLease(grove, input.intent);
    if (!isReleaseResult(result) || result.status !== "released" || inspected !== null) {
      throw attention(
        "release-incomplete",
        input.intent,
        `Grove did not fully release lease ${input.intent.leaseId}`,
      );
    }
    return { status: "released", leaseId: input.intent.leaseId };
  } catch (error) {
    wrapGroveError(error, input.intent);
  }
}

function validateRepairState(
  lease: GroveLease,
  request: FactoryGroveRepairRequest,
  intent: FactoryGroveWorkspaceIntent,
): void {
  if (request.action === "resume-acquire") {
    if (
      (lease.state !== "preparing" && lease.state !== "quarantined") ||
      !pendingTargetMatches(lease, intent)
    ) {
      throw attention(
        "repair-rejected",
        intent,
        `Lease ${intent.leaseId} has no matching pending acquire to resume`,
      );
    }
    return;
  }
  if (request.action === "resume-cleanup") {
    validateAuthority(request.authority, intent);
    const cleanup = lease.pendingCleanup;
    if (
      lease.state !== "quarantined" ||
      cleanup?.cleanup !== "reset" ||
      cleanup.resetTo !== intent.baseSha ||
      cleanup.force === true ||
      cleanup.cleanIgnored === true
    ) {
      throw attention(
        "repair-rejected",
        intent,
        `Lease ${intent.leaseId} has no matching safe reset to resume`,
      );
    }
  }
}

export async function repairFactoryGroveWorkspace(input: {
  readonly config: FactoryGroveWorkspaceConfig;
  readonly intent: FactoryGroveWorkspaceIntent;
  readonly request: FactoryGroveRepairRequest;
}): Promise<FactoryGroveRepairResult> {
  const repository = canonicalRepository(input.config.controllerRepository);
  const grove = await createFactoryGrove(input.config);
  const lease = await inspectFactoryLease(grove, input.intent);
  if (!lease)
    throw attention("lease-missing", input.intent, `Lease ${input.intent.leaseId} is absent`);
  validateLeaseIdentity(lease, repository, input.intent, { allowPendingAcquire: true });
  validateRepairState(lease, input.request, input.intent);

  try {
    const result = await grove.repair({
      leaseId: input.intent.leaseId,
      action: input.request.action,
    });
    if (input.request.action === "resume-cleanup") {
      if (!isReleaseResult(result) || result.status !== "released") {
        throw attention(
          "repair-rejected",
          input.intent,
          `Grove did not finish cleanup for lease ${input.intent.leaseId}`,
        );
      }
      if ((await inspectFactoryLease(grove, input.intent)) !== null) {
        throw attention(
          "release-incomplete",
          input.intent,
          `Grove retained lease ${input.intent.leaseId} after cleanup repair`,
        );
      }
      return { status: "released", leaseId: input.intent.leaseId };
    }
    if (input.request.action === "quarantine") {
      if (!isReleaseResult(result) || result.status !== "quarantined") {
        throw attention(
          "repair-rejected",
          input.intent,
          `Grove did not quarantine lease ${input.intent.leaseId}`,
        );
      }
      return { status: "quarantined", leaseId: input.intent.leaseId };
    }

    if (!("state" in result) || result.state !== "leased") {
      throw attention(
        "repair-rejected",
        input.intent,
        `Grove did not restore lease ${input.intent.leaseId}`,
      );
    }
    validateLeaseIdentity(result, repository, input.intent);
    return {
      status: "leased",
      leaseId: input.intent.leaseId,
      workspace: validateStablePath(lease, result, input.intent),
    };
  } catch (error) {
    wrapGroveError(error, input.intent);
  }
}
