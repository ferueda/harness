import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createFactoryArtifactRef } from "./factory-artifact-ref.ts";
import { appendFactoryActionEvent, readFactoryActionEvents } from "./factory-lifecycle-kernel.ts";
import { prepareFactoryPhaseRequestForTest } from "./factory-phase-request.ts";
import { ensureFactoryStoreFormat } from "./factory-store-format.ts";
import type { FactoryStoreMeta } from "./factory-store.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("rejects an initial request when Factory advances after the deterministic import", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-phase-request-"));
  roots.push(root);
  const projectRoot = join(root, "project");
  const store: FactoryStoreMeta = {
    storeRoot: root,
    projectId: "project",
    projectRoot,
    factoryStateRoot: join(projectRoot, "factory"),
    factoryRunsDir: join(projectRoot, "runs/factory"),
    reviewRunsDir: join(projectRoot, "runs/reviews"),
    repo: { name: "repository", id: "project", idSource: "config" },
    overrides: {},
    warnings: [],
  };
  ensureFactoryStoreFormat(store.factoryStateRoot);
  const workItem = {
    id: "manual:RACE-1",
    source: "manual" as const,
    title: "Import race",
    body: "Observe before import",
    labels: [],
  };
  const workItemPath = join(projectRoot, "inputs/work-item.json");
  mkdirSync(join(projectRoot, "inputs"), { recursive: true });
  writeFileSync(workItemPath, `${JSON.stringify(workItem)}\n`);
  const workItemRef = createFactoryArtifactRef({
    base: "factory-store",
    root: projectRoot,
    path: relative(projectRoot, workItemPath),
  });

  expect(() =>
    prepareFactoryPhaseRequestForTest(
      {
        projectId: store.projectId,
        workItem,
        phase: "triage",
        intent: "start",
        expectedPredecessor: null,
        factoryStore: store,
      },
      {
        afterImported: () => {
          appendFactoryActionEvent({
            factoryStateRoot: store.factoryStateRoot,
            expectedLastEventId: `work_item.imported:${workItem.id}`,
            event: {
              version: 1,
              id: "triage.requested:concurrent-run",
              type: "triage.requested",
              workItemKey: workItem.id,
              occurredAt: "2026-07-16T00:00:00.000Z",
              phaseRunId: "concurrent-run",
              data: {
                expectedPredecessor: `work_item.imported:${workItem.id}`,
                inputRefs: [workItemRef],
                intent: "start",
              },
            },
          });
        },
      },
    ),
  ).toThrow(/lost the durable CAS.*triage\.requested:concurrent-run/);
  expect(readFactoryActionEvents(store.factoryStateRoot, workItem.id)).toHaveLength(2);
});
