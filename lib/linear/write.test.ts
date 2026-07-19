import { describe, expect, it, vi } from "vitest";
import {
  createLinearForClient,
  LinearError,
  type LinearClientLike,
  type LinearReadLimits,
} from "./client.ts";

const DEFAULT_LIMITS: LinearReadLimits = {
  comments: 4,
  labels: 4,
  relations: 4,
  attachments: 4,
  children: 4,
};

type TestPage<T> = {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor?: string };
};

type PageInput = { first: number; after?: string };
type TestComment = { id: string; body: string };
type TestRelation = {
  id: string;
  type: string;
  issueId?: string;
  relatedIssueId?: string;
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

function paged<T>(pages: T[][]) {
  return vi.fn(async (input: PageInput): Promise<TestPage<T>> => {
    const index = input.after ? Number(input.after.replace("cursor-", "")) : 0;
    const hasNextPage = index + 1 < pages.length;
    return page(pages[index] ?? [], {
      hasNextPage,
      ...(hasNextPage ? { endCursor: `cursor-${index + 1}` } : {}),
    });
  });
}

function makeFake(
  input: {
    stateId?: string;
    comments?: TestComment[][];
    relations?: TestRelation[][];
    inverseRelations?: TestRelation[][];
    workflowStates?: Array<{ id: string; name: string; type: string }>;
  } = {},
) {
  const commentReads = paged(input.comments ?? [[]]);
  const relationReads = paged(input.relations ?? [[]]);
  const inverseRelationReads = paged(input.inverseRelations ?? [[]]);
  const issue = {
    id: "issue-1",
    stateId: input.stateId ?? "state-backlog",
    comments: commentReads,
    relations: relationReads,
    inverseRelations: inverseRelationReads,
  };
  const issueReads = vi.fn(async () => page([issue]));
  const stateReads = vi.fn(async () => page(input.workflowStates ?? []));
  const createComment = vi.fn<LinearClientLike["createComment"]>(async () => ({
    success: true,
    comment: { id: "comment-created" },
  }));
  const updateIssue = vi.fn<LinearClientLike["updateIssue"]>(async () => ({
    success: true,
    issue: { id: "issue-1" },
  }));
  const createIssueRelation = vi.fn<LinearClientLike["createIssueRelation"]>(async () => ({
    success: true,
    issueRelation: { id: "relation-created" },
  }));
  const client = {
    issues: issueReads,
    users: async () => page([]),
    workflowStates: stateReads,
    createComment,
    updateIssue,
    createIssueRelation,
  } as unknown as LinearClientLike;

  return {
    client,
    commentReads,
    relationReads,
    inverseRelationReads,
    issueReads,
    stateReads,
    createComment,
    updateIssue,
    createIssueRelation,
  };
}

function service(fake: ReturnType<typeof makeFake>, limits = DEFAULT_LIMITS) {
  return createLinearForClient({ client: fake.client, limits });
}

describe("standalone Linear reads for safe writes", () => {
  it("finds a marker on a later page and returns null after complete absence", async () => {
    const marker = "<!-- triage:delivery-1 -->";
    const fake = makeFake({
      comments: [
        [{ id: "comment-1", body: "Older comment" }],
        [{ id: "comment-2", body: `Decision\n${marker}` }],
      ],
    });
    const linear = service(fake);

    await expect(linear.findCommentMarker({ issueId: "issue-1", marker })).resolves.toBe(
      "comment-2",
    );
    expect(fake.commentReads).toHaveBeenNthCalledWith(2, { first: 3, after: "cursor-1" });

    fake.commentReads.mockImplementation(async () => page([]));
    await expect(linear.findCommentMarker({ issueId: "issue-1", marker })).resolves.toBeNull();
  });

  it("fails an incomplete absent-marker scan", async () => {
    const fake = makeFake({ comments: [[{ id: "comment-1", body: "Unrelated" }]] });
    const linear = service(fake, { ...DEFAULT_LIMITS, comments: 1 });

    await expect(
      linear.findCommentMarker({ issueId: "issue-1", marker: "<!-- missing -->" }),
    ).rejects.toMatchObject({ code: "incomplete" });
  });

  it("finds an exact workflow state for one team", async () => {
    const ready = { id: "state-ready", name: "Ready for Agent", type: "unstarted" };
    const fake = makeFake({ workflowStates: [ready] });

    await expect(
      service(fake).findWorkflowState({ teamId: "team-1", name: ready.name }),
    ).resolves.toEqual(ready);
    expect(fake.stateReads).toHaveBeenCalledWith({
      filter: {
        team: { id: { eq: "team-1" } },
        name: { eq: ready.name },
      },
      first: 2,
    });
  });

  it("classifies missing and ambiguous workflow states", async () => {
    const missing = makeFake();
    await expect(
      service(missing).findWorkflowState({ teamId: "team-1", name: "Missing" }),
    ).rejects.toMatchObject({ code: "not-found" });

    const ambiguous = makeFake({
      workflowStates: [
        { id: "state-a", name: "Ready", type: "unstarted" },
        { id: "state-b", name: "Ready", type: "unstarted" },
      ],
    });
    await expect(
      service(ambiguous).findWorkflowState({ teamId: "team-1", name: "Ready" }),
    ).rejects.toMatchObject({ code: "ambiguous-reference" });
  });
});

describe("standalone Linear comment mutations", () => {
  it("returns a plain comment ID", async () => {
    const fake = makeFake();

    const result = await service(fake).createComment({
      issueId: "issue-1",
      body: "Triage result",
    });

    expect(result).toEqual({ id: "comment-created" });
    expect(fake.createComment).toHaveBeenCalledWith({
      issueId: "issue-1",
      body: "Triage result",
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("creates once and converges on a repeated serialized projection", async () => {
    const marker = "<!-- triage:delivery-1 -->";
    const body = `${marker}\n\nReady for Agent`;
    const fake = makeFake();
    fake.commentReads
      .mockResolvedValueOnce(page([]))
      .mockResolvedValueOnce(page([{ id: "comment-created", body }]));
    const linear = service(fake);

    await expect(linear.ensureComment({ issueId: "issue-1", marker, body })).resolves.toEqual({
      created: true,
      id: "comment-created",
    });
    await expect(linear.ensureComment({ issueId: "issue-1", marker, body })).resolves.toEqual({
      created: false,
      id: "comment-created",
    });
    expect(fake.createComment).toHaveBeenCalledTimes(1);
  });

  it("does not write after invalid or incomplete marker input", async () => {
    const fake = makeFake({ comments: [[{ id: "comment-1", body: "Unrelated" }]] });
    const linear = service(fake, { ...DEFAULT_LIMITS, comments: 1 });

    await expect(
      linear.ensureComment({
        issueId: "issue-1",
        marker: "<!-- missing -->",
        body: "Body without marker",
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    await expect(
      linear.ensureComment({
        issueId: "issue-1",
        marker: "<!-- missing -->",
        body: "<!-- missing -->",
      }),
    ).rejects.toMatchObject({ code: "incomplete" });
    expect(fake.createComment).not.toHaveBeenCalled();
  });

  it("does not write after malformed comment pagination metadata", async () => {
    const fake = makeFake();
    fake.commentReads.mockResolvedValueOnce({
      nodes: [],
      pageInfo: {},
    } as unknown as TestPage<TestComment>);

    await expect(
      service(fake).ensureComment({
        issueId: "issue-1",
        marker: "<!-- triage:delivery-1 -->",
        body: "<!-- triage:delivery-1 -->",
      }),
    ).rejects.toMatchObject({ code: "invalid-response" });
    expect(fake.createComment).not.toHaveBeenCalled();
  });

  it("normalizes comment rejection and malformed success", async () => {
    const rejected = makeFake();
    rejected.createComment.mockResolvedValueOnce({ success: false, comment: undefined });
    await expect(
      service(rejected).createComment({ issueId: "issue-1", body: "Comment" }),
    ).rejects.toMatchObject({ code: "rejected" });

    const malformed = makeFake();
    malformed.createComment.mockResolvedValueOnce({ success: true, comment: undefined });
    await expect(
      service(malformed).createComment({ issueId: "issue-1", body: "Comment" }),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("preserves the cause of comment SDK failures", async () => {
    const cause = new Error("network unavailable");
    const fake = makeFake();
    fake.createComment.mockRejectedValueOnce(cause);

    const error = await service(fake)
      .createComment({ issueId: "issue-1", body: "Comment" })
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(LinearError);
    expect(error).toMatchObject({ code: "upstream", cause });
  });
});

describe("standalone Linear state mutations", () => {
  it("updates only the expected state and returns the target", async () => {
    const fake = makeFake({ stateId: "state-backlog" });

    await expect(
      service(fake).updateIssueState({
        issueId: "issue-1",
        expectedStateId: "state-backlog",
        stateId: "state-ready",
      }),
    ).resolves.toEqual({ changed: true, stateId: "state-ready" });
    expect(fake.updateIssue).toHaveBeenCalledWith("issue-1", { stateId: "state-ready" });
  });

  it("does not mutate an already-target or conflicting state", async () => {
    const alreadyTarget = makeFake({ stateId: "state-ready" });
    await expect(
      service(alreadyTarget).updateIssueState({
        issueId: "issue-1",
        expectedStateId: "state-backlog",
        stateId: "state-ready",
      }),
    ).resolves.toEqual({ changed: false, stateId: "state-ready" });
    expect(alreadyTarget.updateIssue).not.toHaveBeenCalled();

    const conflict = makeFake({ stateId: "state-human" });
    await expect(
      service(conflict).updateIssueState({
        issueId: "issue-1",
        expectedStateId: "state-backlog",
        stateId: "state-ready",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(conflict.updateIssue).not.toHaveBeenCalled();
  });

  it("normalizes state rejection and malformed success without claiming a change", async () => {
    const rejected = makeFake();
    rejected.updateIssue.mockResolvedValueOnce({ success: false, issue: undefined });
    await expect(
      service(rejected).updateIssueState({
        issueId: "issue-1",
        expectedStateId: "state-backlog",
        stateId: "state-ready",
      }),
    ).rejects.toMatchObject({ code: "rejected" });

    const malformed = makeFake();
    malformed.updateIssue.mockResolvedValueOnce({ success: true, issue: undefined });
    await expect(
      service(malformed).updateIssueState({
        issueId: "issue-1",
        expectedStateId: "state-backlog",
        stateId: "state-ready",
      }),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("preserves the cause of state SDK failures", async () => {
    const cause = new Error("state mutation unavailable");
    const fake = makeFake();
    fake.updateIssue.mockRejectedValueOnce(cause);

    const error = await service(fake)
      .updateIssueState({
        issueId: "issue-1",
        expectedStateId: "state-backlog",
        stateId: "state-ready",
      })
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(LinearError);
    expect(error).toMatchObject({ code: "upstream", cause });
  });
});

describe("standalone Linear relation mutations", () => {
  it("creates duplicate and blocker relations in the correct direction", async () => {
    const duplicate = makeFake();
    await expect(
      service(duplicate).ensureDuplicateRelation({
        issueId: "issue-1",
        duplicateOfIssueId: "issue-canonical",
      }),
    ).resolves.toEqual({ created: true, id: "relation-created" });
    expect(duplicate.createIssueRelation).toHaveBeenCalledWith({
      issueId: "issue-1",
      relatedIssueId: "issue-canonical",
      type: "duplicate",
    });

    const blocker = makeFake();
    await expect(
      service(blocker).ensureBlockedByRelation({
        issueId: "issue-1",
        blockerIssueId: "issue-blocker",
      }),
    ).resolves.toEqual({ created: true, id: "relation-created" });
    expect(blocker.createIssueRelation).toHaveBeenCalledWith({
      issueId: "issue-blocker",
      relatedIssueId: "issue-1",
      type: "blocks",
    });
  });

  it("finds existing relations on later pages without mutation", async () => {
    const duplicate = makeFake({
      relations: [
        [{ id: "related", type: "related", relatedIssueId: "issue-other" }],
        [{ id: "duplicate", type: "duplicate", relatedIssueId: "issue-canonical" }],
      ],
    });
    await expect(
      service(duplicate).ensureDuplicateRelation({
        issueId: "issue-1",
        duplicateOfIssueId: "issue-canonical",
      }),
    ).resolves.toEqual({ created: false, id: "duplicate" });
    expect(duplicate.createIssueRelation).not.toHaveBeenCalled();

    const blocker = makeFake({
      inverseRelations: [
        [{ id: "blocker-a", type: "blocks", issueId: "issue-other" }],
        [{ id: "blocker-b", type: "blocks", issueId: "issue-blocker" }],
      ],
    });
    await expect(
      service(blocker).ensureBlockedByRelation({
        issueId: "issue-1",
        blockerIssueId: "issue-blocker",
      }),
    ).resolves.toEqual({ created: false, id: "blocker-b" });
    expect(blocker.createIssueRelation).not.toHaveBeenCalled();
  });

  it("preserves unrelated blockers but rejects a different duplicate target", async () => {
    const blockers = makeFake({
      inverseRelations: [[{ id: "blocker-a", type: "blocks", issueId: "issue-other" }]],
    });
    await expect(
      service(blockers).ensureBlockedByRelation({
        issueId: "issue-1",
        blockerIssueId: "issue-blocker",
      }),
    ).resolves.toEqual({ created: true, id: "relation-created" });

    const duplicate = makeFake({
      relations: [[{ id: "duplicate-a", type: "duplicate", relatedIssueId: "issue-other" }]],
    });
    await expect(
      service(duplicate).ensureDuplicateRelation({
        issueId: "issue-1",
        duplicateOfIssueId: "issue-canonical",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(duplicate.createIssueRelation).not.toHaveBeenCalled();
  });

  it("fails incomplete relation scans before mutation", async () => {
    const duplicate = makeFake({
      relations: [[{ id: "related", type: "related", relatedIssueId: "issue-other" }]],
    });
    await expect(
      service(duplicate, { ...DEFAULT_LIMITS, relations: 1 }).ensureDuplicateRelation({
        issueId: "issue-1",
        duplicateOfIssueId: "issue-canonical",
      }),
    ).rejects.toMatchObject({ code: "incomplete" });
    expect(duplicate.createIssueRelation).not.toHaveBeenCalled();

    const blocker = makeFake({
      inverseRelations: [[{ id: "blocker-a", type: "blocks", issueId: "issue-other" }]],
    });
    await expect(
      service(blocker, { ...DEFAULT_LIMITS, relations: 1 }).ensureBlockedByRelation({
        issueId: "issue-1",
        blockerIssueId: "issue-blocker",
      }),
    ).rejects.toMatchObject({ code: "incomplete" });
    expect(blocker.createIssueRelation).not.toHaveBeenCalled();
  });

  it("does not write after malformed relation pagination metadata", async () => {
    const fake = makeFake();
    fake.relationReads.mockResolvedValueOnce({
      nodes: [],
      pageInfo: {},
    } as unknown as TestPage<TestRelation>);

    await expect(
      service(fake).ensureDuplicateRelation({
        issueId: "issue-1",
        duplicateOfIssueId: "issue-canonical",
      }),
    ).rejects.toMatchObject({ code: "invalid-response" });
    expect(fake.createIssueRelation).not.toHaveBeenCalled();
  });

  it("rejects self-relations before any read or mutation", async () => {
    const fake = makeFake();
    const linear = service(fake);

    await expect(
      linear.ensureDuplicateRelation({
        issueId: "issue-1",
        duplicateOfIssueId: "issue-1",
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    await expect(
      linear.ensureBlockedByRelation({
        issueId: "issue-1",
        blockerIssueId: "issue-1",
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(fake.issueReads).not.toHaveBeenCalled();
    expect(fake.createIssueRelation).not.toHaveBeenCalled();
  });

  it("normalizes relation rejection and malformed success", async () => {
    const rejected = makeFake();
    rejected.createIssueRelation.mockResolvedValueOnce({
      success: false,
      issueRelation: undefined,
    });
    await expect(
      service(rejected).ensureDuplicateRelation({
        issueId: "issue-1",
        duplicateOfIssueId: "issue-canonical",
      }),
    ).rejects.toMatchObject({ code: "rejected" });

    const malformed = makeFake();
    malformed.createIssueRelation.mockResolvedValueOnce({
      success: true,
      issueRelation: undefined,
    });
    await expect(
      service(malformed).ensureDuplicateRelation({
        issueId: "issue-1",
        duplicateOfIssueId: "issue-canonical",
      }),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("preserves the cause of relation SDK failures", async () => {
    const cause = new Error("relation mutation unavailable");
    const fake = makeFake();
    fake.createIssueRelation.mockRejectedValueOnce(cause);

    const error = await service(fake)
      .ensureDuplicateRelation({
        issueId: "issue-1",
        duplicateOfIssueId: "issue-canonical",
      })
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(LinearError);
    expect(error).toMatchObject({ code: "upstream", cause });
  });
});
