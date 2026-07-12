import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const FactoryPhaseRunIdentitySchema = z
  .object({
    version: z.literal(1),
    phaseRunId: z.string().min(1),
    phase: z.literal("triage"),
    workItemKey: z.string().min(1),
    workspace: z.string().min(1),
    projectId: z.string().min(1),
    factoryStateRoot: z.string().min(1),
  })
  .strict();
export type FactoryPhaseRunIdentity = z.infer<typeof FactoryPhaseRunIdentitySchema>;

export function factoryPhaseRunId(input: {
  workItemKey: string;
  phase: string;
  requestId: string;
}): string {
  const digest = createHash("sha256")
    .update(`${input.workItemKey}\0${input.phase}\0${input.requestId}`)
    .digest("hex")
    .slice(0, 20);
  return `${input.phase}-${digest}`;
}

export function writeFactoryPhaseRunIdentity(
  runDir: string,
  identity: FactoryPhaseRunIdentity,
): void {
  const parsed = FactoryPhaseRunIdentitySchema.parse(identity);
  writeFileSync(join(runDir, "context/phase-run.json"), `${JSON.stringify(parsed, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

export function readFactoryPhaseRunIdentity(runDir: string): FactoryPhaseRunIdentity {
  return FactoryPhaseRunIdentitySchema.parse(
    JSON.parse(readFileSync(join(runDir, "context/phase-run.json"), "utf8")),
  );
}
