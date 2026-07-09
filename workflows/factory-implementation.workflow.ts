import {
  FACTORY_IMPLEMENTATION_DRY_RUN_ERROR,
  FactoryImplementationRunError,
  type FactoryImplementationRunContext,
  type FactoryImplementationRunMeta,
} from "../lib/factory-implementation-run-context.ts";
import {
  renderFactoryImplementationChangeReviewHandoff,
  renderFactoryImplementationPrompt,
} from "../lib/prompts/index.ts";

export const meta = { name: "factory-implementation" };

export async function run(
  ctx: FactoryImplementationRunContext,
): Promise<FactoryImplementationRunMeta> {
  if (!ctx.dryRun) {
    throw new FactoryImplementationRunError(FACTORY_IMPLEMENTATION_DRY_RUN_ERROR);
  }

  const promptInput = {
    implementationInput: ctx.implementationInput,
    implementerAgent: ctx.implementerAgent,
  };
  ctx.writeImplementationArtifacts({
    prompt: renderFactoryImplementationPrompt(promptInput),
    changeReviewHandoff: renderFactoryImplementationChangeReviewHandoff(promptInput),
  });
  return ctx.export();
}
