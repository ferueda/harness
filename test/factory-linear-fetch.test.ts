import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { fetchFactoryLinearWorkItem } from "../bin/factory-commands.ts";
import {
  appendFactoryLifecycleEvent,
  deriveFactoryWorkItemKey,
  factoryLifecycleStatePath,
  workItemKeyToFilename,
} from "../lib/factory-lifecycle.ts";
import {
  fakeLinearAdapter,
  LINEAR_SETTINGS,
  LINEAR_WORK_ITEM,
} from "./factory-linear-test-helpers.ts";

test("factory linear fetch inspects missing, corrupt, and held durable lifecycle state without writes", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-linear-fetch-workspace-"));
  const factoryStateRoot = mkdtempSync(join(tmpdir(), "harness-linear-fetch-store-"));
  const workItemKey = deriveFactoryWorkItemKey(LINEAR_WORK_ITEM);
  const statePath = factoryLifecycleStatePath(factoryStateRoot, workItemKey);
  appendFactoryLifecycleEvent({
    factoryStateRoot,
    event: {
      version: 1,
      id: `work_item.imported:${workItemKey}`,
      type: "work_item.imported",
      workItemKey,
      occurredAt: "2026-07-09T00:00:00.000Z",
      source: "harness",
      data: { source: "linear", title: LINEAR_WORK_ITEM.title },
    },
  });
  rmSync(statePath);
  rmSync(join(factoryStateRoot, "locks"), { recursive: true, force: true });

  const fetch = () =>
    fetchFactoryLinearWorkItem({
      issue: "ENG-123",
      workspace,
      factoryStateRoot,
      env: { LINEAR_API_KEY: "test-key" },
      resolveLinearSettings: () => LINEAR_SETTINGS,
      adapterFactory: () => fakeLinearAdapter(),
    });

  const missing = await fetch();
  expect(missing).toMatchObject({
    id: LINEAR_WORK_ITEM.id,
    warnings: [
      {
        code: "durable-state-missing",
        factoryStateRoot,
        workItemKey,
      },
    ],
  });
  expect(existsSync(statePath)).toBe(false);
  expect(existsSync(join(factoryStateRoot, "locks"))).toBe(false);

  writeFileSync(statePath, "{not-json}\n", "utf8");
  const ownerPath = join(
    factoryStateRoot,
    "locks",
    `${workItemKeyToFilename(workItemKey)}.lock`,
    "owner.json",
  );
  mkdirSync(dirname(ownerPath), { recursive: true });
  writeFileSync(
    ownerPath,
    `${JSON.stringify({
      pid: 1,
      hostname: "other-host",
      token: "held-lock",
      workspace,
      workItemKey,
      startedAt: new Date().toISOString(),
    })}\n`,
    "utf8",
  );

  const corruptAndLocked = await fetch();
  expect(corruptAndLocked.warnings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: "durable-state-stale", factoryStateRoot, workItemKey }),
      expect.objectContaining({ code: "lifecycle-lock-held", factoryStateRoot, workItemKey }),
    ]),
  );
  expect(existsSync(statePath)).toBe(true);
  expect(existsSync(ownerPath)).toBe(true);
});
