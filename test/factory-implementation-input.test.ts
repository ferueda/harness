import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  appendFactoryLifecycleEvent,
  deriveFactoryWorkItemKey,
  resolveFactoryStateRoot,
} from "../lib/factory-lifecycle.ts";
import {
  FactoryImplementationInputError,
  resolveFactoryImplementationInput,
} from "../lib/factory-implementation-input.ts";
import { FactoryPlanningError } from "../lib/factory-planning-schemas.ts";
import type { FactoryWorkItem } from "../lib/factory-schemas.ts";
import {
  resolveFactoryWorkItemInput,
  type FactoryResolvedWorkItemInput,
} from "../lib/factory-triage-input.ts";
import {
  fakeLinearAdapter,
  LINEAR_SETTINGS,
  LINEAR_WORK_ITEM,
} from "./factory-linear-test-helpers.ts";

const READY_STATUS = LINEAR_SETTINGS.statuses.readyToImplement;

test("planned Linear input resolves with approved plan metadata and file", () => {
  const { workspace } = createWorkspacePlan();
  const resolvedInput = linearInput({
    factoryStage: "plan-approved",
    approvedPlanPath: "dev/plans/FER-32.md",
    approvedPlanCommit: "abc1234",
  });

  const input = resolveFactoryImplementationInput({
    workspace,
    resolvedInput,
    linearReadyStatus: READY_STATUS,
  });

  expect(input).toMatchObject({
    mode: "planned",
    source: "linear",
    approvedPlanPath: "dev/plans/FER-32.md",
    planPath: join(workspace, "dev/plans/FER-32.md"),
    approvedPlanCommit: "abc1234",
  });
});

test("planned input fails when approved plan file is missing", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-implementation-input-"));
  const resolvedInput = linearInput({
    factoryStage: "plan-approved",
    approvedPlanPath: "dev/plans/FER-32.md",
    approvedPlanCommit: "abc1234",
  });

  expect(() =>
    resolveFactoryImplementationInput({
      workspace,
      resolvedInput,
      linearReadyStatus: READY_STATUS,
    }),
  ).toThrow(/Approved plan does not exist: dev\/plans\/FER-32\.md/);
});

test("item-file planned input fails closed before plan PR is merged", () => {
  const { workspace } = createWorkspacePlan();

  expect(() =>
    resolveFactoryImplementationInput({
      workspace,
      resolvedInput: itemFileInput({
        factoryStage: "plan-pr-open",
        approvedPlanPath: "dev/plans/FER-32.md",
        approvedPlanPrUrl: "https://github.com/owner/repo/pull/32",
      }),
    }),
  ).toThrow(/Planned work is not ready to implement: factoryStage=plan-pr-open/);
});

test("direct Linear input resolves only with explicit direct markers", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-implementation-input-"));
  const resolvedInput = linearInput({
    factoryStage: "ready-to-implement",
    factoryRoute: "ready-to-implement",
    factoryNextAction: "implement-directly",
  });

  const input = resolveFactoryImplementationInput({
    workspace,
    resolvedInput,
    linearReadyStatus: READY_STATUS,
  });

  expect(input).toMatchObject({
    mode: "direct",
    sourceMaterial: {
      title: "Linear issue",
      body: "Fetched from Linear.",
      labels: ["factory"],
      url: "https://linear.app/acme/issue/ENG-123/linear-issue",
      tracker: { source: "linear", id: "ENG-123" },
    },
  });
});

test("direct input rejects Linear Ready to Implement without route markers", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-implementation-input-"));

  expect(() =>
    resolveFactoryImplementationInput({
      workspace,
      resolvedInput: linearInput({ factoryStage: "ready-to-implement" }),
      linearReadyStatus: READY_STATUS,
    }),
  ).toThrow(
    /Factory work item is not ready for implementation: factoryStage=ready-to-implement, factoryRoute=none, factoryNextAction=none, linearStatus=Ready to Implement/,
  );
});

test("Linear projection guard rejects stale status before planned success", () => {
  const { workspace } = createWorkspacePlan();

  expect(() =>
    resolveFactoryImplementationInput({
      workspace,
      resolvedInput: linearInput({
        linearStatus: "Planning",
        factoryStage: "plan-approved",
        approvedPlanPath: "dev/plans/FER-32.md",
        approvedPlanCommit: "abc1234",
      }),
      linearReadyStatus: READY_STATUS,
    }),
  ).toThrow(/Linear issue is in Planning; implementation accepts Ready to Implement/);
});

test("Linear input requires configured ready status", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-implementation-input-"));
  const resolvedInput = linearInput({
    factoryStage: "ready-to-implement",
    factoryRoute: "ready-to-implement",
    factoryNextAction: "implement-directly",
  });

  expect(() =>
    resolveFactoryImplementationInput({
      workspace,
      resolvedInput,
    }),
  ).toThrow(/linearReadyStatus is required/);
  expect(() =>
    resolveFactoryImplementationInput({
      workspace,
      resolvedInput,
      linearReadyStatus: "   ",
    }),
  ).toThrow(/linearReadyStatus is required/);
});

test("Plan Needs Review fails projection guard before planned handoff validation", () => {
  const { workspace } = createWorkspacePlan();

  expect(() =>
    resolveFactoryImplementationInput({
      workspace,
      resolvedInput: linearInput({
        linearStatus: LINEAR_SETTINGS.statuses.needsPlanReview,
        factoryStage: "plan-pr-open",
        approvedPlanPath: "dev/plans/FER-32.md",
        approvedPlanPrUrl: "https://github.com/owner/repo/pull/32",
      }),
      linearReadyStatus: READY_STATUS,
    }),
  ).toThrow(/Linear issue is in Plan Needs Review; implementation accepts Ready to Implement/);
});

test("planned publication signal takes precedence over direct markers", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-implementation-input-"));

  expect(() =>
    resolveFactoryImplementationInput({
      workspace,
      resolvedInput: itemFileInput({
        factoryStage: "ready-to-implement",
        factoryRoute: "ready-to-implement",
        factoryNextAction: "implement-directly",
        approvedPlanCommit: "abc1234",
      }),
    }),
  ).toThrow(/Planned work is not ready to implement: factoryStage=ready-to-implement/);
});

test("item-file input skips Linear projection guard and enforces readiness", () => {
  const { workspace } = createWorkspacePlan();

  expect(
    resolveFactoryImplementationInput({
      workspace,
      resolvedInput: itemFileInput({
        factoryStage: "ready-to-implement",
        factoryRoute: "ready-to-implement",
        factoryNextAction: "implement-directly",
      }),
    }),
  ).toMatchObject({ mode: "direct" });

  expect(() =>
    resolveFactoryImplementationInput({
      workspace,
      resolvedInput: itemFileInput({ factoryStage: "ready-to-implement" }),
    }),
  ).toThrow(/Factory work item is not ready for implementation/);
});

test("invalid metadata shape fails with implementation input parse error", () => {
  const workspace = mkdtempSync(join(tmpdir(), "harness-implementation-input-"));
  let thrown: unknown;

  try {
    resolveFactoryImplementationInput({
      workspace,
      resolvedInput: invalidMetadataInput(),
    });
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(FactoryImplementationInputError);
  expect(thrown).toMatchObject({
    message: "Invalid factory work item metadata for implementation input.",
  });
});

test("lifecycle overlay resolves approved planned implementation input", async () => {
  const { workspace } = createWorkspacePlan();
  const factoryStateRoot = resolveFactoryStateRoot({ workspace });
  const workItemKey = deriveFactoryWorkItemKey(LINEAR_WORK_ITEM);
  appendFactoryLifecycleEvent({
    factoryStateRoot,
    event: {
      version: 1,
      id: `work_item.imported:${workItemKey}`,
      type: "work_item.imported",
      workItemKey,
      occurredAt: "2026-07-08T00:00:00.000Z",
      source: "harness",
      data: {
        source: LINEAR_WORK_ITEM.source,
        title: LINEAR_WORK_ITEM.title,
        tracker: { source: "linear", id: "ENG-123" },
      },
    },
  });
  appendFactoryLifecycleEvent({
    factoryStateRoot,
    event: {
      version: 1,
      id: "plan_pr.merged:run-1",
      type: "plan_pr.merged",
      workItemKey,
      occurredAt: "2026-07-08T00:01:00.000Z",
      runId: "run-1",
      source: "harness",
      data: {
        approvedPlanPath: "dev/plans/FER-32.md",
        approvedPlanPrUrl: "https://github.com/owner/repo/pull/32",
        approvedPlanCommit: "abc1234",
      },
    },
  });

  const resolvedInput = await resolveFactoryWorkItemInput({
    workspace,
    linearIssue: "ENG-123",
    linearSettings: LINEAR_SETTINGS,
    env: { LINEAR_API_KEY: "test-key" },
    linearAdapterFactory: () =>
      fakeLinearAdapter({
        fetchWorkItem: async () =>
          linearInput({
            linearStatus: READY_STATUS,
            factoryStage: "incoming",
          }).workItem,
      }),
  });

  expect(
    resolveFactoryImplementationInput({
      workspace,
      resolvedInput,
      linearReadyStatus: READY_STATUS,
    }),
  ).toMatchObject({
    mode: "planned",
    metadata: {
      factoryStage: "plan-approved",
      approvedPlanPath: "dev/plans/FER-32.md",
      approvedPlanCommit: "abc1234",
    },
  });
});

test("planned handoff errors propagate unchanged", () => {
  const { workspace } = createWorkspacePlan();

  expect(() =>
    resolveFactoryImplementationInput({
      workspace,
      resolvedInput: itemFileInput({
        factoryStage: "plan-approved",
        approvedPlanPath: "dev/plans/FER-32.md",
      }),
    }),
  ).toThrow(FactoryPlanningError);
});

function createWorkspacePlan(): { workspace: string } {
  const workspace = mkdtempSync(join(tmpdir(), "harness-implementation-input-"));
  mkdirSync(join(workspace, "dev/plans"), { recursive: true });
  writeFileSync(join(workspace, "dev/plans/FER-32.md"), "# Plan\n", "utf8");
  return { workspace };
}

function linearInput(
  metadata: NonNullable<FactoryWorkItem["metadata"]>,
): FactoryResolvedWorkItemInput {
  return {
    source: "linear",
    workItem: {
      ...LINEAR_WORK_ITEM,
      metadata: {
        ...LINEAR_WORK_ITEM.metadata,
        linearStatus: READY_STATUS,
        ...metadata,
      },
    },
    linearApplied: false,
  };
}

function itemFileInput(
  metadata: NonNullable<FactoryWorkItem["metadata"]>,
): FactoryResolvedWorkItemInput {
  return {
    source: "item-file",
    workItem: {
      id: "local-1",
      source: "file",
      title: "Local work",
      body: "Local body.",
      labels: ["factory"],
      metadata,
    },
  };
}

function invalidMetadataInput(): FactoryResolvedWorkItemInput {
  return {
    source: "item-file",
    workItem: {
      id: "local-1",
      source: "file",
      title: "Invalid metadata",
      body: "",
      labels: [],
      metadata: { tracker: { source: "not-a-tracker", id: "FER-32" } },
    } as FactoryWorkItem,
  };
}
