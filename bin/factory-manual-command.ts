import type { FactoryReaction } from "../lib/factory-state-machine.ts";

export type FactoryManualCommandProvenance = {
  workspace: string;
  itemFile?: string;
  linearIssue?: string;
  factoryStoreRoot?: string;
  factoryStoreProjectId?: string;
};

export function decorateFactoryReaction(
  reaction: FactoryReaction | null,
  provenance: FactoryManualCommandProvenance | undefined,
): FactoryReaction | null {
  if (!reaction) return null;
  const cleanReaction = withoutCommand(reaction);
  const station =
    reaction.kind === "invoke" || reaction.kind === "start-phase" ? reaction.phase : null;
  if (!station || !provenance) return cleanReaction;
  const command = factoryManualCommand(station, provenance);
  return command ? { ...cleanReaction, command } : cleanReaction;
}

function factoryManualCommand(
  station: "triage" | "planning" | "implementation",
  provenance: FactoryManualCommandProvenance,
): string {
  const args = ["harness", "factory"];
  if (station === "triage") args.push("triage");
  else if (station === "planning") args.push("planning", "run");
  else args.push("implementation", "run");
  args.push("--workspace", provenance.workspace);
  if (provenance.linearIssue) args.push("--linear-issue", provenance.linearIssue, "--apply");
  else if (provenance.itemFile) args.push("--item-file", provenance.itemFile);
  if (provenance.factoryStoreRoot) args.push("--factory-store-root", provenance.factoryStoreRoot);
  if (provenance.factoryStoreProjectId)
    args.push("--factory-store-project-id", provenance.factoryStoreProjectId);
  return args.map(shellArg).join(" ");
}

function withoutCommand<T extends FactoryReaction>(reaction: T): T {
  if (!("command" in reaction)) return reaction;
  const { command: _command, ...without } = reaction;
  return without as T;
}

function shellArg(value: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}
