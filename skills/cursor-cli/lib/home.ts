import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LAUNCHER_COMMAND } from "./command.ts";
import { agentJson } from "./runner.ts";
import { collapseHomePath } from "./output.ts";

const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "cursor-cli.ts");

export async function buildHomeEnvelope(workspace: string): Promise<Record<string, unknown>> {
  const envelope: Record<string, unknown> = {
    bin: collapseHomePath(SCRIPT_PATH),
    description: "Invoke Cursor Agent headlessly for agent-to-agent tasks",
  };

  const status = agentJson(["status", "--format", "json"], workspace);
  if (status.error) {
    return {
      ...envelope,
      status: "failed",
      error: "Could not reach Cursor CLI",
      help: [
        "Install: curl https://cursor.com/install -fsS | bash",
        "Run `agent login` or set CURSOR_API_KEY",
      ],
    };
  }

  const auth = status.data;
  if (auth?.isAuthenticated) {
    const userInfo = objectValue(auth.userInfo);
    envelope.auth = stringValue(userInfo?.email) ?? "authenticated";
  } else {
    envelope.auth = "not authenticated";
    envelope.help = ["Run `agent login` locally or set CURSOR_API_KEY for CI"];
    return envelope;
  }

  const about = agentJson(["about", "--format", "json"], workspace);
  if (about.data?.cliVersion) envelope.cliVersion = about.data.cliVersion;
  if (about.data?.model) envelope.defaultModel = about.data.model;

  envelope.help = [
    `Run \`${LAUNCHER_COMMAND} "your prompt"\` to invoke a subagent`,
    `Run \`${LAUNCHER_COMMAND} --help\` for flags`,
  ];

  return envelope;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
