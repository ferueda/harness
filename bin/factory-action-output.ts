import type { FactoryReaction } from "../lib/factory-state-machine.ts";

export type FactoryActionOutput = {
  outcome: "action-completed" | "waiting" | "complete" | "failed";
  phase: "triage" | "planning" | "implementation";
  phaseRunId?: string;
  action?: { handler: string; attempt: number; eventId: string };
  next: FactoryReaction;
  linearApplied: boolean;
};

export function formatFactoryActionOutput(input: {
  phase: FactoryActionOutput["phase"];
  phaseRunId?: string;
  action?: FactoryActionOutput["action"];
  next: FactoryReaction;
  linearApplied: boolean;
}): FactoryActionOutput {
  const outcome = input.action
    ? "action-completed"
    : input.next.kind === "wait" && input.next.reason === "complete"
      ? "complete"
      : input.next.kind === "wait" && input.next.reason === "failed"
        ? "failed"
        : "waiting";
  return {
    outcome,
    phase: input.phase,
    ...(input.phaseRunId ? { phaseRunId: input.phaseRunId } : {}),
    ...(input.action ? { action: input.action } : {}),
    next: input.next,
    linearApplied: input.linearApplied,
  };
}

export function withManualCommand(reaction: FactoryReaction, command: string): FactoryReaction {
  return reaction.kind === "invoke" ? { ...reaction, command } : reaction;
}
