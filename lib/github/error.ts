export const GITHUB_PUBLICATION_ERROR_CODES = [
  "invalid-input",
  "run-conflict",
  "changes-mismatch",
  "git-failed",
  "remote-conflict",
  "invalid-response",
  "github-failed",
  "github-conflict",
] as const;

export type GitHubPublicationErrorCode = (typeof GITHUB_PUBLICATION_ERROR_CODES)[number];

export class GitHubPublicationError extends Error {
  readonly code: GitHubPublicationErrorCode;

  constructor(code: GitHubPublicationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GitHubPublicationError";
    this.code = code;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function redactSecrets(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets.flatMap(secretForms).filter(Boolean)) {
    redacted = redacted.replaceAll(secret, "[REDACTED]");
  }
  return redacted;
}

function secretForms(secret: string): readonly string[] {
  if (!secret) return [];
  return Object.freeze([
    secret,
    encodeURIComponent(secret),
    Buffer.from(secret).toString("base64"),
    Buffer.from(`x-access-token:${secret}`).toString("base64"),
  ]);
}
