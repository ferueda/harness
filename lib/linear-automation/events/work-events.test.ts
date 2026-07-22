import { describe, expect, it } from "vitest";
import {
  createWorkRequestedEvent,
  ImplementationWorkRequestedEvent,
  SpecWorkRequestedEvent,
  TriageWorkRequestedEvent,
  WORK_REQUEST_EVENT_ID_PREFIX,
  WORK_REQUEST_EVENT_NAMES,
  WORK_REQUEST_EVENT_VERSION,
  WorkRequestDataSchema,
  workRequestEventId,
  type WorkRequestData,
} from "./work-events.ts";

const data: WorkRequestData = {
  issueId: "issue-1",
  issueIdentifier: "FER-225",
  causationEventId: "linear-issue-revision-v1:revision-1",
  snapshotGeneration: "a".repeat(64),
};

describe("provider-neutral work events", () => {
  it("locks one strict shared data contract and three versioned routes", () => {
    expect(TriageWorkRequestedEvent).toMatchObject({
      name: WORK_REQUEST_EVENT_NAMES.triage,
      version: WORK_REQUEST_EVENT_VERSION,
    });
    expect(SpecWorkRequestedEvent).toMatchObject({
      name: WORK_REQUEST_EVENT_NAMES.spec,
      version: WORK_REQUEST_EVENT_VERSION,
    });
    expect(ImplementationWorkRequestedEvent).toMatchObject({
      name: WORK_REQUEST_EVENT_NAMES.implement,
      version: WORK_REQUEST_EVENT_VERSION,
    });
    expect(WorkRequestDataSchema.safeParse(data).success).toBe(true);
    expect(
      WorkRequestDataSchema.safeParse({
        ...data,
        stateId: "must-not-cross-the-boundary",
      }).success,
    ).toBe(false);
  });

  it.each(["triage", "spec", "implement"] as const)(
    "creates a deterministic namespaced %s request",
    (route) => {
      const event = createWorkRequestedEvent(route, data);

      expect(event).toEqual({
        name: WORK_REQUEST_EVENT_NAMES[route],
        data,
        id: workRequestEventId(route, data),
        ts: undefined,
        v: WORK_REQUEST_EVENT_VERSION,
        meta: undefined,
        validate: expect.any(Function),
      });
      expect(event.id).toMatch(new RegExp(`^${WORK_REQUEST_EVENT_ID_PREFIX}[0-9a-f]{64}$`));
    },
  );

  it("changes identity for a different route, issue, or readiness generation", () => {
    const original = workRequestEventId("spec", data);

    expect(workRequestEventId("implement", data)).not.toBe(original);
    expect(workRequestEventId("spec", { ...data, issueId: "issue-2" })).not.toBe(original);
    expect(
      workRequestEventId("spec", {
        ...data,
        snapshotGeneration: "b".repeat(64),
      }),
    ).not.toBe(original);
    expect(workRequestEventId("spec", { ...data, causationEventId: "later-delivery" })).toBe(
      original,
    );
  });

  it.each([
    ["blank issue ID", { ...data, issueId: " " }],
    ["blank causation", { ...data, causationEventId: "" }],
    ["invalid generation", { ...data, snapshotGeneration: "not-a-hash" }],
  ])("rejects %s", (_label, value) => {
    expect(() => createWorkRequestedEvent("triage", value)).toThrow(/invalid|too small/i);
  });
});
