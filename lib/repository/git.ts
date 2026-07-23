import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { RepositoryError, type RepositoryErrorCode } from "./error.ts";
import type { RepositoryChange, RepositoryChangeStatus } from "./types.ts";

const execFileAsync = promisify(execFile);
const FULL_GIT_SHA = /^[0-9a-f]{40,64}$/;

export function assertCredentialFreeRemote(remote: string): void {
  if (
    remote.length === 0 ||
    remote.includes("\u0000") ||
    remote.includes("\r") ||
    remote.includes("\n")
  ) {
    throw new RepositoryError(
      "Repository remote must be a non-empty single line.",
      "invalid_input",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(remote);
  } catch {
    return;
  }

  if (parsed.password || parsed.search || parsed.hash) {
    throw new RepositoryError(
      "Repository remote must not contain credentials, query parameters, or fragments.",
      "invalid_input",
    );
  }
  if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.username) {
    throw new RepositoryError(
      "Repository remote must not contain HTTP credentials.",
      "invalid_input",
    );
  }
}

export async function ensureController(input: {
  remote: string;
  workspace: string;
}): Promise<void> {
  assertCredentialFreeRemote(input.remote);
  if (!existsSync(input.workspace)) {
    await mkdir(dirname(input.workspace), { recursive: true });
    await runGit(dirname(input.workspace), [
      "clone",
      "--no-checkout",
      "--origin",
      "origin",
      "--",
      input.remote,
      input.workspace,
    ]);
  } else {
    const current = await stat(input.workspace);
    if (!current.isDirectory() || !existsSync(join(input.workspace, ".git"))) {
      throw new RepositoryError(
        `Repository controller is not a Git checkout: ${input.workspace}`,
        "controller_failed",
      );
    }
  }

  const actualRemote = await runGit(input.workspace, ["remote", "get-url", "origin"]);
  if (actualRemote !== input.remote) {
    throw new RepositoryError(
      `Repository controller remote mismatch: expected ${input.remote}, found ${actualRemote}`,
      "controller_failed",
    );
  }
}

export async function resolveRemoteBase(input: {
  remote: string;
  controllerWorkspace: string;
  baseRef: string;
}): Promise<string> {
  await ensureController({ remote: input.remote, workspace: input.controllerWorkspace });
  await runGit(input.controllerWorkspace, ["fetch", "--prune", "--no-tags", "origin"]);

  const candidates = baseCandidates(input.baseRef);
  for (const candidate of candidates) {
    try {
      const sha = await runGit(input.controllerWorkspace, [
        "rev-parse",
        "--verify",
        `${candidate}^{commit}`,
      ]);
      if (FULL_GIT_SHA.test(sha)) return sha;
    } catch {
      // Try the next unambiguous candidate.
    }
  }
  throw new RepositoryError(
    `Repository base ref was not found after fetch: ${input.baseRef}`,
    "controller_failed",
  );
}

export async function inspectGitChanges(workspace: string): Promise<readonly RepositoryChange[]> {
  const output = await runGit(
    workspace,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"],
    "inspect_failed",
  );
  return parsePorcelain(output);
}

export async function runGit(
  workspace: string,
  args: readonly string[],
  errorCode: RepositoryErrorCode = "controller_failed",
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", [...args], {
      cwd: workspace,
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout.trimEnd();
  } catch (error) {
    const record = error as Error & { stderr?: string | Buffer };
    const stderr = String(record.stderr ?? "").trim();
    throw new RepositoryError(
      stderr || (error instanceof Error ? error.message : String(error)),
      errorCode,
      { cause: error },
    );
  }
}

function baseCandidates(baseRef: string): readonly string[] {
  const ref = baseRef.trim();
  if (!ref) {
    throw new RepositoryError("Repository base ref must not be empty.", "invalid_input");
  }
  if (FULL_GIT_SHA.test(ref)) return [ref];
  if (ref.startsWith("refs/remotes/origin/")) return [ref];
  if (ref.startsWith("origin/")) return [`refs/remotes/${ref}`];
  if (ref.startsWith("refs/")) {
    throw new RepositoryError(
      "Repository base must be a remote origin branch or an exact commit SHA.",
      "invalid_input",
    );
  }
  return [`refs/remotes/origin/${ref}`];
}

function parsePorcelain(output: string): readonly RepositoryChange[] {
  if (!output) return Object.freeze([]);

  const fields = output.split("\0");
  const changes: RepositoryChange[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    if (field.length < 4 || field[2] !== " ") {
      throw new RepositoryError("Git returned an invalid porcelain record.", "inspect_failed");
    }

    const xy = field.slice(0, 2);
    const path = field.slice(3);
    const status = changeStatus(xy);
    if (status === "renamed" || status === "copied") {
      const previousPath = fields[index + 1];
      if (!previousPath) {
        throw new RepositoryError(
          "Git returned an incomplete rename or copy record.",
          "inspect_failed",
        );
      }
      changes.push(Object.freeze({ path, previousPath, status }));
      index += 1;
      continue;
    }
    changes.push(Object.freeze({ path, status }));
  }
  return Object.freeze(changes);
}

function changeStatus(xy: string): RepositoryChangeStatus {
  if (xy === "??") return "untracked";
  if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(xy)) return "conflicted";
  if (xy.includes("R")) return "renamed";
  if (xy.includes("C")) return "copied";
  if (xy.includes("D")) return "deleted";
  if (xy.includes("A")) return "added";
  return "modified";
}
