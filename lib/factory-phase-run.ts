import { createHash } from "node:crypto";

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
