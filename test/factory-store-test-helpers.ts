import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { defaultFactoryStoreRoot } from "../lib/factory-store.ts";

type FactoryHarnessInput = {
  bin: string;
  args: string[];
  cwd?: string;
  input?: string;
  env?: NodeJS.ProcessEnv;
};

/** Runs a production factory CLI path against an isolated durable store. */
export function runFactoryHarness(input: FactoryHarnessInput) {
  let result: SpawnSyncReturns<string>;
  const factoryStoreRoot = factoryStoreRootFromArgs(input.args);
  const storeRoot = withTempFactoryStore(
    factoryStoreRoot ? { ...input.env, HARNESS_FACTORY_STORE_ROOT: factoryStoreRoot } : input.env,
    ({ env, storeRoot: temporaryStoreRoot }) => {
      result = spawnSync(process.execPath, [input.bin, ...input.args], {
        cwd: input.cwd,
        encoding: "utf8",
        input: input.input,
        env,
      });
      return temporaryStoreRoot;
    },
  );
  assertDefaultRunOutputStaysInStore(input.args, result!.stdout ?? "", storeRoot);
  return { result: result!, storeRoot };
}

export function createFactoryStoreRoot(): string {
  return mkdtempSync(join(tmpdir(), "harness-factory-store-"));
}

/** Scopes a factory command to temp storage and detects accidental default-store writes. */
export function withTempFactoryStore<T>(
  inputEnv: NodeJS.ProcessEnv | undefined,
  run: (input: { env: NodeJS.ProcessEnv; storeRoot: string }) => T,
): T {
  const env = { ...process.env, ...inputEnv };
  const storeRoot = env.HARNESS_FACTORY_STORE_ROOT ?? createFactoryStoreRoot();
  const defaultStoreRoot = defaultFactoryStoreRoot(env);
  const before = directoryFingerprint(defaultStoreRoot);
  try {
    return run({ env: { ...env, HARNESS_FACTORY_STORE_ROOT: storeRoot }, storeRoot });
  } finally {
    const after = directoryFingerprint(defaultStoreRoot);
    if (after !== before) {
      throw new Error(`Factory test command wrote outside its temp store: ${defaultStoreRoot}`);
    }
  }
}

/** Fails tests when a durable run/state artifact escapes its configured test store. */
export function assertPathInsideFactoryStore(storeRoot: string, path: string): void {
  const root = resolve(storeRoot);
  const candidate = resolve(path);
  const pathRelative = relative(root, candidate);
  if (
    pathRelative === "" ||
    pathRelative === ".." ||
    pathRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(pathRelative)
  ) {
    throw new Error(`Expected durable artifact inside test factory store: ${candidate}`);
  }
}

function assertDefaultRunOutputStaysInStore(
  args: string[],
  stdout: string,
  storeRoot: string,
): void {
  let output: unknown;
  try {
    output = JSON.parse(stdout);
  } catch {
    // CLI error/help output is intentionally not JSON and never creates a run.
    return;
  }
  if (
    args.includes("--runs-dir") ||
    args.includes("--run-dir") ||
    !isRecord(output) ||
    typeof output.runDir !== "string"
  ) {
    return;
  }
  assertPathInsideFactoryStore(storeRoot, output.runDir);
}

function factoryStoreRootFromArgs(args: string[]): string | undefined {
  const index = args.indexOf("--factory-store-root");
  if (index >= 0) return args[index + 1];
  return args.find((arg) => arg.startsWith("--factory-store-root="))?.split("=", 2)[1];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function directoryFingerprint(root: string): string {
  if (!existsSync(root)) return "missing";
  const entries: string[] = [];
  const visit = (path: string, relativePath: string): void => {
    const stat = lstatSync(path);
    entries.push(`${relativePath}:${stat.size}:${stat.mtimeMs}`);
    if (!stat.isDirectory()) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      visit(join(path, entry.name), join(relativePath, entry.name));
    }
  };
  visit(root, ".");
  return entries.sort().join("|");
}
