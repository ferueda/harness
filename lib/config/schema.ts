import { z } from "zod";
import {
  AGENT_APPROVAL_POLICIES,
  AGENT_PROVIDERS,
  AGENT_REASONING_EFFORTS,
  AGENT_SANDBOX_MODES,
} from "../agent/contract.ts";
import { LinearAutomationConfigSchema } from "../linear-automation/config-schema.ts";
import { RepositoryRunsConfigSchema } from "../repository/config-schema.ts";

export const HarnessConfigSchema = z
  .object({
    base: z.string().optional(),
    defaultAgent: z.enum(AGENT_PROVIDERS).optional(),
    agents: z
      .object({
        cursor: z
          .object({
            model: z.string().optional(),
          })
          .passthrough()
          .optional(),
        codex: z
          .object({
            model: z.string().optional(),
            executable: z.string().optional(),
            sandboxMode: z.enum(AGENT_SANDBOX_MODES).optional(),
            approvalPolicy: z.enum(AGENT_APPROVAL_POLICIES).optional(),
            modelReasoningEffort: z.enum(AGENT_REASONING_EFFORTS).optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    linearAutomation: LinearAutomationConfigSchema.optional(),
    repositoryRuns: RepositoryRunsConfigSchema.optional(),
  })
  .passthrough()
  .superRefine((config, ctx) => {
    const runtime = config.agents?.cursor?.runtime;
    if (runtime !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["agents", "cursor", "runtime"],
        message:
          "agents.cursor.runtime is no longer supported; harness reviews always use the Cursor SDK. Remove agents.cursor.runtime from harness.json.",
      });
    }

    if ("factory" in config) {
      ctx.addIssue({
        code: "custom",
        path: ["factory"],
        message: "factory is no longer supported; remove it from harness.json",
      });
    }
  });

export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;

export function formatZodError(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`).join("; ");
}
