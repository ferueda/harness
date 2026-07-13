import { expect, test, vi } from "vitest";
import {
  applyLinearImplementationCompleted,
  applyLinearImplementationAttention,
  applyLinearImplementationFailed,
  applyLinearImplementationStarted,
  linearImplementationCompletedMarker,
  linearImplementationFailedMarker,
  LinearImplementationTerminalApplyError,
  type LinearImplementationApplyDeps,
} from "../lib/factory-linear-implementation-apply.ts";
import type {
  LinearClientLike,
  LinearCommentLike,
  LinearIssueLike,
} from "../lib/factory-linear-types.ts";
import { LINEAR_SETTINGS } from "./factory-linear-test-helpers.ts";

function issue(stateName: string | undefined, comments: LinearCommentLike[] = []): LinearIssueLike {
  return {
    id: "issue-1",
    identifier: "ENG-123",
    number: 123,
    title: "Implement Linear projection",
    url: "https://linear.app/acme/issue/ENG-123",
    projectId: "project-1",
    state: stateName ? { id: `state-${stateName}`, name: stateName } : undefined,
    comments: async () => ({ nodes: comments }),
  };
}

function harness(
  initialState: string | undefined,
  options: {
    updateSuccess?: boolean;
    applyUpdate?: boolean;
    updateError?: Error;
    commentSuccess?: boolean;
    commentError?: Error;
  } = {},
) {
  let currentState: string | undefined = initialState;
  const comments: LinearCommentLike[] = [];
  const updateIssue = vi.fn(async (_id: string, input: { stateId: string }) => {
    if (options.updateError) throw options.updateError;
    if (options.updateSuccess !== false && options.applyUpdate !== false) {
      currentState = input.stateId.replace(/^state-/, "");
    }
    return { success: options.updateSuccess !== false };
  });
  const createComment = vi.fn(async (input: { issueId: string; body: string }) => {
    if (options.commentError) throw options.commentError;
    if (options.commentSuccess !== false) {
      comments.push({ id: `comment-${comments.length + 1}`, body: input.body });
    }
    return { success: options.commentSuccess !== false };
  });
  const client: LinearClientLike = {
    issue: async () => issue(currentState, comments),
    issues: async () => ({ nodes: [issue(currentState, comments)] }),
    teams: async () => ({ nodes: [] }),
    createIssue: async () => ({ success: false }),
    updateIssue,
    createComment,
  };
  const deps: LinearImplementationApplyDeps = {
    validateStatusMap: async () => undefined,
    fetchIssue: async () => issue(currentState, comments),
    resolveOptional: async (value) => await value,
    assertIssueInConfiguredScope: async () => undefined,
    fetchWorkflowState: async (_client, _settings, name) => ({ id: `state-${name}`, name }),
    assertMutationSuccess(result, operation) {
      if (!result.success) throw new Error(`Linear ${operation} mutation failed.`);
    },
    issueHasCommentMarker: async (candidate, marker) =>
      (await candidate.comments?.())?.nodes.some((comment) => comment.body.includes(marker)) ??
      false,
    async createComment(candidateClient, input, operation) {
      const result = await candidateClient.createComment(input);
      if (!result.success) throw new Error(`Linear ${operation} mutation failed.`);
    },
  };
  return {
    client,
    deps,
    updateIssue,
    createComment,
    setState: (state: string | undefined) => (currentState = state),
  };
}

test("implementation start projects first and retry attempts to Implementing", async () => {
  const first = harness("Ready to Implement");
  const firstResult = await applyLinearImplementationStarted(
    first.deps,
    first.client,
    LINEAR_SETTINGS,
    {
      issueRef: "ENG-123",
      runId: "run-first",
      runDir: ".harness/runs/factory/run-first",
      intent: "start",
    },
  );
  expect(first.updateIssue).toHaveBeenCalledWith("issue-1", { stateId: "state-Implementing" });
  expect(firstResult).toMatchObject({
    stage: "started",
    fromStatus: "Ready to Implement",
    targetStatus: "Implementing",
  });

  const retry = harness("Implementation Failed");
  await applyLinearImplementationStarted(retry.deps, retry.client, LINEAR_SETTINGS, {
    issueRef: "ENG-123",
    runId: "run-retry",
    runDir: ".harness/runs/factory/run-retry",
    intent: "restart",
  });
  expect(retry.updateIssue).toHaveBeenCalledWith("issue-1", { stateId: "state-Implementing" });
});

test("implementation restart accepts already Implementing without another status mutation", async () => {
  const state = harness("Implementing");
  const result = await applyLinearImplementationStarted(state.deps, state.client, LINEAR_SETTINGS, {
    issueRef: "ENG-123",
    runId: "run-repair",
    runDir: ".harness/runs/factory/run-repair",
    intent: "restart",
  });
  expect(state.updateIssue).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    statusMutationCompleted: false,
    statusPostconditionVerified: true,
  });
});

test("implementation attention remains Implementing and deduplicates its comment", async () => {
  const state = harness("Implementing");
  const input = {
    issueRef: "ENG-123",
    runId: "run-attention",
    runDir: ".harness/runs/factory/run-attention",
    verdict: "needs_changes" as const,
    candidateCommit: "a".repeat(40),
  };
  await applyLinearImplementationAttention(state.deps, state.client, LINEAR_SETTINGS, input);
  await applyLinearImplementationAttention(state.deps, state.client, LINEAR_SETTINGS, input);
  expect(state.updateIssue).not.toHaveBeenCalled();
  expect(state.createComment).toHaveBeenCalledTimes(1);
});

test("implementation start fails closed when fresh state changed", async () => {
  const state = harness("Ready to Implement");
  state.deps.fetchIssue = async () => {
    state.setState("Planning");
    return issue("Ready to Implement");
  };

  await expect(
    applyLinearImplementationStarted(state.deps, state.client, LINEAR_SETTINGS, {
      issueRef: "ENG-123",
      runId: "run-stale",
      runDir: ".harness/runs/factory/run-stale",
      intent: "start",
    }),
  ).rejects.toThrow(/requires Ready to Implement/);
  expect(state.updateIssue).not.toHaveBeenCalled();
});

test("implementation start rejects a same-identifier response with another immutable id", async () => {
  const state = harness("Ready to Implement");
  state.client.issue = async () => ({ ...issue("Ready to Implement"), id: "issue-2" });

  await expect(
    applyLinearImplementationStarted(state.deps, state.client, LINEAR_SETTINGS, {
      issueRef: "ENG-123",
      runId: "run-wrong-id",
      runDir: ".harness/runs/factory/run-wrong-id",
      intent: "start",
    }),
  ).rejects.toThrow(/identity changed/);
  expect(state.updateIssue).not.toHaveBeenCalled();
});

test("implementation start revalidates the status map immediately before mutation", async () => {
  const state = harness("Ready to Implement");
  let validations = 0;
  state.deps.validateStatusMap = async () => {
    validations += 1;
    if (validations === 2) throw new Error("configured status map changed");
  };

  await expect(
    applyLinearImplementationStarted(state.deps, state.client, LINEAR_SETTINGS, {
      issueRef: "ENG-123",
      runId: "run-status-map-drift",
      runDir: ".harness/runs/factory/run-status-map-drift",
      intent: "start",
    }),
  ).rejects.toThrow("configured status map changed");
  expect(state.updateIssue).not.toHaveBeenCalled();
});

test("implementation start treats success false as a failed mutation", async () => {
  const state = harness("Ready to Implement", { updateSuccess: false });

  await expect(
    applyLinearImplementationStarted(state.deps, state.client, LINEAR_SETTINGS, {
      issueRef: "ENG-123",
      runId: "run-failed-mutation",
      runDir: ".harness/runs/factory/run-failed-mutation",
      intent: "start",
    }),
  ).rejects.toThrow(/implementation start mutation failed/);
});

test("implementation retry start treats success false as a failed mutation", async () => {
  const state = harness("Implementation Failed", { updateSuccess: false });

  await expect(
    applyLinearImplementationStarted(state.deps, state.client, LINEAR_SETTINGS, {
      issueRef: "ENG-123",
      runId: "run-retry-failed-mutation",
      runDir: ".harness/runs/factory/run-retry-failed-mutation",
      intent: "restart",
    }),
  ).rejects.toThrow(/implementation start mutation failed/);
  expect(state.createComment).not.toHaveBeenCalled();
});

test("implementation start preserves thrown mutation failures", async () => {
  const state = harness("Ready to Implement", { updateError: new Error("network unavailable") });

  await expect(
    applyLinearImplementationStarted(state.deps, state.client, LINEAR_SETTINGS, {
      issueRef: "ENG-123",
      runId: "run-thrown-mutation",
      runDir: ".harness/runs/factory/run-thrown-mutation",
      intent: "start",
    }),
  ).rejects.toThrow("network unavailable");
});

test("implementation start requires a verified post-write state", async () => {
  const state = harness("Ready to Implement", { applyUpdate: false });

  await expect(
    applyLinearImplementationStarted(state.deps, state.client, LINEAR_SETTINGS, {
      issueRef: "ENG-123",
      runId: "run-unconfirmed",
      runDir: ".harness/runs/factory/run-unconfirmed",
      intent: "start",
    }),
  ).rejects.toThrow(/requires Implementing/);
});

test("implementation completion writes one marker-deduped handoff comment", async () => {
  const state = harness("Implementing");
  const input = {
    issueRef: "ENG-123",
    runId: "run-complete",
    runDir: ".harness/runs/factory/run-complete",
    reviewBase: "base-sha",
    reviewHead: "refs/harness/review",
    reviewCommitSha: "review-sha",
  };

  const result = await applyLinearImplementationCompleted(
    state.deps,
    state.client,
    LINEAR_SETTINGS,
    input,
  );
  await applyLinearImplementationCompleted(state.deps, state.client, LINEAR_SETTINGS, input);

  expect(state.updateIssue).not.toHaveBeenCalled();
  expect(state.createComment).toHaveBeenCalledTimes(1);
  expect(result.commentMarker).toBe(linearImplementationCompletedMarker("run-complete"));
  expect(result.commentBody).toContain("Review commit: `review-sha`");
});

test("implementation failure projects status and writes a retry comment", async () => {
  const state = harness("Implementing");
  const result = await applyLinearImplementationFailed(state.deps, state.client, LINEAR_SETTINGS, {
    issueRef: "ENG-123",
    runId: "run-failed",
    runDir: ".harness/runs/factory/run-failed",
    error: "provider timed out",
  });

  expect(state.updateIssue).toHaveBeenCalledWith("issue-1", {
    stateId: "state-Implementation Failed",
  });
  expect(state.createComment).toHaveBeenCalledTimes(1);
  expect(result.commentMarker).toBe(linearImplementationFailedMarker("run-failed"));
  expect(result.commentBody).toContain("provider timed out");
});

test.each(["Ready to Implement", "Implementation Failed", "Planning"])(
  "implementation completion rejects terminal entry %s before mutation",
  async (entry) => {
    const state = harness(entry);

    await expect(
      applyLinearImplementationCompleted(state.deps, state.client, LINEAR_SETTINGS, {
        issueRef: "ENG-123",
        runId: "run-invalid-complete",
        runDir: ".harness/runs/factory/run-invalid-complete",
        reviewBase: "base",
        reviewHead: "head",
        reviewCommitSha: "commit",
      }),
    ).rejects.toThrow(/completion requires Implementing/);
    expect(state.updateIssue).not.toHaveBeenCalled();
    expect(state.createComment).not.toHaveBeenCalled();
  },
);

test.each(["Ready to Implement", "Implementation Failed", "Planning", undefined])(
  "implementation failure rejects terminal entry %s before mutation",
  async (entry) => {
    const state = harness(entry);

    await expect(
      applyLinearImplementationFailed(state.deps, state.client, LINEAR_SETTINGS, {
        issueRef: "ENG-123",
        runId: "run-invalid-failure",
        runDir: ".harness/runs/factory/run-invalid-failure",
        error: "provider failed",
      }),
    ).rejects.toThrow(/failure requires Implementing/);
    expect(state.updateIssue).not.toHaveBeenCalled();
    expect(state.createComment).not.toHaveBeenCalled();
  },
);

test("implementation completion checks resolved-false and thrown comment failures", async () => {
  const resolved = harness("Implementing", { commentSuccess: false });
  await expect(
    applyLinearImplementationCompleted(resolved.deps, resolved.client, LINEAR_SETTINGS, {
      issueRef: "ENG-123",
      runId: "run-comment-false",
      runDir: ".harness/runs/factory/run-comment-false",
      reviewBase: "base",
      reviewHead: "head",
      reviewCommitSha: "commit",
    }),
  ).rejects.toThrow(/completion comment mutation failed/);

  const thrown = harness("Implementing", { commentError: new Error("comment network failure") });
  await expect(
    applyLinearImplementationCompleted(thrown.deps, thrown.client, LINEAR_SETTINGS, {
      issueRef: "ENG-123",
      runId: "run-comment-thrown",
      runDir: ".harness/runs/factory/run-comment-thrown",
      reviewBase: "base",
      reviewHead: "head",
      reviewCommitSha: "commit",
    }),
  ).rejects.toThrow("comment network failure");
});

test("implementation completion revalidates the status map immediately before commenting", async () => {
  const state = harness("Implementing");
  let validations = 0;
  state.deps.validateStatusMap = async () => {
    validations += 1;
    if (validations === 3) throw new Error("configured status map changed before comment");
  };

  await expect(
    applyLinearImplementationCompleted(state.deps, state.client, LINEAR_SETTINGS, {
      issueRef: "ENG-123",
      runId: "run-comment-status-drift",
      runDir: ".harness/runs/factory/run-comment-status-drift",
      reviewBase: "base",
      reviewHead: "head",
      reviewCommitSha: "commit",
    }),
  ).rejects.toThrow("configured status map changed before comment");
  expect(state.createComment).not.toHaveBeenCalled();
});

test("implementation failure requires a verified failed state before commenting", async () => {
  const state = harness("Implementing", { applyUpdate: false });

  await expect(
    applyLinearImplementationFailed(state.deps, state.client, LINEAR_SETTINGS, {
      issueRef: "ENG-123",
      runId: "run-failed-unconfirmed",
      runDir: ".harness/runs/factory/run-failed-unconfirmed",
      error: "provider failed",
    }),
  ).rejects.toThrow(/requires Implementation Failed/);
  expect(state.createComment).not.toHaveBeenCalled();
});

test("implementation failure preserves verified status progress when its comment fails", async () => {
  const state = harness("Implementing", { commentSuccess: false });
  let thrown: unknown;

  try {
    await applyLinearImplementationFailed(state.deps, state.client, LINEAR_SETTINGS, {
      issueRef: "ENG-123",
      runId: "run-failed-comment",
      runDir: ".harness/runs/factory/run-failed-comment",
      error: "provider failed",
    });
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(LinearImplementationTerminalApplyError);
  expect(thrown).toMatchObject({
    update: {
      stage: "failed",
      targetStatus: "Implementation Failed",
      statusMutationCompleted: true,
      statusPostconditionVerified: true,
      commentPresent: false,
      commentMarker: linearImplementationFailedMarker("run-failed-comment"),
      commentBody: expect.stringContaining("provider failed"),
    },
  });
});

test("implementation apply precondition failures perform zero mutations", async () => {
  const state = harness("Ready to Implement");
  state.deps.assertIssueInConfiguredScope = async () => {
    throw new Error("outside configured project");
  };

  await expect(
    applyLinearImplementationStarted(state.deps, state.client, LINEAR_SETTINGS, {
      issueRef: "ENG-123",
      runId: "run-out-of-scope",
      runDir: ".harness/runs/factory/run-out-of-scope",
      intent: "start",
    }),
  ).rejects.toThrow("outside configured project");
  expect(state.updateIssue).not.toHaveBeenCalled();
  expect(state.createComment).not.toHaveBeenCalled();
});
