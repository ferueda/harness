export type FactoryRunStartedStation = "triage" | "planning" | "implementation";

export type FactoryRunStartedProgress = {
  harnessFactory: "run-started";
  station: FactoryRunStartedStation;
  runId: string;
  runDir: string;
  workspace: string;
};

/**
 * Emit one always-on stderr JSON progress line after factory run context
 * creation. This is CLI progress only — not a WorkflowEvent and not written
 * to events.jsonl.
 */
export function announceFactoryRunStarted(
  input: Omit<FactoryRunStartedProgress, "harnessFactory">,
  write: (line: string) => void = (line) => {
    process.stderr.write(`${line}\n`);
  },
): FactoryRunStartedProgress {
  const progress: FactoryRunStartedProgress = {
    harnessFactory: "run-started",
    station: input.station,
    runId: input.runId,
    runDir: input.runDir,
    workspace: input.workspace,
  };
  write(JSON.stringify(progress));
  return progress;
}
