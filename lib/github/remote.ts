import { GitHubPublicationError } from "./error.ts";
import type { GitHubRepositoryIdentity } from "./types.ts";

const SCP_REMOTE = /^git@github\.com:([^/]+)\/([^/]+)$/i;
const REPOSITORY_PART = /^[A-Za-z0-9_.-]+$/;

export function parseGitHubRemote(remote: string): GitHubRepositoryIdentity {
  const trimmed = remote.trim();
  const scp = SCP_REMOTE.exec(trimmed);
  if (scp) return repositoryIdentity(scp[1] ?? "", scp[2] ?? "");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw invalidRemote();
  }

  if (
    !["https:", "ssh:"].includes(url.protocol) ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw invalidRemote();
  }
  if (url.protocol === "https:" && url.username) throw invalidRemote();
  if (url.protocol === "ssh:" && url.username !== "git") throw invalidRemote();

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) throw invalidRemote();
  return repositoryIdentity(parts[0] ?? "", parts[1] ?? "");
}

function repositoryIdentity(owner: string, repositoryWithSuffix: string): GitHubRepositoryIdentity {
  const repository = repositoryWithSuffix.endsWith(".git")
    ? repositoryWithSuffix.slice(0, -4)
    : repositoryWithSuffix;
  if (
    !owner ||
    !repository ||
    !REPOSITORY_PART.test(owner) ||
    !REPOSITORY_PART.test(repository) ||
    owner === "." ||
    owner === ".." ||
    repository === "." ||
    repository === ".."
  ) {
    throw invalidRemote();
  }
  return Object.freeze({
    owner,
    repository,
    httpsRemote: `https://github.com/${owner}/${repository}.git`,
  });
}

function invalidRemote(): GitHubPublicationError {
  return new GitHubPublicationError(
    "invalid-input",
    "GitHub publication requires a credential-free github.com SSH or HTTPS repository remote.",
  );
}
