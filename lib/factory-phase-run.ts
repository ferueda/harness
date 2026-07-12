import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { AGENT_APPROVAL_POLICIES, AGENT_REASONING_EFFORTS, AGENT_SANDBOX_MODES } from "./agents.ts";
import { FactoryPhaseRunIdSchema } from "./factory-action-contract.ts";
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

export const FactoryPhaseRunIdentitySchema = z
  .object({
    version: z.literal(1),
    phaseRunId: FactoryPhaseRunIdSchema,
    phase: z.literal("triage"),
    workItemKey: z.string().min(1),
    workspace: z.string().min(1),
    projectId: z.string().min(1),
    factoryStateRoot: z.string().min(1),
    actions: z
      .object({
        triageWorkItem: FactoryActionExecutionProfileSchema,
      })
      .strict(),
  })
  .strict();
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
