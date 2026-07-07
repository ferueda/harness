import { expect, test } from "vitest";
import type { FactoryLinearSettings } from "../lib/config.ts";
import {
  createLinearFactoryAdapterForClient,
  parseLinearIssueIdentifier,
  type LinearClientLike,
} from "../lib/factory-linear-adapter.ts";

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

const ISSUE = {
  id: "issue-1",
  identifier: "ENG-123",
  number: 123,
  title: "Add export shortcut",
  description: "Users need a keyboard shortcut for export.",
  url: "https://linear.app/acme/issue/ENG-123/add-export-shortcut",
  priority: 2,
  priorityLabel: "High",
  createdAt: new Date("2026-07-07T10:00:00Z"),
  updatedAt: new Date("2026-07-07T11:00:00Z"),
  state: Promise.resolve({ id: "state-planning", name: "Needs Plan", type: "unstarted" }),
  team: Promise.resolve(TEAM),
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
    ...overrides,
  };
}

test("parseLinearIssueIdentifier accepts human issue ids", () => {
  expect(parseLinearIssueIdentifier("eng-123")).toEqual({ teamKey: "ENG", number: 123 });
  expect(parseLinearIssueIdentifier("not-a-linear-id")).toBeNull();
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
