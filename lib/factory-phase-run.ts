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

const FactoryPhaseRunBaseSchema = z.object({
  version: z.literal(1),
  phaseRunId: FactoryPhaseRunIdSchema,
  workItemKey: z.string().min(1),
  workspace: z.string().min(1),
  projectId: z.string().min(1),
  factoryStateRoot: z.string().min(1),
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

export const FactoryPhaseRunIdentitySchema = z.discriminatedUnion("phase", [
  FactoryPhaseRunBaseSchema.extend({
    phase: z.literal("triage"),
    actions: z
      .object({
        triageWorkItem: FactoryActionExecutionProfileSchema,
      })
      .strict(),
  }).strict(),
  FactoryPhaseRunBaseSchema.extend({
    phase: z.literal("planning"),
    reviewCeiling: z.number().int().positive(),
    outputPlan: z.string().min(1),
    publicationMode: z.enum(["local", "pull-request"]),
    actions: z
      .object({
        producePlanCandidate: FactoryActionExecutionProfileSchema,
        reviewPlanCandidate: FactoryActionExecutionProfileSchema,
      })
      .strict(),
  }).strict(),
  FactoryPhaseRunBaseSchema.extend({
    phase: z.literal("implementation"),
    reviewCeiling: z.number().int().positive(),
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
