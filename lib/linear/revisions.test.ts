import { describe, expect, it, vi } from "vitest";
import { createLinearForClient, type LinearClientLike, type LinearReadLimits } from "./client.ts";

const LIMITS: LinearReadLimits = {
  comments: 10,
  labels: 10,
  relations: 10,
  attachments: 10,
  children: 10,
};
const TEAM_ID = "team-fer";
const PROJECT_ID = "project-harness";
const STATE_ID = "state-backlog";

type RevisionIssue = {
  id: string;
  identifier: string;
  updatedAt: string;
};

type RevisionPage = {
  nodes: RevisionIssue[];
  pageInfo: { hasNextPage: boolean; endCursor?: string };
};

function revisions(count: number): RevisionIssue[] {
  return Array.from({ length: count }, (_, index) => {
    const number = count - index;
    return {
      id: `issue-${number}`,
      identifier: `FER-${number}`,
      updatedAt: new Date(Date.UTC(2026, 6, 20, 20, index)).toISOString(),
    };
  });
}

function service(issues: RevisionIssue[], failure?: unknown) {
  const issueReads = vi.fn<(variables?: unknown) => Promise<RevisionPage>>(async (variables) => {
    if (failure) throw failure;
    const query = variables as { after?: string; first?: number };
    const offset = Number(query.after ?? "0");
    const first = query.first ?? 0;
    const nodes = issues.slice(offset, offset + first);
    const nextOffset = offset + nodes.length;
    return {
      nodes,
      pageInfo: {
        hasNextPage: nextOffset < issues.length,
        ...(nextOffset < issues.length ? { endCursor: String(nextOffset) } : {}),
      },
    };
  });
  const client = {
    issues: issueReads,
  } as unknown as LinearClientLike;
  return {
    linear: createLinearForClient({ client, limits: LIMITS }),
    issueReads,
  };
}

function revisionInput(limit: number) {
  return {
    teamId: TEAM_ID,
    projectId: PROJECT_ID,
    stateId: STATE_ID,
    limit,
  };
}

describe("standalone Linear issue revisions", () => {
  it("lists only plain revisions through exact stable-ID filters", async () => {
    const fake = service(revisions(51));

    const result = await fake.linear.listIssueRevisions(revisionInput(51));

    expect(result.truncated).toBe(false);
    expect(result.revisions).toHaveLength(51);
    expect(result.revisions[0]).toEqual({
      id: "issue-1",
      identifier: "FER-1",
      updatedAt: "2026-07-20T20:50:00.000Z",
    });
    expect(Object.keys(result.revisions[0])).toEqual(["id", "identifier", "updatedAt"]);
    expect(fake.issueReads).toHaveBeenNthCalledWith(1, {
      filter: {
        team: { id: { eq: TEAM_ID } },
        project: { id: { eq: PROJECT_ID } },
        state: { id: { eq: STATE_ID } },
      },
      first: 50,
    });
    expect(fake.issueReads).toHaveBeenNthCalledWith(2, {
      filter: {
        team: { id: { eq: TEAM_ID } },
        project: { id: { eq: PROJECT_ID } },
        state: { id: { eq: STATE_ID } },
      },
      first: 2,
      after: "50",
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("accepts the exact pilot limit and reports the first excess issue", async () => {
    await expect(
      service(revisions(250)).linear.listIssueRevisions(revisionInput(250)),
    ).resolves.toMatchObject({ truncated: false, revisions: { length: 250 } });
    await expect(
      service(revisions(251)).linear.listIssueRevisions(revisionInput(250)),
    ).resolves.toMatchObject({ truncated: true, revisions: { length: 250 } });
  });

  it("validates inputs and normalizes upstream failures", async () => {
    const fake = service(revisions(1));
    await expect(
      fake.linear.listIssueRevisions({ ...revisionInput(250), teamId: " " }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    await expect(fake.linear.listIssueRevisions(revisionInput(0))).rejects.toMatchObject({
      code: "invalid-input",
    });

    const cause = new Error("revision query unavailable");
    const error = await service([], cause)
      .linear.listIssueRevisions(revisionInput(250))
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "upstream", cause });
  });
});
