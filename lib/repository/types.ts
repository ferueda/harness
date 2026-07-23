import type { RepositoryRunsConfigInput } from "./config-schema.ts";

export type RepositoryBase = Readonly<{
  remote: string;
  baseRef: string;
  baseSha: string;
}>;

export type RepositoryRun = Readonly<{
  version: 1;
  id: string;
  workspace: string;
  remote: string;
  baseRef: string;
  baseSha: string;
  branch: string;
}>;

export type RepositoryChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "conflicted";

export type RepositoryChange = Readonly<{
  path: string;
  previousPath?: string;
  status: RepositoryChangeStatus;
}>;

export type RepositoryCleanupResult = Readonly<{
  status: "released" | "already-clean";
}>;

export type RepositoryService = Readonly<{
  resolveBase(input: { baseRef: string }): Promise<RepositoryBase>;
  prepareRun(input: { id: string; base: RepositoryBase; branch: string }): Promise<RepositoryRun>;
  inspectChanges(run: RepositoryRun): Promise<readonly RepositoryChange[]>;
  cleanupRun(run: RepositoryRun): Promise<RepositoryCleanupResult>;
}>;

export type CreateRepositoryOptions = RepositoryRunsConfigInput & {
  controllerWorkspace: string;
  poolDirectory: string;
  ownerId?: string;
  setupEnvironment?: NodeJS.ProcessEnv;
};
