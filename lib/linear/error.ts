export type LinearErrorCode =
  | "invalid-config"
  | "invalid-reference"
  | "invalid-input"
  | "not-found"
  | "ambiguous-reference"
  | "incomplete"
  | "conflict"
  | "rejected"
  | "invalid-response"
  | "upstream";

export class LinearError extends Error {
  readonly code: LinearErrorCode;

  constructor(code: LinearErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LinearError";
    this.code = code;
  }
}
