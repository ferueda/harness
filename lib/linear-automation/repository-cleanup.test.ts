import { describe, expect, it, vi } from "vitest";
import type { RepositoryRun, RepositoryService } from "../repository/types.ts";
import { cleanupRepositoryRun, RepositoryCleanupDiagnosticError } from "./repository-cleanup.ts";

const run: RepositoryRun = {
  version: 1,
  id: "run-1",
  workspace: "/tmp/harness-spec-run",
  remote: "https://github.com/example/project.git",
  baseRef: "main",
  baseSha: "a".repeat(40),
  branch: "harness/spec/FER-320",
};

describe("cleanupRepositoryRun", () => {
  it("reports a cleanup failure after the durable cleanup step is exhausted", async () => {
    const steps: string[] = [];
    const reportFailure = vi.fn<(error: string) => Promise<void>>(async () => undefined);

    const result = await cleanupRepositoryRun({
      runStep: async (id, handler) => {
        steps.push(id);
        return handler();
      },
      cleanupStepId: "cleanup",
      diagnosticStepId: "diagnostic",
      repository: {
        cleanupRun: vi.fn<RepositoryService["cleanupRun"]>(async () => {
          throw new Error("cleanup unavailable");
        }),
      },
      run,
      reportFailure,
    });

    expect(result).toBe("failed");
    expect(steps).toEqual(["cleanup", "diagnostic"]);
    expect(reportFailure).toHaveBeenCalledWith("cleanup unavailable");
  });

  it("does not write a diagnostic after successful cleanup", async () => {
    const reportFailure = vi.fn<(error: string) => Promise<void>>(async () => undefined);

    const result = await cleanupRepositoryRun({
      runStep: (_id, handler) => handler(),
      cleanupStepId: "cleanup",
      diagnosticStepId: "diagnostic",
      repository: {
        cleanupRun: vi.fn<RepositoryService["cleanupRun"]>(async () => ({
          status: "released",
        })),
      },
      run,
      reportFailure,
    });

    expect(result).toBe("cleaned");
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it("propagates an exhausted diagnostic failure", async () => {
    const steps: string[] = [];

    await expect(
      cleanupRepositoryRun({
        runStep: async (id, handler) => {
          steps.push(id);
          return handler();
        },
        cleanupStepId: "cleanup",
        diagnosticStepId: "diagnostic",
        repository: {
          cleanupRun: vi.fn<RepositoryService["cleanupRun"]>(async () => {
            throw new Error("cleanup unavailable");
          }),
        },
        run,
        reportFailure: async () => {
          throw new Error("Linear unavailable");
        },
      }),
    ).rejects.toThrow(RepositoryCleanupDiagnosticError);

    expect(steps).toEqual(["cleanup", "diagnostic"]);
  });
});
