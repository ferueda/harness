import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkItemContext } from "../work-item/schema.ts";
import {
  implementationPlanPath,
  inspectImplementationSource,
  resolveImplementationSource,
  verifyImplementationSource,
  type ImplementationSource,
} from "./source.ts";

const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("implementation source resolution", () => {
  it("uses complete Linear context when no canonical plan exists", () => {
    const workspace = temporaryWorkspace();
    const workItem = validWorkItem();

    expect(resolveImplementationSource({ workspace, workItem })).toEqual({
      ok: true,
      value: { kind: "linear", workItem },
    });
  });

  it("promotes a Linear work item to its canonical merged plan", () => {
    const workspace = temporaryWorkspace();
    const workItem = validWorkItem();
    const path = implementationPlanPath(workItem.reference);
    writePlan(workspace, path, "# Implement FER-323\n");

    expect(resolveImplementationSource({ workspace, workItem })).toEqual({
      ok: true,
      value: {
        kind: "plan",
        issueReference: "FER-323",
        path,
      },
    });
  });

  it.each([
    "commentsTruncated",
    "labelsTruncated",
    "relationsTruncated",
    "linksTruncated",
    "childrenTruncated",
  ] as const)("rejects Linear context with %s", (flag) => {
    const workspace = temporaryWorkspace();
    const workItem = validWorkItem();
    workItem.completeness[flag] = true;

    const result = resolveImplementationSource({ workspace, workItem });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining(`completeness.${flag}`),
    });
  });
});

describe("implementation source inspection", () => {
  it("rejects a missing explicit plan without falling back to Linear", () => {
    const workspace = temporaryWorkspace();

    expect(
      inspectImplementationSource({
        workspace,
        source: {
          kind: "plan",
          issueReference: "FER-323",
          path: "dev/plans/FER-323.md",
        },
      }),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("Invalid implementation source dev/plans/FER-323.md"),
    });
  });

  it("rejects a noncanonical explicit plan path", () => {
    const workspace = temporaryWorkspace();
    const source = {
      kind: "plan",
      issueReference: "FER-323",
      path: "dev/plans/OTHER.md",
    } as ImplementationSource;

    expect(inspectImplementationSource({ workspace, source })).toMatchObject({
      ok: false,
      error: expect.stringContaining("must be the canonical plan path"),
    });
  });

  it("rejects a malformed explicit plan issue reference", () => {
    const workspace = temporaryWorkspace();
    const source = {
      kind: "plan",
      issueReference: "fer-323",
      path: "dev/plans/fer-323.md",
    } as ImplementationSource;

    expect(inspectImplementationSource({ workspace, source })).toMatchObject({
      ok: false,
      error: expect.stringContaining("must be an uppercase issue reference"),
    });
  });

  it("rejects an empty or symlinked canonical plan", () => {
    const emptyWorkspace = temporaryWorkspace();
    writePlan(emptyWorkspace, "dev/plans/FER-323.md", " \n");
    expect(inspectPlan(emptyWorkspace)).toMatchObject({
      ok: false,
      error: expect.stringContaining("is empty"),
    });

    const linkedWorkspace = temporaryWorkspace();
    const external = join(linkedWorkspace, "outside.md");
    writeFileSync(external, "# External\n");
    const linkedPath = join(linkedWorkspace, "dev/plans/FER-323.md");
    mkdirSync(dirname(linkedPath), { recursive: true });
    symlinkSync(external, linkedPath);
    expect(inspectPlan(linkedWorkspace)).toMatchObject({
      ok: false,
      error: expect.stringContaining("must be a regular file"),
    });
  });

  it("rejects a canonical plan reached through a parent symlink outside the workspace", () => {
    const workspace = temporaryWorkspace();
    const external = temporaryWorkspace();
    writePlan(external, "plans/FER-323.md", "# External plan\n");
    symlinkSync(external, join(workspace, "dev"), "dir");

    expect(inspectPlan(workspace)).toMatchObject({
      ok: false,
      error: expect.stringContaining("resolves outside the supplied workspace"),
    });
  });

  it("detects a selected plan change after the initial snapshot", () => {
    const workspace = temporaryWorkspace();
    writePlan(workspace, "dev/plans/FER-323.md", "# Initial\n");
    const inspected = inspectPlan(workspace);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;

    writePlan(workspace, "dev/plans/FER-323.md", "# Changed\n");

    expect(verifyImplementationSource(workspace, inspected.value)).toMatchObject({
      ok: false,
      error: expect.stringContaining("content no longer matches its initial snapshot"),
    });
  });
});

function inspectPlan(workspace: string) {
  return inspectImplementationSource({
    workspace,
    source: {
      kind: "plan",
      issueReference: "FER-323",
      path: "dev/plans/FER-323.md",
    },
  });
}

function temporaryWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "harness-implementation-source-"));
  temporaryPaths.push(workspace);
  return workspace;
}

function writePlan(workspace: string, path: string, contents: string): void {
  const file = join(workspace, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents, "utf8");
}

function validWorkItem(): WorkItemContext {
  return {
    id: "issue-323",
    reference: "FER-323",
    title: "Build the implementation operation",
    description: "Apply one trusted source.",
    url: "https://linear.app/issue/FER-323",
    state: "Open",
    labels: ["Implement"],
    comments: [],
    parent: null,
    children: [],
    duplicateOf: null,
    blockedBy: [],
    related: [],
    links: [],
    createdAt: "2026-07-29T20:00:00.000Z",
    updatedAt: "2026-07-29T21:00:00.000Z",
    completeness: {
      commentsTruncated: false,
      labelsTruncated: false,
      relationsTruncated: false,
      linksTruncated: false,
      childrenTruncated: false,
    },
  };
}
