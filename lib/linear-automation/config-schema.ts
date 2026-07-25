import { z } from "zod";
import { AGENT_REASONING_EFFORTS } from "../agent/contract.ts";
import { LinearReadinessMappingSchema } from "./readiness.ts";

const LinearAutomationTriageSchema = z
  .object({
    agent: z.literal("codex"),
    model: z.string().trim().min(1).optional(),
    modelReasoningEffort: z.enum(AGENT_REASONING_EFFORTS).optional(),
    maxRuntimeMs: z.number().int().positive(),
  })
  .strict();

const LinearAutomationSpecSchema = z
  .object({
    agent: z.literal("codex"),
    model: z.literal("gpt-5.6-sol"),
    modelReasoningEffort: z.literal("high"),
    maxRuntimeMs: z.literal(1_800_000),
  })
  .strict();

export const LinearAutomationConfigSchema = z
  .object({
    readiness: LinearReadinessMappingSchema,
    triage: LinearAutomationTriageSchema,
    spec: LinearAutomationSpecSchema.optional(),
  })
  .strict();

export type LinearAutomationConfig = z.infer<typeof LinearAutomationConfigSchema>;
