import { expect, test, vi } from "vitest";
import {
  applyLinearImplementationMerged,
  applyLinearImplementationPublished,
} from "../lib/factory-linear-implementation-handoff.ts";
import { LINEAR_SETTINGS } from "./factory-linear-test-helpers.ts";

test("projects reviewed PR and human merge once with marker-deduplicated comments", async () => {
  let status = "Implementing";
  const markers = new Set<string>();
  const issue = () => ({
    id: "issue-1",
    identifier: "ENG-1",
    state: Promise.resolve({ id: `state-${status}`, name: status, type: "started" }),
  });
  const updateIssue = vi.fn<
    (id: string, update: { stateId: string }) => Promise<{ success: boolean }>
  >(async (_id, update) => {
    status = update.stateId.replace("state-", "");
    return { success: true };
  });
  const createComment = vi.fn<
    (_client: unknown, input: { issueId: string; body: string }) => Promise<void>
  >(async (_client, input) => {
    markers.add(input.body.split("\n")[0]!);
  });
  const client = { issue: async () => issue(), updateIssue } as never;
  const deps = {
    validateStatusMap: async () => undefined,
    fetchIssue: async () => issue(),
    resolveOptional: async <T>(value: Promise<T | undefined> | T | undefined) => value,
    assertIssueInConfiguredScope: async () => undefined,
    fetchWorkflowState: async (_client: unknown, _settings: unknown, name: string) => ({
      id: `state-${name}`,
      name,
      type: "started",
    }),
    assertMutationSuccess: (result: { success: boolean }) => {
      if (!result.success) throw new Error("mutation failed");
    },
    issueHasCommentMarker: async (_issue: unknown, marker: string) => markers.has(marker),
    createComment,
  } as never;
  const publication = {
    issueRef: "ENG-1",
    runId: "run-1",
    runDir: "/store/run-1",
    prUrl: "https://example.test/pull/1",
    reviewedHead: "a".repeat(40),
  };

  await applyLinearImplementationPublished(deps, client, LINEAR_SETTINGS, publication);
  await applyLinearImplementationPublished(deps, client, LINEAR_SETTINGS, publication);
  expect(status).toBe("Ready for Review");
  await applyLinearImplementationMerged(deps, client, LINEAR_SETTINGS, {
    ...publication,
    mergeCommit: "b".repeat(40),
  });
  await applyLinearImplementationMerged(deps, client, LINEAR_SETTINGS, {
    ...publication,
    mergeCommit: "b".repeat(40),
  });
  expect(status).toBe("Done");
  expect(updateIssue).toHaveBeenCalledTimes(2);
  expect(createComment).toHaveBeenCalledTimes(2);
});
