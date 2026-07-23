import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RepositoryError } from "./error.ts";

const execFileAsync = promisify(execFile);
const SETUP_ENVIRONMENT_KEYS = Object.freeze([
  "COREPACK_HOME",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NODE_EXTRA_CA_CERTS",
  "PATH",
  "PNPM_CONFIG_STORE_DIR",
  "PNPM_HOME",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TMPDIR",
  "XDG_CACHE_HOME",
] as const);

export function repositorySetupEnvironment(
  source: NodeJS.ProcessEnv,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {
    CI: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of SETUP_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return Object.freeze(environment);
}

export async function runRepositorySetup(input: {
  workspace: string;
  command: readonly string[];
  timeoutMs: number;
  environment: NodeJS.ProcessEnv;
}): Promise<void> {
  const [executable, ...args] = input.command;
  if (!executable) {
    throw new RepositoryError("Repository setup command must not be empty.", "invalid_input");
  }

  try {
    await execFileAsync(executable, args, {
      cwd: input.workspace,
      env: { ...repositorySetupEnvironment(input.environment) },
      timeout: input.timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    const diagnostic = setupDiagnostic(error);
    throw new RepositoryError(
      `Repository setup failed${diagnostic ? `: ${diagnostic}` : "."}`,
      "setup_failed",
      { cause: error },
    );
  }
}

function setupDiagnostic(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const record = error as Error & {
    killed?: boolean;
    signal?: string;
    stderr?: string | Buffer;
  };
  if (record.killed) {
    return record.signal ? `terminated by ${record.signal}` : "timed out";
  }
  const stderr = String(record.stderr ?? "").trim();
  if (stderr) return stderr.slice(-4_000);
  return error.message;
}
