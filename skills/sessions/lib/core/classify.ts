export const AUTOMATION_WORKER_MARKER = "You are running as an automated worker";
export const AUTOMATION_MARKERS = [
  AUTOMATION_WORKER_MARKER,
  "Hard requirements for your FINAL answer",
] as const;

export function hasAutomationMarker(value = ""): boolean {
  return AUTOMATION_MARKERS.some((marker) => value.includes(marker));
}
