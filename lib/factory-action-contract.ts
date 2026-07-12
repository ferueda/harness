import { z } from "zod";
import { createHash } from "node:crypto";

export const FACTORY_HANDLERS = [
  "triageWorkItem",
  "producePlanCandidate",
  "reviewPlanCandidate",
  "produceImplementationCandidate",
  "reviewImplementationCandidate",
] as const;

export const FactoryHandlerSchema = z.enum(FACTORY_HANDLERS);
export const FactoryPhaseSchema = z.enum(["triage", "planning", "implementation"]);
export const FactoryFailureKindSchema = z.enum(["retryable", "human-required", "terminal"]);
export const FactoryPhaseRunIdSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be a safe phase-run identifier");
export type FactoryHandler = z.infer<typeof FactoryHandlerSchema>;
export type FactoryPhase = z.infer<typeof FactoryPhaseSchema>;

export function factoryActionKey(input: {
  phaseRunId: string;
  handler: FactoryHandler;
  attempt: number;
  causationEventId: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        phaseRunId: input.phaseRunId,
        handler: input.handler,
        attempt: input.attempt,
        causationEventId: input.causationEventId,
      }),
    )
    .digest("hex");
}
