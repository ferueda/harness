/**
 * Minimal TOON encoder for cursor-agent stdout (subset of TOON v3).
 * https://toonformat.dev/
 */

type ToonRecord = Record<string, unknown>;

function needsQuoting(value: string): boolean {
  if (value.length === 0) return true;
  return /[:\n\r\t",\\]|^\s|\s$/.test(value);
}

function formatPrimitive(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "string") {
    return needsQuoting(value) ? JSON.stringify(value) : value;
  }
  return JSON.stringify(String(value));
}

function isUniformObjectArray(items: unknown[]): items is ToonRecord[] {
  if (items.length === 0) return false;
  if (!items.every((item) => item && typeof item === "object" && !Array.isArray(item))) {
    return false;
  }
  const first = items[0] as ToonRecord;
  const keys = Object.keys(first);
  if (keys.length === 0) return false;
  return items.every((item) => {
    const record = item as ToonRecord;
    return keys.every((key) => key in record);
  });
}

function encodeTabularArray(name: string, items: ToonRecord[], indent: number): string {
  const keys = Object.keys(items[0]);
  const pad = "  ".repeat(indent);
  const header = `${pad}${name}[${items.length}]{${keys.join(",")}}:`;
  const rows = items.map(
    (item) => `${pad}  ${keys.map((key) => formatPrimitive(item[key])).join(",")}`,
  );
  return [header, ...rows].join("\n");
}

function encodeStringArray(name: string, items: string[], indent: number): string {
  const pad = "  ".repeat(indent);
  const header = `${pad}${name}[${items.length}]:`;
  const rows = items.map((item) => `${pad}  ${formatPrimitive(item)}`);
  return [header, ...rows].join("\n");
}

function encodeValue(value: unknown, indent = 0): string {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return `${"  ".repeat(indent)}items[0]:`;
    }
    if (value.every((item) => typeof item === "string")) {
      return encodeStringArray("help", value, indent);
    }
    if (isUniformObjectArray(value)) {
      return encodeTabularArray("items", value, indent);
    }
    const pad = "  ".repeat(indent);
    return value.map((item) => `${pad}- ${formatPrimitive(item)}`).join("\n");
  }

  if (value && typeof value === "object") {
    const lines = [];
    const pad = "  ".repeat(indent);
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue;
      if (Array.isArray(child)) {
        if (child.every((item) => typeof item === "string")) {
          lines.push(encodeStringArray(key, child, indent));
          continue;
        }
        if (isUniformObjectArray(child)) {
          lines.push(encodeTabularArray(key, child, indent));
          continue;
        }
      }
      if (child && typeof child === "object" && !Array.isArray(child)) {
        lines.push(`${pad}${key}:`);
        lines.push(encodeValue(child, indent + 1));
        continue;
      }
      lines.push(`${pad}${key}: ${formatPrimitive(child)}`);
    }
    return lines.join("\n");
  }

  return `${"  ".repeat(indent)}${formatPrimitive(value)}`;
}

export function encodeToon(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return `${encodeValue(value, 0)}\n`;
  }
  return `${encodeValue(value, 0)}\n`;
}
