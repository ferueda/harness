import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fetchFactoryLinearWorkItem } from "../bin/factory-commands.ts";
import {
  fakeLinearAdapter,
  LINEAR_SETTINGS,
  LINEAR_WORK_ITEM,
} from "./factory-linear-test-helpers.ts";

test("factory linear fetch does not read or initialize lifecycle state", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-linear-fetch-workspace-"));
  const factoryStoreRoot = join(workspace, "factory-store");

  const fetched = await fetchFactoryLinearWorkItem({
    issue: "ENG-123",
    workspace,
    factoryStoreRoot,
    factoryStoreProjectId: "test-project",
    env: { LINEAR_API_KEY: "test-key" },
    resolveLinearSettings: () => LINEAR_SETTINGS,
    adapterFactory: () => fakeLinearAdapter(),
  });

  expect(fetched).toMatchObject({ id: LINEAR_WORK_ITEM.id });
  expect(fetched).not.toHaveProperty("warnings");
  expect(existsSync(factoryStoreRoot)).toBe(false);
});
