import { expect, test } from "vitest";
import type { FactoryLinearSettings } from "../lib/config.ts";
import {
  assertLinearTriageApplyAllowed,
  createLinearFactoryAdapterForClient,
  linearTriageTargetStatus,
  parseLinearIssueIdentifier,
  renderLinearPlanningApprovedComment,
  renderLinearPlanningReadyComment,
  renderLinearTriageCompleteComment,
  type LinearClientLike,
} from "../lib/factory-linear-adapter.ts";
import type { FactoryRoute, FactoryTriageOutput } from "../lib/factory-schemas.ts";

const LINEAR_SETTINGS = {
  teamKey: "ENG",
  statuses: {
    intake: "Backlog",
    parked: "Parked",
    needsInfo: "Needs Info",
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

test("Linear triage helpers map routes and render concise comments", () => {
  expect(linearTriageTargetStatus(LINEAR_SETTINGS, "ready-to-implement")).toBe(
    "Ready to Implement",
  );
  expect(linearTriageTargetStatus(LINEAR_SETTINGS, "ready-to-plan")).toBe("Needs Plan");
  expect(linearTriageTargetStatus(LINEAR_SETTINGS, "needs-info")).toBe("Needs Info");
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
      /only accepts Backlog, Needs Info, or Triage Failed/,
    );
  }

  expect(
    renderLinearTriageCompleteComment({
      runId: "run-1",
      runDir: ".harness/runs/factory/run-1",
      route: "needs-info",
      targetStatus: "Needs Info",
      questions: ["Which provider should own this?"],
    }),
  ).toContain("<!-- harness-factory:triage:run-1 -->");
});

test("Linear adapter fetches an issue as a factory work item", async () => {
  const queries: unknown[] = [];
  const client = fakeClient({
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

test("Linear adapter enforces the configured project during fetch", async () => {
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

test("Linear adapter keeps omitted projectId backward compatible", async () => {
  const adapter = createLinearFactoryAdapterForClient({
    client: fakeClient({
      issues: async () => ({
        nodes: [
          {
            ...ISSUE,
            projectId: "project-2",
            project: Promise.resolve({ id: "project-2", name: "Other Repo" }),
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

test("Linear adapter rejects issues outside the configured project", async () => {
  const otherProject = {
    id: "project-2",
    name: "Other Repo",
    url: "https://linear.app/acme/project/other-456",
  };
  const adapter = createLinearFactoryAdapterForClient({
    client: fakeClient({
      issues: async () => ({
        nodes: [
          {
            ...ISSUE,
            projectId: otherProject.id,
            project: Promise.resolve(otherProject),
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
        projectId: "project-2",
        project: Promise.resolve({ id: "project-2", name: "Other Repo" }),
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
    /missing configured statuses: Parked, Needs Info/,
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
    /missing configured statuses: Parked, Needs Info/,
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
  for (const statusName of ["Backlog", "Needs Info", "Triage Failed"]) {
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
  ).rejects.toThrow(/only accepts Backlog, Needs Info, or Triage Failed/);
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
            projectId: "project-2",
            project: Promise.resolve({ id: "project-2", name: "Other Repo" }),
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
              projectId: "project-2",
              project: Promise.resolve({ id: "project-2", name: "Other Repo" }),
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
    triage: TRIAGE_READY_TO_PLAN,
  });

  expect(updates).toEqual([{ id: "issue-1", input: { stateId: "state-Needs Plan" } }]);
  expect(comments).toHaveLength(1);
  expect(comments[0].body).toContain("Route: ready-to-plan");
  expect(result).toMatchObject({
    stage: "complete",
    fromStatus: "Triaging",
    targetStatus: "Needs Plan",
    commentMarker: "<!-- harness-factory:triage:run-1 -->",
  });
});

test.each([
  {
    route: "ready-to-implement" as const,
    targetStatus: "Ready to Implement",
    expectedBody: "Route: ready-to-implement",
  },
  {
    route: "needs-info" as const,
    targetStatus: "Needs Info",
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
