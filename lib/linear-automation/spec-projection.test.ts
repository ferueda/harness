import { describe, expect, it, vi } from "vitest";
import type { LinearIssueContext } from "../linear/types.ts";
import type { WorkRequestData } from "./events/work-events.ts";
import type { LinearReadinessConfig } from "./readiness.ts";
import type { SpecAuthority } from "./spec-authority.ts";
import {
  beginSpecRecovery,
  claimSpecState,
  consumeSpecAgentReady,
  finishSpecRecovery,
  reopenSpecClaim,
  type LinearSpecProjectionService,
} from "./spec-projection.ts";

const readiness: LinearReadinessConfig = {
  teamId: "team-1",
  projectId: "project-1",
  stateIds: {
    backlog: "backlog",
    open: "open",
    inProgress: "in-progress",
    needsInput: "needs-input",
    needsReview: "needs-review",
    done: "done",
    canceled: "canceled",
    duplicate: "duplicate",
  },
  agentActionLabelIds: { spec: "spec", implement: "implement" },
  agentReadyLabelId: "agent-ready",
  enabledRoutes: { triage: true, spec: true, implement: false },
};

const event: WorkRequestData = {
  issueId: "issue-1",
  issueIdentifier: "FER-320",
  causationEventId: "cause-1",
  snapshotGeneration: "b".repeat(64),
};

const authority: SpecAuthority = {
  issueId: event.issueId,
  issueIdentifier: event.issueIdentifier,
  sourceFingerprint: "a".repeat(64),
};

describe("Spec recovery projection", () => {
  it("keeps claim state and permission consumption independently callable", async () => {
    const order: string[] = [];
    const linear: LinearSpecProjectionService = {
      getIssueContext: vi.fn<LinearSpecProjectionService["getIssueContext"]>(),
      ensureComment: vi.fn<LinearSpecProjectionService["ensureComment"]>(),
      updateIssueState: vi.fn<LinearSpecProjectionService["updateIssueState"]>(async (input) => {
        order.push("state");
        return { changed: true, stateId: input.stateId };
      }),
      updateIssueLabels: vi.fn<LinearSpecProjectionService["updateIssueLabels"]>(async (input) => {
        order.push("labels");
        return {
          submitted: true,
          addedLabelIds: input.addLabelIds,
          removedLabelIds: input.removeLabelIds,
        };
      }),
    };

    await claimSpecState(linear, event.issueId, readiness);
    await consumeSpecAgentReady(linear, event.issueId, readiness);

    expect(order).toEqual(["state", "labels"]);
  });

  it("does not mutate labels when the lifecycle guard fails", async () => {
    const updateIssueLabels = vi.fn<LinearSpecProjectionService["updateIssueLabels"]>(async () => ({
      submitted: true,
      addedLabelIds: [],
      removedLabelIds: [],
    }));
    const linear: LinearSpecProjectionService = {
      getIssueContext: vi.fn<LinearSpecProjectionService["getIssueContext"]>(async () =>
        claimedContext(),
      ),
      ensureComment: vi.fn<LinearSpecProjectionService["ensureComment"]>(async () => ({
        created: true,
        id: "comment-1",
      })),
      updateIssueState: vi.fn<LinearSpecProjectionService["updateIssueState"]>(async () => {
        throw new Error("state conflict");
      }),
      updateIssueLabels,
    };

    const recovery = await beginSpecRecovery({
      linear,
      event,
      authority,
      readiness,
      error: "provider retries exhausted",
    });
    expect(recovery.currentClaim).toBe(true);
    await expect(reopenSpecClaim({ linear, issueId: event.issueId, readiness })).rejects.toThrow(
      "state conflict",
    );

    expect(linear.ensureComment).toHaveBeenCalledOnce();
    expect(updateIssueLabels).not.toHaveBeenCalled();
  });

  it("finishes label cleanup after an idempotent state replay", async () => {
    const order: string[] = [];
    let stateId = readiness.stateIds.inProgress;
    let failLabels = true;
    const linear: LinearSpecProjectionService = {
      getIssueContext: vi.fn<LinearSpecProjectionService["getIssueContext"]>(async () => ({
        ...claimedContext(),
        state: { id: stateId, name: stateId, type: "started" },
      })),
      ensureComment: vi.fn<LinearSpecProjectionService["ensureComment"]>(async () => {
        order.push("comment");
        return { created: order.filter((value) => value === "comment").length === 1, id: "c-1" };
      }),
      updateIssueState: vi.fn<LinearSpecProjectionService["updateIssueState"]>(async (input) => {
        order.push("state");
        if (stateId !== input.expectedStateId && stateId !== input.stateId) {
          throw new Error("state conflict");
        }
        const changed = stateId !== input.stateId;
        stateId = input.stateId;
        return { changed, stateId };
      }),
      updateIssueLabels: vi.fn<LinearSpecProjectionService["updateIssueLabels"]>(async (input) => {
        order.push("labels");
        if (failLabels) {
          failLabels = false;
          throw new Error("label transport failed");
        }
        return {
          submitted: true,
          addedLabelIds: input.addLabelIds,
          removedLabelIds: input.removeLabelIds,
        };
      }),
    };

    const recovery = await beginSpecRecovery({
      linear,
      event,
      authority,
      readiness,
      error: "failed",
    });
    expect(recovery.currentClaim).toBe(true);
    await reopenSpecClaim({ linear, issueId: event.issueId, readiness });
    await expect(finishSpecRecovery({ linear, issueId: event.issueId, readiness })).rejects.toThrow(
      "label transport failed",
    );
    await finishSpecRecovery({ linear, issueId: event.issueId, readiness });

    expect(order).toEqual(["comment", "state", "labels", "labels"]);
    expect(stateId).toBe(readiness.stateIds.open);
  });

  it("preserves a human-restored Agent Ready permission", async () => {
    const updateIssueState = vi.fn<LinearSpecProjectionService["updateIssueState"]>();
    const updateIssueLabels = vi.fn<LinearSpecProjectionService["updateIssueLabels"]>();
    const linear: LinearSpecProjectionService = {
      getIssueContext: vi.fn<LinearSpecProjectionService["getIssueContext"]>(async () =>
        claimedContext({ agentReady: true }),
      ),
      ensureComment: vi.fn<LinearSpecProjectionService["ensureComment"]>(async () => ({
        created: true,
        id: "comment-1",
      })),
      updateIssueState,
      updateIssueLabels,
    };

    const recovery = await beginSpecRecovery({
      linear,
      event,
      authority,
      readiness,
      error: "stale authority",
    });

    expect(recovery.currentClaim).toBe(false);
    expect(linear.ensureComment).toHaveBeenCalledOnce();
    expect(updateIssueState).not.toHaveBeenCalled();
    expect(updateIssueLabels).not.toHaveBeenCalled();
  });

  it("recovers Agent Ready when the durable claim state is known to have succeeded", async () => {
    const order: string[] = [];
    const linear: LinearSpecProjectionService = {
      getIssueContext: vi.fn<LinearSpecProjectionService["getIssueContext"]>(async () =>
        claimedContext({ agentReady: true }),
      ),
      ensureComment: vi.fn<LinearSpecProjectionService["ensureComment"]>(async () => {
        order.push("comment");
        return { created: true, id: "comment-1" };
      }),
      updateIssueState: vi.fn<LinearSpecProjectionService["updateIssueState"]>(async (input) => {
        order.push("state");
        return { changed: true, stateId: input.stateId };
      }),
      updateIssueLabels: vi.fn<LinearSpecProjectionService["updateIssueLabels"]>(async (input) => {
        order.push("labels");
        return {
          submitted: true,
          addedLabelIds: input.addLabelIds,
          removedLabelIds: input.removeLabelIds,
        };
      }),
    };

    const recovery = await beginSpecRecovery({
      linear,
      event,
      authority,
      readiness,
      error: "Agent Ready consumption exhausted",
      allowAgentReadyClaim: true,
    });
    expect(recovery.currentClaim).toBe(true);
    await reopenSpecClaim({ linear, issueId: event.issueId, readiness });
    await finishSpecRecovery({ linear, issueId: event.issueId, readiness });

    expect(order).toEqual(["comment", "state", "labels"]);
  });
});

function claimedContext(options: { agentReady?: boolean } = {}): LinearIssueContext {
  return {
    id: event.issueId,
    identifier: event.issueIdentifier,
    title: "Run a bounded Spec cycle",
    description: "Compose the existing primitives.",
    url: "https://linear.app/example/FER-320",
    state: { id: readiness.stateIds.inProgress, name: "In Progress", type: "started" },
    team: { id: readiness.teamId, key: "FER", name: "ferueda" },
    project: { id: readiness.projectId, name: "Harness", url: null },
    assignee: null,
    creator: null,
    labels: [
      { id: readiness.agentActionLabelIds.spec, name: "Spec" },
      ...(options.agentReady ? [{ id: readiness.agentReadyLabelId, name: "Agent Ready" }] : []),
    ],
    comments: [],
    parent: null,
    children: [],
    duplicateOf: null,
    blockedBy: [],
    related: [],
    attachments: [],
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T01:00:00.000Z",
    completeness: {
      commentsTruncated: false,
      labelsTruncated: false,
      relationsTruncated: false,
      attachmentsTruncated: false,
      childrenTruncated: false,
    },
  };
}
