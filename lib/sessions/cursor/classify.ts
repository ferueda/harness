const AUTOMATION_WORKER_MARKER = "You are running as an automated worker";
const AUTOMATION_MARKERS = [AUTOMATION_WORKER_MARKER, "Hard requirements for your FINAL answer"];

export function isAutomationSession(firstUserQuery = ""): boolean {
  return AUTOMATION_MARKERS.some((marker) => firstUserQuery.includes(marker));
}

export function isSubagentSession(chatId: string, firstUserQuery = ""): boolean {
  return chatId.startsWith("agent-") || firstUserQuery.includes(AUTOMATION_WORKER_MARKER);
}
