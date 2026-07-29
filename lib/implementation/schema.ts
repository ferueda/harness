import { z } from "zod";

export const IMPLEMENTATION_RESULT_SCHEMA_VERSION = "1";

const NonEmptyStringSchema = z.string().min(1);

export const ImplementationProofSchema = z
  .object({
    action: NonEmptyStringSchema,
    status: z.enum(["passed", "failed", "skipped"]),
    observedResult: NonEmptyStringSchema,
  })
  .strict();

const ImplementedDecisionSchema = z
  .object({
    outcome: z.literal("implemented"),
    summary: NonEmptyStringSchema,
    proof: z.array(ImplementationProofSchema).min(1),
    remainingUncertainty: z.array(NonEmptyStringSchema),
    questions: z.array(NonEmptyStringSchema).length(0),
  })
  .strict()
  .superRefine((decision, ctx) => {
    if (
      decision.proof.some((proof) => proof.status !== "passed") &&
      decision.remainingUncertainty.length === 0
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["remainingUncertainty"],
        message: "failed or skipped proof requires at least one remaining uncertainty",
      });
    }
  });

const NeedsInputDecisionSchema = z
  .object({
    outcome: z.literal("needs-input"),
    summary: NonEmptyStringSchema,
    proof: z.array(ImplementationProofSchema).length(0),
    remainingUncertainty: z.array(NonEmptyStringSchema).length(0),
    questions: z.array(NonEmptyStringSchema).min(1),
  })
  .strict();

export const ImplementationDecisionSchema = z.discriminatedUnion("outcome", [
  ImplementedDecisionSchema,
  NeedsInputDecisionSchema,
]);

export type ImplementationProof = z.infer<typeof ImplementationProofSchema>;
export type ImplementationDecision = z.infer<typeof ImplementationDecisionSchema>;
