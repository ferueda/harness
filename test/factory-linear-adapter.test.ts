import { expect, test } from "vitest";
import type { FactoryLinearSettings } from "../lib/config.ts";
import {
  assertLinearTriageApplyAllowed,
  createLinearFactoryAdapterForClient,
  linearTriageTargetStatus,
  parseLinearFactoryStatusKeys,
  parseLinearIssueIdentifier,
  renderLinearPlanningApprovedComment,
  renderLinearPlanningReadyComment,
  renderLinearTriageCompleteComment,
} from "../lib/factory-linear-adapter.ts";
import {
  assertLinearPlanningApplyAllowed,
  linearPlanningAttentionStageFromComments,
  linearPlanningApplyCommentMarker,
  linearPlanningApplyFailedCommentMarker,
  linearPlanningTargetStatus,
  renderLinearPlanningApplyCompleteComment,
  renderLinearPlanningApplyFailedComment,
} from "../lib/factory-linear-planning-apply.ts";
import {
  assertLinearPlanningMergedApplyAllowed,
  assertLinearPlanningPublishedApplyAllowed,
  linearPlanningApprovedCommentMarker,
  linearPlanningReadyCommentMarker,
} from "../lib/factory-linear-planning-handoff.ts";
import type { LinearClientLike } from "../lib/factory-linear-types.ts";
import type { FactoryRoute, FactoryTriageOutput } from "../lib/factory-schemas.ts";

const LINEAR_SETTINGS = {
  teamKey: "ENG",
  statuses: {
    intake: "Backlog",
    parked: "Parked",
    needsInfo: "Needs Clarification",
    needsPlanReview: "Plan Needs Review",
    needsPlan: "Needs Plan",
    readyToImplement: "Ready to Implement",
    triaging: "Triaging",
    planning: "Planning",
    triageFailed: "Triage Failed",
    planningFailed: "Planning Failed",
  },
} satisfies FactoryLinearSettings;

const TEAM = {
  id: "team-1",
  key: "ENG",
  name: "Engineering",
  states: async () => ({
    nodes: Object.values(LINEAR_SETTINGS.statuses).map((name) => ({
      id: `state-${name}`,
      name,
      type: "unstarted",
    })),
  }),
};

const PROJECT = {
  id: "project-1",
  name: "Harness",
  url: "https://linear.app/acme/project/harness-123",
};

const OTHER_PROJECT = {
  id: "project-2",
  name: "Other Repo",
  url: "https://linear.app/acme/project/other-456",
};

const SCOPED_LINEAR_SETTINGS = {
  ...LINEAR_SETTINGS,
  projectId: PROJECT.id,
} satisfies FactoryLinearSettings;

const ISSUE = {
  id: "issue-1",
  identifier: "ENG-123",
  number: 123,
  title: "Add export shortcut",
  description: "Users need a keyboard shortcut for export.",
  url: "https://linear.app/acme/issue/ENG-123/add-export-shortcut",
  projectId: PROJECT.id,
  priority: 2,
  priorityLabel: "High",
  createdAt: new Date("2026-07-07T10:00:00Z"),
  updatedAt: new Date("2026-07-07T11:00:00Z"),
  state: Promise.resolve({ id: "state-planning", name: "Needs Plan", type: "unstarted" }),
  team: Promise.resolve(TEAM),
  project: Promise.resolve(PROJECT),
  assignee: Promise.resolve({ displayName: "Felipe" }),
  labels: async () => ({ nodes: [{ name: "factory" }, { name: "product" }] }),
  comments: async () => ({
    pageInfo: { hasPreviousPage: false },
    nodes: [
      {
        id: "comment-1",
        body: "Please keep the shortcut configurable.",
        createdAt: new Date("2026-07-07T12:00:00Z"),
      },
    ],
  }),
};

function issueWithState(
  name: string,
  extra: {
    comments?: Array<{ id: string; body: string; createdAt?: Date }>;
    projectId?: string;
    project?: Promise<typeof PROJECT | typeof OTHER_PROJECT | undefined>;
  } = {},
) {
  return {
    ...ISSUE,
    projectId: extra.projectId ?? ISSUE.projectId,
    project: extra.project ?? ISSUE.project,
    state: Promise.resolve({ id: `state-${name}`, name, type: "started" }),
    comments: async () => ({
      pageInfo: { hasPreviousPage: false },
      nodes: extra.comments ?? [],
    }),
  };
}

function fakeClient(overrides: Partial<LinearClientLike> = {}): LinearClientLike {
  return {
    issue: async () => ISSUE,
    issues: async () => ({ nodes: [ISSUE] }),
    teams: async () => ({ nodes: [TEAM] }),
    updateIssue: async () => ({ success: true }),
    createComment: async () => ({ success: true }),
    ...overrides,
  };
}

function fakeReadOnlyLinearClient(overrides: Partial<LinearClientLike> = {}): LinearClientLike {
  return fakeClient({
    updateIssue: async () => {
      throw new Error("updateIssue should not run while listing");
    },
    createComment: async () => {
      throw new Error("createComment should not run while listing");
    },
    ...overrides,
  });
}

const TRIAGE_READY_TO_PLAN = {
  route: "ready-to-plan",
  confidence: "high",
  rationale: "Needs a reviewed plan.",
  evidence: [{ kind: "tracker", summary: "Issue asks for a larger workflow." }],
  suggestedNext: { action: "create-plan" },
} satisfies FactoryTriageOutput;

const NEXT_ACTION_BY_ROUTE = {
  "ready-to-implement": "implement-directly",
  "ready-to-plan": "create-plan",
  "needs-info": "ask-human",
  "wait-to-implement": "park",
} satisfies Record<FactoryRoute, FactoryTriageOutput["suggestedNext"]["action"]>;

function triageOutput(
  route: FactoryRoute,
  extra: Partial<Pick<FactoryTriageOutput, "questions" | "reconsiderWhen">> = {},
): FactoryTriageOutput {
  return {
    route,
    confidence: "high",
    rationale: "Route-specific triage.",
    evidence: [{ kind: "tracker", summary: "Issue metadata supports this route." }],
    suggestedNext: { action: NEXT_ACTION_BY_ROUTE[route] },
    ...extra,
  };
}

test("parseLinearIssueIdentifier accepts human issue ids", () => {
  expect(parseLinearIssueIdentifier("eng-123")).toEqual({ teamKey: "ENG", number: 123 });
  expect(parseLinearIssueIdentifier("not-a-linear-id")).toBeNull();
});

test("parseLinearFactoryStatusKeys preserves order, dedupes, and rejects unknown keys", () => {
  expect(parseLinearFactoryStatusKeys(LINEAR_SETTINGS, ["intake", "needsPlan", "intake"])).toEqual([
    "intake",
    "needsPlan",
  ]);
  expect(() => parseLinearFactoryStatusKeys(LINEAR_SETTINGS, ["Backlog"])).toThrow(
    /Unknown factory\.linear\.statuses key: Backlog\. Allowed keys: intake, parked, needsInfo, needsPlanReview, needsPlan/,
  );
});

test("Linear planning comments include stable markers and plan handoff links", () => {
  expect(
    renderLinearPlanningReadyComment({
      runId: "20260707-120000",
      approvedPlanPath: "dev/plans/FER-123.md",
      approvedPlanPrUrl: "https://github.com/owner/repo/pull/123",
      runDir: ".harness/runs/factory/20260707-120000",
    }),
  ).toContain("<!-- harness-factory:planning:20260707-120000 -->");
  expect(
    renderLinearPlanningApprovedComment({
      runId: "20260707-120000",
      approvedPlanPath: "dev/plans/FER-123.md",
      approvedPlanPrUrl: "https://github.com/owner/repo/pull/123",
      approvedPlanCommit: "abc1234",
      runDir: ".harness/runs/factory/20260707-120000",
    }),
  ).toContain("Commit: `abc1234`");
});

test("Linear planning handoff apply helpers guard statuses", () => {
  expect(() =>
    assertLinearPlanningPublishedApplyAllowed(LINEAR_SETTINGS, "Needs Plan"),
  ).not.toThrow();
  expect(() =>
    assertLinearPlanningPublishedApplyAllowed(LINEAR_SETTINGS, "Planning"),
  ).not.toThrow();
  expect(() =>
    assertLinearPlanningPublishedApplyAllowed(LINEAR_SETTINGS, "Plan Needs Review"),
  ).not.toThrow();
  expect(() => assertLinearPlanningPublishedApplyAllowed(LINEAR_SETTINGS, "Backlog")).toThrow(
    /planning publish --apply only accepts Needs Plan, Planning, Plan Needs Review/,
  );

  expect(() =>
    assertLinearPlanningMergedApplyAllowed(LINEAR_SETTINGS, "Plan Needs Review"),
  ).not.toThrow();
  expect(() =>
    assertLinearPlanningMergedApplyAllowed(LINEAR_SETTINGS, "Ready to Implement"),
  ).not.toThrow();
  expect(() => assertLinearPlanningMergedApplyAllowed(LINEAR_SETTINGS, "Planning")).toThrow(
    /planning mark-plan-merged --apply only accepts Plan Needs Review, Ready to Implement/,
  );
});

test("Linear adapter publishes plan handoff to Plan Needs Review", async () => {
  const updates: unknown[] = [];
  const comments: unknown[] = [];
  const adapter = createLinearFactoryAdapterForClient({
    client: fakeClient({
      issues: async () => ({ nodes: [issueWithState("Planning")] }),
      updateIssue: async (id, input) => {
        updates.push({ id, input });
        return { success: true };
      },
      createComment: async (input) => {
        comments.push(input);
        return { success: true };
      },
    }),
    settings: LINEAR_SETTINGS,
  });

  const result = await adapter.applyPlanningPublished({
    issueRef: "ENG-123",
    runId: "run-1",
    runDir: ".harness/runs/factory/run-1",
    approvedPlanPath: "dev/plans/ENG-123.md",
    approvedPlanPrUrl: "https://github.com/owner/repo/pull/123",
  });

  expect(updates).toEqual([{ id: "issue-1", input: { stateId: "state-Plan Needs Review" } }]);
  expect(comments).toHaveLength(1);
  expect(comments[0]).toMatchObject({
    issueId: "issue-1",
    body: expect.stringContaining(linearPlanningReadyCommentMarker("run-1")),
  });
  expect(result).toMatchObject({
    stage: "publish",
    fromStatus: "Planning",
    targetStatus: "Plan Needs Review",
    commentMarker: linearPlanningReadyCommentMarker("run-1"),
  });
});

test("Linear adapter publishes local-only planning runs from Needs Plan", async () => {
  const updates: unknown[] = [];
  const adapter = createLinearFactoryAdapterForClient({
    client: fakeClient({
      issues: async () => ({ nodes: [issueWithState("Needs Plan")] }),
      updateIssue: async (id, input) => {
        updates.push({ id, input });
        return { success: true };
      },
    }),
    settings: LINEAR_SETTINGS,
  });

  await adapter.applyPlanningPublished({
    issueRef: "ENG-123",
    runId: "run-1",
    runDir: ".harness/runs/factory/run-1",
    approvedPlanPath: "dev/plans/ENG-123.md",
    approvedPlanPrUrl: "https://github.com/owner/repo/pull/123",
  });

  expect(updates).toEqual([{ id: "issue-1", input: { stateId: "state-Plan Needs Review" } }]);
});

test("Linear adapter publish apply is idempotent and dedupes comments", async () => {
  const updates: unknown[] = [];
  const comments: unknown[] = [];
  const adapter = createLinearFactoryAdapterForClient({
    client: fakeClient({
      issues: async () => ({
        nodes: [
          issueWithState("Plan Needs Review", {
            comments: [
              {
                id: "comment-1",
                body: linearPlanningReadyCommentMarker("run-1"),
                createdAt: new Date("2026-07-07T12:00:00Z"),
              },
            ],
          }),
        ],
      }),
      updateIssue: async (id, input) => {
        updates.push({ id, input });
        return { success: true };
      },
      createComment: async (input) => {
        comments.push(input);
        return { success: true };
      },
    }),
    settings: LINEAR_SETTINGS,
  });

  await adapter.applyPlanningPublished({
    issueRef: "ENG-123",
    runId: "run-1",
    runDir: ".harness/runs/factory/run-1",
    approvedPlanPath: "dev/plans/ENG-123.md",
    approvedPlanPrUrl: "https://github.com/owner/repo/pull/123",
  });

  expect(updates).toEqual([]);
  expect(comments).toEqual([]);
});

test("Linear adapter rejects publish apply from unrelated statuses before mutation", async () => {
  const updates: unknown[] = [];
  const comments: unknown[] = [];
  const adapter = createLinearFactoryAdapterForClient({
    client: fakeClient({
      issues: async () => ({ nodes: [issueWithState("Backlog")] }),
      updateIssue: async (id, input) => {
        updates.push({ id, input });
        return { success: true };
      },
      createComment: async (input) => {
        comments.push(input);
        return { success: true };
      },
    }),
    settings: LINEAR_SETTINGS,
  });

  await expect(
    adapter.applyPlanningPublished({
      issueRef: "ENG-123",
      runId: "run-1",
      runDir: ".harness/runs/factory/run-1",
      approvedPlanPath: "dev/plans/ENG-123.md",
      approvedPlanPrUrl: "https://github.com/owner/repo/pull/123",
    }),
  ).rejects.toThrow(/planning publish --apply only accepts/);
  expect(updates).toEqual([]);
  expect(comments).toEqual([]);
});

test("Linear adapter marks merged planning handoff Ready to Implement", async () => {
  const updates: unknown[] = [];
  const comments: unknown[] = [];
  const adapter = createLinearFactoryAdapterForClient({
    client: fakeClient({
      issues: async () => ({ nodes: [issueWithState("Plan Needs Review")] }),
      updateIssue: async (id, input) => {
        updates.push({ id, input });
        return { success: true };
      },
      createComment: async (input) => {
        comments.push(input);
        return { success: true };
      },
    }),
    settings: LINEAR_SETTINGS,
  });

  const result = await adapter.applyPlanningMerged({
    issueRef: "ENG-123",
    runId: "run-1",
    runDir: ".harness/runs/factory/run-1",
    approvedPlanPath: "dev/plans/ENG-123.md",
    approvedPlanPrUrl: "https://github.com/owner/repo/pull/123",
    approvedPlanCommit: "abc1234",
  });

  expect(updates).toEqual([{ id: "issue-1", input: { stateId: "state-Ready to Implement" } }]);
  expect(comments[0]).toMatchObject({
    issueId: "issue-1",
    body: expect.stringContaining(linearPlanningApprovedCommentMarker("run-1")),
  });
  expect(result).toMatchObject({
    stage: "merged",
    fromStatus: "Plan Needs Review",
    targetStatus: "Ready to Implement",
  });
});

test("Linear adapter merged apply is idempotent and dedupes comments", async () => {
  const updates: unknown[] = [];
  const comments: unknown[] = [];
  const adapter = createLinearFactoryAdapterForClient({
    client: fakeClient({
      issues: async () => ({
        nodes: [
          issueWithState("Ready to Implement", {
            comments: [
              {
                id: "comment-1",
                body: linearPlanningApprovedCommentMarker("run-1"),
                createdAt: new Date("2026-07-07T12:00:00Z"),
              },
            ],
          }),
        ],
      }),
      updateIssue: async (id, input) => {
        updates.push({ id, input });
        return { success: true };
      },
      createComment: async (input) => {
        comments.push(input);
        return { success: true };
      },
    }),
    settings: LINEAR_SETTINGS,
  });

  await adapter.applyPlanningMerged({
    issueRef: "ENG-123",
    runId: "run-1",
    runDir: ".harness/runs/factory/run-1",
    approvedPlanPath: "dev/plans/ENG-123.md",
    approvedPlanPrUrl: "https://github.com/owner/repo/pull/123",
    approvedPlanCommit: "abc1234",
  });

  expect(updates).toEqual([]);
  expect(comments).toEqual([]);
});

test("Linear adapter rejects merged apply from unrelated statuses before mutation", async () => {
  const updates: unknown[] = [];
  const comments: unknown[] = [];
  const adapter = createLinearFactoryAdapterForClient({
    client: fakeClient({
      issues: async () => ({ nodes: [issueWithState("Planning")] }),
      updateIssue: async (id, input) => {
        updates.push({ id, input });
        return { success: true };
      },
      createComment: async (input) => {
        comments.push(input);
        return { success: true };
      },
    }),
    settings: LINEAR_SETTINGS,
  });

  await expect(
    adapter.applyPlanningMerged({
      issueRef: "ENG-123",
      runId: "run-1",
      runDir: ".harness/runs/factory/run-1",
      approvedPlanPath: "dev/plans/ENG-123.md",
      approvedPlanPrUrl: "https://github.com/owner/repo/pull/123",
      approvedPlanCommit: "abc1234",
    }),
  ).rejects.toThrow(/planning mark-plan-merged --apply only accepts/);
  expect(updates).toEqual([]);
  expect(comments).toEqual([]);
});

test("Linear adapter rejects handoff apply outside configured project before mutation", async () => {
  const updates: unknown[] = [];
  const comments: unknown[] = [];
  const adapter = createLinearFactoryAdapterForClient({
    client: fakeClient({
      issues: async () => ({
        nodes: [
          issueWithState("Planning", {
            projectId: OTHER_PROJECT.id,
            project: Promise.resolve(OTHER_PROJECT),
          }),
        ],
      }),
      updateIssue: async (id, input) => {
        updates.push({ id, input });
        return { success: true };
      },
      createComment: async (input) => {
        comments.push(input);
        return { success: true };
      },
    }),
    settings: SCOPED_LINEAR_SETTINGS,
  });

  await expect(
    adapter.applyPlanningPublished({
      issueRef: "ENG-123",
      runId: "run-1",
      runDir: ".harness/runs/factory/run-1",
      approvedPlanPath: "dev/plans/ENG-123.md",
      approvedPlanPrUrl: "https://github.com/owner/repo/pull/123",
    }),
  ).rejects.toThrow(/belongs to project Other Repo/);
  expect(updates).toEqual([]);
  expect(comments).toEqual([]);
});

test("Linear planning apply helpers map statuses and render concise comments", () => {
  expect(linearPlanningTargetStatus(LINEAR_SETTINGS, "plan-approved")).toBe("Planning");
  expect(linearPlanningTargetStatus(LINEAR_SETTINGS, "plan-needs-human")).toBe(
    "Needs Clarification",
  );
  expect(linearPlanningTargetStatus(LINEAR_SETTINGS, "plan-review-unresolved")).toBe(
    "Plan Needs Review",
  );
  expect(linearPlanningTargetStatus(LINEAR_SETTINGS, "planning-failed")).toBe("Planning Failed");
  expect(() => linearPlanningTargetStatus(LINEAR_SETTINGS, "dry_run")).toThrow(
    /cannot be used with dry-run/,
  );
  expect(() => assertLinearPlanningApplyAllowed(LINEAR_SETTINGS, "Needs Plan")).not.toThrow();
  expect(() =>
    assertLinearPlanningApplyAllowed(LINEAR_SETTINGS, "Needs Clarification"),
  ).not.toThrow();
  expect(() =>
    assertLinearPlanningApplyAllowed(LINEAR_SETTINGS, "Plan Needs Review"),
  ).not.toThrow();
  expect(() => assertLinearPlanningApplyAllowed(LINEAR_SETTINGS, "Planning Failed")).not.toThrow();
  for (const status of ["Backlog", "Ready to Implement", "Planning"]) {
    expect(() => assertLinearPlanningApplyAllowed(LINEAR_SETTINGS, status)).toThrow(
      /only accepts Needs Plan, Needs Clarification, Plan Needs Review, or Planning Failed/,
    );
  }

  expect(linearPlanningApplyCommentMarker("run-1")).toBe(
    "<!-- harness-factory:planning-apply:run-1 -->",
  );
  expect(linearPlanningApplyFailedCommentMarker("run-1")).toBe(
    "<!-- harness-factory:planning-apply-failed:run-1 -->",
  );
  expect(
    renderLinearPlanningApplyCompleteComment({
      issueRef: "ENG-123",
      runId: "run-1",
      runDir: ".harness/runs/factory/run-1",
      status: "plan-approved",
      approvedPlanPath: "dev/plans/ENG-123.md",
      targetStatus: "Planning",
    }),
  ).toContain("Factory plan ready.");
  expect(
    renderLinearPlanningApplyFailedComment({
      issueRef: "ENG-123",
      runId: "run-1",
      runDir: ".harness/runs/factory/run-1",
      error: "agent timeout",
    }),
  ).toContain("Factory planning command failed.");
});

test("Linear planning attention parser selects the latest planning marker", () => {
  expect(
    linearPlanningAttentionStageFromComments([
      {
        body: [
          "<!-- harness-factory:planning-apply:run-1 -->",
          "",
          "Status: plan-needs-human",
        ].join("\n"),
        createdAt: new Date("2026-07-07T10:00:00Z"),
      },
      {
        body: [
          "<!-- harness-factory:planning-apply:run-2 -->",
          "",
          "Status: plan-review-unresolved",
        ].join("\n"),
        createdAt: new Date("2026-07-07T11:00:00Z"),
      },
    ]),
  ).toBe("plan-review-unresolved");
  expect(linearPlanningAttentionStageFromComments([{ body: "human comment" }])).toBeUndefined();
});

test("Linear triage helpers map routes and render concise comments", () => {
  expect(linearTriageTargetStatus(LINEAR_SETTINGS, "ready-to-implement")).toBe(
    "Ready to Implement",
  );
  expect(linearTriageTargetStatus(LINEAR_SETTINGS, "ready-to-plan")).toBe("Needs Plan");
  expect(linearTriageTargetStatus(LINEAR_SETTINGS, "needs-info")).toBe("Needs Clarification");
  expect(linearTriageTargetStatus(LINEAR_SETTINGS, "wait-to-implement")).toBe("Parked");
  expect(() => assertLinearTriageApplyAllowed(LINEAR_SETTINGS, "Backlog")).not.toThrow();
  for (const status of [
    "Needs Plan",
    "Ready to Implement",
    "Parked",
    "Triaging",
    "Planning",
    "Planning Failed",
  ]) {
    expect(() => assertLinearTriageApplyAllowed(LINEAR_SETTINGS, status)).toThrow(
      /only accepts Backlog, Needs Clarification, or Triage Failed/,
    );
  }

  const comment = renderLinearTriageCompleteComment({
    runId: "run-1",
    runDir: ".harness/runs/factory/run-1",
    route: "needs-info",
    targetStatus: "Needs Clarification",
    rationale: "Human input is required.",
    evidence: [{ kind: "tracker", summary: "Issue is missing scope." }],
    questions: ["Which provider should own this?"],
  });
  expect(comment).toContain("<!-- harness-factory:triage:run-1 -->");
  expect(comment).not.toContain("Why Needs Plan:");
  expect(comment).not.toContain("Evidence:");
});

test("Linear adapter fetches an issue as a factory work item", async () => {
  const queries: unknown[] = [];
  const client = fakeReadOnlyLinearClient({
    issues: async (variables) => {
      queries.push(variables);
      return { nodes: [ISSUE] };
    },
  });
  const adapter = createLinearFactoryAdapterForClient({ client, settings: LINEAR_SETTINGS });

  const item = await adapter.fetchWorkItem("ENG-123");

  expect(queries).toEqual([
    {
      filter: {
        team: { key: { eq: "ENG" } },
        number: { eq: 123 },
      },
      first: 2,
    },
  ]);
  expect(item).toMatchObject({
    id: "linear:ENG-123",
    source: "linear",
    title: "Add export shortcut",
    url: "https://linear.app/acme/issue/ENG-123/add-export-shortcut",
    labels: ["factory", "product"],
    metadata: {
      tracker: {
        source: "linear",
        id: "ENG-123",
        url: "https://linear.app/acme/issue/ENG-123/add-export-shortcut",
      },
      factoryStage: "ready-to-plan",
      linearIssueId: "issue-1",
      linearTeamKey: "ENG",
      linearProjectId: "project-1",
      linearProjectName: "Harness",
      linearProjectUrl: "https://linear.app/acme/project/harness-123",
      linearStatus: "Needs Plan",
      linearAssignee: "Felipe",
      linearCommentsIncluded: 1,
      linearCommentsTruncated: false,
    },
  });
  expect(item.body).toContain("Users need a keyboard shortcut");
  expect(item.body).toContain("## Linear Comments");
  expect(item.body).toContain("Please keep the shortcut configurable.");
});

test("Linear adapter lists lightweight issue summaries by configured status keys", async () => {
  const queries: unknown[] = [];
  const listIssue = {
    ...ISSUE,
    labels: async () => {
      throw new Error("labels should not be fetched while listing");
    },
    comments: async () => {
      throw new Error("comments should not be fetched while listing");
    },
  };
  const client = fakeReadOnlyLinearClient({
    issues: async (variables) => {
      queries.push(variables);
      return {
        pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
        nodes: [listIssue],
      };
    },
  });
  const adapter = createLinearFactoryAdapterForClient({
    client,
    settings: SCOPED_LINEAR_SETTINGS,
  });

  const result = await adapter.listWorkItemsByStatus({
    statusKeys: ["intake", "needsPlan"],
    first: 25,
    after: "cursor-0",
  });

  expect(queries).toEqual([
    {
      filter: {
        team: { key: { eq: "ENG" } },
        state: { name: { in: ["Backlog", "Needs Plan"] } },
        project: { id: { eq: PROJECT.id } },
      },
      first: 25,
      after: "cursor-0",
    },
  ]);
  expect(result).toEqual({
    teamKey: "ENG",
    projectId: PROJECT.id,
    statusKeys: ["intake", "needsPlan"],
    statusNames: ["Backlog", "Needs Plan"],
    issues: [
      {
        id: "linear:ENG-123",
        source: "linear",
        identifier: "ENG-123",
        title: "Add export shortcut",
        url: "https://linear.app/acme/issue/ENG-123/add-export-shortcut",
        status: "Needs Plan",
        statusType: "unstarted",
        factoryStage: "ready-to-plan",
        projectId: PROJECT.id,
        projectName: "Harness",
        projectUrl: "https://linear.app/acme/project/harness-123",
        assignee: "Felipe",
        priority: 2,
        priorityLabel: "High",
        createdAt: "2026-07-07T10:00:00.000Z",
        updatedAt: "2026-07-07T11:00:00.000Z",
      },
    ],
    pageInfo: {
      fetchedPages: 1,
      hasNextPage: true,
      endCursor: "cursor-1",
    },
  });
  expect(result.issues[0]).not.toHaveProperty("body");
});

test("Linear adapter omits comment-derived factory stage for Needs Clarification lists", async () => {
  const adapter = createLinearFactoryAdapterForClient({
    client: fakeReadOnlyLinearClient({
      issues: async () => ({
        nodes: [
          {
            ...ISSUE,
            state: Promise.resolve({
              id: "state-Needs Clarification",
              name: "Needs Clarification",
              type: "unstarted",
            }),
          },
        ],
      }),
    }),
    settings: LINEAR_SETTINGS,
  });

  const result = await adapter.listWorkItemsByStatus({ statusKeys: ["needsInfo"] });

  expect(result.issues[0]).toMatchObject({
    status: "Needs Clarification",
  });
  expect(result.issues[0]).not.toHaveProperty("factoryStage");
});

test("Linear adapter rejects listed issues outside configured project", async () => {
  const adapter = createLinearFactoryAdapterForClient({
    client: fakeReadOnlyLinearClient({
      issues: async () => ({
        nodes: [
          {
            ...ISSUE,
            projectId: OTHER_PROJECT.id,
            project: Promise.resolve(OTHER_PROJECT),
          },
        ],
      }),
    }),
    settings: SCOPED_LINEAR_SETTINGS,
  });

  await expect(adapter.listWorkItemsByStatus({ statusKeys: ["intake"] })).rejects.toThrow(
    /belongs to project Other Repo \(project-2\), but factory\.linear\.projectId is project-1/,
  );
});

test("Linear adapter lists all pages using safe cursors", async () => {
  const queries: unknown[] = [];
  const adapter = createLinearFactoryAdapterForClient({
    client: fakeReadOnlyLinearClient({
      issues: async (variables) => {
        queries.push(variables);
        if (queries.length === 1) {
          return {
            pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
            nodes: [ISSUE],
          };
        }
        return {
          pageInfo: { hasNextPage: false, endCursor: "cursor-2" },
          nodes: [
            {
              ...ISSUE,
              id: "issue-2",
              identifier: "ENG-124",
              number: 124,
              title: "Second issue",
            },
          ],
        };
      },
    }),
    settings: LINEAR_SETTINGS,
  });

  const result = await adapter.listWorkItemsByStatus({
    statusKeys: ["intake"],
    all: true,
    first: 10,
  });

  expect(queries).toEqual([
    {
      filter: {
        team: { key: { eq: "ENG" } },
        state: { name: { in: ["Backlog"] } },
      },
      first: 10,
    },
    {
      filter: {
        team: { key: { eq: "ENG" } },
        state: { name: { in: ["Backlog"] } },
      },
      first: 10,
      after: "cursor-1",
    },
  ]);
  expect(result.issues.map((issue) => issue.identifier)).toEqual(["ENG-123", "ENG-124"]);
  expect(result.pageInfo).toEqual({
    fetchedPages: 2,
    hasNextPage: false,
    endCursor: "cursor-2",
  });
});

test("Linear adapter rejects unsafe list pagination inputs", async () => {
  const adapter = createLinearFactoryAdapterForClient({
    client: fakeReadOnlyLinearClient(),
    settings: LINEAR_SETTINGS,
  });

  await expect(adapter.listWorkItemsByStatus({ statusKeys: [] })).rejects.toThrow(
    /At least one factory status key is required/,
  );
  await expect(adapter.listWorkItemsByStatus({ statusKeys: ["intake"], first: 0 })).rejects.toThrow(
    /between 1 and 100/,
  );
  await expect(
    adapter.listWorkItemsByStatus({ statusKeys: ["intake"], first: 101 }),
  ).rejects.toThrow(/between 1 and 100/);
  await expect(
    adapter.listWorkItemsByStatus({ statusKeys: ["intake"], all: true, after: "cursor-1" }),
  ).rejects.toThrow(/cannot be combined with an after cursor/);
});

test("Linear adapter fails closed when all-pages listing cannot advance", async () => {
  const adapter = createLinearFactoryAdapterForClient({
    client: fakeReadOnlyLinearClient({
      issues: async () => ({
        pageInfo: { hasNextPage: true },
        nodes: [ISSUE],
      }),
    }),
    settings: LINEAR_SETTINGS,
  });

  await expect(
    adapter.listWorkItemsByStatus({ statusKeys: ["intake"], all: true }),
  ).rejects.toThrow(/hasNextPage without endCursor/);
});

test("Linear adapter accepts issues in configured project during fetch", async () => {
  const adapter = createLinearFactoryAdapterForClient({
    client: fakeClient(),
    settings: SCOPED_LINEAR_SETTINGS,
  });

  await expect(adapter.fetchWorkItem("ENG-123")).resolves.toMatchObject({
    metadata: {
      linearProjectId: PROJECT.id,
      linearProjectName: PROJECT.name,
    },
  });
});

test("Linear adapter compares configured project ids case-insensitively", async () => {
  const adapter = createLinearFactoryAdapterForClient({
    client: fakeClient(),
    settings: {
      ...SCOPED_LINEAR_SETTINGS,
      projectId: PROJECT.id.toUpperCase(),
    },
  });

  await expect(adapter.fetchWorkItem("ENG-123")).resolves.toMatchObject({
    metadata: {
      linearProjectId: PROJECT.id,
    },
  });
});

test("Linear adapter keeps omitted projectId backward compatible", async () => {
  const adapter = createLinearFactoryAdapterForClient({
    client: fakeClient({
      issues: async () => ({
        nodes: [
          {
            ...ISSUE,
            projectId: OTHER_PROJECT.id,
            project: Promise.resolve(OTHER_PROJECT),
          },
        ],
      }),
    }),
    settings: LINEAR_SETTINGS,
  });

  await expect(adapter.fetchWorkItem("ENG-123")).resolves.toMatchObject({
    metadata: {
      linearProjectId: "project-2",
      linearProjectName: "Other Repo",
    },
  });
});

test("Linear adapter accepts matching project relation when scalar projectId is absent", async () => {
  const adapter = createLinearFactoryAdapterForClient({
    client: fakeClient({
      issues: async () => ({
        nodes: [
          {
            ...ISSUE,
            projectId: undefined,
            project: Promise.resolve(PROJECT),
          },
        ],
      }),
    }),
    settings: SCOPED_LINEAR_SETTINGS,
  });

  await expect(adapter.fetchWorkItem("ENG-123")).resolves.toMatchObject({
    metadata: {
      linearProjectId: PROJECT.id,
      linearProjectName: PROJECT.name,
    },
  });
});

test("Linear adapter rejects inconsistent project scalar and relation data", async () => {
  const adapter = createLinearFactoryAdapterForClient({
    client: fakeClient({
      issues: async () => ({
        nodes: [
          {
            ...ISSUE,
            projectId: "project-stale",
            project: Promise.resolve(OTHER_PROJECT),
          },
        ],
      }),
    }),
    settings: LINEAR_SETTINGS,
  });

  await expect(adapter.fetchWorkItem("ENG-123")).rejects.toThrow(
    /returned inconsistent project data: projectId project-stale, project relation Other Repo \(project-2\)/,
  );
});

test("Linear adapter rejects issues outside the configured project", async () => {
  const adapter = createLinearFactoryAdapterForClient({
    client: fakeClient({
      issues: async () => ({
        nodes: [
          {
            ...ISSUE,
            projectId: OTHER_PROJECT.id,
            project: Promise.resolve(OTHER_PROJECT),
          },
        ],
      }),
    }),
    settings: SCOPED_LINEAR_SETTINGS,
  });

  await expect(adapter.fetchWorkItem("ENG-123")).rejects.toThrow(
    /belongs to project Other Repo \(project-2\), but factory\.linear\.projectId is project-1/,
  );
});

test("Linear adapter rejects project-scoped fetch when issue has no project", async () => {
  const adapter = createLinearFactoryAdapterForClient({
    client: fakeClient({
      issues: async () => ({
        nodes: [
          {
            ...ISSUE,
            projectId: undefined,
            project: undefined,
          },
        ],
      }),
    }),
    settings: SCOPED_LINEAR_SETTINGS,
  });

  await expect(adapter.fetchWorkItem("ENG-123")).rejects.toThrow(
    /has no project, but factory\.linear\.projectId is project-1/,
  );
});

test("Linear adapter treats non-human refs as direct issue ids", async () => {
  const client = fakeClient({
    issue: async (id) => ({ ...ISSUE, id, identifier: "ENG-124", number: 124 }),
    issues: async () => {
      throw new Error("identifier lookup should not run");
    },
  });
  const adapter = createLinearFactoryAdapterForClient({ client, settings: LINEAR_SETTINGS });

  const item = await adapter.fetchWorkItem("uuid-issue-id");

  expect(item.id).toBe("linear:ENG-124");
});

test("Linear adapter rejects direct issue ids outside the configured project", async () => {
  const adapter = createLinearFactoryAdapterForClient({
    client: fakeClient({
      issue: async (id) => ({
        ...ISSUE,
        id,
        projectId: OTHER_PROJECT.id,
        project: Promise.resolve(OTHER_PROJECT),
      }),
      issues: async () => {
        throw new Error("identifier lookup should not run");
      },
    }),
    settings: SCOPED_LINEAR_SETTINGS,
  });

  await expect(adapter.fetchWorkItem("uuid-issue-id")).rejects.toThrow(
    /belongs to project Other Repo \(project-2\), but factory\.linear\.projectId is project-1/,
  );
});

test("Linear adapter validates configured statuses against team states", async () => {
  const missingStatusTeam = {
    ...TEAM,
    states: async () => ({
      nodes: [{ id: "state-backlog", name: "Backlog", type: "backlog" }],
    }),
  };
  const adapter = createLinearFactoryAdapterForClient({
    client: fakeClient({ teams: async () => ({ nodes: [missingStatusTeam] }) }),
    settings: LINEAR_SETTINGS,
  });

  await expect(adapter.validateStatusMap()).rejects.toThrow(
    /missing configured statuses: Parked, Needs Clarification/,
  );
});

test("Linear adapter validates status map during fetch", async () => {
  const missingStatusTeam = {
    ...TEAM,
    states: async () => ({
      nodes: [{ id: "state-backlog", name: "Backlog", type: "backlog" }],
    }),
  };
  const adapter = createLinearFactoryAdapterForClient({
    client: fakeClient({ teams: async () => ({ nodes: [missingStatusTeam] }) }),
    settings: LINEAR_SETTINGS,
  });

  await expect(adapter.fetchWorkItem("ENG-123")).rejects.toThrow(
    /missing configured statuses: Parked, Needs Clarification/,
  );
});

test("Linear adapter rejects issue identifiers outside the configured team", async () => {
  const adapter = createLinearFactoryAdapterForClient({
    client: fakeClient(),
    settings: LINEAR_SETTINGS,
  });

  await expect(adapter.fetchWorkItem("OPS-123")).rejects.toThrow(
    /belongs to OPS, but factory\.linear\.teamKey is ENG/,
  );
});

test("Linear adapter rejects direct issue ids outside the configured team", async () => {
  const opsTeam = { ...TEAM, key: "OPS", name: "Operations" };
  const adapter = createLinearFactoryAdapterForClient({
    client: fakeClient({
      issue: async () => ({ ...ISSUE, identifier: "OPS-123", team: Promise.resolve(opsTeam) }),
    }),
    settings: LINEAR_SETTINGS,
  });

  await expect(adapter.fetchWorkItem("issue-uuid")).rejects.toThrow(
    /belongs to OPS, but factory\.linear\.teamKey is ENG/,
  );
});

test("Linear adapter fails closed when issue team is missing", async () => {
  const adapter = createLinearFactoryAdapterForClient({
    client: fakeClient({
      issue: async () => ({ ...ISSUE, team: undefined }),
    }),
    settings: LINEAR_SETTINGS,
  });

  await expect(adapter.fetchWorkItem("issue-uuid")).rejects.toThrow(
    /did not include team data; cannot verify factory\.linear\.teamKey ENG/,
  );
});

test("Linear adapter preserves Triage Failed as Linear metadata only", async () => {
  const adapter = createLinearFactoryAdapterForClient({
    client: fakeClient({
      issues: async () => ({
        nodes: [
          {
            ...ISSUE,
            state: Promise.resolve({
              id: "state-triage-failed",
              name: "Triage Failed",
              type: "canceled",
            }),
          },
        ],
      }),
    }),
    settings: LINEAR_SETTINGS,
  });

  const item = await adapter.fetchWorkItem("ENG-123");

  expect(item.metadata).toMatchObject({ linearStatus: "Triage Failed" });
  expect(item.metadata).not.toHaveProperty("factoryStage");
});

test("Linear adapter sorts comments and records truncation", async () => {
  const commentQueries: unknown[] = [];
  const adapter = createLinearFactoryAdapterForClient({
    client: fakeClient({
      issues: async () => ({
        nodes: [
          {
            ...ISSUE,
            comments: async (variables) => {
              commentQueries.push(variables);
              return {
                pageInfo: { hasPreviousPage: true },
                nodes: [
                  {
                    id: "later",
                    body: "Second comment.",
                    createdAt: new Date("2026-07-07T12:00:00Z"),
                  },
                  {
                    id: "earlier",
                    body: "First comment.",
                    createdAt: new Date("2026-07-07T10:00:00Z"),
                  },
                ],
              };
            },
          },
        ],
      }),
    }),
    settings: LINEAR_SETTINGS,
  });

  const item = await adapter.fetchWorkItem("ENG-123");

  expect(commentQueries).toEqual([{ last: 20 }]);
  expect(item.body.indexOf("First comment.")).toBeLessThan(item.body.indexOf("Second comment."));
  expect(item.metadata).toMatchObject({
    linearCommentsIncluded: 2,
    linearCommentsTruncated: true,
  });
});

test("Linear adapter maps Plan Needs Review to unresolved planning", async () => {
  const adapter = createLinearFactoryAdapterForClient({
    client: fakeClient({
      issues: async () => ({
        nodes: [
          {
            ...ISSUE,
            state: Promise.resolve({ id: "state-Plan Needs Review", name: "Plan Needs Review" }),
          },
        ],
      }),
    }),
    settings: LINEAR_SETTINGS,
  });

  const item = await adapter.fetchWorkItem("ENG-123");

  expect(item.metadata).toMatchObject({
    factoryStage: "plan-review-unresolved",
    linearStatus: "Plan Needs Review",
  });
});

test("Linear adapter keeps generic Needs Clarification without planning marker", async () => {
  const adapter = createLinearFactoryAdapterForClient({
    client: fakeClient({
      issues: async () => ({
        nodes: [
          {
            ...ISSUE,
            state: Promise.resolve({
              id: "state-Needs Clarification",
              name: "Needs Clarification",
            }),
            comments: async () => ({
              nodes: [
                {
                  body: "<!-- harness-factory:triage:run-1 -->\n\nRoute: needs-info",
                  createdAt: new Date("2026-07-07T12:00:00Z"),
                },
              ],
            }),
          },
        ],
      }),
    }),
    settings: LINEAR_SETTINGS,
  });

  const item = await adapter.fetchWorkItem("ENG-123");

  expect(item.metadata).toMatchObject({
    factoryStage: "needs-info",
    linearStatus: "Needs Clarification",
  });
});

test("Linear adapter preserves needs-human stage from Needs Clarification comments", async () => {
  const adapter = createLinearFactoryAdapterForClient({
    client: fakeClient({
      issues: async () => ({
        nodes: [
          {
            ...ISSUE,
            state: Promise.resolve({
              id: "state-Needs Clarification",
              name: "Needs Clarification",
            }),
            comments: async () => ({
              nodes: [
                {
                  body: [
                    "<!-- harness-factory:planning-apply:run-1 -->",
                    "",
                    "Factory planning needs human input.",
                    "",
                    "Status: plan-needs-human",
                  ].join("\n"),
                  createdAt: new Date("2026-07-07T12:00:00Z"),
                },
              ],
            }),
          },
        ],
      }),
    }),
    settings: LINEAR_SETTINGS,
  });

  const item = await adapter.fetchWorkItem("ENG-123");

  expect(item.metadata).toMatchObject({
    factoryStage: "plan-needs-human",
    linearStatus: "Needs Clarification",
  });
});

test("Linear adapter reports missing and ambiguous human issue identifiers", async () => {
  const missing = createLinearFactoryAdapterForClient({
    client: fakeClient({ issues: async () => ({ nodes: [] }) }),
    settings: LINEAR_SETTINGS,
  });
  await expect(missing.fetchWorkItem("ENG-404")).rejects.toThrow(/Linear issue not found: ENG-404/);

  const ambiguous = createLinearFactoryAdapterForClient({
    client: fakeClient({ issues: async () => ({ nodes: [ISSUE, { ...ISSUE, id: "issue-2" }] }) }),
    settings: LINEAR_SETTINGS,
  });
  await expect(ambiguous.fetchWorkItem("ENG-123")).rejects.toThrow(
    /Linear issue lookup was ambiguous: ENG-123/,
  );
});

test("Linear adapter applies triage started status from allowed entry states", async () => {
  for (const statusName of ["Backlog", "Needs Clarification", "Triage Failed"]) {
    const updates: Array<{ id: string; input: { stateId: string } }> = [];
    const adapter = createLinearFactoryAdapterForClient({
      client: fakeClient({
        issues: async () => ({
          nodes: [
            {
              ...ISSUE,
              state: Promise.resolve({ id: `state-${statusName}`, name: statusName }),
            },
          ],
        }),
        updateIssue: async (id, input) => {
          updates.push({ id, input });
          return { success: true };
        },
      }),
      settings: LINEAR_SETTINGS,
    });

    const result = await adapter.applyTriageStarted({
      issueRef: "ENG-123",
      runId: "run-1",
      runDir: ".harness/runs/factory/run-1",
    });

    expect(updates).toEqual([{ id: "issue-1", input: { stateId: "state-Triaging" } }]);
    expect(result).toMatchObject({
      issueIdentifier: "ENG-123",
      stage: "start",
      fromStatus: statusName,
      targetStatus: "Triaging",
    });
  }
});

test("Linear adapter rejects triage apply from terminal statuses before mutation", async () => {
  const updates: Array<{ id: string; input: { stateId: string } }> = [];
  const adapter = createLinearFactoryAdapterForClient({
    client: fakeClient({
      updateIssue: async (id, input) => {
        updates.push({ id, input });
        return { success: true };
      },
    }),
    settings: LINEAR_SETTINGS,
  });

  await expect(
    adapter.applyTriageStarted({
      issueRef: "ENG-123",
      runId: "run-1",
      runDir: ".harness/runs/factory/run-1",
    }),
  ).rejects.toThrow(/only accepts Backlog, Needs Clarification, or Triage Failed/);
  expect(updates).toEqual([]);
});

test("Linear adapter rejects triage apply outside configured project before mutation", async () => {
  const updates: Array<{ id: string; input: { stateId: string } }> = [];
  const adapter = createLinearFactoryAdapterForClient({
    client: fakeClient({
      issues: async () => ({
        nodes: [
          {
            ...ISSUE,
            state: Promise.resolve({ id: "state-Backlog", name: "Backlog", type: "backlog" }),
            projectId: OTHER_PROJECT.id,
            project: Promise.resolve(OTHER_PROJECT),
          },
        ],
      }),
      updateIssue: async (id, input) => {
        updates.push({ id, input });
        return { success: true };
      },
    }),
    settings: SCOPED_LINEAR_SETTINGS,
  });

  await expect(
    adapter.applyTriageStarted({
      issueRef: "ENG-123",
      runId: "run-1",
      runDir: ".harness/runs/factory/run-1",
    }),
  ).rejects.toThrow(/belongs to project Other Repo \(project-2\)/);
  expect(updates).toEqual([]);
});

test("Linear adapter rejects triage apply without a project before mutation", async () => {
  const updates: Array<{ id: string; input: { stateId: string } }> = [];
  const adapter = createLinearFactoryAdapterForClient({
    client: fakeClient({
      issues: async () => ({
        nodes: [
          {
            ...ISSUE,
            state: Promise.resolve({ id: "state-Backlog", name: "Backlog", type: "backlog" }),
            projectId: undefined,
            project: undefined,
          },
        ],
      }),
      updateIssue: async (id, input) => {
        updates.push({ id, input });
        return { success: true };
      },
    }),
    settings: SCOPED_LINEAR_SETTINGS,
  });

  await expect(
    adapter.applyTriageStarted({
      issueRef: "ENG-123",
      runId: "run-1",
      runDir: ".harness/runs/factory/run-1",
    }),
  ).rejects.toThrow(/has no project, but factory\.linear\.projectId is project-1/);
  expect(updates).toEqual([]);
});

test("Linear adapter rejects terminal triage apply outside configured project before mutation", async () => {
  for (const apply of ["completed", "failed"] as const) {
    const updates: Array<{ id: string; input: { stateId: string } }> = [];
    const comments: Array<{ issueId: string; body: string }> = [];
    const adapter = createLinearFactoryAdapterForClient({
      client: fakeClient({
        issues: async () => ({
          nodes: [
            {
              ...ISSUE,
              projectId: OTHER_PROJECT.id,
              project: Promise.resolve(OTHER_PROJECT),
            },
          ],
        }),
        updateIssue: async (id, input) => {
          updates.push({ id, input });
          return { success: true };
        },
        createComment: async (input) => {
          comments.push(input);
          return { success: true };
        },
      }),
      settings: SCOPED_LINEAR_SETTINGS,
    });

    if (apply === "completed") {
      await expect(
        adapter.applyTriageCompleted({
          issueRef: "ENG-123",
          runId: "run-1",
          runDir: ".harness/runs/factory/run-1",
          triage: TRIAGE_READY_TO_PLAN,
        }),
      ).rejects.toThrow(/belongs to project Other Repo \(project-2\)/);
    } else {
      await expect(
        adapter.applyTriageFailed({
          issueRef: "ENG-123",
          runId: "run-1",
          runDir: ".harness/runs/factory/run-1",
          error: "agent timeout",
        }),
      ).rejects.toThrow(/belongs to project Other Repo \(project-2\)/);
    }
    expect(updates).toEqual([]);
    expect(comments).toEqual([]);
  }
});

test("Linear adapter applies planning started status from allowed entry states", async () => {
  for (const statusName of [
    "Needs Plan",
    "Needs Clarification",
    "Plan Needs Review",
    "Planning Failed",
  ]) {
    const updates: Array<{ id: string; input: { stateId: string } }> = [];
    const adapter = createLinearFactoryAdapterForClient({
      client: fakeClient({
        issues: async () => ({
          nodes: [
            {
              ...ISSUE,
              state: Promise.resolve({ id: `state-${statusName}`, name: statusName }),
            },
          ],
        }),
        updateIssue: async (id, input) => {
          updates.push({ id, input });
          return { success: true };
        },
      }),
      settings: LINEAR_SETTINGS,
    });

    const result = await adapter.applyPlanningStarted({
      issueRef: "ENG-123",
      runId: "run-1",
      runDir: ".harness/runs/factory/run-1",
    });

    expect(updates).toEqual([{ id: "issue-1", input: { stateId: "state-Planning" } }]);
    expect(result).toMatchObject({
      issueIdentifier: "ENG-123",
      stage: "start",
      fromStatus: statusName,
      targetStatus: "Planning",
    });
  }
});

test("Linear adapter rejects planning apply from disallowed statuses before mutation", async () => {
  const updates: Array<{ id: string; input: { stateId: string } }> = [];
  const adapter = createLinearFactoryAdapterForClient({
    client: fakeClient({
      issues: async () => ({
        nodes: [
          {
            ...ISSUE,
            state: Promise.resolve({ id: "state-Backlog", name: "Backlog" }),
          },
        ],
      }),
      updateIssue: async (id, input) => {
        updates.push({ id, input });
        return { success: true };
      },
    }),
    settings: LINEAR_SETTINGS,
  });

  await expect(
    adapter.applyPlanningStarted({
      issueRef: "ENG-123",
      runId: "run-1",
      runDir: ".harness/runs/factory/run-1",
    }),
  ).rejects.toThrow(
    /only accepts Needs Plan, Needs Clarification, Plan Needs Review, or Planning Failed/,
  );
  expect(updates).toEqual([]);
});

test("Linear adapter rejects planning apply outside configured project before mutation", async () => {
  for (const apply of ["started", "completed", "failed"] as const) {
    const updates: Array<{ id: string; input: { stateId: string } }> = [];
    const comments: Array<{ issueId: string; body: string }> = [];
    const adapter = createLinearFactoryAdapterForClient({
      client: fakeClient({
        issues: async () => ({
          nodes: [
            {
              ...ISSUE,
              state: Promise.resolve({ id: "state-Needs Plan", name: "Needs Plan" }),
              projectId: OTHER_PROJECT.id,
              project: Promise.resolve(OTHER_PROJECT),
            },
          ],
        }),
        updateIssue: async (id, input) => {
          updates.push({ id, input });
          return { success: true };
        },
        createComment: async (input) => {
          comments.push(input);
          return { success: true };
        },
      }),
      settings: SCOPED_LINEAR_SETTINGS,
    });

    if (apply === "started") {
      await expect(
        adapter.applyPlanningStarted({
          issueRef: "ENG-123",
          runId: "run-1",
          runDir: ".harness/runs/factory/run-1",
        }),
      ).rejects.toThrow(/belongs to project Other Repo \(project-2\)/);
    } else if (apply === "completed") {
      await expect(
        adapter.applyPlanningCompleted({
          issueRef: "ENG-123",
          runId: "run-1",
          runDir: ".harness/runs/factory/run-1",
          status: "plan-approved",
          approvedPlanPath: "dev/plans/ENG-123.md",
        }),
      ).rejects.toThrow(/belongs to project Other Repo \(project-2\)/);
    } else {
      await expect(
        adapter.applyPlanningFailed({
          issueRef: "ENG-123",
          runId: "run-1",
          runDir: ".harness/runs/factory/run-1",
          error: "provider crashed",
        }),
      ).rejects.toThrow(/belongs to project Other Repo \(project-2\)/);
    }
    expect(updates).toEqual([]);
    expect(comments).toEqual([]);
  }
});

test.each([
  {
    status: "plan-approved" as const,
    targetStatus: "Planning",
    expectedBody: "Open/register a plan PR",
    extra: { approvedPlanPath: "dev/plans/ENG-123.md" },
  },
  {
    status: "plan-needs-human" as const,
    targetStatus: "Needs Clarification",
    expectedBody: "- Which scope should we use?",
    extra: { humanQuestions: ["Which scope should we use?"] },
  },
  {
    status: "plan-review-unresolved" as const,
    targetStatus: "Plan Needs Review",
    expectedBody: "Factory plan needs human review.",
    extra: {
      draftPlanPath: ".harness/runs/factory/run-1/iterations/3/plan.md",
      reviewFindingsPath: ".harness/runs/factory/run-1/iterations/3/review-findings.json",
      error: "Plan review still needs changes after max review iterations",
    },
  },
  {
    status: "planning-failed" as const,
    targetStatus: "Planning Failed",
    expectedBody: "Error: planner failed",
    extra: { error: "planner failed" },
  },
])(
  "Linear adapter applies completed planning outcome $status",
  async ({ status, targetStatus, expectedBody, extra }) => {
    const updates: Array<{ id: string; input: { stateId: string } }> = [];
    const comments: Array<{ issueId: string; body: string }> = [];
    const adapter = createLinearFactoryAdapterForClient({
      client: fakeClient({
        issues: async () => ({
          nodes: [
            {
              ...ISSUE,
              state: Promise.resolve({ id: "state-Planning", name: "Planning", type: "started" }),
            },
          ],
        }),
        updateIssue: async (id, input) => {
          updates.push({ id, input });
          return { success: true };
        },
        createComment: async (input) => {
          comments.push(input);
          return { success: true };
        },
      }),
      settings: LINEAR_SETTINGS,
    });

    const result = await adapter.applyPlanningCompleted({
      issueRef: "ENG-123",
      runId: `run-${status}`,
      runDir: `.harness/runs/factory/run-${status}`,
      status,
      ...extra,
    });

    expect(updates).toEqual(
      targetStatus === "Planning"
        ? []
        : [{ id: "issue-1", input: { stateId: `state-${targetStatus}` } }],
    );
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain(`Status: ${status}`);
    expect(comments[0].body).toContain(expectedBody);
    if (status === "plan-review-unresolved") {
      expect(comments[0].body).toContain("Draft:");
      expect(comments[0].body).toContain("Findings:");
      expect(comments[0].body).toContain("Do not implement until the plan is approved");
    }
    expect(result).toMatchObject({
      stage: "complete",
      fromStatus: "Planning",
      targetStatus,
      commentMarker: `<!-- harness-factory:planning-apply:run-${status} -->`,
    });
  },
);

test("Linear adapter skips duplicate planning apply comments", async () => {
  const comments: Array<{ issueId: string; body: string }> = [];
  const adapter = createLinearFactoryAdapterForClient({
    client: fakeClient({
      issues: async () => ({
        nodes: [
          {
            ...ISSUE,
            state: Promise.resolve({ id: "state-Planning", name: "Planning", type: "started" }),
            comments: async () => ({
              nodes: [{ body: "<!-- harness-factory:planning-apply:run-1 -->\nAlready posted." }],
            }),
          },
        ],
      }),
      createComment: async (input) => {
        comments.push(input);
        return { success: true };
      },
    }),
    settings: LINEAR_SETTINGS,
  });

  await adapter.applyPlanningCompleted({
    issueRef: "ENG-123",
    runId: "run-1",
    runDir: ".harness/runs/factory/run-1",
    status: "plan-approved",
    approvedPlanPath: "dev/plans/ENG-123.md",
  });

  expect(comments).toEqual([]);
});

test("Linear adapter applies failed planning status and comment", async () => {
  const updates: Array<{ id: string; input: { stateId: string } }> = [];
  const comments: Array<{ issueId: string; body: string }> = [];
  const adapter = createLinearFactoryAdapterForClient({
    client: fakeClient({
      issues: async () => ({
        nodes: [
          {
            ...ISSUE,
            state: Promise.resolve({ id: "state-Planning", name: "Planning", type: "started" }),
          },
        ],
      }),
      updateIssue: async (id, input) => {
        updates.push({ id, input });
        return { success: true };
      },
      createComment: async (input) => {
        comments.push(input);
        return { success: true };
      },
    }),
    settings: LINEAR_SETTINGS,
  });

  const result = await adapter.applyPlanningFailed({
    issueRef: "ENG-123",
    runId: "run-1",
    runDir: ".harness/runs/factory/run-1",
    error: "provider crashed",
  });

  expect(updates).toEqual([{ id: "issue-1", input: { stateId: "state-Planning Failed" } }]);
  expect(comments[0].body).toContain("Error: provider crashed");
  expect(result).toMatchObject({
    stage: "failed",
    fromStatus: "Planning",
    targetStatus: "Planning Failed",
    commentMarker: "<!-- harness-factory:planning-apply-failed:run-1 -->",
  });
});

test("Linear adapter skips duplicate failed planning apply comments", async () => {
  const comments: Array<{ issueId: string; body: string }> = [];
  const adapter = createLinearFactoryAdapterForClient({
    client: fakeClient({
      issues: async () => ({
        nodes: [
          {
            ...ISSUE,
            state: Promise.resolve({ id: "state-Planning", name: "Planning", type: "started" }),
            comments: async () => ({
              nodes: [
                {
                  body: "<!-- harness-factory:planning-apply-failed:run-1 -->\nAlready posted.",
                },
              ],
            }),
          },
        ],
      }),
      updateIssue: async () => ({ success: true }),
      createComment: async (input) => {
        comments.push(input);
        return { success: true };
      },
    }),
    settings: LINEAR_SETTINGS,
  });

  await adapter.applyPlanningFailed({
    issueRef: "ENG-123",
    runId: "run-1",
    runDir: ".harness/runs/factory/run-1",
    error: "provider crashed",
  });

  expect(comments).toEqual([]);
});

test("Linear adapter applies completed triage status and comment", async () => {
  const updates: Array<{ id: string; input: { stateId: string } }> = [];
  const comments: Array<{ issueId: string; body: string }> = [];
  const adapter = createLinearFactoryAdapterForClient({
    client: fakeClient({
      issues: async () => ({
        nodes: [
          {
            ...ISSUE,
            state: Promise.resolve({ id: "state-Triaging", name: "Triaging", type: "started" }),
          },
        ],
      }),
      updateIssue: async (id, input) => {
        updates.push({ id, input });
        return { success: true };
      },
      createComment: async (input) => {
        comments.push(input);
        return { success: true };
      },
    }),
    settings: LINEAR_SETTINGS,
  });

  const result = await adapter.applyTriageCompleted({
    issueRef: "ENG-123",
    runId: "run-1",
    runDir: ".harness/runs/factory/run-1",
    triage: {
      ...TRIAGE_READY_TO_PLAN,
      evidence: [
        { kind: "tracker", summary: "Issue asks for a larger workflow." },
        { kind: "docs", path: "docs/contributing/factory.md", summary: "Factory docs apply." },
        { kind: "code", path: "lib/factory-linear-adapter.ts", summary: "Adapter needs updates." },
        {
          kind: "test",
          path: "test/factory-linear-adapter.test.ts",
          summary: "Tests need coverage.",
        },
      ],
      questions: ["Which command should publish the plan PR?"],
    },
  });

  expect(updates).toEqual([{ id: "issue-1", input: { stateId: "state-Needs Plan" } }]);
  expect(comments).toHaveLength(1);
  const commentBody = comments[0].body;
  expect(commentBody).toContain("Route: ready-to-plan");
  expect(commentBody).toContain("Why Needs Plan:");
  expect(commentBody).toContain("- Needs a reviewed plan.");
  expect(commentBody).toContain("Evidence:");
  expect(commentBody).toContain("- tracker: Issue asks for a larger workflow.");
  expect(commentBody).toContain("- docs (docs/contributing/factory.md): Factory docs apply.");
  expect(commentBody).toContain("- code (lib/factory-linear-adapter.ts): Adapter needs updates.");
  expect(commentBody).not.toContain("Tests need coverage.");
  expect(commentBody).toContain("Questions:");
  expect(commentBody).toContain("- Which command should publish the plan PR?");
  expect(commentBody.indexOf("Evidence:")).toBeLessThan(commentBody.indexOf("Questions:"));
  expect(result).toMatchObject({
    stage: "complete",
    fromStatus: "Triaging",
    targetStatus: "Needs Plan",
    commentMarker: "<!-- harness-factory:triage:run-1 -->",
  });
});

test("Linear adapter omits questions section for ready-to-plan without questions", async () => {
  const comments: Array<{ issueId: string; body: string }> = [];
  const adapter = createLinearFactoryAdapterForClient({
    client: fakeClient({
      issues: async () => ({
        nodes: [
          {
            ...ISSUE,
            state: Promise.resolve({ id: "state-Triaging", name: "Triaging", type: "started" }),
          },
        ],
      }),
      createComment: async (input) => {
        comments.push(input);
        return { success: true };
      },
    }),
    settings: LINEAR_SETTINGS,
  });

  await adapter.applyTriageCompleted({
    issueRef: "ENG-123",
    runId: "run-no-questions",
    runDir: ".harness/runs/factory/run-no-questions",
    triage: TRIAGE_READY_TO_PLAN,
  });

  expect(comments[0].body).toContain("Why Needs Plan:");
  expect(comments[0].body).toContain("Evidence:");
  expect(comments[0].body).not.toContain("Questions:");
});

test.each([
  {
    route: "ready-to-implement" as const,
    targetStatus: "Ready to Implement",
    expectedBody: "Route: ready-to-implement",
  },
  {
    route: "needs-info" as const,
    targetStatus: "Needs Clarification",
    triageExtra: { questions: ["Which provider should own this?"] },
    expectedBody: "- Which provider should own this?",
  },
  {
    route: "wait-to-implement" as const,
    targetStatus: "Parked",
    triageExtra: { reconsiderWhen: "Roadmap priority changes." },
    expectedBody: "Reconsider when: Roadmap priority changes.",
  },
])(
  "Linear adapter applies completed triage route $route",
  async ({ route, targetStatus, triageExtra, expectedBody }) => {
    const updates: Array<{ id: string; input: { stateId: string } }> = [];
    const comments: Array<{ issueId: string; body: string }> = [];
    const adapter = createLinearFactoryAdapterForClient({
      client: fakeClient({
        issues: async () => ({
          nodes: [
            {
              ...ISSUE,
              state: Promise.resolve({ id: "state-Triaging", name: "Triaging", type: "started" }),
            },
          ],
        }),
        updateIssue: async (id, input) => {
          updates.push({ id, input });
          return { success: true };
        },
        createComment: async (input) => {
          comments.push(input);
          return { success: true };
        },
      }),
      settings: LINEAR_SETTINGS,
    });

    await adapter.applyTriageCompleted({
      issueRef: "ENG-123",
      runId: `run-${route}`,
      runDir: `.harness/runs/factory/run-${route}`,
      triage: triageOutput(route, triageExtra),
    });

    expect(updates).toEqual([{ id: "issue-1", input: { stateId: `state-${targetStatus}` } }]);
    expect(comments[0].body).toContain(`Next: ${targetStatus}`);
    expect(comments[0].body).toContain(expectedBody);
    expect(comments[0].body).not.toContain("Why Needs Plan:");
    expect(comments[0].body).not.toContain("Evidence:");
  },
);

test("Linear adapter skips terminal status update when already at target", async () => {
  const updates: Array<{ id: string; input: { stateId: string } }> = [];
  const comments: Array<{ issueId: string; body: string }> = [];
  const adapter = createLinearFactoryAdapterForClient({
    client: fakeClient({
      issues: async () => ({
        nodes: [
          {
            ...ISSUE,
            state: Promise.resolve({
              id: "state-Needs Plan",
              name: "Needs Plan",
              type: "unstarted",
            }),
          },
        ],
      }),
      updateIssue: async (id, input) => {
        updates.push({ id, input });
        return { success: true };
      },
      createComment: async (input) => {
        comments.push(input);
        return { success: true };
      },
    }),
    settings: LINEAR_SETTINGS,
  });

  await adapter.applyTriageCompleted({
    issueRef: "ENG-123",
    runId: "run-1",
    runDir: ".harness/runs/factory/run-1",
    triage: TRIAGE_READY_TO_PLAN,
  });

  expect(updates).toEqual([]);
  expect(comments[0].body).toContain("Next: Needs Plan");
});

test("Linear adapter skips duplicate triage comments", async () => {
  const comments: Array<{ issueId: string; body: string }> = [];
  const adapter = createLinearFactoryAdapterForClient({
    client: fakeClient({
      issues: async () => ({
        nodes: [
          {
            ...ISSUE,
            state: Promise.resolve({ id: "state-Triaging", name: "Triaging", type: "started" }),
            comments: async () => ({
              nodes: [{ body: "<!-- harness-factory:triage:run-1 -->\nAlready posted." }],
            }),
          },
        ],
      }),
      createComment: async (input) => {
        comments.push(input);
        return { success: true };
      },
    }),
    settings: LINEAR_SETTINGS,
  });

  await adapter.applyTriageCompleted({
    issueRef: "ENG-123",
    runId: "run-1",
    runDir: ".harness/runs/factory/run-1",
    triage: TRIAGE_READY_TO_PLAN,
  });

  expect(comments).toEqual([]);
});

test("Linear adapter applies failed triage status and comment", async () => {
  const updates: Array<{ id: string; input: { stateId: string } }> = [];
  const comments: Array<{ issueId: string; body: string }> = [];
  const adapter = createLinearFactoryAdapterForClient({
    client: fakeClient({
      issues: async () => ({
        nodes: [
          {
            ...ISSUE,
            state: Promise.resolve({ id: "state-Triaging", name: "Triaging", type: "started" }),
          },
        ],
      }),
      updateIssue: async (id, input) => {
        updates.push({ id, input });
        return { success: true };
      },
      createComment: async (input) => {
        comments.push(input);
        return { success: true };
      },
    }),
    settings: LINEAR_SETTINGS,
  });

  const result = await adapter.applyTriageFailed({
    issueRef: "ENG-123",
    runId: "run-1",
    runDir: ".harness/runs/factory/run-1",
    error: "agent timeout",
  });

  expect(updates).toEqual([{ id: "issue-1", input: { stateId: "state-Triage Failed" } }]);
  expect(comments[0].body).toContain("Error: agent timeout");
  expect(result).toMatchObject({
    stage: "failed",
    fromStatus: "Triaging",
    targetStatus: "Triage Failed",
    commentMarker: "<!-- harness-factory:triage-failed:run-1 -->",
  });
});
