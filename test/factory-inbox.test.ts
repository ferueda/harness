import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { defaultFactoryInboxDir, factoryInboxStatus } from "../lib/factory-inbox.ts";

function createWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "harness-factory-inbox-"));
}

test("factoryInboxStatus lists pending items sorted and does not create directories", () => {
  const workspace = createWorkspace();
  const inboxDir = join(workspace, ".harness/inbox/factory");
  mkdirSync(inboxDir, { recursive: true });
  writeFileSync(
    join(inboxDir, "002-item.json"),
    JSON.stringify({ id: "two", source: "file", title: "Second", body: "Two" }),
    "utf8",
  );
  writeFileSync(
    join(inboxDir, "001-item.json"),
    JSON.stringify({ id: "one", source: "file", title: "First", body: "One" }),
    "utf8",
  );

  const status = factoryInboxStatus({ workspace });

  expect(status.workspace).toBe(workspace);
  expect(status.inboxDir).toBe(defaultFactoryInboxDir(workspace));
  expect(status.pendingCount).toBe(2);
  expect(status.pending.map((pending) => pending.file)).toEqual(["001-item.json", "002-item.json"]);
  expect(status.pending[0]).toMatchObject({
    id: "one",
    source: "file",
    title: "First",
  });
  expect(status.processedCount).toBe(0);
  expect(status.failedCount).toBe(0);
  expect(existsSync(join(workspace, ".harness/runs/factory"))).toBe(false);
});

test("factoryInboxStatus reports failed items with error summaries", () => {
  const workspace = createWorkspace();
  const failedDir = join(workspace, ".harness/inbox/factory/failed");
  mkdirSync(failedDir, { recursive: true });
  const failedPath = join(failedDir, "run-001-item.json");
  const errorPath = join(failedDir, "run-001-item.error.json");
  writeFileSync(failedPath, '{ "bad": true }\n', "utf8");
  writeFileSync(errorPath, JSON.stringify({ error: "Invalid factory work item JSON" }), "utf8");

  const status = factoryInboxStatus({ workspace });

  expect(status.failedCount).toBe(1);
  expect(status.failed[0]).toMatchObject({
    file: "run-001-item.json",
    path: failedPath,
    error: "Invalid factory work item JSON",
    errorPath,
  });
});

test("factoryInboxStatus reports invalid pending items without creating runs", () => {
  const workspace = createWorkspace();
  const inboxDir = join(workspace, ".harness/inbox/factory");
  mkdirSync(inboxDir, { recursive: true });
  writeFileSync(join(inboxDir, "001-item.json"), "{ nope", "utf8");

  const status = factoryInboxStatus({ workspace });

  expect(status.pendingCount).toBe(1);
  expect(status.pending[0]?.file).toBe("001-item.json");
  expect(status.pending[0]?.error).toContain("Invalid factory work item JSON");
  expect(existsSync(join(workspace, ".harness/runs/factory"))).toBe(false);
});

test("factoryInboxStatus resolves relative inboxDir against workspace", () => {
  const workspace = createWorkspace();
  const inboxDir = join(workspace, "custom-inbox");
  mkdirSync(inboxDir, { recursive: true });
  writeFileSync(
    join(inboxDir, "001-item.json"),
    JSON.stringify({ id: "local", source: "file", title: "Queued", body: "Body" }),
    "utf8",
  );

  const status = factoryInboxStatus({ workspace, inboxDir: "custom-inbox" });

  expect(status.inboxDir).toBe(inboxDir);
  expect(status.pendingCount).toBe(1);
  expect(status.pending[0]?.id).toBe("local");
});
