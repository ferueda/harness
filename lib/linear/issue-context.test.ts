import { describe, expect, it, vi } from "vitest";
import {
  createLinear,
  createLinearForClient,
  LinearError,
  type LinearClientLike,
  type LinearReadLimits,
} from "./client.ts";

const DEFAULT_LIMITS: LinearReadLimits = {
  comments: 10,
  labels: 10,
  relations: 10,
  attachments: 10,
  children: 10,
};

const READY_STATE = { id: "state-ready", name: "Ready for Agent", type: "unstarted" };
const BLOCKED_STATE = { id: "state-blocked", name: "Blocked", type: "backlog" };
const TEAM = { id: "team-fer", key: "FER", name: "Harness" };
const PROJECT = { id: "project-harness", name: "Harness", url: "https://linear.app/p/harness" };
const ASSIGNEE = { id: "user-a", name: "Ada", displayName: "Ada Lovelace" };
const CREATOR = { id: "user-c", name: "Grace", displayName: "Grace Hopper" };
const COMMENTER = { id: "user-comment", name: "Lin", displayName: "Lin Chen" };

type QueryVariables = {
  after?: string;
  first?: number;
  filter?: {
    id?: { eq?: string; in?: string[] };
    team?: { id?: { eq?: string }; key?: { eq?: string } };
    project?: { id?: { eq?: string } };
    state?: { id?: { eq?: string } };
    number?: { eq?: number };
  };
};

type TestPage<T> = {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor?: string };
};

function page<T>(
  nodes: T[],
  pageInfo: { hasNextPage?: boolean; endCursor?: string } = {},
): TestPage<T> {
  return {
    nodes,
    pageInfo: {
      hasNextPage: pageInfo.hasNextPage ?? false,
      ...(pageInfo.endCursor ? { endCursor: pageInfo.endCursor } : {}),
    },
  };
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-root",
    identifier: "FER-213",
    title: "Build a Linear reader",
    description: "Read complete triage context.",
    url: "https://linear.app/issue/FER-213",
    stateId: READY_STATE.id,
    teamId: TEAM.id,
    projectId: PROJECT.id,
    assigneeId: ASSIGNEE.id,
    creatorId: CREATOR.id,
    parentId: null,
    createdAt: new Date("2026-07-18T10:00:00.000Z"),
    updatedAt: "2026-07-18T11:00:00.000Z",
    state: Promise.resolve(READY_STATE),
    team: Promise.resolve(TEAM),
    project: Promise.resolve(PROJECT),
    comments: async () => page([]),
    labels: async () => page([]),
    relations: async () => page([]),
    inverseRelations: async () => page([]),
    attachments: async () => page([]),
    children: async () => page([]),
    ...overrides,
  };
}

function makeReference(id: string, identifier: string, stateId = READY_STATE.id) {
  return makeIssue({
    id,
    identifier,
    title: `Issue ${identifier}`,
    url: `https://linear.app/issue/${identifier}`,
    stateId,
    projectId: null,
    assigneeId: null,
    creatorId: null,
    project: undefined,
  });
}

function expectedReference(
  id: string,
  identifier: string,
  state: typeof READY_STATE | typeof BLOCKED_STATE = READY_STATE,
) {
  return {
    id,
    identifier,
    title: `Issue ${identifier}`,
    url: `https://linear.app/issue/${identifier}`,
    state,
  };
}

type TestIssue = ReturnType<typeof makeIssue>;
type TestUser = { id: string; name: string; displayName: string };
type TestState = { id: string; name: string; type: string };
type TestComment = {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
};
type TestLabel = { id: string; name: string };
type TestRelation = {
  id: string;
  type: string;
  issueId?: string;
  relatedIssueId?: string;
};
type TestAttachment = {
  id: string;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
};

function makeFakeClient(input: {
  roots?: TestIssue[];
  issues?: TestIssue[];
  users?: TestUser[];
  states?: TestState[];
  issueFailure?: unknown;
  lookupResult?: unknown;
}) {
  const roots = input.roots ?? [];
  const issueReads = vi.fn<(variables?: unknown) => Promise<TestPage<TestIssue>>>(
    async (variables?: unknown) => {
      if (input.issueFailure) throw input.issueFailure;
      const query = variables as QueryVariables;
      const ids = query.filter?.id?.in;
      if (ids) return page((input.issues ?? []).filter((issue) => ids.includes(issue.id)));
      if (input.lookupResult !== undefined) {
        return input.lookupResult as TestPage<TestIssue>;
      }
      const opaqueId = query.filter?.id?.eq;
      if (opaqueId) return page(roots.filter((issue) => issue.id === opaqueId));
      const teamKey = query.filter?.team?.key?.eq;
      const number = query.filter?.number?.eq;
      return page(
        roots.filter((issue) => {
          const match = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(issue.identifier);
          return match?.[1].toUpperCase() === teamKey && Number(match?.[2]) === number;
        }),
      );
    },
  );
  const userReads = vi.fn<(variables?: unknown) => Promise<TestPage<TestUser>>>(
    async (variables?: unknown) => {
      const ids = (variables as QueryVariables).filter?.id?.in ?? [];
      return page((input.users ?? [ASSIGNEE, CREATOR]).filter((user) => ids.includes(user.id)));
    },
  );
  const stateReads = vi.fn<(variables?: unknown) => Promise<TestPage<TestState>>>(
    async (variables?: unknown) => {
      const ids = (variables as QueryVariables).filter?.id?.in ?? [];
      return page((input.states ?? []).filter((state) => ids.includes(state.id)));
    },
  );
  return {
    client: {
      issues: issueReads,
      users: userReads,
      workflowStates: stateReads,
      createComment: async () => ({ success: true, comment: { id: "unused-comment" } }),
      updateIssue: async () => ({ success: true, issue: { id: "unused-issue" } }),
      createIssueRelation: async () => ({
        success: true,
        issueRelation: { id: "unused-relation" },
      }),
    } as unknown as LinearClientLike,
    issueReads,
    userReads,
    stateReads,
  };
}

function service(client: LinearClientLike, limits: LinearReadLimits = DEFAULT_LIMITS) {
  return createLinearForClient({ client, limits });
}

describe("standalone Linear issue context", () => {
  it("normalizes rich context, relation direction, actors, ordering, and safe attachments", async () => {
    const parent = makeReference("issue-parent", "FER-100");
    const duplicate = makeReference("issue-duplicate", "FER-101");
    const blocker = makeReference("issue-blocker", "FER-99", BLOCKED_STATE.id);
    const relatedA = makeReference("issue-related-a", "FER-201");
    const relatedB = makeReference("issue-related-b", "FER-200");
    const childB = makeReference("issue-child-b", "FER-302");
    const childA = makeReference("issue-child-a", "FER-301", BLOCKED_STATE.id);
    const childATie = makeReference("issue-child-a-tie", "FER-301");
    const root = makeIssue({
      parentId: parent.id,
      comments: async () =>
        page([
          {
            id: "comment-z",
            body: "No actor",
            createdAt: "2026-07-18T10:04:00Z",
            updatedAt: "2026-07-18T10:04:00Z",
          },
          {
            id: "comment-user-b",
            body: "User note B",
            userId: COMMENTER.id,
            parentId: "comment-parent",
            quotedText: "quoted",
            createdAt: "2026-07-18T10:01:00Z",
            updatedAt: "2026-07-18T10:02:00Z",
          },
          {
            id: "comment-user-a",
            body: "User note A",
            userId: COMMENTER.id,
            createdAt: "2026-07-18T10:01:00Z",
            updatedAt: "2026-07-18T10:01:00Z",
          },
          {
            id: "comment-bot",
            body: "Bot note",
            botActor: { id: "bot-1", name: "Triage bot" },
            createdAt: "2026-07-18T10:03:00Z",
            updatedAt: "2026-07-18T10:03:00Z",
          },
          {
            id: "comment-external",
            body: "External note",
            externalUserId: "external-1",
            createdAt: "2026-07-18T10:02:00Z",
            updatedAt: "2026-07-18T10:02:00Z",
          },
        ]),
      labels: async () =>
        page([
          { id: "label-z", name: "bug" },
          { id: "label-agent-b", name: "agent" },
          { id: "label-agent-a", name: "agent" },
        ]),
      relations: async () =>
        page([
          { id: "r-duplicate", type: "duplicate", relatedIssueId: duplicate.id },
          { id: "r-related-b", type: "related", relatedIssueId: relatedB.id },
          { id: "r-blocks", type: "blocks", relatedIssueId: "issue-ignored" },
        ]),
      inverseRelations: async () =>
        page([
          { id: "r-blocker", type: "blocks", issueId: blocker.id },
          { id: "r-related-a", type: "related", issueId: relatedA.id },
          { id: "r-related-b-again", type: "related", issueId: relatedB.id },
          { id: "r-incoming-duplicate", type: "duplicate", issueId: "issue-ignored" },
        ]),
      children: async () => page([childB, childATie, childA, childA]),
      attachments: async () =>
        page([
          {
            id: "attachment-b",
            title: "Pull request",
            subtitle: null,
            url: "https://github.com/example/repo/pull/2",
            sourceType: "github",
            createdAt: "2026-07-18T10:01:00Z",
            updatedAt: "2026-07-18T10:03:00Z",
            metadata: { secret: true },
            bodyData: { content: "not public" },
          },
          {
            id: "attachment-a",
            title: "Design",
            url: "https://example.com/design",
            createdAt: "2026-07-18T10:01:00Z",
            updatedAt: "2026-07-18T10:01:00Z",
            source: { private: true },
          },
        ]),
    });
    const fake = makeFakeClient({
      roots: [root],
      issues: [parent, duplicate, blocker, relatedA, relatedB],
      users: [ASSIGNEE, CREATOR, COMMENTER],
      states: [BLOCKED_STATE],
    });

    const result = await service(fake.client).getIssueContext("fer-213");

    expect(result).toEqual({
      id: "issue-root",
      identifier: "FER-213",
      title: "Build a Linear reader",
      description: "Read complete triage context.",
      url: "https://linear.app/issue/FER-213",
      state: READY_STATE,
      team: TEAM,
      project: PROJECT,
      assignee: ASSIGNEE,
      creator: CREATOR,
      labels: [
        { id: "label-agent-a", name: "agent" },
        { id: "label-agent-b", name: "agent" },
        { id: "label-z", name: "bug" },
      ],
      comments: [
        {
          id: "comment-user-a",
          body: "User note A",
          author: { kind: "user", ...COMMENTER },
          parentId: null,
          quotedText: null,
          createdAt: "2026-07-18T10:01:00.000Z",
          updatedAt: "2026-07-18T10:01:00.000Z",
        },
        {
          id: "comment-user-b",
          body: "User note B",
          author: { kind: "user", ...COMMENTER },
          parentId: "comment-parent",
          quotedText: "quoted",
          createdAt: "2026-07-18T10:01:00.000Z",
          updatedAt: "2026-07-18T10:02:00.000Z",
        },
        {
          id: "comment-external",
          body: "External note",
          author: { kind: "external", id: "external-1", name: null },
          parentId: null,
          quotedText: null,
          createdAt: "2026-07-18T10:02:00.000Z",
          updatedAt: "2026-07-18T10:02:00.000Z",
        },
        {
          id: "comment-bot",
          body: "Bot note",
          author: { kind: "bot", id: "bot-1", name: "Triage bot" },
          parentId: null,
          quotedText: null,
          createdAt: "2026-07-18T10:03:00.000Z",
          updatedAt: "2026-07-18T10:03:00.000Z",
        },
        {
          id: "comment-z",
          body: "No actor",
          author: null,
          parentId: null,
          quotedText: null,
          createdAt: "2026-07-18T10:04:00.000Z",
          updatedAt: "2026-07-18T10:04:00.000Z",
        },
      ],
      parent: expectedReference(parent.id, "FER-100"),
      children: [
        expectedReference(childA.id, "FER-301", BLOCKED_STATE),
        expectedReference(childATie.id, "FER-301"),
        expectedReference(childB.id, "FER-302"),
      ],
      duplicateOf: expectedReference(duplicate.id, "FER-101"),
      blockedBy: [expectedReference(blocker.id, "FER-99", BLOCKED_STATE)],
      related: [
        expectedReference(relatedB.id, "FER-200"),
        expectedReference(relatedA.id, "FER-201"),
      ],
      attachments: [
        {
          id: "attachment-a",
          title: "Design",
          subtitle: null,
          url: "https://example.com/design",
          sourceType: null,
          createdAt: "2026-07-18T10:01:00.000Z",
          updatedAt: "2026-07-18T10:01:00.000Z",
        },
        {
          id: "attachment-b",
          title: "Pull request",
          subtitle: null,
          url: "https://github.com/example/repo/pull/2",
          sourceType: "github",
          createdAt: "2026-07-18T10:01:00.000Z",
          updatedAt: "2026-07-18T10:03:00.000Z",
        },
      ],
      createdAt: "2026-07-18T10:00:00.000Z",
      updatedAt: "2026-07-18T11:00:00.000Z",
      completeness: {
        commentsTruncated: false,
        labelsTruncated: false,
        relationsTruncated: false,
        attachmentsTruncated: false,
        childrenTruncated: false,
      },
    });
    expect(Object.keys(result.attachments[0])).toEqual([
      "id",
      "title",
      "subtitle",
      "url",
      "sourceType",
      "createdAt",
      "updatedAt",
    ]);
    expect(fake.userReads).toHaveBeenCalledTimes(1);
    expect(fake.stateReads).toHaveBeenCalledTimes(1);
    expect(fake.issueReads).toHaveBeenCalledTimes(2);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("supports opaque IDs and keeps absent values and nullable bot identity explicit", async () => {
    const root = makeIssue({
      description: undefined,
      projectId: null,
      assigneeId: null,
      creatorId: null,
      project: undefined,
      comments: async () =>
        page([
          {
            id: "comment-bot",
            body: "Bot without identity",
            botActor: {},
            createdAt: "2026-07-18T10:00:00Z",
            updatedAt: "2026-07-18T10:00:00Z",
          },
        ]),
    });
    const fake = makeFakeClient({ roots: [root] });

    const result = await service(fake.client).getIssueContext("issue-root");

    expect(result.description).toBeNull();
    expect(result.project).toBeNull();
    expect(result.assignee).toBeNull();
    expect(result.creator).toBeNull();
    expect(result.parent).toBeNull();
    expect(result.comments[0].author).toEqual({ kind: "bot", id: null, name: null });
    expect(fake.issueReads).toHaveBeenNthCalledWith(1, {
      filter: { id: { eq: "issue-root" } },
      first: 2,
    });
  });

  it("paginates with cursors and conservatively marks exact-limit collections truncated", async () => {
    const commentReads = vi.fn<
      (variables: QueryVariables) => Promise<TestPage<Record<string, unknown>>>
    >(async (variables: QueryVariables) => {
      if (!variables.after) {
        return page(
          [
            {
              id: "comment-2",
              body: "Second",
              createdAt: "2026-07-18T10:02:00Z",
              updatedAt: "2026-07-18T10:02:00Z",
            },
            {
              id: "comment-1",
              body: "First",
              createdAt: "2026-07-18T10:01:00Z",
              updatedAt: "2026-07-18T10:01:00Z",
            },
          ],
          { hasNextPage: true, endCursor: "cursor-1" },
        );
      }
      return page([
        {
          id: "comment-3",
          body: "Third",
          createdAt: "2026-07-18T10:03:00Z",
          updatedAt: "2026-07-18T10:03:00Z",
        },
      ]);
    });
    const root = makeIssue({ comments: commentReads });
    const fake = makeFakeClient({ roots: [root] });

    const result = await service(fake.client, {
      ...DEFAULT_LIMITS,
      comments: 3,
    }).getIssueContext("FER-213");

    expect(result.comments.map((comment) => comment.id)).toEqual([
      "comment-1",
      "comment-2",
      "comment-3",
    ]);
    expect(result.completeness.commentsTruncated).toBe(true);
    expect(commentReads).toHaveBeenNthCalledWith(1, { first: 3 });
    expect(commentReads).toHaveBeenNthCalledWith(2, { first: 1, after: "cursor-1" });
  });

  it("wires every collection limit to its matching completeness flag", async () => {
    const child = makeReference("issue-child", "FER-300");
    const commentReads = vi.fn<(variables: QueryVariables) => Promise<TestPage<TestComment>>>(
      async () =>
        page([
          {
            id: "comment-1",
            body: "One",
            createdAt: "2026-07-18T10:00:00Z",
            updatedAt: "2026-07-18T10:00:00Z",
          },
        ]),
    );
    const labelReads = vi.fn<(variables: QueryVariables) => Promise<TestPage<TestLabel>>>(
      async () => page([{ id: "label-1", name: "one" }]),
    );
    const outgoingReads = vi.fn<(variables: QueryVariables) => Promise<TestPage<TestRelation>>>(
      async () => page([{ id: "relation-out", type: "blocks", relatedIssueId: "ignored" }]),
    );
    const inverseReads = vi.fn<(variables: QueryVariables) => Promise<TestPage<TestRelation>>>(
      async () => page([{ id: "relation-in", type: "duplicate", issueId: "ignored" }]),
    );
    const attachmentReads = vi.fn<(variables: QueryVariables) => Promise<TestPage<TestAttachment>>>(
      async () =>
        page([
          {
            id: "attachment-1",
            title: "One",
            url: "https://example.com/one",
            createdAt: "2026-07-18T10:00:00Z",
            updatedAt: "2026-07-18T10:00:00Z",
          },
        ]),
    );
    const childReads = vi.fn<(variables: QueryVariables) => Promise<TestPage<TestIssue>>>(
      async () => page([child]),
    );
    const root = makeIssue({
      comments: commentReads,
      labels: labelReads,
      relations: outgoingReads,
      inverseRelations: inverseReads,
      attachments: attachmentReads,
      children: childReads,
    });
    const fake = makeFakeClient({ roots: [root] });

    const result = await service(fake.client, {
      comments: 1,
      labels: 1,
      relations: 1,
      attachments: 1,
      children: 1,
    }).getIssueContext("FER-213");

    expect(result.completeness).toEqual({
      commentsTruncated: true,
      labelsTruncated: true,
      relationsTruncated: true,
      attachmentsTruncated: true,
      childrenTruncated: true,
    });
    for (const read of [
      commentReads,
      labelReads,
      outgoingReads,
      inverseReads,
      attachmentReads,
      childReads,
    ]) {
      expect(read).toHaveBeenCalledWith({ first: 1 });
    }
  });

  it("rejects multiple outgoing duplicate targets", async () => {
    const root = makeIssue({
      relations: async () =>
        page([
          { id: "duplicate-a", type: "duplicate", relatedIssueId: "issue-a" },
          { id: "duplicate-b", type: "duplicate", relatedIssueId: "issue-b" },
        ]),
    });
    const fake = makeFakeClient({ roots: [root] });

    await expect(service(fake.client).getIssueContext("FER-213")).rejects.toMatchObject({
      code: "invalid-response",
    });
  });

  it.each([
    { key: "comments", value: 0 },
    { key: "labels", value: 1.5 },
    { key: "relations", value: -1 },
    { key: "attachments", value: Number.NaN },
    { key: "children", value: 0 },
  ])("rejects invalid $key limits", ({ key, value }) => {
    const limits = { ...DEFAULT_LIMITS, [key]: value };
    const fake = makeFakeClient({});
    expect(() => service(fake.client, limits)).toThrowError(
      expect.objectContaining({ code: "invalid-config" }),
    );
  });

  it("rejects an empty API key and issue reference", async () => {
    expect(() => createLinear({ apiKey: " ", limits: DEFAULT_LIMITS })).toThrowError(
      expect.objectContaining({ code: "invalid-config" }),
    );
    const fake = makeFakeClient({});
    await expect(service(fake.client).getIssueContext(" ")).rejects.toMatchObject({
      code: "invalid-reference",
    });
  });

  it("normalizes exact lookup failures", async () => {
    const missing = makeFakeClient({ roots: [] });
    await expect(service(missing.client).getIssueContext("FER-404")).rejects.toMatchObject({
      code: "not-found",
    });

    const first = makeIssue();
    const second = makeIssue({ id: "issue-other" });
    const ambiguous = makeFakeClient({ roots: [first, second] });
    await expect(service(ambiguous.client).getIssueContext("FER-213")).rejects.toMatchObject({
      code: "ambiguous-reference",
    });
  });

  it("classifies malformed lookup pages and candidates as invalid responses", async () => {
    const malformedPage = makeFakeClient({
      lookupResult: { pageInfo: { hasNextPage: false } },
    });
    await expect(service(malformedPage.client).getIssueContext("FER-213")).rejects.toMatchObject({
      code: "invalid-response",
    });

    const malformedCandidate = makeFakeClient({ roots: [makeIssue({ id: undefined })] });
    await expect(
      service(malformedCandidate.client).getIssueContext("FER-213"),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("preserves upstream causes", async () => {
    const cause = new Error("network unavailable");
    const fake = makeFakeClient({ issueFailure: cause });

    const error = await service(fake.client)
      .getIssueContext("FER-213")
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(LinearError);
    expect(error).toMatchObject({ code: "upstream", cause });
  });

  it.each([
    ["state", undefined],
    ["team", undefined],
  ])("rejects a missing required %s relation", async (key, value) => {
    const root = makeIssue({ [key]: value });
    const fake = makeFakeClient({ roots: [root] });

    await expect(service(fake.client).getIssueContext("FER-213")).rejects.toMatchObject({
      code: "invalid-response",
    });
  });
});
