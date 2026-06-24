import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHarnessWorkspace } from "./config.ts";

const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS_ROOT = basename(MODULE_ROOT) === "dist" ? resolve(MODULE_ROOT, "..") : MODULE_ROOT;
const PACKAGED_SKILLS_DIR = resolve(HARNESS_ROOT, "skills");
const LOCAL_SKILLS_DIR = ".agents/skills";
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type InstallSkillOptions = {
  workspace?: string;
  force?: boolean;
  dryRun?: boolean;
};

export type InstallSkillResult = {
  workspace: string;
  skill: string;
  sourcePath: string;
  targetPath: string;
  status: "installed" | "skipped" | "would_install" | "would_overwrite";
};

export function installPackagedSkill(
  skillName: string,
  options: InstallSkillOptions = {},
): InstallSkillResult {
  assertValidSkillName(skillName);

  const workspace = resolveHarnessWorkspace(options.workspace, process.cwd());
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
    throw new Error(`Workspace does not exist: ${workspace}`);
  }

  const sourcePath = resolve(PACKAGED_SKILLS_DIR, skillName);
  assertInsideDirectory(sourcePath, PACKAGED_SKILLS_DIR);
  if (!existsSync(resolve(sourcePath, "SKILL.md"))) {
    throw new Error(`Packaged skill not found: ${skillName}`);
  }

  const localSkillsRoot = resolve(workspace, LOCAL_SKILLS_DIR);
  const targetPath = resolve(localSkillsRoot, skillName);
  assertInsideDirectory(targetPath, localSkillsRoot);
  const targetExists = existsSync(targetPath);
  const result = {
    workspace,
    skill: skillName,
    sourcePath,
    targetPath,
    status: resolveInstallStatus(targetExists, Boolean(options.force), Boolean(options.dryRun)),
  } satisfies InstallSkillResult;

  if (result.status !== "installed") return result;
  mkdirSync(localSkillsRoot, { recursive: true });
  installDirectory(sourcePath, targetPath, localSkillsRoot, skillName, targetExists);
  return result;
}

function assertValidSkillName(skillName: string): void {
  if (!SKILL_NAME_PATTERN.test(skillName)) {
    throw new Error(`Invalid skill name: ${skillName}`);
  }
}

function assertInsideDirectory(path: string, root: string): void {
  const relativePath = relative(root, path);
  if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Resolved skill path escapes root: ${path}`);
  }
}

function installDirectory(
  sourcePath: string,
  targetPath: string,
  parentPath: string,
  skillName: string,
  targetExists: boolean,
): void {
  const tempPath = createCopyTempPath(parentPath, skillName);

  try {
    cpSync(sourcePath, tempPath, { recursive: true });
    if (targetExists) {
      replaceDirectory(tempPath, targetPath, parentPath, skillName);
      return;
    }
    renameSync(tempPath, targetPath);
  } catch (error) {
    rmSync(tempPath, { recursive: true, force: true });
    throw error;
  }
}

function replaceDirectory(
  tempPath: string,
  targetPath: string,
  parentPath: string,
  skillName: string,
): void {
  const backupPath = createBackupPath(parentPath, skillName);
  let backupCreated = false;

  try {
    renameSync(targetPath, backupPath);
    backupCreated = true;
    renameSync(tempPath, targetPath);
    rmSync(backupPath, { recursive: true, force: true });
  } catch (error) {
    if (backupCreated && !existsSync(targetPath)) {
      renameSync(backupPath, targetPath);
    }
    throw error;
  }
}

function createCopyTempPath(parentPath: string, skillName: string): string {
  // Reserve a collision-free sibling path; cpSync will create the actual directory tree.
  const tempPath = mkdtempSync(resolve(parentPath, `${skillName}.tmp-`));
  rmSync(tempPath, { recursive: true, force: true });
  return tempPath;
}

function createBackupPath(parentPath: string, skillName: string): string {
  return resolve(parentPath, `${skillName}.backup-${process.pid}-${Date.now()}`);
}

function resolveInstallStatus(
  targetExists: boolean,
  force: boolean,
  dryRun: boolean,
): InstallSkillResult["status"] {
  if (!targetExists) return dryRun ? "would_install" : "installed";
  if (!force) return "skipped";
  return dryRun ? "would_overwrite" : "installed";
}
