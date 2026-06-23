import { encodeToon } from "./toon.mjs";

export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
};

export function collapseHomePath(path) {
  const home = process.env.HOME;
  if (home && path.startsWith(home)) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

export function emitEnvelope(envelope, format, quiet) {
  if (quiet) return;
  if (format === "json") {
    console.log(JSON.stringify(envelope));
    return;
  }
  process.stdout.write(encodeToon(envelope));
}

export function finish(envelope, format, quiet) {
  emitEnvelope(envelope, format, quiet);
  const code =
    envelope.status === "failed" || envelope.status === "timed_out"
      ? EXIT.ERROR
      : EXIT.OK;
  process.exit(code);
}

export function failUsage(message, help, format = "toon") {
  const envelope = {
    status: "failed",
    error: message,
    help: help ?? [],
  };
  emitEnvelope(envelope, format, false);
  process.exit(EXIT.USAGE);
}
