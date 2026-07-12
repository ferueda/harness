import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  AGENT_APPROVAL_POLICIES,
  AGENT_PROVIDERS,
  AGENT_REASONING_EFFORTS,
  AGENT_SANDBOX_MODES,
} from "./agents.ts";
import { FactoryPhaseRunIdSchema } from "./factory-action-contract.ts";

export const FactoryActionExecutionProfileSchema = z
  .object({
    provider: z.enum(AGENT_PROVIDERS),
    model: z.string().min(1),
    executable: z.string().min(1).optional(),
    sandbox: z.enum(AGENT_SANDBOX_MODES).optional(),
    approvalPolicy: z.enum(AGENT_APPROVAL_POLICIES).optional(),
    reasoningEffort: z.enum(AGENT_REASONING_EFFORTS).optional(),
  })
  .strict()
  .superRefine((profile, ctx) => {
    if (profile.provider === "cursor") {
      for (const key of ["executable", "sandbox", "approvalPolicy", "reasoningEffort"] as const) {
        if (profile[key] !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: `${key} is only valid for the codex provider`,
          });
        }
      }
    }
  });
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

export function factoryPhaseRunId(input: {
  workItemKey: string;
  phase: string;
  requestId: string;
}): string {
  const digest = createHash("sha256")
    .update(`${input.workItemKey}\0${input.phase}\0${input.requestId}`)
    .digest("hex")
    .slice(0, 20);
  return `${input.phase}-${digest}`;
}

export function writeFactoryPhaseRunIdentity(
  runDir: string,
  identity: FactoryPhaseRunIdentity,
): void {
  const parsed = FactoryPhaseRunIdentitySchema.parse(identity);
  writeFileSync(join(runDir, "context/phase-run.json"), `${JSON.stringify(parsed, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

export function readFactoryPhaseRunIdentity(runDir: string): FactoryPhaseRunIdentity {
  return FactoryPhaseRunIdentitySchema.parse(
    JSON.parse(readFileSync(join(runDir, "context/phase-run.json"), "utf8")),
  );
}

export function resolveFactoryTriageExecutionProfileForRun(input: {
  existingRunDir?: string;
  newPhaseProfile: FactoryActionExecutionProfile;
}): FactoryActionExecutionProfile {
  return input.existingRunDir
    ? readFactoryPhaseRunIdentity(input.existingRunDir).actions.triageWorkItem
    : FactoryActionExecutionProfileSchema.parse(input.newPhaseProfile);
}
