import { z } from "zod";
import { formatZodError } from "./schemas.ts";

export const FACTORY_PLANNING_OUTCOMES = ["draft-ready", "needs-human"] as const;
export const FACTORY_PLANNING_FINDING_DECISIONS = ["implement", "adapt", "decline"] as const;

export class FactoryPlanningError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "FactoryPlanningError";
  }
}

export const FactoryPlanningOutputSchema = z
  .object({
    outcome: z.enum(FACTORY_PLANNING_OUTCOMES),
    summary: z.string().min(1),
    shortSlug: z.string().min(1).optional(),
    planMarkdown: z.string().min(1).optional(),
    humanQuestions: z.array(z.string().min(1)).optional(),
    findingDecisions: z
      .array(
        z
          .object({
            findingId: z.string().min(1),
            decision: z.enum(FACTORY_PLANNING_FINDING_DECISIONS),
            rationale: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
  })
  .strict()
  .superRefine((output, ctx) => {
    if (output.outcome === "draft-ready") {
      if (!output.shortSlug) {
        ctx.addIssue({
          code: "custom",
          path: ["shortSlug"],
          message: "draft-ready requires shortSlug",
        });
      }
      if (!output.planMarkdown) {
        ctx.addIssue({
          code: "custom",
          path: ["planMarkdown"],
          message: "draft-ready requires planMarkdown",
        });
      }
    }

    if (
      output.outcome === "needs-human" &&
      (!output.humanQuestions || output.humanQuestions.length === 0)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["humanQuestions"],
        message: "needs-human requires at least one human question",
      });
    }
  });

export type FactoryPlanningOutput = z.infer<typeof FactoryPlanningOutputSchema>;

export function parseFactoryPlanningOutput(value: unknown): FactoryPlanningOutput {
  const result = FactoryPlanningOutputSchema.safeParse(value);
  if (result.success) return result.data;
  throw new FactoryPlanningError(
    `Invalid factory planning output: ${formatZodError(result.error)}`,
    {
      cause: result.error,
    },
  );
}
