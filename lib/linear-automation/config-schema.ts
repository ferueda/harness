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
    model: z.string().trim().min(1),
    modelReasoningEffort: z.enum(AGENT_REASONING_EFFORTS),
    maxRuntimeMs: z.number().int().positive(),
  })
  .strict();

const LinearAutomationImplementationProfileSchema = z
  .object({
    agent: z.literal("codex"),
    model: z.string().trim().min(1),
    modelReasoningEffort: z.enum(AGENT_REASONING_EFFORTS),
    maxRuntimeMs: z.number().int().positive(),
  })
  .strict();

const LinearAutomationImplementationSchema = z
  .object({
    implementer: LinearAutomationImplementationProfileSchema,
    reviewers: LinearAutomationImplementationProfileSchema,
  })
  .strict();

export const LinearAutomationConfigSchema = z
  .object({
    readiness: LinearReadinessMappingSchema,
    triage: LinearAutomationTriageSchema,
    spec: LinearAutomationSpecSchema.optional(),
    implementation: LinearAutomationImplementationSchema.optional(),
  })
  .strict();

export type LinearAutomationConfig = z.infer<typeof LinearAutomationConfigSchema>;
