import { errorMessage } from "../agent/invocation.ts";
import type { RepositoryRun, RepositoryService } from "../repository/types.ts";

export type DurableStepRunner = (id: string, handler: () => Promise<unknown>) => Promise<unknown>;

export const REPOSITORY_CLEANUP_DIAGNOSTIC_ERROR_CODE =
  "repository_cleanup_diagnostic_failed" as const;

export class RepositoryCleanupDiagnosticError extends Error {
  override readonly name = "RepositoryCleanupDiagnosticError";
  readonly code = REPOSITORY_CLEANUP_DIAGNOSTIC_ERROR_CODE;

  constructor(message: string, cause: unknown) {
    super(message, { cause });
  }
}

export function isRepositoryCleanupDiagnosticError(error: unknown): boolean {
  return (
    error instanceof RepositoryCleanupDiagnosticError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === REPOSITORY_CLEANUP_DIAGNOSTIC_ERROR_CODE)
  );
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
      throw new RepositoryCleanupDiagnosticError(
        `Repository cleanup and its operator diagnostic both failed: ${errorMessage(diagnosticError)}`,
        diagnosticError,
      );
    }
    return "failed";
  }
}
