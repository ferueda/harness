import type { FactoryImplementationRunContext } from "./factory-implementation-run-context.ts";
import type { FactoryLifecycleEvent } from "./factory-lifecycle-events.ts";

export const MAX_FACTORY_IMPLEMENTATION_RESTART_GUIDANCE_BYTES = 32 * 1024;

export function validateFactoryImplementationRestartGuidance(guidance: string): string {
  if (!guidance.trim()) throw new Error("Factory implementation restart guidance is blank");
  if (Buffer.byteLength(guidance, "utf8") > MAX_FACTORY_IMPLEMENTATION_RESTART_GUIDANCE_BYTES)
    throw new Error(
      `Factory implementation restart guidance exceeds ${MAX_FACTORY_IMPLEMENTATION_RESTART_GUIDANCE_BYTES} bytes`,
    );
  return guidance;
}

export function assertFactoryImplementationRestartGuidanceBinding(input: {
  ctx: FactoryImplementationRunContext;
  events: FactoryLifecycleEvent[];
}): void {
  const request = input.events.findLast(
    (event) => event.type === "implementation.requested" && event.phaseRunId === input.ctx.runId,
  );
  if (!request || request.type !== "implementation.requested")
    throw new Error("Factory implementation phase has no matching request");
  if (!sameArtifactRef(request.data.restartGuidance, input.ctx.identity.restartGuidance))
    throw new Error("Factory implementation restart guidance conflicts with its request");
}

function sameArtifactRef(
  left: { base: string; path: string; sha256: string } | undefined,
  right: { base: string; path: string; sha256: string } | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.base === right.base && left.path === right.path && left.sha256 === right.sha256;
}
