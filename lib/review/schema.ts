import { z } from "zod";

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
