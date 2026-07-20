import { describe, expect, it } from "vitest";
import type { LinearIssueContext, LinearIssueReference } from "./linear/read.ts";
import {
  classifyLinearReadiness,
  LinearReadinessConfigSchema,
  linearReadinessSnapshotGeneration,
  type LinearReadinessConfig,
} from "./linear-readiness.ts";

const config: LinearReadinessConfig = {
  teamId: "team-1",
  projectId: "project-1",
  stateIds: {
    backlog: "state-backlog",
    open: "state-open",
    inProgress: "state-in-progress",
    inReview: "state-in-review",
    done: "state-done",
    canceled: "state-canceled",
    duplicate: "state-duplicate",
  },
  nextActionLabelIds: {
    plan: "label-plan",
    implement: "label-implement",
    needsInput: "label-needs-input",
  },
  enabledRoutes: {
    triage: true,
    plan: true,
    implement: true,
  },
};

type ContextOptions = Readonly<{
  stateId?: string;
  teamId?: string;
  projectId?: string | null;
  actionLabelIds?: readonly string[];
  unrelatedLabelIds?: readonly string[];
  blockerStateIds?: readonly string[];
  labelsTruncated?: boolean;
  relationsTruncated?: boolean;
}>;

function context(options: ContextOptions = {}): LinearIssueContext {
  const stateId = options.stateId ?? config.stateIds.backlog;
  const labels = [...(options.actionLabelIds ?? []), ...(options.unrelatedLabelIds ?? [])];
  return {
    id: "issue-1",
    identifier: "FER-225",
    title: "Route Linear readiness",
    description: "Description",
    url: "https://linear.app/example/FER-225",
    state: workflowState(stateId),
    team: {
      id: options.teamId ?? config.teamId,
      key: "FER",
      name: "ferueda",
    },
    project:
      options.projectId === null
        ? null
        : {
            id: options.projectId ?? config.projectId,
            name: "Harness",
            url: "https://linear.app/example/project",
          },
    assignee: null,
    creator: null,
    labels: labels.map((id) => ({ id, name: `Label ${id}` })),
    comments: [],
    parent: null,
    children: [],
    duplicateOf: null,
    blockedBy: (options.blockerStateIds ?? []).map(blocker),
    related: [],
    attachments: [],
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T01:00:00.000Z",
    completeness: {
      commentsTruncated: false,
      labelsTruncated: options.labelsTruncated ?? false,
      relationsTruncated: options.relationsTruncated ?? false,
      attachmentsTruncated: false,
      childrenTruncated: false,
    },
  };
}

function workflowState(id: string) {
  return { id, name: `State ${id}`, type: "started" };
}

function blocker(stateId: string, index: number): LinearIssueReference {
  return {
    id: `blocker-${index}`,
    identifier: `FER-${100 + index}`,
    title: `Blocker ${index}`,
    url: `https://linear.app/example/FER-${100 + index}`,
    state: workflowState(stateId),
  };
}

describe("Linear readiness policy", () => {
  it.each([
    [
      "out-of-scope team",
      context({ teamId: "other-team" }),
      { kind: "ignore", reason: "out-of-scope" },
    ],
    [
      "out-of-scope project",
      context({ projectId: "other-project" }),
      { kind: "ignore", reason: "out-of-scope" },
    ],
    [
      "truncated labels",
      context({ labelsTruncated: true }),
      { kind: "invalid", reason: "incomplete-context" },
    ],
    [
      "truncated relations",
      context({ relationsTruncated: true }),
      { kind: "invalid", reason: "incomplete-context" },
    ],
    ["Backlog without action", context(), { kind: "dispatch", reason: "ready", route: "triage" }],
    [
      "Backlog with action",
      context({ actionLabelIds: [config.nextActionLabelIds.plan] }),
      { kind: "wait", reason: "projection-repair" },
    ],
    [
      "Open Plan",
      context({
        stateId: config.stateIds.open,
        actionLabelIds: [config.nextActionLabelIds.plan],
      }),
      { kind: "dispatch", reason: "ready", route: "plan" },
    ],
    [
      "Open Implement",
      context({
        stateId: config.stateIds.open,
        actionLabelIds: [config.nextActionLabelIds.implement],
      }),
      { kind: "dispatch", reason: "ready", route: "implement" },
    ],
    [
      "Open Needs Input",
      context({
        stateId: config.stateIds.open,
        actionLabelIds: [config.nextActionLabelIds.needsInput],
      }),
      { kind: "wait", reason: "needs-input" },
    ],
    [
      "Open actionable with unresolved blocker",
      context({
        stateId: config.stateIds.open,
        actionLabelIds: [config.nextActionLabelIds.plan],
        blockerStateIds: [config.stateIds.open],
      }),
      { kind: "wait", reason: "blocked" },
    ],
    [
      "Open actionable with resolved blocker",
      context({
        stateId: config.stateIds.open,
        actionLabelIds: [config.nextActionLabelIds.plan],
        blockerStateIds: [config.stateIds.done],
      }),
      { kind: "dispatch", reason: "ready", route: "plan" },
    ],
    [
      "Open without action",
      context({ stateId: config.stateIds.open }),
      { kind: "invalid", reason: "missing-next-action" },
    ],
    [
      "Open with conflicting actions",
      context({
        stateId: config.stateIds.open,
        actionLabelIds: [config.nextActionLabelIds.plan, config.nextActionLabelIds.implement],
      }),
      { kind: "invalid", reason: "conflicting-next-action" },
    ],
    [
      "In Progress",
      context({ stateId: config.stateIds.inProgress }),
      { kind: "ignore", reason: "already-claimed" },
    ],
    [
      "In Review",
      context({ stateId: config.stateIds.inReview }),
      { kind: "ignore", reason: "human-review" },
    ],
    ["Done", context({ stateId: config.stateIds.done }), { kind: "ignore", reason: "terminal" }],
    [
      "Canceled",
      context({ stateId: config.stateIds.canceled }),
      { kind: "ignore", reason: "terminal" },
    ],
    [
      "Duplicate",
      context({ stateId: config.stateIds.duplicate }),
      { kind: "ignore", reason: "terminal" },
    ],
    [
      "unknown lifecycle",
      context({ stateId: "state-unknown" }),
      { kind: "invalid", reason: "unknown-state" },
    ],
  ])("classifies %s", (_label, issue, expected) => {
    expect(classifyLinearReadiness({ context: issue, config })).toMatchObject(expected);
  });

  it.each(["triage", "plan", "implement"] as const)(
    "waits when the %s route is disabled",
    (route) => {
      const issue =
        route === "triage"
          ? context()
          : context({
              stateId: config.stateIds.open,
              actionLabelIds: [config.nextActionLabelIds[route]],
            });
      const disabled = {
        ...config,
        enabledRoutes: { ...config.enabledRoutes, [route]: false },
      };

      expect(classifyLinearReadiness({ context: issue, config: disabled })).toMatchObject({
        kind: "wait",
        reason: "route-disabled",
        route,
      });
    },
  );

  it("ignores unrelated labels", () => {
    expect(
      classifyLinearReadiness({
        context: context({ unrelatedLabelIds: ["label-bug", "label-improvement"] }),
        config,
      }),
    ).toMatchObject({ kind: "dispatch", route: "triage" });
  });

  it("keeps generation stable across unrelated data and collection order", () => {
    const original = context({
      stateId: config.stateIds.open,
      actionLabelIds: [config.nextActionLabelIds.plan],
      unrelatedLabelIds: ["label-z", "label-a"],
      blockerStateIds: [config.stateIds.open, config.stateIds.done],
    });
    const reordered = {
      ...original,
      title: "Renamed",
      updatedAt: "2030-01-01T00:00:00.000Z",
      labels: original.labels.toReversed(),
      blockedBy: original.blockedBy.toReversed(),
      comments: [
        {
          id: "comment-1",
          body: "Unrelated comment",
          author: null,
          parentId: null,
          quotedText: null,
          createdAt: "2026-07-19T02:00:00.000Z",
          updatedAt: "2026-07-19T02:00:00.000Z",
        },
      ],
    };

    expect(linearReadinessSnapshotGeneration(reordered, config)).toBe(
      linearReadinessSnapshotGeneration(original, config),
    );
  });

  it.each([
    ["team", context({ teamId: "team-2" })],
    ["project", context({ projectId: "project-2" })],
    ["state", context({ stateId: config.stateIds.open })],
    ["action", context({ actionLabelIds: [config.nextActionLabelIds.plan] })],
    ["blocker", context({ blockerStateIds: [config.stateIds.open] })],
    ["completeness", context({ relationsTruncated: true })],
  ])("changes generation for relevant %s truth", (_label, changed) => {
    expect(linearReadinessSnapshotGeneration(changed, config)).not.toBe(
      linearReadinessSnapshotGeneration(context(), config),
    );
  });

  it("rejects conflicting trusted IDs", () => {
    expect(
      LinearReadinessConfigSchema.safeParse({
        ...config,
        stateIds: { ...config.stateIds, open: config.stateIds.backlog },
      }).success,
    ).toBe(false);
    expect(
      LinearReadinessConfigSchema.safeParse({
        ...config,
        nextActionLabelIds: {
          ...config.nextActionLabelIds,
          plan: config.nextActionLabelIds.implement,
        },
      }).success,
    ).toBe(false);
  });
});
