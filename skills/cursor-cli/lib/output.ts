import { encodeToon } from "./toon.ts";
import type { CursorEnvelope } from "./envelope.ts";

export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
};

export function collapseHomePath(path: string): string {
  const home = process.env.HOME;
  if (home && path.startsWith(home)) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

export function emitEnvelope(
  envelope: CursorEnvelope | Record<string, unknown>,
  format: "toon" | "json",
  quiet: boolean,
): void {
  if (quiet) return;
  if (format === "json") {
    console.log(JSON.stringify(envelope));
    return;
  }
  process.stdout.write(encodeToon(envelope));
}

export function finish(envelope: CursorEnvelope, format: "toon" | "json", quiet: boolean): never {
  emitEnvelope(envelope, format, quiet);
  const code =
    envelope.status === "failed" || envelope.status === "timed_out" ? EXIT.ERROR : EXIT.OK;
  process.exit(code);
}

export function failUsage(
  message: string,
  help?: string[],
  format: "toon" | "json" = "toon",
): never {
  const envelope = {
    status: "failed",
    error: message,
    help: help ?? [],
  };
  emitEnvelope(envelope, format, false);
  process.exit(EXIT.USAGE);
}
