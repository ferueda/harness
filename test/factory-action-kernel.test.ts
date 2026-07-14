import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import {
  FactoryArtifactRefSchema,
  isFactoryRelativePathContained,
  createFactoryArtifactRef,
  verifyFactoryArtifactRef,
} from "../lib/factory-artifact-ref.ts";
import { readFactoryActionResult, writeFactoryActionResult } from "../lib/factory-action-result.ts";
import { factoryActionKey, FactoryPhaseRunIdSchema } from "../lib/factory-action-contract.ts";
import {
  FactoryLifecycleConflictError,
  appendFactoryActionEvent,
  readFactoryActionEvents,
} from "../lib/factory-lifecycle-kernel.ts";
import {
  FactoryLifecycleEventSchema,
  type FactoryLifecycleEvent,
} from "../lib/factory-lifecycle-events.ts";
import {
  FactoryPhaseRunIdentitySchema,
  writeFactoryPhaseRunIdentity,
} from "../lib/factory-phase-run.ts";
import { ensureFactoryStoreFormat, FactoryStoreFormatError } from "../lib/factory-store-format.ts";
import {
  decideNextFactoryAction,
  FactoryLifecycleStateSchema,
  reduceFactoryLifecycleEvents,
} from "../lib/factory-state-machine.ts";

const root = () => mkdtempSync(join(tmpdir(), "factory-action-"));
const inputRef = {
  base: "factory-store" as const,
  path: "inputs/item.json",
  sha256: "0".repeat(64),
};

function completedTriageEvents(
  route: "ready-to-plan" | "ready-to-implement",
): FactoryLifecycleEvent[] {
  return [
    imported(),
    {
      version: 1,
      id: "triage-request",
      type: "triage.requested",
      workItemKey: "item-1",
      occurredAt: "2026-07-11T01:00:00.000Z",
      phaseRunId: "triage-run",
      data: { expectedPredecessor: "import:item-1", inputRefs: [inputRef], intent: "start" },
    },
    {
      version: 1,
      id: "triage-complete",
      type: "triage.work_item.completed",
      workItemKey: "item-1",
      occurredAt: "2026-07-11T02:00:00.000Z",
      phaseRunId: "triage-run",
      data: {
        handler: "triageWorkItem",
        handlerVersion: 1,
        attempt: 1,
        causationEventId: "triage-request",
        execution: { workspaceRef: "repo", runRef: inputRef },
        evidence: [inputRef],
        route,
        rationale: "routed",
      },
    },
  ];
}
const imported = (
  occurredAt = "2026-07-11T00:00:00.000Z",
): Extract<FactoryLifecycleEvent, { type: "work_item.imported" }> => ({
  version: 1,
  id: "import:item-1",
  type: "work_item.imported",
  workItemKey: "item-1",
  occurredAt,
  data: { source: "file" },
});

describe("Factory action lifecycle kernel", () => {
  test("requires request inputs and action evidence", () => {
    expect(() =>
      FactoryLifecycleEventSchema.parse({
        version: 1,
        id: "request",
        type: "triage.requested",
        workItemKey: "item-1",
        occurredAt: "2026-07-11T01:00:00.000Z",
        phaseRunId: "triage-run",
        data: { expectedPredecessor: "import:item-1", inputRefs: [], intent: "start" },
      }),
    ).toThrow(/Too small/);
    const completed = completedTriageEvents("ready-to-plan").at(-1)!;
    expect(() =>
      FactoryLifecycleEventSchema.parse({
        ...completed,
        data: { ...completed.data, evidence: [] },
      }),
    ).toThrow(/Too small/);
  });
  test("requires a new phase-run ID for planning and implementation requests", () => {
    expect(() =>
      reduceFactoryLifecycleEvents([
        ...completedTriageEvents("ready-to-plan"),
        {
          version: 1,
          id: "planning-request",
          type: "planning.requested",
          workItemKey: "item-1",
          occurredAt: "2026-07-11T03:00:00.000Z",
          phaseRunId: "triage-run",
          data: {
            expectedPredecessor: "triage-complete",
            inputRefs: [inputRef],
            intent: "start",
            reviewCeiling: 1,
            publicationMode: "local",
            outputPlan: "dev/plans/item-1.md",
          },
        },
      ]),
    ).toThrow(/Invalid Factory transition/);
    expect(() =>
      reduceFactoryLifecycleEvents([
        ...completedTriageEvents("ready-to-implement"),
        {
          version: 1,
          id: "implementation-request",
          type: "implementation.requested",
          workItemKey: "item-1",
          occurredAt: "2026-07-11T03:00:00.000Z",
          phaseRunId: "triage-run",
          data: {
            expectedPredecessor: "triage-complete",
            inputRefs: [inputRef],
            reviewCeiling: 1,
            intent: "start",
          },
        },
      ]),
    ).toThrow(/Invalid Factory transition/);
  });
  test("state schema rejects phase-incompatible statuses and routes", () => {
    const common = {
      projectionVersion: 1,
      workItemKey: "item-1",
      lastEventId: "event-1",
      updatedAt: "2026-07-11T00:00:00.000Z",
      phaseRunId: "run-1",
    };

    expect(() =>
      FactoryLifecycleStateSchema.parse({
        ...common,
        phase: "planning",
        status: "complete",
        reviewCeiling: 2,
        attempt: 1,
      }),
    ).toThrow();
    expect(() =>
      FactoryLifecycleStateSchema.parse({
        ...common,
        phase: "implementation",
        status: "awaiting-plan-merge",
        reviewCeiling: 2,
        attempt: 1,
      }),
    ).toThrow();
    expect(() =>
      FactoryLifecycleStateSchema.parse({
        ...common,
        phase: "triage",
        status: "routed",
        route: "needs-info",
      }),
    ).toThrow();
  });

  test("rejects failures from a handler that does not own the current state", () => {
    const request: FactoryLifecycleEvent = {
      version: 1,
      id: "planning-request",
      type: "planning.requested",
      workItemKey: "item-1",
      occurredAt: "2026-07-11T02:00:00.000Z",
      phaseRunId: "planning-run",
      data: {
        expectedPredecessor: "triage-complete",
        inputRefs: [inputRef],
        intent: "start",
        reviewCeiling: 2,
        publicationMode: "local",
        outputPlan: "dev/plans/item-1.md",
      },
    };
    const events: FactoryLifecycleEvent[] = [
      imported(),
      {
        version: 1,
        id: "triage-request",
        type: "triage.requested",
        workItemKey: "item-1",
        occurredAt: "2026-07-11T01:00:00.000Z",
        phaseRunId: "triage-run",
        data: { expectedPredecessor: "import:item-1", inputRefs: [inputRef], intent: "start" },
      },
      {
        version: 1,
        id: "triage-complete",
        type: "triage.work_item.completed",
        workItemKey: "item-1",
        occurredAt: "2026-07-11T01:30:00.000Z",
        phaseRunId: "triage-run",
        data: {
          handler: "triageWorkItem",
          handlerVersion: 1,
          attempt: 1,
          causationEventId: "triage-request",
          execution: {
            workspaceRef: "repo",
            runRef: { base: "factory-store", path: "runs/triage", sha256: "a".repeat(64) },
          },
          evidence: [inputRef],
          route: "ready-to-plan",
          rationale: "Plan first",
        },
      },
      request,
    ];
    const failure: FactoryLifecycleEvent = {
      version: 1,
      id: "bad-review-failure",
      type: "factory.action.failed",
      workItemKey: "item-1",
      occurredAt: "2026-07-11T03:00:00.000Z",
      phaseRunId: "planning-run",
      data: {
        handler: "reviewPlanCandidate",
        handlerVersion: 1,
        attempt: 1,
        causationEventId: request.id,
        execution: {
          workspaceRef: "repo",
          runRef: { base: "factory-store", path: "runs/planning", sha256: "b".repeat(64) },
        },
        evidence: [inputRef],
        phase: "planning",
        failureKind: "retryable",
        message: "review failed before candidate",
      },
    };

    expect(() => reduceFactoryLifecycleEvents([...events, failure])).toThrow(
      /Invalid Factory transition/,
    );
    expect(
      reduceFactoryLifecycleEvents([
        ...events,
        {
          ...failure,
          id: "producer-failure",
          data: { ...failure.data, handler: "producePlanCandidate" },
        },
      ]),
    ).toMatchObject({ phase: "planning", status: "awaiting-candidate", attempt: 1 });
  });

  test("rejects stale cursors and divergent duplicate ids", () => {
    const store = root();
    appendFactoryActionEvent({
      factoryStateRoot: store,
      event: imported(),
      expectedLastEventId: null,
    });
    expect(() =>
      appendFactoryActionEvent({
        factoryStateRoot: store,
        event: {
          ...imported(),
          occurredAt: "2026-07-11T01:00:00.000Z",
          data: { source: "linear" },
        },
        expectedLastEventId: null,
      }),
    ).toThrow(FactoryLifecycleConflictError);
    const request: FactoryLifecycleEvent = {
      version: 1,
      id: "triage:request:item-1",
      type: "triage.requested",
      workItemKey: "item-1",
      occurredAt: "2026-07-11T02:00:00.000Z",
      phaseRunId: "triage-run",
      data: { expectedPredecessor: "import:item-1", inputRefs: [inputRef], intent: "start" },
    };
    expect(() =>
      appendFactoryActionEvent({
        factoryStateRoot: store,
        event: request,
        expectedLastEventId: null,
      }),
    ).toThrow(/Stale Factory cursor/);
  });

  test("returns canonical duplicate while ignoring occurredAt", () => {
    const store = root();
    const first = appendFactoryActionEvent({
      factoryStateRoot: store,
      event: imported(),
      expectedLastEventId: null,
    });
    const duplicate = appendFactoryActionEvent({
      factoryStateRoot: store,
      event: imported("2026-07-12T00:00:00.000Z"),
      expectedLastEventId: null,
    });
    expect(duplicate.event).toEqual(first.event);
    expect(readFactoryActionEvents(store, "item-1")).toHaveLength(1);
  });

  test("recovers a terminal action result without repeating work", () => {
    const store = root();
    appendFactoryActionEvent({
      factoryStateRoot: store,
      event: imported(),
      expectedLastEventId: null,
    });
    const request: FactoryLifecycleEvent = {
      version: 1,
      id: "triage:request:item-1",
      type: "triage.requested",
      workItemKey: "item-1",
      occurredAt: "2026-07-11T01:00:00.000Z",
      phaseRunId: "triage-run",
      data: { expectedPredecessor: "import:item-1", inputRefs: [inputRef], intent: "start" },
    };
    const requested = appendFactoryActionEvent({
      factoryStateRoot: store,
      event: request,
      expectedLastEventId: "import:item-1",
    });
    expect(decideNextFactoryAction(requested.state, requested.event)).toMatchObject({
      kind: "invoke",
      handler: "triageWorkItem",
    });
    const terminal: Extract<FactoryLifecycleEvent, { type: "triage.work_item.completed" }> = {
      version: 1,
      id: "placeholder",
      type: "triage.work_item.completed",
      workItemKey: "item-1",
      occurredAt: "2026-07-11T02:00:00.000Z",
      phaseRunId: "triage-run",
      data: {
        handler: "triageWorkItem",
        handlerVersion: 1,
        attempt: 1,
        causationEventId: request.id,
        execution: {
          workspaceRef: "repo",
          runRef: { base: "factory-store", path: "runs/triage", sha256: "a".repeat(64) },
        },
        evidence: [inputRef],
        route: "ready-to-plan",
        nextCommand: "harness factory planning run --item-file item.json",
        rationale: "Needs planning",
      },
    };
    const actionKey = factoryActionKey({
      phaseRunId: terminal.phaseRunId,
      handler: terminal.data.handler,
      attempt: terminal.data.attempt,
      causationEventId: terminal.data.causationEventId,
    });
    terminal.id = `${terminal.type}:${actionKey}`;
    const actionDir = join(store, "actions", actionKey);
    expect(() =>
      reduceFactoryLifecycleEvents([
        imported(),
        request,
        { ...terminal, data: { ...terminal.data, attempt: 2 } },
      ]),
    ).toThrow(/Invalid Factory transition/);
    expect(() =>
      appendFactoryActionEvent({
        factoryStateRoot: store,
        event: { ...terminal, id: "triage.work_item.completed:wrong" },
        expectedLastEventId: request.id,
      }),
    ).toThrow(/action event identity mismatch/);
    expect(readFactoryActionEvents(store, "item-1")).toHaveLength(2);
    writeFactoryActionResult(actionDir, terminal);
    expect(writeFactoryActionResult(actionDir, terminal)).toBe(
      join(actionDir, "action-result.json"),
    );
    expect(
      writeFactoryActionResult(actionDir, {
        ...terminal,
        occurredAt: "2026-07-12T02:00:00.000Z",
      }),
    ).toBe(join(actionDir, "action-result.json"));
    expect(readFactoryActionResult(actionDir).occurredAt).toBe(terminal.occurredAt);
    expect(() =>
      writeFactoryActionResult(actionDir, {
        ...terminal,
        data: { ...terminal.data, rationale: "Divergent" },
      }),
    ).toThrow(/Divergent Factory action result/);
    expect(() =>
      writeFactoryActionResult(join(store, "actions", "0".repeat(64)), terminal),
    ).toThrow(/path mismatch/);
    expect(() =>
      writeFactoryActionResult(join(store, "actions", actionKey), {
        ...terminal,
        id: `triage.work_item.completed:${"0".repeat(64)}`,
      }),
    ).toThrow(/identity mismatch/);
    expect(() =>
      writeFactoryActionResult(join(store, "actions", actionKey), {
        ...terminal,
        data: { ...terminal.data, attempt: 2 },
      }),
    ).toThrow(/identity mismatch/);
    const recovered = appendFactoryActionEvent({
      factoryStateRoot: store,
      event: readFactoryActionResult(actionDir),
      expectedLastEventId: request.id,
    });
    expect(recovered.state).toMatchObject({ phase: "triage", status: "routed" });
    expect(decideNextFactoryAction(recovered.state, recovered.event)).toEqual({
      kind: "wait",
      reason: "phase-command",
      command: terminal.data.nextCommand,
    });
  });

  test("rejects a terminal event without its request transition", () => {
    const store = root();
    appendFactoryActionEvent({
      factoryStateRoot: store,
      event: imported(),
      expectedLastEventId: null,
    });
    const terminal: Extract<FactoryLifecycleEvent, { type: "triage.work_item.completed" }> = {
      version: 1,
      id: "bad-terminal",
      type: "triage.work_item.completed",
      workItemKey: "item-1",
      occurredAt: "2026-07-11T02:00:00.000Z",
      phaseRunId: "triage-run",
      data: {
        handler: "triageWorkItem",
        handlerVersion: 1,
        attempt: 1,
        causationEventId: "import:item-1",
        execution: {
          workspaceRef: "repo",
          runRef: { base: "factory-store", path: "runs/triage", sha256: "a".repeat(64) },
        },
        evidence: [inputRef],
        route: "ready-to-plan",
        nextCommand: "next",
        rationale: "bad",
      },
    };
    terminal.id = `${terminal.type}:${factoryActionKey({
      phaseRunId: terminal.phaseRunId,
      handler: terminal.data.handler,
      attempt: terminal.data.attempt,
      causationEventId: terminal.data.causationEventId,
    })}`;
    expect(() =>
      appendFactoryActionEvent({
        factoryStateRoot: store,
        event: terminal,
        expectedLastEventId: "import:item-1",
      }),
    ).toThrow(/Invalid Factory transition/);
  });

  test("emits an explicit plan-publication reaction after planning approval", () => {
    const events: FactoryLifecycleEvent[] = [
      imported(),
      {
        version: 1,
        id: "triage-request",
        type: "triage.requested",
        workItemKey: "item-1",
        occurredAt: "2026-07-11T01:00:00.000Z",
        phaseRunId: "triage-run",
        data: { expectedPredecessor: "import:item-1", inputRefs: [inputRef], intent: "start" },
      },
      {
        version: 1,
        id: "triage-complete",
        type: "triage.work_item.completed",
        workItemKey: "item-1",
        occurredAt: "2026-07-11T02:00:00.000Z",
        phaseRunId: "triage-run",
        data: {
          handler: "triageWorkItem",
          handlerVersion: 1,
          attempt: 1,
          causationEventId: "triage-request",
          execution: {
            workspaceRef: "repo",
            runRef: { base: "factory-store", path: "runs/triage", sha256: "a".repeat(64) },
          },
          evidence: [inputRef],
          route: "ready-to-plan",
          rationale: "Plan first",
        },
      },
      {
        version: 1,
        id: "planning-request",
        type: "planning.requested",
        workItemKey: "item-1",
        occurredAt: "2026-07-11T03:00:00.000Z",
        phaseRunId: "planning-run",
        data: {
          expectedPredecessor: "triage-complete",
          inputRefs: [inputRef],
          intent: "start",
          reviewCeiling: 2,
          publicationMode: "pull-request",
          outputPlan: "dev/plans/item-1.md",
        },
      },
      {
        version: 1,
        id: "candidate",
        type: "planning.candidate.produced",
        workItemKey: "item-1",
        occurredAt: "2026-07-11T04:00:00.000Z",
        phaseRunId: "planning-run",
        data: {
          handler: "producePlanCandidate",
          handlerVersion: 1,
          attempt: 1,
          causationEventId: "planning-request",
          execution: {
            workspaceRef: "repo",
            runRef: { base: "factory-store", path: "runs/planning", sha256: "b".repeat(64) },
          },
          evidence: [inputRef],
          candidate: { base: "factory-store", path: "plans/candidate", sha256: "c".repeat(64) },
          effectiveSession: { provider: "codex", id: "session" },
        },
      },
      {
        version: 1,
        id: "review",
        type: "planning.review.completed",
        workItemKey: "item-1",
        occurredAt: "2026-07-11T05:00:00.000Z",
        phaseRunId: "planning-run",
        data: {
          handler: "reviewPlanCandidate",
          handlerVersion: 1,
          attempt: 1,
          causationEventId: "candidate",
          execution: {
            workspaceRef: "repo",
            runRef: { base: "factory-store", path: "runs/planning", sha256: "b".repeat(64) },
          },
          evidence: [inputRef],
          verdict: "pass",
          review: { base: "factory-store", path: "reviews/result", sha256: "d".repeat(64) },
          reviewCeiling: 2,
        },
      },
    ];
    const state = reduceFactoryLifecycleEvents(events);
    expect(state).toBeDefined();
    expect(decideNextFactoryAction(state!, events.at(-1)!)).toEqual({
      kind: "wait",
      reason: "plan-publication",
    });
  });
});

describe("Factory store and artifact boundaries", () => {
  test("rejects an old non-empty store explicitly", () => {
    const store = root();
    writeFileSync(join(store, "old.jsonl"), "{}\n");
    expect(() => ensureFactoryStoreFormat(store)).toThrow(FactoryStoreFormatError);
    expect(() => ensureFactoryStoreFormat(store)).toThrow(/Archive or reset/);
  });
  test("recovers an orphaned Harness format-marker temp", () => {
    const store = root();
    writeFileSync(
      join(store, "store-format.json.123e4567-e89b-42d3-a456-426614174000.tmp"),
      "partial",
    );

    expect(readFactoryActionEvents(store, "item-1")).toEqual([]);
    ensureFactoryStoreFormat(store);

    expect(readdirSync(store).sort()).toEqual([
      "store-format.json",
      "store-format.json.123e4567-e89b-42d3-a456-426614174000.tmp",
    ]);
    expect(() => ensureFactoryStoreFormat(store)).not.toThrow();
  });
  test("concurrent processes converge while initializing one shared store", async () => {
    const moduleUrl = pathToFileURL(join(process.cwd(), "lib/factory-store-format.ts")).href;
    const source = `import { ensureFactoryStoreFormat } from ${JSON.stringify(moduleUrl)}; ensureFactoryStoreFormat(process.argv[1]);`;
    for (let round = 0; round < 4; round += 1) {
      const store = root();
      const children = Array.from({ length: 8 }, () =>
        spawn(
          process.execPath,
          ["--experimental-strip-types", "--input-type=module", "-e", source, store],
          {
            stdio: ["ignore", "ignore", "pipe"],
          },
        ),
      );

      const results = await Promise.all(
        children.map(
          (child) =>
            new Promise<{ code: number | null; stderr: string }>((resolveResult) => {
              let stderr = "";
              child.stderr.on("data", (chunk: Buffer) => {
                stderr += chunk.toString();
              });
              child.on("close", (code) => resolveResult({ code, stderr }));
            }),
        ),
      );

      expect(results).toEqual(Array.from({ length: 8 }, () => ({ code: 0, stderr: "" })));
      expect(JSON.parse(readFileSync(join(store, "store-format.json"), "utf8"))).toEqual({
        format: "harness-factory",
        version: 1,
      });
    }
  });
  test("read-only event access does not initialize an empty store", () => {
    const store = root();
    expect(readFactoryActionEvents(store, "item-1")).toEqual([]);
    expect(existsSync(join(store, "store-format.json"))).toBe(false);
  });
  test("inspection event access does not acquire a lock for existing history", () => {
    const store = root();
    appendFactoryActionEvent({
      factoryStateRoot: store,
      expectedLastEventId: null,
      event: imported(),
    });
    const locks = join(store, "locks");
    const before = readdirSync(locks);

    expect(readFactoryActionEvents(store, "item-1", { mode: "inspection" })).toHaveLength(1);
    expect(readdirSync(locks)).toEqual(before);
  });
  test("rejects absolute, traversal, and changed artifact content", () => {
    expect(() =>
      FactoryArtifactRefSchema.parse({
        base: "repository",
        path: "/tmp/x",
        sha256: "a".repeat(64),
      }),
    ).toThrow();
    for (const path of ["C:\\temp\\x", "\\\\server\\share", "..\\x", "a\\..\\x"]) {
      expect(() =>
        FactoryArtifactRefSchema.parse({ base: "repository", path, sha256: "a".repeat(64) }),
      ).toThrow();
    }
    expect(() =>
      FactoryArtifactRefSchema.parse({ base: "repository", path: "../x", sha256: "a".repeat(64) }),
    ).toThrow();
    const repo = root();
    mkdirSync(join(repo, "evidence"));
    writeFileSync(join(repo, "evidence/result.json"), "one");
    const ref = createFactoryArtifactRef({
      base: "repository",
      root: repo,
      path: "evidence\\result.json",
    });
    expect(ref.path).toBe("evidence/result.json");
    writeFileSync(join(repo, "evidence/result.json"), "two");
    expect(() =>
      verifyFactoryArtifactRef(ref, { repository: repo, "factory-store": root() }),
    ).toThrow(/hash mismatch/);
  });

  test("rejects unsafe phase-run identifiers at every durable boundary", () => {
    for (const phaseRunId of ["../run", "run/child", "run\\child", ".", "run name"]) {
      expect(() => FactoryPhaseRunIdSchema.parse(phaseRunId)).toThrow(/phase-run identifier/);
      expect(() =>
        FactoryPhaseRunIdentitySchema.parse({
          version: 1,
          phaseRunId,
          phase: "triage",
          workItemKey: "item-1",
          workspace: "/repo",
          projectId: "project",
          factoryStateRoot: "/store",
        }),
      ).toThrow(/phase-run identifier/);
    }
  });

  test("recognizes portable containment with either native separator", () => {
    expect(isFactoryRelativePathContained("context/result.json")).toBe(true);
    expect(isFactoryRelativePathContained("context\\result.json")).toBe(true);
    expect(isFactoryRelativePathContained("..\\outside.json")).toBe(false);
    expect(isFactoryRelativePathContained("C:\\outside.json")).toBe(false);
  });

  test("reuses the immutable triage action profile for an active phase", () => {
    const runDir = mkdtempSync(join(tmpdir(), "factory-profile-"));
    mkdirSync(join(runDir, "context"));
    const frozen = {
      provider: "codex" as const,
      model: "frozen-model",
      executable: "/opt/frozen-codex",
      sandbox: "read-only" as const,
      approvalPolicy: "never" as const,
      reasoningEffort: "high" as const,
    };
    writeFactoryPhaseRunIdentity(runDir, {
      version: 1,
      phaseRunId: "triage-run",
      phase: "triage",
      workItemKey: "item-1",
      workspace: "/repo",
      projectId: "project",
      factoryStateRoot: "/store",
      actions: { triageWorkItem: frozen },
    });

    const parsed = FactoryPhaseRunIdentitySchema.parse(
      JSON.parse(readFileSync(join(runDir, "context/phase-run.json"), "utf8")),
    );
    expect(parsed.phase === "triage" ? parsed.actions.triageWorkItem : undefined).toEqual(frozen);
  });

  test("rejects malformed persisted action profiles", () => {
    const runDir = mkdtempSync(join(tmpdir(), "factory-profile-"));
    mkdirSync(join(runDir, "context"));
    writeFileSync(
      join(runDir, "context/phase-run.json"),
      JSON.stringify({
        version: 1,
        phaseRunId: "triage-run",
        phase: "triage",
        workItemKey: "item-1",
        workspace: "/repo",
        projectId: "project",
        factoryStateRoot: "/store",
        actions: { triageWorkItem: { provider: "cursor", model: "", approvalPolicy: "never" } },
      }),
    );
    expect(() =>
      FactoryPhaseRunIdentitySchema.parse(
        JSON.parse(readFileSync(join(runDir, "context/phase-run.json"), "utf8")),
      ),
    ).toThrow();
  });
});
