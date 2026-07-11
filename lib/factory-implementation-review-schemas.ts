import { z } from "zod";
import { AGENT_PROVIDERS } from "./agents.ts";
import { formatZodError } from "./schemas.ts";

export const FACTORY_REMEDIATION_DECISIONS = ["implement", "adapt", "decline"] as const;

export const FactoryImplementationRemediationOutputSchema = z
  .object({
    summary: z.string().min(1),
    findingDecisions: z
      .array(
        z
          .object({
            findingId: z.string().min(1),
            decision: z.enum(FACTORY_REMEDIATION_DECISIONS),
            rationale: z.string().min(1),
          })
          .strict(),
      )
      .min(0),
  })
  .strict();

export type FactoryImplementationRemediationOutput = z.infer<
  typeof FactoryImplementationRemediationOutputSchema
>;
export type FactoryRemediationDecision = (typeof FACTORY_REMEDIATION_DECISIONS)[number];

const PositiveIntegerSchema = z.number().int().positive();
const NonnegativeIntegerSchema = z.number().int().nonnegative();
const RelativeArtifactPathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith("/"), "must be relative")
  .refine((value) => !value.split("/").includes(".."), "must not contain ..")
  .refine((value) => value === value.replaceAll("\\", "/"), "must use POSIX separators")
  .refine((value) => !value.split("/").includes(""), "must not contain empty path segments");

export const AgentSessionRefSchema = z
  .object({
    provider: z.enum(AGENT_PROVIDERS),
    id: z.string().min(1),
    raw: z.unknown().optional(),
  })
  .strict();

export const RunRootProvenanceSchema = z
  .object({
    factoryRunsDir: z.string().min(1),
    reviewRunsDir: z.string().min(1),
  })
  .strict();

export const ArtifactPointerSchema = z
  .object({
    runId: z.string().min(1),
    root: z.enum(["factory", "review"]),
    path: RelativeArtifactPathSchema,
  })
  .strict();

export const CandidateTupleSchema = z
  .object({
    ref: z.string().min(1),
    commit: z.string().min(1),
    tree: z.string().min(1),
  })
  .strict();

export const WorkspaceProvenanceSchema = z
  .object({
    physicalGitRoot: z.string().min(1),
    workspaceKey: z.string().min(1),
    factoryProjectId: z.string().min(1),
  })
  .strict();

export const EffectiveReviewLimitSchema = z
  .object({
    value: PositiveIntegerSchema,
    source: z.enum(["default", "config", "cli"]),
  })
  .strict();

export const PartialRecoverySchema = z
  .object({
    tuple: CandidateTupleSchema,
    attemptId: z.string().min(1),
    reviewIndex: PositiveIntegerSchema,
    status: ArtifactPointerSchema,
    patch: ArtifactPointerSchema,
    recovery: ArtifactPointerSchema,
  })
  .strict();

export const ImplementationReviewCheckpointSchema = z
  .object({
    version: z.literal(1),
    checkpointId: z.string().min(1),
    owningImplementationRunId: z.string().min(1),
    originalReviewBase: z.string().min(1),
    approvedCandidate: CandidateTupleSchema,
    implementerSession: AgentSessionRefSchema,
    workspace: WorkspaceProvenanceSchema,
    runRoots: RunRootProvenanceSchema,
    latestCheckpointId: z.string().min(1),
    candidateVersion: NonnegativeIntegerSchema,
    completedReviewCount: NonnegativeIntegerSchema,
    effectiveReviewLimit: EffectiveReviewLimitSchema,
    activeReviewAttemptId: z.string().min(1).optional(),
    priorReviewAttemptId: z.string().min(1).optional(),
    activeReviewIndex: PositiveIntegerSchema.optional(),
    latestReview: ArtifactPointerSchema.optional(),
    latestDecision: ArtifactPointerSchema.optional(),
    partialRecovery: PartialRecoverySchema.optional(),
    latestOutcome: z.string().min(1).optional(),
    latestErrorClass: z.string().min(1).optional(),
  })
  .strict();

export type RunRootProvenance = z.infer<typeof RunRootProvenanceSchema>;
export type ArtifactPointer = z.infer<typeof ArtifactPointerSchema>;
export type CandidateTuple = z.infer<typeof CandidateTupleSchema>;
export type WorkspaceProvenance = z.infer<typeof WorkspaceProvenanceSchema>;
export type EffectiveReviewLimit = z.infer<typeof EffectiveReviewLimitSchema>;
export type PartialRecovery = z.infer<typeof PartialRecoverySchema>;
export type ImplementationReviewCheckpoint = z.infer<typeof ImplementationReviewCheckpointSchema>;

export function parseFactoryImplementationRemediationOutput(
  value: unknown,
): FactoryImplementationRemediationOutput {
  const result = FactoryImplementationRemediationOutputSchema.safeParse(value);
  if (result.success) return result.data;
  throw new FactoryImplementationReviewSchemaError(
    `Invalid factory implementation remediation output: ${formatZodError(result.error)}`,
    { cause: result.error },
  );
}

export class FactoryImplementationReviewSchemaError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "FactoryImplementationReviewSchemaError";
  }
}

export const FACTORY_IMPLEMENTATION_REMEDIATION_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "FactoryImplementationRemediationOutput",
  type: "object",
  additionalProperties: false,
  required: ["summary", "findingDecisions"],
  properties: {
    summary: { type: "string", minLength: 1 },
    findingDecisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["findingId", "decision", "rationale"],
        properties: {
          findingId: { type: "string", minLength: 1 },
          decision: { type: "string", enum: [...FACTORY_REMEDIATION_DECISIONS] },
          rationale: { type: "string", minLength: 1 },
        },
      },
    },
  },
} as const;
