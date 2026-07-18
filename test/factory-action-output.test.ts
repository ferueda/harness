import { describe, expect, test } from "vitest";
import { formatFactoryActionOutput } from "../bin/factory-action-output.ts";
import { decorateFactoryReaction } from "../bin/factory-manual-command.ts";

describe("Factory manual action output", () => {
  test.each([
    ["complete", "complete"],
    ["human", "waiting"],
    ["plan-merge", "waiting"],
    ["failed", "failed"],
  ] as const)("maps %s waits to %s", (reason, outcome) => {
    expect(
      formatFactoryActionOutput({
        phase: "triage",
        phaseRunId: "triage-run",
        next: { kind: "wait", reason },
        linearApplied: false,
      }),
    ).toMatchObject({ outcome, phase: "triage", phaseRunId: "triage-run", linearApplied: false });
  });

  test("adds a secret-free exact command to invoke reactions", () => {
    const reaction = decorateFactoryReaction(
      {
        kind: "invoke",
        phase: "triage",
        handler: "triageWorkItem",
        attempt: 1,
        causationEventId: "request",
        scheduling: "retry",
        reason: "retryable-failure",
      },
      { workspace: "/repo", linearIssue: "ENG-1" },
    );
    expect(reaction).toMatchObject({
      kind: "invoke",
      scheduling: "retry",
      command: "harness factory triage --workspace /repo --linear-issue ENG-1 --apply",
    });
    expect(JSON.stringify(reaction)).not.toMatch(/API_KEY|token|secret/i);
  });

  test("reports a terminal failed action as failed", () => {
    expect(
      formatFactoryActionOutput({
        phase: "triage",
        action: { handler: "triageWorkItem", attempt: 1, eventId: "failed" },
        next: { kind: "wait", reason: "failed" },
        linearApplied: false,
      }).outcome,
    ).toBe("failed");
  });
});
