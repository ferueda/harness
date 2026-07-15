import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  FactoryArtifactRefSchema,
  verifyFactoryArtifactRef,
  type FactoryArtifactRef,
} from "./factory-artifact-ref.ts";
import {
  FactoryActionExecutionProfileSchema,
  type FactoryActionExecutionProfile,
} from "./factory-phase-run.ts";
import { FACTORY_IMPLEMENTATION_REVIEW_HANDOFF_CONTRACT_VERSION } from "./prompts/factory-implementation.ts";
import { IMPLEMENTATION_REVIEW_PROMPT, QUALITY_REVIEW_PROMPT } from "./prompts/index.ts";
import { ReviewOutputSchema, type ReviewOutput } from "./schemas.ts";

export const FACTORY_IMPLEMENTATION_REVIEW_ROLES = ["implementation", "quality"] as const;
export type FactoryImplementationReviewRole = (typeof FACTORY_IMPLEMENTATION_REVIEW_ROLES)[number];

const TERMINAL_VERDICT_CONTRACT_VERSION = 1;
const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS_ROOT = basename(MODULE_ROOT) === "dist" ? resolve(MODULE_ROOT, "..") : MODULE_ROOT;
const REVIEW_OUTPUT_SCHEMA = readFileSync(join(HARNESS_ROOT, "schemas/review-output.schema.json"));

const CheckpointRoleSchema = z
  .object({
    contractSha256: z.string().regex(/^[a-f0-9]{64}$/),
    prompt: FactoryArtifactRefSchema,
    output: FactoryArtifactRefSchema,
  })
  .strict();

export const FactoryImplementationReviewCheckpointSchema = z
  .object({
    version: z.literal(1),
    phaseRunId: z.string().min(1),
    reviewRound: z.number().int().positive(),
    candidateAttempt: z.number().int().positive(),
    base: z.string().min(1),
    commit: z.string().min(1),
    tree: z.string().min(1),
    executionProfile: FactoryActionExecutionProfileSchema,
    roles: z
      .object({
        implementation: CheckpointRoleSchema.optional(),
        quality: CheckpointRoleSchema.optional(),
      })
      .strict(),
  })
  .strict();

export type FactoryImplementationReviewCheckpoint = z.infer<
  typeof FactoryImplementationReviewCheckpointSchema
>;
export type FactoryImplementationReviewCheckpointRole = z.infer<typeof CheckpointRoleSchema>;
export type AuthenticatedFactoryImplementationReviewRole =
  FactoryImplementationReviewCheckpointRole & { review: ReviewOutput };
export type AuthenticatedFactoryImplementationReviewRoles = Partial<
  Record<FactoryImplementationReviewRole, AuthenticatedFactoryImplementationReviewRole>
>;

export type FactoryImplementationReviewCheckpointIdentity = {
  phaseRunId: string;
  reviewRound: number;
  candidateAttempt: number;
  base: string;
  commit: string;
  tree: string;
  executionProfile: FactoryActionExecutionProfile;
};

const ReviewFailureSchema = z
  .object({
    error: z.string(),
    failureKind: z.enum(["retryable", "human-required", "terminal"]),
    checkpoint: FactoryArtifactRefSchema.optional(),
  })
  .strict();

export function factoryImplementationReviewContractFingerprint(
  role: FactoryImplementationReviewRole,
): string {
  const prompt = role === "implementation" ? IMPLEMENTATION_REVIEW_PROMPT : QUALITY_REVIEW_PROMPT;
  return createHash("sha256")
    .update(
      JSON.stringify({
        role,
        prompt,
        reviewOutputSchema: REVIEW_OUTPUT_SCHEMA.toString("utf8"),
        terminalVerdictContractVersion: TERMINAL_VERDICT_CONTRACT_VERSION,
        handoffContractVersion: FACTORY_IMPLEMENTATION_REVIEW_HANDOFF_CONTRACT_VERSION,
      }),
    )
    .digest("hex");
}

export function authenticateFactoryImplementationReviewCheckpoint(input: {
  ref: FactoryArtifactRef;
  roots: Record<FactoryArtifactRef["base"], string>;
  identity: FactoryImplementationReviewCheckpointIdentity;
}): {
  checkpoint?: FactoryImplementationReviewCheckpoint;
  roles: AuthenticatedFactoryImplementationReviewRoles;
} {
  const path = verifyFactoryArtifactRef(input.ref, input.roots);
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(raw) || raw.version !== 1) return { roles: {} };

  const checkpoint = FactoryImplementationReviewCheckpointSchema.parse(raw);
  const authenticated: AuthenticatedFactoryImplementationReviewRoles = {};
  for (const role of FACTORY_IMPLEMENTATION_REVIEW_ROLES) {
    const entry = checkpoint.roles[role];
    if (!entry) continue;
    const result = authenticateFactoryImplementationReviewRole({
      role,
      entry,
      roots: input.roots,
    });
    if (result) authenticated[role] = result;
  }

  if (!sameCheckpointIdentity(checkpoint, input.identity)) return { checkpoint, roles: {} };
  return { checkpoint, roles: authenticated };
}

export function authenticateFactoryImplementationReviewRole(input: {
  role: FactoryImplementationReviewRole;
  entry: FactoryImplementationReviewCheckpointRole;
  roots: Record<FactoryArtifactRef["base"], string>;
}): AuthenticatedFactoryImplementationReviewRole | undefined {
  verifyFactoryArtifactRef(input.entry.prompt, input.roots);
  const outputPath = verifyFactoryArtifactRef(input.entry.output, input.roots);
  const review = ReviewOutputSchema.parse(JSON.parse(readFileSync(outputPath, "utf8")));
  assertTerminalReviewVerdict(input.role, review);
  return input.entry.contractSha256 === factoryImplementationReviewContractFingerprint(input.role)
    ? { ...input.entry, review }
    : undefined;
}

export function authenticateCausativeFactoryImplementationReviewCheckpoint(input: {
  failureRef: FactoryArtifactRef;
  executionRef: FactoryArtifactRef;
  evidence: FactoryArtifactRef[];
  roots: Record<FactoryArtifactRef["base"], string>;
  identity: FactoryImplementationReviewCheckpointIdentity;
}): {
  roles: AuthenticatedFactoryImplementationReviewRoles;
  ref?: FactoryArtifactRef;
} {
  if (JSON.stringify(input.failureRef) !== JSON.stringify(input.executionRef))
    throw new Error("Retryable review failure has invalid primary evidence");
  const failure = ReviewFailureSchema.parse(
    JSON.parse(readFileSync(verifyFactoryArtifactRef(input.failureRef, input.roots), "utf8")),
  );
  if (
    failure.failureKind !== "retryable" ||
    !failure.checkpoint ||
    !input.evidence.some(
      (evidence) => JSON.stringify(evidence) === JSON.stringify(failure.checkpoint),
    )
  )
    return { roles: {} };
  const authenticated = authenticateFactoryImplementationReviewCheckpoint({
    ref: failure.checkpoint,
    roots: input.roots,
    identity: input.identity,
  });
  return { roles: authenticated.roles, ref: failure.checkpoint };
}

export function authenticateStagedFactoryImplementationReviewRoles(input: {
  meta: unknown;
  reviewRunDir: string;
  requestedRoles: FactoryImplementationReviewRole[];
  roots: Record<FactoryArtifactRef["base"], string>;
  createRef: (path: string) => FactoryArtifactRef;
}): AuthenticatedFactoryImplementationReviewRoles {
  const meta = input.meta;
  if (!isRecord(meta)) throw new Error("Change-review metadata is invalid");
  if (
    meta.workflow !== "change-review" ||
    JSON.stringify(meta.availableSteps) !==
      JSON.stringify([...FACTORY_IMPLEMENTATION_REVIEW_ROLES]) ||
    JSON.stringify(meta.requestedSteps) !== JSON.stringify(input.requestedRoles)
  )
    throw new Error("Change-review metadata conflicts with the requested reviewer set");
  if (
    !Array.isArray(meta.executedSteps) ||
    !meta.executedSteps.every(
      (role) =>
        typeof role === "string" &&
        isFactoryImplementationReviewRole(role) &&
        input.requestedRoles.includes(role),
    ) ||
    !Array.isArray(meta.omittedSteps) ||
    meta.partial !== meta.omittedSteps.length > 0
  )
    throw new Error("Change-review execution metadata is invalid");
  if (!isRecord(meta.reviews)) throw new Error("Change-review metadata has no review results");

  const roles: AuthenticatedFactoryImplementationReviewRoles = {};
  for (const role of input.requestedRoles) {
    const summaryKey = role === "implementation" ? "implementation" : "codeQuality";
    const summary = meta.reviews[summaryKey];
    if (!isRecord(summary)) continue;
    if (!meta.executedSteps.includes(role))
      throw new Error(`${role} review metadata claims an unexecuted result`);
    const authenticated = authenticateFactoryImplementationReviewRole({
      role,
      entry: {
        contractSha256: factoryImplementationReviewContractFingerprint(role),
        prompt: input.createRef(join(input.reviewRunDir, `${role}-review.prompt.md`)),
        output: input.createRef(join(input.reviewRunDir, `${role}-review.json`)),
      },
      roots: input.roots,
    });
    if (!authenticated) throw new Error(`${role} review contract is incompatible`);
    if (summary.verdict !== authenticated.review.verdict)
      throw new Error(`${role} review metadata verdict conflicts with its output`);
    roles[role] = authenticated;
  }
  if (meta.status === "completed" && input.requestedRoles.some((role) => !roles[role]))
    throw new Error("Completed change-review metadata is missing a requested role result");
  if (meta.status !== "completed" && meta.status !== "failed")
    throw new Error("Change-review metadata has no terminal status");
  return roles;
}

export function buildFactoryImplementationReviewCheckpoint(
  identity: FactoryImplementationReviewCheckpointIdentity,
  roles: AuthenticatedFactoryImplementationReviewRoles,
): FactoryImplementationReviewCheckpoint {
  return FactoryImplementationReviewCheckpointSchema.parse({
    version: 1,
    ...identity,
    roles: Object.fromEntries(
      FACTORY_IMPLEMENTATION_REVIEW_ROLES.flatMap((role) => {
        const entry = roles[role];
        return entry
          ? [
              [
                role,
                {
                  contractSha256: entry.contractSha256,
                  prompt: entry.prompt,
                  output: entry.output,
                },
              ],
            ]
          : [];
      }),
    ),
  });
}

export function assertTerminalReviewVerdict(
  role: FactoryImplementationReviewRole,
  review: ReviewOutput,
): void {
  if (review.verdict === "blocked") return;
  const hasMustFix = review.findings.some((finding) => finding.must_fix);
  if (review.verdict === "needs_changes" && !hasMustFix)
    throw new Error(`${role} review needs_changes verdict has no must_fix finding`);
  if (review.verdict === "pass" && hasMustFix)
    throw new Error(`${role} review pass verdict has a must_fix finding`);
}

function sameCheckpointIdentity(
  checkpoint: FactoryImplementationReviewCheckpoint,
  identity: FactoryImplementationReviewCheckpointIdentity,
): boolean {
  return (
    checkpoint.phaseRunId === identity.phaseRunId &&
    checkpoint.reviewRound === identity.reviewRound &&
    checkpoint.candidateAttempt === identity.candidateAttempt &&
    checkpoint.base === identity.base &&
    checkpoint.commit === identity.commit &&
    checkpoint.tree === identity.tree &&
    JSON.stringify(checkpoint.executionProfile) === JSON.stringify(identity.executionProfile)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFactoryImplementationReviewRole(
  value: string,
): value is FactoryImplementationReviewRole {
  return (FACTORY_IMPLEMENTATION_REVIEW_ROLES as readonly string[]).includes(value);
}
