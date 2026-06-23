export const meta = { name: "dual-review" };

export async function run(ctx) {
  const implementation = await ctx.agent("review-implementation");
  const quality = await ctx.agent("code-quality-review", {
    prior: implementation,
  });

  return ctx.export({
    implementation,
    quality,
    verdict: ctx.aggregate([implementation, quality]),
  });
}
