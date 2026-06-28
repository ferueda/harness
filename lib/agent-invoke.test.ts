import { afterEach, expect, test, vi } from "vitest";
import {
  errorArtifact,
  errorMessage,
  raceWithTimeout,
  STREAM_SETTLE_TIMEOUT_MS,
} from "./agent-invoke.ts";

test("errorMessage returns message for Error and string for unknown", () => {
  expect(errorMessage(new Error("boom"))).toBe("boom");
  expect(errorMessage("plain")).toBe("plain");
});

test("errorArtifact captures plain Error fields", () => {
  const error = new Error("boom");
  expect(errorArtifact(error)).toEqual({
    name: "Error",
    message: "boom",
    stack: error.stack,
    code: undefined,
    status: undefined,
    requestId: undefined,
    isRetryable: undefined,
    helpUrl: undefined,
    operation: undefined,
    endpoint: undefined,
  });
});

test("errorArtifact preserves Cursor SDK extension fields", () => {
  const error = new Error("sdk failed") as Error & {
    code: string;
    status: number;
    requestId: string;
    isRetryable: boolean;
    helpUrl: string;
    operation: string;
    endpoint: string;
  };
  error.code = "rate_limit";
  error.status = 429;
  error.requestId = "req-1";
  error.isRetryable = true;
  error.helpUrl = "https://example.com/help";
  error.operation = "run.wait";
  error.endpoint = "/v1/agents";

  expect(errorArtifact(error)).toMatchObject({
    name: "Error",
    message: "sdk failed",
    code: "rate_limit",
    status: 429,
    requestId: "req-1",
    isRetryable: true,
    helpUrl: "https://example.com/help",
    operation: "run.wait",
    endpoint: "/v1/agents",
  });
});

test("errorArtifact wraps non-Error values", () => {
  expect(errorArtifact("oops")).toEqual({ error: "oops" });
});

test("raceWithTimeout resolves fallback when task exceeds timeout", async () => {
  vi.useFakeTimers();
  try {
    const pending = new Promise<string>(() => {});
    const resultPromise = raceWithTimeout(pending, () => "fallback");
    await vi.advanceTimersByTimeAsync(STREAM_SETTLE_TIMEOUT_MS);
    await expect(resultPromise).resolves.toBe("fallback");
  } finally {
    vi.useRealTimers();
  }
});

afterEach(() => {
  vi.useRealTimers();
});
