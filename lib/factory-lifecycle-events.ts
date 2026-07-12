import { z } from "zod";
import { FactoryArtifactRefSchema } from "./factory-artifact-ref.ts";
import {
  FactoryFailureKindSchema,
  FactoryHandlerSchema,
  FactoryPhaseSchema,
} from "./factory-action-contract.ts";

const Base = z
  .object({
    version: z.literal(1),
    id: z.string().min(1),
    type: z.string().min(1),
    workItemKey: z.string().min(1),
    occurredAt: z.iso.datetime(),
    phaseRunId: z.string().min(1).optional(),
  })
  .strict();
const Execution = z
  .object({ workspaceRef: z.string().min(1), runRef: FactoryArtifactRefSchema })
  .strict();
const RequestData = z
  .object({
    expectedPredecessor: z.string().min(1).nullable(),
    inputRefs: z.array(FactoryArtifactRefSchema),
  })
  .strict();
const ActionData = z
  .object({
    handler: FactoryHandlerSchema,
    handlerVersion: z.literal(1),
    attempt: z.number().int().positive(),
    causationEventId: z.string().min(1),
    execution: Execution,
    evidence: z.array(FactoryArtifactRefSchema),
  })
  .strict();

export const FactoryLifecycleEventSchema = z.discriminatedUnion("type", [
  Base.extend({
    type: z.literal("work_item.imported"),
    data: z.object({ source: z.string().min(1), title: z.string().min(1) }).strict(),
  }),
  Base.extend({
    type: z.literal("triage.requested"),
    phaseRunId: z.string().min(1),
    data: RequestData,
  }),
  Base.extend({
    type: z.literal("triage.work_item.completed"),
    phaseRunId: z.string().min(1),
    data: ActionData.extend({
      route: z.enum(["ready-to-plan", "ready-to-implement", "needs-info", "wait-to-implement"]),
      nextCommand: z.string().min(1),
      rationale: z.string().min(1),
    }),
  }),
  Base.extend({
    type: z.literal("planning.requested"),
    phaseRunId: z.string().min(1),
    data: RequestData.extend({ reviewCeiling: z.number().int().positive() }),
  }),
  Base.extend({
    type: z.literal("implementation.requested"),
    phaseRunId: z.string().min(1),
    data: RequestData.extend({ reviewCeiling: z.number().int().positive() }),
  }),
  Base.extend({
    type: z.literal("factory.action.failed"),
    phaseRunId: z.string().min(1),
    data: ActionData.extend({
      phase: FactoryPhaseSchema,
      failureKind: FactoryFailureKindSchema,
      message: z.string().min(1),
    }),
  }),
]);

export type FactoryLifecycleEvent = z.infer<typeof FactoryLifecycleEventSchema>;
export type FactoryActionEvent = Extract<
  FactoryLifecycleEvent,
  { type: "triage.work_item.completed" | "factory.action.failed" }
>;

export function parseFactoryLifecycleEvent(value: unknown): FactoryLifecycleEvent {
  return FactoryLifecycleEventSchema.parse(value);
}
