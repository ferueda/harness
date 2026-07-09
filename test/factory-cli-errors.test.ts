import { expect, test } from "vitest";
import { formatHarnessError } from "../lib/factory-cli-errors.ts";
import { FactoryLifecycleLockTimeoutError } from "../lib/factory-locks.ts";

test("formats lifecycle lock timeouts as diagnostic JSON for CLI stderr", () => {
  const error = new FactoryLifecycleLockTimeoutError({
    operation: "read",
    workItemKey: "linear:FER-53",
    filename: "linear-FER-53-hash",
    lockPath: "/tmp/factory/locks/linear-FER-53-hash.lock",
    ageMs: 42,
    stale: false,
    classification: "owner-invalid",
  });

  expect(JSON.parse(formatHarnessError(error))).toMatchObject({
    code: "factory-lifecycle-lock-timeout",
    diagnostic: {
      operation: "read",
      workItemKey: "linear:FER-53",
      lockPath: "/tmp/factory/locks/linear-FER-53-hash.lock",
      ageMs: 42,
      stale: false,
      classification: "owner-invalid",
    },
  });
});
