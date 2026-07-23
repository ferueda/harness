import { z } from "zod";

export const RepositoryRunsConfigSchema = z
  .object({
    remote: z.string().trim().min(1),
    maxTrees: z.number().int().positive().default(2),
    setup: z
      .object({
        command: z.array(z.string().min(1)).min(1),
        timeoutMs: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

export type RepositoryRunsConfig = z.infer<typeof RepositoryRunsConfigSchema>;
export type RepositoryRunsConfigInput = z.input<typeof RepositoryRunsConfigSchema>;
