export const HANDOFF_CONFLICT_ERROR = "Use only one handoff input";
export const HANDOFF_STDIN_CONFLICT_ERROR =
  "Use only one handoff input: --handoff or --handoff-stdin";
export const HANDOFF_STDIN_EMPTY_ERROR = "--handoff-stdin requires non-empty stdin";
export const HANDOFF_STDIN_TTY_ERROR = "--handoff-stdin requires piped stdin";
export const HANDOFF_TEXT_EMPTY_ERROR = "Handoff text must not be empty";

export function assertPipedHandoffStdin(isTty: boolean | undefined): void {
  if (isTty) {
    throw new Error(HANDOFF_STDIN_TTY_ERROR);
  }
}

export function assertNonEmptyHandoffStdin(text: string): void {
  assertNonBlankText(text, HANDOFF_STDIN_EMPTY_ERROR);
}

export function assertNonEmptyHandoffText(text: string): void {
  assertNonBlankText(text, HANDOFF_TEXT_EMPTY_ERROR);
}

function assertNonBlankText(text: string, message: string): void {
  if (!text.trim()) {
    throw new Error(message);
  }
}
