import { expect, test } from "vitest";
import {
  decodeWorkspacePathFromKey,
  extractWorkspacePathFromUserInfo,
} from "../../../lib/sessions/cursor/paths.ts";

test("decodes simple Cursor workspace keys", () => {
  expect(decodeWorkspacePathFromKey("Users-example-dev-harness")).toEqual({
    path: "/Users/example/dev/harness",
    confidence: "decoded",
    source: "project-key",
  });
});

test("treats hyphenated workspace decode as lossy unless explicit path exists", () => {
  expect(decodeWorkspacePathFromKey("Users-alice-dev-my-repo")).toEqual({
    path: "/Users/alice/dev/my/repo",
    confidence: "decoded",
    source: "project-key",
  });
  expect(extractWorkspacePathFromUserInfo("Workspace Path: /Users/alice/dev/my-repo\n")).toEqual({
    path: "/Users/alice/dev/my-repo",
    confidence: "explicit",
    source: "transcript",
  });
});
