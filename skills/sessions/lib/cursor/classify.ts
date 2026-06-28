export {
  AUTOMATION_MARKERS,
  AUTOMATION_WORKER_MARKER,
  hasAutomationMarker,
} from "../core/classify.ts";

import { AUTOMATION_WORKER_MARKER, hasAutomationMarker } from "../core/classify.ts";

export function isAutomationSession(firstUserQuery = ""): boolean {
  return hasAutomationMarker(firstUserQuery);
}

export function isSubagentSession(chatId: string, firstUserQuery = ""): boolean {
  return chatId.startsWith("agent-") || firstUserQuery.includes(AUTOMATION_WORKER_MARKER);
}
