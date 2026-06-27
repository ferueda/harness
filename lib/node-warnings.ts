const NODE_SQLITE_WARNING = "SQLite is an experimental feature";

let sqliteWarningSuppressionDepth = 0;
let originalEmitWarning: typeof process.emitWarning | undefined;

export function suppressNodeSqliteExperimentalWarning(): () => void {
  if (sqliteWarningSuppressionDepth === 0) {
    originalEmitWarning = process.emitWarning;

    process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
      if (isNodeSqliteExperimentalWarning(warning, args)) return;
      return originalEmitWarning?.call(process, warning as never, ...(args as never[]));
    }) as typeof process.emitWarning;
  }

  sqliteWarningSuppressionDepth += 1;

  return () => {
    sqliteWarningSuppressionDepth -= 1;
    if (sqliteWarningSuppressionDepth === 0 && originalEmitWarning) {
      process.emitWarning = originalEmitWarning;
      originalEmitWarning = undefined;
    }
  };
}

export async function importNodeSqlite(): Promise<typeof import("node:sqlite")> {
  const restoreWarnings = suppressNodeSqliteExperimentalWarning();
  try {
    return await import("node:sqlite");
  } finally {
    restoreWarnings();
  }
}

function isNodeSqliteExperimentalWarning(warning: string | Error, args: unknown[]): boolean {
  const message = warning instanceof Error ? warning.message : String(warning);
  const warningType = warning instanceof Error ? warning.name : warningTypeFromArgs(args);

  return warningType === "ExperimentalWarning" && message.includes(NODE_SQLITE_WARNING);
}

function warningTypeFromArgs(args: unknown[]): string | undefined {
  const [first] = args;
  if (typeof first === "string") return first;
  if (!first || typeof first !== "object") return undefined;
  if (!("type" in first)) return undefined;

  const type = first.type;
  return typeof type === "string" ? type : undefined;
}
