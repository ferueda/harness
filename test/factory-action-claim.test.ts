import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { withFactoryActionClaim } from "../lib/factory-action-claim.ts";

test("Factory action claim permits only one provider side effect", async () => {
  const actionDir = mkdtempSync(join(tmpdir(), "factory-action-claim-"));
  const resultPath = join(actionDir, "action-result.json");
  let releaseProvider!: () => void;
  const providerGate = new Promise<void>((resolve) => {
    releaseProvider = resolve;
  });
  const provider = vi.fn(async () => {
    await providerGate;
    writeFileSync(resultPath, "{}\n");
    return "owner";
  });

  const owner = withFactoryActionClaim({ actionDir, resultPath, action: provider });
  const follower = withFactoryActionClaim({ actionDir, resultPath, action: provider });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(provider).toHaveBeenCalledOnce();
  releaseProvider();

  await expect(owner).resolves.toBe("owner");
  await expect(follower).resolves.toBeUndefined();
  expect(provider).toHaveBeenCalledOnce();
  expect(existsSync(join(actionDir, "action-claim.json"))).toBe(false);
});
