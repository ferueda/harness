import { errorMessage } from "../agent/invocation.ts";
import type { RepositoryRun, RepositoryService } from "../repository/types.ts";

export type DurableStepRunner = (id: string, handler: () => Promise<unknown>) => Promise<unknown>;

export class SpecCleanupDiagnosticError extends Error {
  override readonly name = "SpecCleanupDiagnosticError";

  constructor(message: string, cause: unknown) {
    super(message, { cause });
  }
}

export async function cleanupRepositoryRun(input: {
  runStep: DurableStepRunner;
  cleanupStepId: string;
  diagnosticStepId: string;
  repository: Pick<RepositoryService, "cleanupRun">;
  run: RepositoryRun;
  reportFailure: (error: string) => Promise<unknown>;
}): Promise<"cleaned" | "failed"> {
  try {
    await input.runStep(input.cleanupStepId, () => input.repository.cleanupRun(input.run));
    return "cleaned";
  } catch (error) {
    try {
      await input.runStep(input.diagnosticStepId, () => input.reportFailure(errorMessage(error)));
    } catch (diagnosticError) {
      throw new SpecCleanupDiagnosticError(
        `Repository cleanup and its operator diagnostic both failed: ${errorMessage(diagnosticError)}`,
        diagnosticError,
      );
    }
    return "failed";
  }
}
