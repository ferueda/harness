import { vi } from "vitest";
import {
  LINEAR_TRIAGE_AGENT_STEP_ID,
  LINEAR_TRIAGE_COMMENT_STEP_ID,
  LINEAR_TRIAGE_CONFIRM_STEP_ID,
  LINEAR_TRIAGE_LABELS_STEP_ID,
  LINEAR_TRIAGE_LOAD_STEP_ID,
  LINEAR_TRIAGE_RELATIONS_STEP_ID,
  LINEAR_TRIAGE_RESOLVE_STEP_ID,
  LINEAR_TRIAGE_STATE_STEP_ID,
  type LinearTriageService,
} from "../lib/linear-triage.ts";
import type { LinearIssueContext } from "../lib/linear/read.ts";

export function fakeLinear(input: {
  roots: LinearIssueContext[];
  targets?: Record<string, LinearIssueContext>;
}) {
  const order: string[] = [];
  let rootIndex = 0;
  const getIssueContext = vi.fn<LinearTriageService["getIssueContext"]>(async (reference) => {
    order.push(`read:${reference}`);
    if (reference === "issue-1") {
      const value = input.roots[rootIndex] ?? input.roots.at(-1);
      rootIndex += 1;
      if (value) return value;
    }
    const target = input.targets?.[reference];
    if (target) return target;
    throw new Error(`Unexpected Linear read ${reference}`);
  });
  const ensureComment = vi.fn<LinearTriageService["ensureComment"]>(async () => {
    order.push("comment");
    return { created: true, id: "comment-created" };
  });
  const ensureDuplicateRelation = vi.fn<LinearTriageService["ensureDuplicateRelation"]>(
    async () => {
      order.push("duplicate");
      return { created: true, id: "duplicate-created" };
    },
  );
  const ensureBlockedByRelation = vi.fn<LinearTriageService["ensureBlockedByRelation"]>(
    async () => {
      order.push("blocker");
      return { created: true, id: "blocker-created" };
    },
  );
  const updateIssueLabels = vi.fn<LinearTriageService["updateIssueLabels"]>(async (labels) => {
    order.push("labels");
    return {
      submitted: true,
      addedLabelIds: labels.addLabelIds,
      removedLabelIds: labels.removeLabelIds,
    };
  });
  const updateIssueState = vi.fn<LinearTriageService["updateIssueState"]>(async (state) => {
    order.push("state");
    return { changed: true, stateId: state.stateId };
  });
  return {
    service: {
      getIssueContext,
      ensureComment,
      ensureDuplicateRelation,
      ensureBlockedByRelation,
      updateIssueLabels,
      updateIssueState,
    } satisfies LinearTriageService,
    order,
    getIssueContext,
    ensureComment,
    ensureDuplicateRelation,
    ensureBlockedByRelation,
    updateIssueLabels,
    updateIssueState,
  };
}

export type ProjectionBoundary = "comment" | "blocker" | "labels" | "state";

export function projectionState(
  context: LinearIssueContext,
  lostResponse: ProjectionBoundary | null,
) {
  return {
    stateId: context.state.id,
    labelIds: new Set(context.labels.map((label) => label.id)),
    commentMarkers: new Set<string>(),
    blockerIssueIds: new Set<string>(),
    applied: { comment: 0, blocker: 0, labels: 0, state: 0 },
    lostResponse,
    responseLost: false,
  };
}

export function statefulLinear(
  context: LinearIssueContext,
  blocker: LinearIssueContext,
  state: ReturnType<typeof projectionState>,
) {
  const loseResponse = (boundary: ProjectionBoundary) => {
    if (state.lostResponse === boundary && !state.responseLost) {
      state.responseLost = true;
      throw new Error(`${boundary} response lost`);
    }
  };
  const getIssueContext = vi.fn<LinearTriageService["getIssueContext"]>(async (issueRef) => {
    if (issueRef === context.id) {
      return {
        ...context,
        state: workflowState(state.stateId),
        labels: [...state.labelIds].map((id) => ({
          id,
          name: id === "label-unrelated" ? "Improvement" : `Action ${id}`,
        })),
      };
    }
    if (issueRef === blocker.identifier) return blocker;
    throw new Error(`Unexpected Linear read ${issueRef}`);
  });
  const ensureComment = vi.fn<LinearTriageService["ensureComment"]>(async (input) => {
    const created = !state.commentMarkers.has(input.marker);
    state.commentMarkers.add(input.marker);
    if (created) state.applied.comment += 1;
    loseResponse("comment");
    return { created, id: "comment-1" };
  });
  const ensureBlockedByRelation = vi.fn<LinearTriageService["ensureBlockedByRelation"]>(
    async (input) => {
      const created = !state.blockerIssueIds.has(input.blockerIssueId);
      state.blockerIssueIds.add(input.blockerIssueId);
      if (created) state.applied.blocker += 1;
      loseResponse("blocker");
      return { created, id: "blocker-relation-1" };
    },
  );
  const updateIssueLabels = vi.fn<LinearTriageService["updateIssueLabels"]>(async (input) => {
    const before = [...state.labelIds].toSorted().join(",");
    for (const id of input.removeLabelIds) state.labelIds.delete(id);
    for (const id of input.addLabelIds) state.labelIds.add(id);
    if ([...state.labelIds].toSorted().join(",") !== before) state.applied.labels += 1;
    loseResponse("labels");
    return {
      submitted: true,
      addedLabelIds: input.addLabelIds,
      removedLabelIds: input.removeLabelIds,
    };
  });
  const updateIssueState = vi.fn<LinearTriageService["updateIssueState"]>(async (input) => {
    const changed = state.stateId !== input.stateId;
    if (changed) {
      if (state.stateId !== input.expectedStateId) {
        throw new Error(`Unexpected state ${state.stateId}`);
      }
      state.stateId = input.stateId;
      state.applied.state += 1;
    }
    loseResponse("state");
    return { changed, stateId: input.stateId };
  });
  const ensureDuplicateRelation = vi.fn<LinearTriageService["ensureDuplicateRelation"]>(
    async () => ({ created: true, id: "unexpected-duplicate" }),
  );
  return {
    service: {
      getIssueContext,
      ensureComment,
      ensureBlockedByRelation,
      ensureDuplicateRelation,
      updateIssueLabels,
      updateIssueState,
    } satisfies LinearTriageService,
    getIssueContext,
  };
}

const TRIAGE_PROJECTION_STEP_IDS = [
  LINEAR_TRIAGE_LOAD_STEP_ID,
  LINEAR_TRIAGE_AGENT_STEP_ID,
  LINEAR_TRIAGE_CONFIRM_STEP_ID,
  LINEAR_TRIAGE_RESOLVE_STEP_ID,
  LINEAR_TRIAGE_COMMENT_STEP_ID,
  LINEAR_TRIAGE_RELATIONS_STEP_ID,
  LINEAR_TRIAGE_LABELS_STEP_ID,
  LINEAR_TRIAGE_STATE_STEP_ID,
] as const;

export async function completedStepsBefore(
  state: Record<string, Promise<unknown>>,
  failedStepId: (typeof TRIAGE_PROJECTION_STEP_IDS)[number],
) {
  const completedIds = TRIAGE_PROJECTION_STEP_IDS.slice(
    0,
    TRIAGE_PROJECTION_STEP_IDS.indexOf(failedStepId),
  );
  // The test engine hashes state keys, but preserves durable execution order.
  const values = Object.values(state);
  return Promise.all(
    completedIds.map(async (id, index) => {
      const value = await values[index];
      return { id, handler: () => value };
    }),
  );
}

function workflowState(id: string) {
  return { id, name: `State ${id}`, type: "unstarted" };
}
