import { z } from "zod";
import {
  AGENT_APPROVAL_POLICIES,
  AGENT_PROVIDERS,
  AGENT_REASONING_EFFORTS,
  AGENT_SANDBOX_MODES,
  CURSOR_SDK_MODEL_MODES,
  type AgentProviderName,
} from "./agents.ts";

const CodexOnlyRoleFields = [
  "executable",
  "sandboxMode",
  "approvalPolicy",
  "modelReasoningEffort",
] as const;

const FactoryRoleSchema = z
  .object({
    agent: z.enum(AGENT_PROVIDERS).optional(),
    model: z.string().optional(),
    executable: z.string().optional(),
    sandboxMode: z.enum(AGENT_SANDBOX_MODES).optional(),
    approvalPolicy: z.enum(AGENT_APPROVAL_POLICIES).optional(),
    modelReasoningEffort: z.enum(AGENT_REASONING_EFFORTS).optional(),
  })
  .strict();

const FactoryLinearStatusesSchema = z
  .object({
    intake: z.string().min(1),
    parked: z.string().min(1),
    needsInfo: z.string().min(1),
    needsPlan: z.string().min(1),
    needsPlanReview: z.string().min(1),
    readyToImplement: z.string().min(1),
    implementing: z.string().min(1),
    readyForReview: z.string().min(1),
    implementationFailed: z.string().min(1),
    triaging: z.string().min(1),
    planning: z.string().min(1),
    triageFailed: z.string().min(1),
    planningFailed: z.string().min(1),
    /** Optional non-completion terminal board statuses for operator moves / list filters. */
    done: z.string().min(1),
    canceled: z.string().min(1).optional(),
    duplicate: z.string().min(1).optional(),
  })
  .strict();

const FactoryLinearConfigSchema = z
  .object({
    teamKey: z.string().min(1),
    projectId: z.uuid().optional(),
    statuses: FactoryLinearStatusesSchema,
  })
  .strict();

/** A store project id is joined below `<storeRoot>/projects`, never sanitized. */
export const FactoryStoreProjectIdSchema = z
  .string()
  .min(1)
  .max(120)
  .refine((value) => value === value.trim(), "must not contain leading or trailing whitespace")
  .refine((value) => value !== "." && value !== "..", "must not be . or ..")
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be one safe path segment");

const FactoryStoreConfigSchema = z
  .object({
    root: z.string().min(1).optional(),
    projectId: FactoryStoreProjectIdSchema.optional(),
  })
  .strict();

const FactoryConfigSchema = z
  .object({
    triage: z
      .object({
        roles: z
          .object({
            triager: FactoryRoleSchema.optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    planning: z
      .object({
        maxReviewIterations: z.number().int().positive().optional(),
        roles: z
          .object({
            planner: FactoryRoleSchema.optional(),
            reviewer: FactoryRoleSchema.optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    implementation: z
      .object({
        maxReviewIterations: z.number().int().positive().optional(),
        roles: z
          .object({
            implementer: FactoryRoleSchema.optional(),
            reviewer: FactoryRoleSchema.optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    linear: FactoryLinearConfigSchema.optional(),
    store: FactoryStoreConfigSchema.optional(),
  })
  .strict();

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
    factory: FactoryConfigSchema.optional(),
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

    validateFactoryRole(
      config,
      ctx,
      ["factory", "triage", "roles", "triager"],
      config.factory?.triage?.roles?.triager,
    );
    validateFactoryRole(
      config,
      ctx,
      ["factory", "planning", "roles", "planner"],
      config.factory?.planning?.roles?.planner,
    );
    validateFactoryRole(
      config,
      ctx,
      ["factory", "planning", "roles", "reviewer"],
      config.factory?.planning?.roles?.reviewer,
    );
    validateFactoryRole(
      config,
      ctx,
      ["factory", "implementation", "roles", "implementer"],
      config.factory?.implementation?.roles?.implementer,
    );
    validateFactoryRole(
      config,
      ctx,
      ["factory", "implementation", "roles", "reviewer"],
      config.factory?.implementation?.roles?.reviewer,
    );
  });

export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;
export type FactoryRoleConfig = z.infer<typeof FactoryRoleSchema>;
export type FactoryLinearConfig = z.infer<typeof FactoryLinearConfigSchema>;
export type FactoryLinearStatusesConfig = z.infer<typeof FactoryLinearStatusesSchema>;
export type FactoryStoreConfig = z.infer<typeof FactoryStoreConfigSchema>;

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

function validateFactoryRole(
  config: { defaultAgent?: AgentProviderName },
  ctx: z.RefinementCtx,
  path: string[],
  role: FactoryRoleConfig | undefined,
): void {
  if (!role) return;

  const effectiveAgent = role.agent ?? config.defaultAgent ?? "cursor";
  if (effectiveAgent !== "codex") {
    for (const field of CodexOnlyRoleFields) {
      if (role[field] === undefined) continue;
      ctx.addIssue({
        code: "custom",
        path: [...path, field],
        message: `${field} applies only when role agent is codex`,
      });
    }
  }

  if (effectiveAgent === "cursor" && role.model && !isCursorModel(role.model)) {
    ctx.addIssue({
      code: "custom",
      path: [...path, "model"],
      message: `Unsupported Cursor model: ${role.model}`,
    });
  }
}

function isCursorModel(model: string): boolean {
  return CURSOR_SDK_MODEL_MODES.some((knownModel) => knownModel === model);
}
