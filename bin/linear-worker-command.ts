import type { Command } from "commander";
import { runLinearAutomationWorker } from "../lib/linear-automation/worker.ts";

type LinearWorkerOptions = {
  workspace?: string;
};

export function addLinearWorkerCommand(program: Command): void {
  program
    .command("linear")
    .description("Run independent Linear automations")
    .command("worker")
    .description("Connect Linear polling, readiness, triage, and optional Spec work to Inngest")
    .option("--workspace <path>", "target repo (default: nearest harness.json or Git root)")
    .action(async (options: LinearWorkerOptions) => {
      await runLinearAutomationWorker({ workspace: options.workspace });
    });
}
