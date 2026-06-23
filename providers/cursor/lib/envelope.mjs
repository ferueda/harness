const DEFAULT_PREVIEW_CHARS = 800;

function formatTokenCount(count) {
  if (count === undefined) return null;
  if (count < 1000) return `${count}`;
  return `${Math.round(count / 1000)}k`;
}

export function summarizeUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const input = usage.inputTokens ?? usage.input_tokens;
  const output = usage.outputTokens ?? usage.output_tokens;
  if (input === undefined && output === undefined) return undefined;
  const inLabel = formatTokenCount(input);
  const outLabel = formatTokenCount(output);
  const parts = [];
  if (inLabel !== null) parts.push(`${inLabel} in`);
  if (outLabel !== null) parts.push(`${outLabel} out`);
  return parts.join(", ");
}

export function truncateText(text, limit = DEFAULT_PREVIEW_CHARS) {
  if (!text || text.length <= limit) {
    return { preview: text ?? "", truncated: false, totalChars: text?.length ?? 0 };
  }
  return {
    preview: `${text.slice(0, limit)}…`,
    truncated: true,
    totalChars: text.length,
  };
}

export function buildHelpHints(context) {
  const help = [];

  if (context.error) {
    if (context.error.includes("prompt is required")) {
      help.push('Run `cursor-agent "your task"` or pass --prompt-file / --stdin');
    }
    if (context.error.includes("schema")) {
      help.push("Use only one of --schema or --schema-json");
    }
    if (context.structuredError) {
      help.push("Retry with a simpler --schema-json or fix the model answer");
    }
    if (context.authRequired) {
      help.push("Run `agent login` locally or set CURSOR_API_KEY for CI");
    }
    if (context.timedOut) {
      help.push("Increase --max-runtime-ms or retry with --resume <sessionId>");
    }
    return help;
  }

  if (context.status === "completed") {
    if (context.sessionId) {
      help.push(`Run \`cursor-agent --resume ${context.sessionId} "follow up"\` to continue`);
    }
    if (context.resultTruncated) {
      help.push("Run with --full for complete result text");
    }
    if (!context.hasSchema && !context.resultTruncated) {
      help.push('Run `cursor-agent --schema-json \'{"type":"object",…}\' "task"` for typed output');
    }
  }

  if (context.isHome) {
    help.push('Run `cursor-agent "your prompt"` to invoke a subagent');
  }

  return help.slice(0, 3);
}

export function buildEnvelope({
  status,
  sessionId,
  resultText,
  structuredOutput,
  structuredError,
  usage,
  durationMs,
  workspace,
  full = false,
  verbose = false,
  schema,
  timeoutKind,
}) {
  const envelope = { status };

  if (sessionId) envelope.sessionId = sessionId;
  if (durationMs !== undefined) envelope.durationMs = durationMs;

  const usageSummary = summarizeUsage(usage);
  if (usageSummary) envelope.usageSummary = usageSummary;

  if (structuredError) {
    envelope.error = structuredError;
  }

  if (structuredOutput !== undefined) {
    envelope.structuredOutput = structuredOutput;
    if (!full && !verbose) {
      // Schema mode: structured payload is primary; skip redundant prose.
      const help = buildHelpHints({
        status,
        sessionId,
        structuredError,
        resultTruncated: false,
        hasSchema: Boolean(schema),
        error: structuredError,
        timedOut: status === "timed_out",
      });
      if (help.length > 0) envelope.help = help;
      return envelope;
    }
  }

  if (resultText) {
    if (full || verbose) {
      envelope.result = resultText;
    } else {
      const { preview, truncated, totalChars } = truncateText(resultText);
      envelope.result = preview;
      if (truncated) {
        envelope.resultTruncated = true;
        envelope.resultChars = totalChars;
      }
    }
  }

  if (verbose) {
    envelope.verbose = {
      workspace,
      usage,
      timeoutKind,
    };
  }

  const help = buildHelpHints({
    status,
    sessionId,
    structuredError,
    resultTruncated: envelope.resultTruncated === true,
    hasSchema: Boolean(schema),
    error: envelope.error,
    timedOut: status === "timed_out",
  });
  if (help.length > 0) envelope.help = help;

  return envelope;
}

export function buildErrorEnvelope(message, help = []) {
  return {
    status: "failed",
    error: message,
    help: help.length > 0 ? help : buildHelpHints({ error: message }),
  };
}
