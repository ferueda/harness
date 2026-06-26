export const AUTOMATION_WORKER_MARKER = "You are running as an automated worker";
export const AUTOMATION_MARKERS = [
  AUTOMATION_WORKER_MARKER,
  "Hard requirements for your FINAL answer",
] as const;

export function isAutomationSession(firstUserQuery = ""): boolean {
  return AUTOMATION_MARKERS.some((marker) => firstUserQuery.includes(marker));
}

export function isSubagentSession(chatId: string, firstUserQuery = ""): boolean {
  return chatId.startsWith("agent-") || firstUserQuery.includes(AUTOMATION_WORKER_MARKER);
}
