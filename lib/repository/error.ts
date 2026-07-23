import { GroveError } from "@ferueda/grove";

export const REPOSITORY_ERROR_CODES = [
  "invalid_input",
  "controller_failed",
  "run_conflict",
  "pool_exhausted",
  "setup_failed",
  "inspect_failed",
  "cleanup_failed",
] as const;

export type RepositoryErrorCode = (typeof REPOSITORY_ERROR_CODES)[number];

export class RepositoryError extends Error {
  readonly code: RepositoryErrorCode;

  constructor(message: string, code: RepositoryErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = "RepositoryError";
    this.code = code;
  }
}

export function normalizeRepositoryError(
  operation: "prepare" | "inspect" | "cleanup",
  error: unknown,
): RepositoryError {
  if (error instanceof RepositoryError) return error;

  if (error instanceof GroveError) {
    if (error.code === "GROVE_EXHAUSTED" || error.code === "POOL_EXHAUSTED") {
      return new RepositoryError(error.message, "pool_exhausted", { cause: error });
    }
    if (
      error.code === "LEASE_CONFLICT" ||
      error.code === "LEASE_ALREADY_EXISTS" ||
      error.code === "LEASE_QUARANTINED" ||
      error.code === "LEASE_BUSY" ||
      error.code === "ACQUIRE_IN_PROGRESS" ||
      error.code === "BRANCH_EXISTS"
    ) {
      return new RepositoryError(error.message, "run_conflict", { cause: error });
    }
  }

  const message = error instanceof Error ? error.message : String(error);
  const code =
    operation === "prepare"
      ? "controller_failed"
      : operation === "inspect"
        ? "inspect_failed"
        : "cleanup_failed";
  return new RepositoryError(`Repository ${operation} failed: ${message}`, code, {
    cause: error,
  });
}
