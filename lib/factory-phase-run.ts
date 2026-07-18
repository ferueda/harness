import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { AGENT_APPROVAL_POLICIES, AGENT_REASONING_EFFORTS, AGENT_SANDBOX_MODES } from "./agents.ts";
import { FactoryPhaseRunIdSchema } from "./factory-action-contract.ts";
import { FactoryArtifactRefSchema } from "./factory-artifact-ref.ts";
import { writeDurableFactoryFile } from "./factory-durable-file.ts";

export const FactoryActionExecutionProfileSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("cursor"), model: z.string().min(1) }).strict(),
  z
    .object({
      provider: z.literal("codex"),
      model: z.string().min(1),
      executable: z.string().min(1).optional(),
      sandbox: z.enum(AGENT_SANDBOX_MODES),
      approvalPolicy: z.enum(AGENT_APPROVAL_POLICIES),
      reasoningEffort: z.enum(AGENT_REASONING_EFFORTS),
    })
    .strict(),
]);
export type FactoryActionExecutionProfile = z.infer<typeof FactoryActionExecutionProfileSchema>;

const FactoryPhaseRunV1BaseSchema = z.object({
  version: z.literal(1),
  phaseRunId: FactoryPhaseRunIdSchema,
  workItemKey: z.string().min(1),
  workspace: z.string().min(1),
  projectId: z.string().min(1),
  factoryStateRoot: z.string().min(1),
});

export const FactoryPhaseGitIdentitySchema = z
  .object({
    repositoryId: z.string().min(1),
    baseSha: z.string().regex(/^[0-9a-f]{40}$/),
    target: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("detached") }).strict(),
      z
        .object({ mode: z.literal("branch"), branchRef: z.string().regex(/^refs\/heads\/.+/) })
        .strict(),
    ]),
  })
  .strict();
export type FactoryPhaseGitIdentity = z.infer<typeof FactoryPhaseGitIdentitySchema>;

export const DEFAULT_FACTORY_AUTOMATIC_ACTION_POLICY = Object.freeze({
  maxExecutions: 3,
});
export const FactoryAutomaticActionPolicySchema = z
  .object({
    maxExecutions: z.number().int().positive(),
  })
  .strict();
export type FactoryAutomaticActionPolicy = z.infer<typeof FactoryAutomaticActionPolicySchema>;

const FactoryPhaseRunV2BaseSchema = z.object({
  version: z.literal(2),
  phaseRunId: FactoryPhaseRunIdSchema,
  workItemKey: z.string().min(1),
  workspace: z.string().min(1),
  projectId: z.string().min(1),
  factoryStateRoot: z.string().min(1),
  git: FactoryPhaseGitIdentitySchema.optional(),
  automaticActionPolicy: FactoryAutomaticActionPolicySchema.optional(),
});

export const FactoryImplementationInputSnapshotSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("direct"),
      importedEventId: z.string().min(1),
      readinessEventId: z.string().min(1),
      workItem: FactoryArtifactRefSchema,
      readiness: FactoryArtifactRefSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal("planned"),
      importedEventId: z.string().min(1),
      candidateEventId: z.string().min(1),
      reviewEventId: z.string().min(1),
      workItem: FactoryArtifactRefSchema,
      planCandidate: FactoryArtifactRefSchema,
      approvedPlan: FactoryArtifactRefSchema.optional(),
      outputPlan: z.string().min(1),
      publicationMode: z.enum(["local", "pull-request"]),
      mergedEventId: z.string().min(1).optional(),
      mergedUrl: z.url().optional(),
      mergedCommit: z
        .string()
        .regex(/^[0-9a-f]{40}$/)
        .optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      const completeMerge = Boolean(value.mergedEventId && value.mergedUrl && value.mergedCommit);
      if ((value.publicationMode === "pull-request") !== completeMerge)
        ctx.addIssue({ code: "custom", message: "pull-request input requires merge identity" });
    }),
]);
export type FactoryImplementationInputSnapshot = z.infer<
  typeof FactoryImplementationInputSnapshotSchema
>;

const FactoryPhaseRunV1IdentitySchema = z.discriminatedUnion("phase", [
  FactoryPhaseRunV1BaseSchema.extend({
    phase: z.literal("triage"),
    actions: z
      .object({
        triageWorkItem: FactoryActionExecutionProfileSchema,
      })
      .strict(),
  }).strict(),
  FactoryPhaseRunV1BaseSchema.extend({
    phase: z.literal("planning"),
    outputPlan: z.string().min(1),
    publicationMode: z.enum(["local", "pull-request"]),
    baseRef: z.string().min(1).optional(),
    baseSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .optional(),
    branchRef: z
      .string()
      .regex(/^refs\/heads\/.+/)
      .optional(),
    actions: z
      .object({
        producePlanCandidate: FactoryActionExecutionProfileSchema,
        reviewPlanCandidate: FactoryActionExecutionProfileSchema,
      })
      .strict(),
  })
    .strict()
    .superRefine((value, ctx) => {
      if (
        value.publicationMode === "pull-request" &&
        (!value.baseRef || !value.baseSha || !value.branchRef)
      )
        ctx.addIssue({ code: "custom", message: "pull-request planning requires Git identity" });
    }),
  FactoryPhaseRunV1BaseSchema.extend({
    phase: z.literal("implementation"),
    baseRef: z.string().min(1),
    branchRef: z.string().regex(/^refs\/heads\/.+/),
    baseSha: z.string().regex(/^[0-9a-f]{40}$/),
    input: FactoryImplementationInputSnapshotSchema,
    actions: z
      .object({
        produceImplementationCandidate: FactoryActionExecutionProfileSchema,
        reviewImplementationCandidate: FactoryActionExecutionProfileSchema,
      })
      .strict(),
  }).strict(),
]);

const FactoryPhaseRunV2IdentitySchema = z.discriminatedUnion("phase", [
  FactoryPhaseRunV2BaseSchema.extend({
    phase: z.literal("triage"),
    actions: z.object({ triageWorkItem: FactoryActionExecutionProfileSchema }).strict(),
  }).strict(),
  FactoryPhaseRunV2BaseSchema.extend({
    phase: z.literal("planning"),
    outputPlan: z.string().min(1),
    publicationMode: z.enum(["local", "pull-request"]),
    baseRef: z.string().min(1).optional(),
    actions: z
      .object({
        producePlanCandidate: FactoryActionExecutionProfileSchema,
        reviewPlanCandidate: FactoryActionExecutionProfileSchema,
      })
      .strict(),
  })
    .strict()
    .superRefine((value, ctx) => {
      if (
        value.publicationMode === "pull-request" &&
        (!value.baseRef || value.git?.target.mode !== "branch")
      )
        ctx.addIssue({ code: "custom", message: "pull-request planning requires Git identity" });
    }),
  FactoryPhaseRunV2BaseSchema.extend({
    phase: z.literal("implementation"),
    baseRef: z.string().min(1),
    git: FactoryPhaseGitIdentitySchema.refine((git) => git.target.mode === "branch", {
      message: "implementation requires branch Git identity",
    }),
    input: FactoryImplementationInputSnapshotSchema,
    actions: z
      .object({
        produceImplementationCandidate: FactoryActionExecutionProfileSchema,
        reviewImplementationCandidate: FactoryActionExecutionProfileSchema,
      })
      .strict(),
  }).strict(),
]);

export const FactoryPhaseRunIdentitySchema = z.union([
  FactoryPhaseRunV1IdentitySchema,
  FactoryPhaseRunV2IdentitySchema,
]);
export type FactoryPhaseRunIdentity = z.infer<typeof FactoryPhaseRunIdentitySchema>;

export function writeFactoryPhaseRunIdentity(
  runDir: string,
  identity: FactoryPhaseRunIdentity,
): void {
  const parsed = FactoryPhaseRunIdentitySchema.parse(identity);
  writeDurableFactoryFile(
    join(runDir, "context/phase-run.json"),
    `${JSON.stringify(parsed, null, 2)}\n`,
    true,
  );
}

export function readFactoryPhaseRunIdentity(runDir: string): FactoryPhaseRunIdentity {
  return FactoryPhaseRunIdentitySchema.parse(
    JSON.parse(readFileSync(join(runDir, "context/phase-run.json"), "utf8")),
  );
}
