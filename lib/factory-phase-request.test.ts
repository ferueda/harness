import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createFactoryArtifactRef } from "./factory-artifact-ref.ts";
import { appendFactoryActionEvent, readFactoryActionEvents } from "./factory-lifecycle-kernel.ts";
import {
  appendPreparedFactoryPhaseRequest,
  prepareFactoryPhaseRequestForTest,
} from "./factory-phase-request.ts";
import { writeFactoryPhaseRunIdentity } from "./factory-phase-run.ts";
import { ensureFactoryStoreFormat } from "./factory-store-format.ts";
import type { FactoryStoreMeta } from "./factory-store.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("rejects an initial request when Factory advances after the deterministic import", () => {
  const { projectRoot, store } = phaseRequestFixture();
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

test("fresh phases still reject changed work-item evidence", () => {
  const { root, store } = phaseRequestFixture();
  const workItem = {
    id: "manual:EVIDENCE-1",
    source: "manual" as const,
    title: "Original",
    body: "Original body",
    labels: [],
  };
  const prepared = prepareFactoryPhaseRequestForTest(
    {
      projectId: store.projectId,
      workItem,
      phase: "triage",
      intent: "start",
      expectedPredecessor: null,
      factoryStore: store,
    },
    {},
  );
  const phaseRunId = "triage-evidence-change";
  const runDir = join(store.factoryRunsDir, phaseRunId);
  mkdirSync(join(runDir, "context"), { recursive: true });
  writeFileSync(
    join(runDir, "context/work-item.json"),
    `${JSON.stringify({ ...workItem, body: "Changed body" })}\n`,
  );
  writeFactoryPhaseRunIdentity(runDir, {
    version: 1,
    phaseRunId,
    phase: "triage",
    workItemKey: workItem.id,
    workspace: root,
    projectId: store.projectId,
    factoryStateRoot: store.factoryStateRoot,
    actions: { triageWorkItem: { provider: "cursor", model: "triager" } },
  });

  expect(() => appendPreparedFactoryPhaseRequest({ prepared, phaseRunId })).toThrow(
    /work-item evidence changed/,
  );
});

function phaseRequestFixture(): {
  root: string;
  projectRoot: string;
  store: FactoryStoreMeta;
} {
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
  return { root, projectRoot, store };
}
