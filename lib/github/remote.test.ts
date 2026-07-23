import { describe, expect, it } from "vitest";
import { parseGitHubRemote } from "./remote.ts";

describe("parseGitHubRemote", () => {
  it.each([
    "https://github.com/ferueda/harness.git",
    "git@github.com:ferueda/harness.git",
    "ssh://git@github.com/ferueda/harness.git",
  ])("normalizes supported GitHub remote %s", (remote) => {
    expect(parseGitHubRemote(remote)).toEqual({
      owner: "ferueda",
      repository: "harness",
      httpsRemote: "https://github.com/ferueda/harness.git",
    });
  });

  it.each([
    "https://token@github.com/ferueda/harness.git",
    "https://github.com/ferueda/harness/extra.git",
    "https://gitlab.com/ferueda/harness.git",
    "file:///tmp/harness.git",
    "git@example.com:ferueda/harness.git",
  ])("rejects unsupported or credential-bearing remote %s", (remote) => {
    expect(() => parseGitHubRemote(remote)).toThrow(/credential-free github\.com/);
  });
});
