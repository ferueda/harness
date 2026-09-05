import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test("format scripts cover first-party guidance without installed skill trees", () => {
  const parsed: unknown = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  if (!parsed || typeof parsed !== "object" || !("scripts" in parsed)) {
    throw new Error("Missing package scripts");
  }
  const scripts = parsed.scripts;
  if (!scripts || typeof scripts !== "object") throw new Error("Invalid package scripts");
  for (const name of ["format", "format:check"]) {
    const command = Reflect.get(scripts, name);
    expect(typeof command).toBe("string");
    for (const path of ["docs", "skills", "automations", "AGENTS.md", "README.md"]) {
      expect(command).toContain(` ${path} `);
    }
    expect(command).not.toContain(".agents");
  }
});
