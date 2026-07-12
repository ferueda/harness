import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  factoryImplementationExecutionLeaseFilename,
  isFactoryImplementationExecutionLeaseFilename,
  withFactoryImplementationExecutionLease,
} from "../lib/factory-implementation-policy.ts";
import { acquireFactoryWorkItemLock, releaseFactoryWorkItemLock } from "../lib/factory-locks.ts";
import { deriveFactoryWorkItemKey } from "../lib/factory-lifecycle-legacy.ts";

const workItem = {
  id: "linear:ENG-12",
  source: "linear" as const,
  title: "Lease test",
  body: "",
  labels: [],
  metadata: { tracker: { source: "linear", id: "ENG-12", url: "https://linear.app/ENG-12" } },
};

test("implementation execution leases retain async work and fail fast on contention", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-implementation-lease-"));
  let release!: () => void;
  const held = withFactoryImplementationExecutionLease({
    factoryStateRoot: root,
    workspace: root,
    workItem,
    action: () => new Promise<void>((resolve) => (release = resolve)),
  });
  await expect(
    withFactoryImplementationExecutionLease({
      factoryStateRoot: root,
      workspace: root,
      workItem,
      action: async () => undefined,
    }),
  ).rejects.toThrow(/Timed out waiting/);
  release();
  await held;
});

test("implementation execution leases are independent per work item", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-implementation-lease-"));
  let release!: () => void;
  const held = withFactoryImplementationExecutionLease({
    factoryStateRoot: root,
    workspace: root,
    workItem,
    action: () => new Promise<void>((resolve) => (release = resolve)),
  });

  await expect(
    withFactoryImplementationExecutionLease({
      factoryStateRoot: root,
      workspace: root,
      workItem: {
        ...workItem,
        id: "linear:ENG-13",
        metadata: { tracker: { source: "linear", id: "ENG-13" } },
      },
      action: async () => "independent",
    }),
  ).resolves.toBe("independent");
  release();
  await held;
});

test("implementation execution lease releases after callback failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-implementation-lease-"));
  await expect(
    withFactoryImplementationExecutionLease({
      factoryStateRoot: root,
      workspace: root,
      workItem,
      action: async () => {
        throw new Error("implementation failed");
      },
    }),
  ).rejects.toThrow("implementation failed");

  await expect(
    withFactoryImplementationExecutionLease({
      factoryStateRoot: root,
      workspace: root,
      workItem,
      action: async () => "next run",
    }),
  ).resolves.toBe("next run");
});

test("execution lease filename has a stable inspectable suffix", () => {
  const filename = factoryImplementationExecutionLeaseFilename("linear:ENG-12");
  expect(isFactoryImplementationExecutionLeaseFilename(filename)).toBe(true);
  expect(isFactoryImplementationExecutionLeaseFilename(`${filename}.other`)).toBe(false);
});

test("execution lease recovers a dead same-host owner regardless of age", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-implementation-lease-"));
  const workItemKey = deriveFactoryWorkItemKey(workItem);
  const filename = factoryImplementationExecutionLeaseFilename(workItemKey);
  const oldOwner = acquireFactoryWorkItemLock({
    factoryStateRoot: root,
    workItemKey,
    workItemFilename: filename,
    workspace: root,
    operation: "write",
    options: { hostname: "same-test-host", pid: 2_147_483_647 },
  });

  await expect(
    withFactoryImplementationExecutionLease({
      factoryStateRoot: root,
      workspace: root,
      workItem,
      options: { hostname: "same-test-host" },
      action: async () => "recovered",
    }),
  ).resolves.toBe("recovered");
  releaseFactoryWorkItemLock({
    factoryStateRoot: root,
    workItemFilename: filename,
    owner: oldOwner,
  });
});

test("execution lease never expires a remote owner by age", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-implementation-lease-"));
  const workItemKey = deriveFactoryWorkItemKey(workItem);
  const filename = factoryImplementationExecutionLeaseFilename(workItemKey);
  const remoteOwner = acquireFactoryWorkItemLock({
    factoryStateRoot: root,
    workItemKey,
    workItemFilename: filename,
    workspace: root,
    operation: "write",
    options: { hostname: "remote-test-host" },
  });

  await expect(
    withFactoryImplementationExecutionLease({
      factoryStateRoot: root,
      workspace: root,
      workItem,
      options: {
        hostname: "local-test-host",
        now: () => Date.parse(remoteOwner.startedAt) + 365 * 24 * 60 * 60 * 1_000,
      },
      action: async () => undefined,
    }),
  ).rejects.toMatchObject({ diagnostic: { classification: "remote-owner", stale: false } });
  releaseFactoryWorkItemLock({
    factoryStateRoot: root,
    workItemFilename: filename,
    owner: remoteOwner,
  });
});
