import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { createFactoryArtifactRef, type FactoryArtifactRef } from "./factory-artifact-ref.ts";
import {
  FactoryImplementationReviewCheckpointSchema,
  authenticateFactoryImplementationReviewCheckpoint,
  factoryImplementationReviewContractFingerprint,
  type FactoryImplementationReviewCheckpointIdentity,
} from "./factory-implementation-review-checkpoint.ts";

describe("Factory implementation review checkpoint", () => {
  test.each([
    ["phaseRunId", "other-run"],
    ["reviewRound", 2],
    ["candidateAttempt", 2],
    ["base", "other-base"],
    ["commit", "other-commit"],
    ["tree", "other-tree"],
  ] as const)("does not reuse roles after %s changes", (field, value) => {
    const fixture = checkpointFixture();
    const authenticated = authenticateFactoryImplementationReviewCheckpoint({
      ref: fixture.checkpoint,
      roots: fixture.roots,
      identity: { ...fixture.identity, [field]: value },
    });
    expect(authenticated.roles).toEqual({});
  });

  test("does not reuse roles after the persisted execution profile changes", () => {
    const fixture = checkpointFixture();
    const authenticated = authenticateFactoryImplementationReviewCheckpoint({
      ref: fixture.checkpoint,
      roots: fixture.roots,
      identity: {
        ...fixture.identity,
        executionProfile: { provider: "cursor", model: "different-model" },
      },
    });
    expect(authenticated.roles).toEqual({});
  });

  test("invalidates only the role whose review contract changed", () => {
    const fixture = checkpointFixture({ implementationContract: "0".repeat(64) });
    const authenticated = authenticateFactoryImplementationReviewCheckpoint({
      ref: fixture.checkpoint,
      roots: fixture.roots,
      identity: fixture.identity,
    });
    expect(authenticated.roles.implementation).toBeUndefined();
    expect(authenticated.roles.quality?.review.verdict).toBe("pass");
  });

  test.each(["checkpoint", "prompt", "output"] as const)(
    "rejects %s artifact tampering",
    (artifact) => {
      const fixture = checkpointFixture();
      writeFileSync(fixture.paths[artifact], "tampered\n");
      expect(() =>
        authenticateFactoryImplementationReviewCheckpoint({
          ref: fixture.checkpoint,
          roots: fixture.roots,
          identity: fixture.identity,
        }),
      ).toThrow(artifact === "checkpoint" ? /hash mismatch/ : /hash mismatch/);
    },
  );

  test("rejects schema-valid output whose terminal verdict contract is false", () => {
    const fixture = checkpointFixture({
      implementationReview: {
        verdict: "pass",
        summary: "contradictory",
        findings: [finding(true)],
      },
    });
    expect(() =>
      authenticateFactoryImplementationReviewCheckpoint({
        ref: fixture.checkpoint,
        roots: fixture.roots,
        identity: fixture.identity,
      }),
    ).toThrow(/pass verdict has a must_fix finding/);
  });

  test("treats an unsupported checkpoint version as incompatible", () => {
    const fixture = checkpointFixture({ version: 2 });
    expect(
      authenticateFactoryImplementationReviewCheckpoint({
        ref: fixture.checkpoint,
        roots: fixture.roots,
        identity: fixture.identity,
      }).roles,
    ).toEqual({});
  });
});

function checkpointFixture(
  options: {
    version?: number;
    implementationContract?: string;
    implementationReview?: unknown;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "factory-review-checkpoint-"));
  const identity: FactoryImplementationReviewCheckpointIdentity = {
    phaseRunId: "run-1",
    reviewRound: 1,
    candidateAttempt: 1,
    base: "base",
    commit: "commit",
    tree: "tree",
    executionProfile: { provider: "cursor", model: "reviewer" },
  };
  const implementationPrompt = join(root, "implementation-review.prompt.md");
  const implementationOutput = join(root, "implementation-review.json");
  const qualityPrompt = join(root, "quality-review.prompt.md");
  const qualityOutput = join(root, "quality-review.json");
  writeFileSync(implementationPrompt, "implementation prompt\n");
  writeFileSync(
    implementationOutput,
    `${JSON.stringify(options.implementationReview ?? passReview())}\n`,
  );
  writeFileSync(qualityPrompt, "quality prompt\n");
  writeFileSync(qualityOutput, `${JSON.stringify(passReview())}\n`);
  const artifact = (path: string): FactoryArtifactRef =>
    createFactoryArtifactRef({ base: "factory-store", root, path: relative(root, path) });
  const checkpointPath = join(root, "checkpoint.json");
  const checkpointValue = {
    version: options.version ?? 1,
    ...identity,
    roles: {
      implementation: {
        contractSha256:
          options.implementationContract ??
          factoryImplementationReviewContractFingerprint("implementation"),
        prompt: artifact(implementationPrompt),
        output: artifact(implementationOutput),
      },
      quality: {
        contractSha256: factoryImplementationReviewContractFingerprint("quality"),
        prompt: artifact(qualityPrompt),
        output: artifact(qualityOutput),
      },
    },
  };
  const serialized =
    checkpointValue.version === 1
      ? FactoryImplementationReviewCheckpointSchema.parse(checkpointValue)
      : checkpointValue;
  writeFileSync(checkpointPath, `${JSON.stringify(serialized, null, 2)}\n`);
  return {
    identity,
    roots: { "factory-store": root, repository: root } as const,
    checkpoint: artifact(checkpointPath),
    paths: {
      checkpoint: checkpointPath,
      prompt: implementationPrompt,
      output: implementationOutput,
    },
  };
}

function passReview() {
  return { verdict: "pass", summary: "ok", findings: [] };
}

function finding(mustFix: boolean) {
  return {
    title: "Finding",
    severity: "High",
    location: "file.ts",
    issue: "Issue",
    recommendation: "Fix",
    rationale: "Required",
    must_fix: mustFix,
  };
}
