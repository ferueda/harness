import { FactoryLifecycleLockTimeoutError } from "./factory-locks.ts";

/** Formats lock contention with the operator diagnostics needed for safe recovery. */
export function formatHarnessError(error: unknown): string {
  if (error instanceof FactoryLifecycleLockTimeoutError) {
    return JSON.stringify({
      error: error.message,
      code: "factory-lifecycle-lock-timeout",
      diagnostic: error.diagnostic,
    });
  }
  return error instanceof Error ? error.message : String(error);
}
