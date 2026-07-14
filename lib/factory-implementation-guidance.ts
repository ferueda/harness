export const MAX_FACTORY_IMPLEMENTATION_RESTART_GUIDANCE_BYTES = 32 * 1024;

export function validateFactoryImplementationRestartGuidance(guidance: string): string {
  if (!guidance.trim()) throw new Error("Factory implementation restart guidance is blank");
  if (Buffer.byteLength(guidance, "utf8") > MAX_FACTORY_IMPLEMENTATION_RESTART_GUIDANCE_BYTES)
    throw new Error(
      `Factory implementation restart guidance exceeds ${MAX_FACTORY_IMPLEMENTATION_RESTART_GUIDANCE_BYTES} bytes`,
    );
  return guidance;
}
