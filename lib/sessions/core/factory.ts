import type { SessionEnvironment } from "./env.ts";
import type { SessionProvider } from "./provider.ts";
import { createCodexSessionProvider } from "../codex/provider.ts";
import { createCursorSessionProvider } from "../cursor/provider.ts";

export type SessionProviderFactoryId = "cursor" | "codex" | "auto";

export function createSessionProvider(
  id: SessionProviderFactoryId,
  env: Partial<SessionEnvironment> = {},
): SessionProvider {
  switch (id) {
    case "cursor":
    case "auto":
      return createCursorSessionProvider(env);
    case "codex":
      return createCodexSessionProvider();
  }
}
