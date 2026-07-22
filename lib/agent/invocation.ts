export const STREAM_SETTLE_TIMEOUT_MS = 1_000;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorArtifact(error: unknown): unknown {
  if (!(error instanceof Error)) return { error };
  const sdkError = error as Error & {
    code?: unknown;
    status?: unknown;
    requestId?: unknown;
    isRetryable?: unknown;
    helpUrl?: unknown;
    operation?: unknown;
    endpoint?: unknown;
  };
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    code: sdkError.code,
    status: sdkError.status,
    requestId: sdkError.requestId,
    isRetryable: sdkError.isRetryable,
    helpUrl: sdkError.helpUrl,
    operation: sdkError.operation,
    endpoint: sdkError.endpoint,
  };
}

export async function raceWithTimeout<T>(
  task: Promise<T>,
  fallback: () => T,
  timeoutMs = STREAM_SETTLE_TIMEOUT_MS,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<T>((resolve) => {
        timeout = setTimeout(() => resolve(fallback()), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
