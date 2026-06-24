import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentJson } from "./runner.ts";
import { collapseHomePath } from "./output.ts";

const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "cursor-agent.ts");

export async function buildHomeEnvelope(workspace: string): Promise<Record<string, unknown>> {
  const envelope: Record<string, any> = {
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
    envelope.auth = auth.userInfo?.email ?? "authenticated";
  } else {
    envelope.auth = "not authenticated";
    envelope.help = ["Run `agent login` locally or set CURSOR_API_KEY for CI"];
    return envelope;
  }

  const about = agentJson(["about", "--format", "json"], workspace);
  if (about.data?.cliVersion) envelope.cliVersion = about.data.cliVersion;
  if (about.data?.model) envelope.defaultModel = about.data.model;

  envelope.help = [
    'Run `cursor-agent "your prompt"` to invoke a subagent',
    "Run `cursor-agent --help` for flags",
  ];

  return envelope;
}
