import { expect, test } from "vitest";
import { formatFactoryActionOutput } from "../bin/factory-action-output.ts";

test("planning uses the shared one-action output contract", () => {
  expect(
    formatFactoryActionOutput({
      phase: "planning",
      phaseRunId: "run-1",
      action: { handler: "producePlanCandidate", attempt: 1, eventId: "candidate-1" },
      next: { kind: "wait", reason: "plan-merge" },
      linearApplied: false,
    }),
  ).toMatchObject({ outcome: "action-completed", phase: "planning", phaseRunId: "run-1" });
});
