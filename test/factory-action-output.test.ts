import { describe, expect, test } from "vitest";
import { formatFactoryActionOutput, withManualCommand } from "../bin/factory-action-output.ts";

describe("Factory manual action output", () => {
  test.each([
    ["complete", "complete"],
    ["human", "waiting"],
    ["plan-merge", "waiting"],
    ["phase-command", "waiting"],
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
    const reaction = withManualCommand(
      {
        kind: "invoke",
        phase: "triage",
        handler: "triageWorkItem",
        attempt: 1,
        causationEventId: "request",
        scheduling: "retry",
        reason: "retryable-failure",
      },
      "harness factory triage --linear-issue ENG-1 --apply",
    );
    expect(reaction).toMatchObject({
      kind: "invoke",
      scheduling: "retry",
      command: "harness factory triage --linear-issue ENG-1 --apply",
    });
    expect(JSON.stringify(reaction)).not.toMatch(/API_KEY|token|secret/i);
  });
});
