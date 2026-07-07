#!/usr/bin/env node

/**
 * codex-proxy -- inspect what Codex sends to the OpenAI Responses API.
 *
 * Run:
 *   node scripts/codex-proxy.mjs
 *
 * Point Codex CLI at it:
 *   codex exec \
 *     -c 'model_provider="openai-proxy"' \
 *     -c 'model_providers.openai-proxy={name="OpenAI Proxy", base_url="http://127.0.0.1:8787", wire_api="responses", requires_openai_auth=true, supports_websockets=false}' \
 *     'Say hi'
 */

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 8787);
const UPSTREAM = new URL(
  process.env.CODEX_PROXY_UPSTREAM_ORIGIN ?? "https://chatgpt.com/backend-api/codex",
);
const CODEX_HOME = process.env.CODEX_HOME ?? path.join(process.env.HOME ?? "", ".codex");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(HERE, "..", "logs", "codex-proxy");

const REDACT_HEADERS = new Set(["authorization", "api-key", "x-api-key"]);
const estTokens = (bytes) => Math.round(bytes / 4);
const isResponsesRequest = (reqPath) => reqPath === "/responses" || reqPath === "/v1/responses";
const isModelsRequest = (reqPath) => reqPath === "/models" || reqPath.startsWith("/models?");
const thisFile = fileURLToPath(import.meta.url);

function upstreamPath(reqPath) {
  if (reqPath.startsWith("/v1/")) return reqPath;
  return `${UPSTREAM.pathname.replace(/\/$/, "")}${reqPath}`;
}

function forwardHeaders(headers, body) {
  const out = { ...headers };
  delete out.host;
  delete out.connection;
  delete out["accept-encoding"];
  delete out["transfer-encoding"];
  delete out["content-length"];
  if (body.length > 0) out["content-length"] = String(body.length);
  return out;
}

function baseName() {
  return `${new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "")}_codex`;
}

function byteLen(value) {
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value ?? ""));
}

function tableCell(value) {
  return String(value).replaceAll("\n", "\\n").replaceAll("|", "\\|");
}

function textPreview(value) {
  return tableCell(value.slice(0, 80));
}

function textParts(item) {
  const content = Array.isArray(item?.content) ? item.content : [];
  return content.filter((part) => typeof part?.text === "string");
}

function auditRequest(reqJson, responseUsage) {
  const tools = Array.isArray(reqJson?.tools) ? reqJson.tools : [];
  const toolRows = tools
    .map((tool) => {
      const bytes = byteLen(tool);
      return {
        name: tool?.name ?? tool?.function?.name ?? tool?.type ?? "(unnamed)",
        type: tool?.type ?? "",
        bytes,
        tokens: estTokens(bytes),
      };
    })
    .sort((a, b) => b.bytes - a.bytes);

  const toolsBytes = toolRows.reduce((sum, row) => sum + row.bytes, 0);
  const instructionsBytes = byteLen(reqJson?.instructions ?? "");
  const input = Array.isArray(reqJson?.input) ? reqJson.input : [];
  const inputBytes = byteLen(reqJson?.input ?? []);
  const inputRows = input.map((item, index) => {
    const parts = textParts(item);
    return {
      index: index + 1,
      role: item?.role ?? item?.type ?? "unknown",
      bytes: byteLen(item),
      textBytes: parts.reduce((sum, part) => sum + byteLen(part.text), 0),
      parts: parts.length,
    };
  });
  const inputPartRows = input
    .flatMap((item, index) =>
      textParts(item).map((part, partIndex) => ({
        input: index + 1,
        part: partIndex + 1,
        role: item?.role ?? item?.type ?? "unknown",
        bytes: byteLen(part.text),
        preview: textPreview(part.text),
      })),
    )
    .sort((a, b) => b.bytes - a.bytes);
  const totalBytes = byteLen(reqJson ?? {});
  const inputTokens =
    responseUsage?.input_tokens ?? responseUsage?.input_tokens_details?.total_tokens ?? null;
  const cachedInputTokens = responseUsage?.input_tokens_details?.cached_tokens ?? null;
  const uncachedInputTokens =
    inputTokens != null && cachedInputTokens != null ? inputTokens - cachedInputTokens : null;

  return {
    toolRows,
    toolCount: toolRows.length,
    toolsBytes,
    instructionsBytes,
    inputBytes,
    inputRows,
    inputPartRows,
    totalBytes,
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens,
  };
}

function renderAudit(audit) {
  const pct = (bytes) =>
    audit.totalBytes ? `${((bytes / audit.totalBytes) * 100).toFixed(1)}%` : "0.0%";
  const rows = audit.toolRows
    .map(
      (row) =>
        `| ${row.name} | ${row.type} | ${row.bytes.toLocaleString()} | ~${row.tokens.toLocaleString()} | ${pct(row.bytes)} |`,
    )
    .join("\n");
  const inputRows = audit.inputRows
    .map(
      (row) =>
        `| ${row.index} | ${tableCell(row.role)} | ${row.bytes.toLocaleString()} | ${row.textBytes.toLocaleString()} | ${row.parts} |`,
    )
    .join("\n");
  const inputPartRows = audit.inputPartRows
    .slice(0, 12)
    .map(
      (row) =>
        `| ${row.input}.${row.part} | ${tableCell(row.role)} | ${row.bytes.toLocaleString()} | ${row.preview} |`,
    )
    .join("\n");
  const usageLine =
    audit.inputTokens == null
      ? ""
      : audit.cachedInputTokens == null
        ? `**${audit.inputTokens.toLocaleString()} input tokens** reported by the response usage.`
        : `**${audit.inputTokens.toLocaleString()} input tokens** reported by the response usage (${audit.cachedInputTokens.toLocaleString()} cached, ${audit.uncachedInputTokens.toLocaleString()} uncached).`;

  return [
    "<audit>",
    "",
    usageLine,
    "",
    `- **tools**: ${audit.toolCount} definitions, ${audit.toolsBytes.toLocaleString()} bytes (~${estTokens(audit.toolsBytes).toLocaleString()} tokens)`,
    `- **instructions**: ${audit.instructionsBytes.toLocaleString()} bytes (~${estTokens(audit.instructionsBytes).toLocaleString()} tokens)`,
    `- **input**: ${audit.inputBytes.toLocaleString()} bytes (~${estTokens(audit.inputBytes).toLocaleString()} tokens)`,
    `- **total request**: ${audit.totalBytes.toLocaleString()} bytes`,
    "",
    "| tool | type | bytes | ~tokens | % of request |",
    "| --- | --- | --: | --: | --: |",
    rows,
    "",
    "| input | role | json bytes | text bytes | text parts |",
    "| ---: | --- | --: | --: | --: |",
    inputRows,
    "",
    "| input.part | role | text bytes | preview |",
    "| --- | --- | --: | --- |",
    inputPartRows,
    "",
    "</audit>",
  ].join("\n");
}

function printAudit(audit, base) {
  const top = audit.toolRows.slice(0, 12);
  const width = Math.max(4, ...top.map((row) => row.name.length));
  console.log(
    `\n[codex-proxy] ${audit.toolCount} tools · ${audit.toolsBytes.toLocaleString()} tool bytes` +
      (audit.inputTokens != null
        ? ` · ${audit.inputTokens.toLocaleString()} input tokens` +
          (audit.cachedInputTokens != null
            ? ` (${audit.cachedInputTokens.toLocaleString()} cached, ${audit.uncachedInputTokens.toLocaleString()} uncached)`
            : "")
        : ""),
  );
  for (const row of top) {
    console.log(
      `  ${row.name.padEnd(width)}  ${String(row.bytes).padStart(7)} B  ~${row.tokens} tok`,
    );
  }
  if (audit.toolRows.length > top.length)
    console.log(`  ... ${audit.toolRows.length - top.length} more`);
  console.log(`  logs/codex-proxy/${base}.md\n`);
}

function fenceJson(value) {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function renderHeaders(headers) {
  return Object.entries(headers)
    .map(([key, value]) => {
      const rendered = Array.isArray(value) ? value.join(", ") : (value ?? "");
      return `${key}: ${REDACT_HEADERS.has(key.toLowerCase()) ? "[REDACTED]" : rendered}`;
    })
    .join("\n");
}

function renderInput(input) {
  if (!Array.isArray(input)) return fenceJson(input);
  return input
    .map((item, index) => {
      const role = item?.role ?? item?.type ?? "unknown";
      return [
        `<input index="${index + 1}" role="${role}">`,
        "",
        fenceJson(item),
        "",
        "</input>",
      ].join("\n");
    })
    .join("\n\n");
}

function renderTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return "";
  return [
    "<tools>",
    "",
    tools
      .map((tool) => {
        const name = tool?.name ?? tool?.function?.name ?? tool?.type ?? "(unnamed)";
        return [`### ${name}`, "", fenceJson(tool)].join("\n");
      })
      .join("\n\n"),
    "",
    "</tools>",
  ].join("\n");
}

function decodeResponsesStream(raw) {
  const events = [];
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^data:\s?(.*)$/);
    if (!match || match[1] === "[DONE]" || match[1].trim() === "") continue;
    try {
      events.push(JSON.parse(match[1]));
    } catch {
      // Non-JSON SSE lines are not useful for this audit.
    }
  }

  let usage = null;
  let status = "";
  const text = [];
  for (const event of events) {
    if (event.type === "response.completed" || event.type === "response.incomplete") {
      usage = event.response?.usage ?? usage;
      status = event.response?.status ?? status;
    } else if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      text.push(event.delta);
    }
  }

  const parts = [];
  if (status) parts.push(`- **status**: ${status}`);
  if (usage) parts.push(`- **usage**: ${JSON.stringify(usage)}`);
  if (text.length)
    parts.push(["<assistant-text>", "", text.join(""), "", "</assistant-text>"].join("\n"));

  return {
    markdown: parts.length
      ? parts.join("\n\n")
      : "```text\n(stream captured; no decoded response text)\n```",
    usage,
  };
}

function decodeJsonResponse(raw) {
  try {
    const json = JSON.parse(raw);
    return { markdown: fenceJson(json), usage: json?.usage ?? null };
  } catch {
    return { markdown: `\`\`\`text\n${raw}\n\`\`\``, usage: null };
  }
}

function decodeResponse(raw, contentType) {
  if (contentType.includes("text/event-stream") || /^data:\s?\{/m.test(raw)) {
    return decodeResponsesStream(raw);
  }
  return decodeJsonResponse(raw);
}

function readModelCache() {
  try {
    return fs.readFileSync(path.join(CODEX_HOME, "models_cache.json"));
  } catch {
    return Buffer.from(JSON.stringify({ models: [] }));
  }
}

function renderMarkdown(capture, audit, responseMd) {
  const req = capture.reqJson;
  return [
    "<meta>",
    "",
    `- **timestamp**: ${capture.timestamp}`,
    `- **model**: ${req?.model ?? "unknown"}`,
    `- **endpoint**: ${capture.method} ${capture.path}`,
    `- **upstream**: ${UPSTREAM.origin}${upstreamPath(capture.path)}`,
    `- **upstream status**: ${capture.statusCode}`,
    "",
    "</meta>",
    "",
    renderAudit(audit),
    "",
    "<headers>",
    "",
    "```",
    renderHeaders(capture.headers),
    "```",
    "",
    "</headers>",
    "",
    "<instructions>",
    "",
    typeof req?.instructions === "string" ? req.instructions : fenceJson(req?.instructions),
    "",
    "</instructions>",
    "",
    renderTools(req?.tools),
    "",
    "<input>",
    "",
    renderInput(req?.input),
    "",
    "</input>",
    "",
    "<response>",
    "",
    responseMd,
    "",
    "</response>",
    "",
  ]
    .filter((part) => part !== "")
    .join("\n");
}

function persistCapture(capture, responseRaw) {
  try {
    const { markdown, usage } = decodeResponse(
      responseRaw,
      String(capture.responseHeaders["content-type"] ?? ""),
    );
    const audit = auditRequest(capture.reqJson, usage);
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(LOG_DIR, `${capture.base}.md`),
      renderMarkdown(capture, audit, markdown),
    );
    if (process.env.CODEX_PROXY_WRITE_RAW === "1") {
      fs.writeFileSync(
        path.join(LOG_DIR, `${capture.base}.request.json`),
        JSON.stringify(capture.reqJson, null, 2),
      );
    }
    printAudit(audit, capture.base);
  } catch (error) {
    console.error(`[codex-proxy] could not render request: ${error.message}`);
  }
}

function handle(req, res) {
  const reqPath = req.url ?? "/";
  if (req.method === "GET" && isModelsRequest(reqPath)) {
    // Codex refreshes models through the configured provider. Local cache keeps
    // this proxy focused on /responses and avoids auth-scope mismatches.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(readModelCache());
    return;
  }

  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const startedAt = new Date().toISOString();
    const base = baseName();
    const client = UPSTREAM.protocol === "http:" ? http : https;
    const up = client.request(
      {
        hostname: UPSTREAM.hostname,
        port: UPSTREAM.port || (UPSTREAM.protocol === "http:" ? 80 : 443),
        path: upstreamPath(reqPath),
        protocol: UPSTREAM.protocol,
        method: req.method,
        headers: forwardHeaders(req.headers, body),
      },
      (upstream) => {
        res.writeHead(upstream.statusCode ?? 502, upstream.headers);
        const responseChunks = [];
        upstream.on("data", (chunk) => {
          responseChunks.push(chunk);
          res.write(chunk);
        });
        upstream.on("end", () => {
          res.end();
          if (!isResponsesRequest(reqPath)) return;
          try {
            persistCapture(
              {
                base,
                timestamp: startedAt,
                method: req.method ?? "GET",
                path: reqPath,
                statusCode: upstream.statusCode ?? 0,
                headers: req.headers,
                responseHeaders: upstream.headers,
                reqJson: JSON.parse(body.toString("utf8")),
              },
              Buffer.concat(responseChunks).toString("utf8"),
            );
          } catch (error) {
            console.error(`[codex-proxy] could not parse request body: ${error.message}`);
          }
        });
      },
    );

    up.on("error", (error) => {
      console.error(`[codex-proxy] upstream error: ${error.message}`);
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ error: { message: `codex-proxy upstream error: ${error.message}` } }),
      );
    });

    if (body.length > 0) up.write(body);
    up.end();
  });
}

function startServer() {
  const server = http.createServer(handle);

  function close() {
    server.close(() => process.exit(0));
  }

  process.on("SIGINT", close);
  process.on("SIGTERM", close);

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[codex-proxy] listening on http://127.0.0.1:${PORT}`);
    console.log("[codex-proxy] point Codex at it with:");
    console.log(
      `  codex exec -c 'model_provider="openai-proxy"' -c 'model_providers.openai-proxy={name="OpenAI Proxy", base_url="http://127.0.0.1:${PORT}", wire_api="responses", requires_openai_auth=true, supports_websockets=false}' 'Say hi'`,
    );
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  startServer();
}

export { auditRequest, decodeResponse, decodeResponsesStream, renderAudit, startServer };
