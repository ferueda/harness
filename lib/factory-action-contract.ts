import { z } from "zod";

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
export type FactoryHandler = z.infer<typeof FactoryHandlerSchema>;
export type FactoryPhase = z.infer<typeof FactoryPhaseSchema>;

export function factoryActionKey(input: {
  phaseRunId: string;
  handler: FactoryHandler;
  attempt: number;
  causationEventId: string;
}): string {
  return `${input.phaseRunId}:${input.handler}:${input.attempt}:${input.causationEventId}`;
}
