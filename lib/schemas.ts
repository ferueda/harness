import { z } from "zod";
import {
  AGENT_APPROVAL_POLICIES,
  AGENT_PROVIDERS,
  AGENT_REASONING_EFFORTS,
  AGENT_SANDBOX_MODES,
} from "./agents.ts";

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
  })
  .passthrough()
  .superRefine((config, ctx) => {
    const runtime = config.agents?.cursor?.runtime;
    if (runtime === undefined) return;
    ctx.addIssue({
      code: "custom",
      path: ["agents", "cursor", "runtime"],
      message:
        "Cursor CLI runtime has been removed; harness reviews use the Cursor SDK (default). Remove agents.cursor.runtime from harness.json.",
    });
  });

export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;

export const ReviewOutputSchema = z
  .object({
    verdict: z.enum(["pass", "needs_changes", "blocked"]),
    summary: z.string(),
    findings: z.array(
      z
        .object({
          title: z.string(),
          severity: z.enum(["Critical", "High", "Medium", "Low"]),
          location: z.string(),
          issue: z.string(),
          recommendation: z.string(),
          rationale: z.string(),
          must_fix: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();

export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

export function formatZodError(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`).join("; ");
}
