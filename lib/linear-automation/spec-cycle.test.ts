import { describe, expect, it } from "vitest";
import type { SpecReviewProvenance } from "../spec-review/review.ts";
import type { SpecReviewFinding } from "../spec-review/schema.ts";
import {
  SPEC_CYCLE_LAST_REVIEW_ROUND,
  SPEC_CYCLE_REVIEW_ROUNDS,
  createInitialSpecCheckpointIdentity,
  createSpecCycleRoundIdentity,
  toSpecRevisionAuthorSession,
  toSpecRevisionReview,
} from "./spec-cycle.ts";
import { WORK_REQUEST_EVENT_ID_PREFIX } from "./events/work-events.ts";

const WORK_REQUEST_ID = `${WORK_REQUEST_EVENT_ID_PREFIX}${"a".repeat(64)}`;
const CHECKPOINT_A = "1".repeat(40);
const CHECKPOINT_B = "2".repeat(40);

describe("Spec cycle policy", () => {
  it("locks the cycle to three reviews and two revision attempts", () => {
    expect(SPEC_CYCLE_REVIEW_ROUNDS).toEqual([0, 1, 2]);
    expect(SPEC_CYCLE_LAST_REVIEW_ROUND).toBe(2);
  });

  it("replays the same checkpoint-bound round with identical identities", () => {
    const input = {
      workRequestId: WORK_REQUEST_ID,
      reviewRound: 1 as const,
      checkpointRevision: CHECKPOINT_A,
    };

    expect(createSpecCycleRoundIdentity(input)).toEqual(createSpecCycleRoundIdentity(input));
  });

  it("separates different checkpoints reviewed in the same round", () => {
    const first = createSpecCycleRoundIdentity({
      workRequestId: WORK_REQUEST_ID,
      reviewRound: 1,
      checkpointRevision: CHECKPOINT_A,
    });
    const second = createSpecCycleRoundIdentity({
      workRequestId: WORK_REQUEST_ID,
      reviewRound: 1,
      checkpointRevision: CHECKPOINT_B,
    });

    for (const field of [
      "key",
      "checkpointDigest",
      "reviewStepId",
      "revisionStepId",
      "childCheckpointId",
      "publishStepId",
      "commentIdentity",
    ] as const) {
      expect(first[field]).not.toBe(second[field]);
    }
  });

  it("separates the same checkpoint across fixed rounds", () => {
    const first = createSpecCycleRoundIdentity({
      workRequestId: WORK_REQUEST_ID,
      reviewRound: 0,
      checkpointRevision: CHECKPOINT_A,
    });
    const second = createSpecCycleRoundIdentity({
      workRequestId: WORK_REQUEST_ID,
      reviewRound: 1,
      checkpointRevision: CHECKPOINT_A,
    });

    expect(first.key).not.toBe(second.key);
    expect(first.reviewStepId).not.toBe(second.reviewStepId);
    expect(first.childCheckpointId).not.toBe(second.childCheckpointId);
  });

  it("gives the initial checkpoint a stable root-bound identity", () => {
    const input = {
      workRequestId: WORK_REQUEST_ID,
      parentRevision: CHECKPOINT_A,
    };
    expect(createInitialSpecCheckpointIdentity(input)).toEqual(
      createInitialSpecCheckpointIdentity(input),
    );
    expect(createInitialSpecCheckpointIdentity(input).checkpointId).toMatch(
      /^spec-cycle-v1:initial-checkpoint:[0-9a-f]{64}$/,
    );
    expect(createInitialSpecCheckpointIdentity(input)).not.toEqual(
      createInitialSpecCheckpointIdentity({
        ...input,
        parentRevision: CHECKPOINT_B,
      }),
    );
  });

  it.each([
    ["an invalid root work request", /work request/i, "bad", 0, CHECKPOINT_A],
    ["an unsupported review round", /review round/i, WORK_REQUEST_ID, 3, CHECKPOINT_A],
    ["a short checkpoint revision", /checkpoint revision/i, WORK_REQUEST_ID, 0, "abc123"],
  ])("rejects %s", (_name, expected, workRequestId, reviewRound, checkpointRevision) => {
    expect(() =>
      createSpecCycleRoundIdentity({
        workRequestId,
        reviewRound: reviewRound as 0,
        checkpointRevision,
      }),
    ).toThrow(expected);
  });
});

describe("Spec cycle revision inputs", () => {
  it("versions the normalized author continuation without extra session data", () => {
    expect(toSpecRevisionAuthorSession({ provider: "codex", id: "thread-320" })).toEqual({
      version: 1,
      provider: "codex",
      id: "thread-320",
    });
    expect(toSpecRevisionAuthorSession(null)).toBeNull();
  });

  it("rejects a malformed author continuation", () => {
    expect(() => toSpecRevisionAuthorSession({ provider: "codex", id: " " })).toThrow();
  });

  it("binds trusted review findings to the exact artifact revision", () => {
    const finding = reviewFinding();
    const review = toSpecRevisionReview({
      artifact: {
        path: "dev/plans/FER-320.md",
        revision: CHECKPOINT_A,
      },
      decision: {
        outcome: "changes-requested",
        rationale: "The acceptance check needs one more observable case.",
        findings: [finding],
      },
      provenance: {
        rubricVersion: "spec-review-rubric-v1",
      } satisfies Pick<SpecReviewProvenance, "rubricVersion">,
    });

    expect(review).toEqual({
      reviewedRevision: CHECKPOINT_A,
      rubricVersion: "spec-review-rubric-v1",
      findings: [finding],
    });
  });
});

function reviewFinding(): SpecReviewFinding {
  return {
    id: `spec-review-finding-${"b".repeat(64)}`,
    criterion: "verification",
    artifactLocation: {
      section: "Verify",
      lineStart: 42,
      lineEnd: 42,
    },
    evidence: [
      {
        source: "artifact",
        path: "dev/plans/FER-320.md",
        lineStart: 42,
        lineEnd: 42,
        summary: "The current check omits the retry boundary.",
      },
    ],
    problem: "The retry boundary is not asserted.",
    requiredOutcome: "Name the durable replay assertion.",
  };
}
