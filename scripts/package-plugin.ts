#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXED_TIME = new Date("2000-01-01T00:00:00Z");
const metadata: unknown = JSON.parse(readFileSync(join(ROOT, "plugin.json"), "utf8"));
if (
  !metadata ||
  typeof metadata !== "object" ||
  !("name" in metadata) ||
  metadata.name !== "harness" ||
  !("version" in metadata) ||
  typeof metadata.version !== "string" ||
  !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(metadata.version)
) {
  throw new Error("Expected harness plugin identity and a filename-safe semantic version");
}

// Git's tracked file list excludes untracked caches, credentials, and local work.
// The catalogue is contributor documentation, not a discoverable skill package.
const skills = execFileSync("git", ["ls-files", "-z", "--", "skills"], {
  cwd: ROOT,
  encoding: "utf8",
})
  .split("\0")
  .filter((path) => path && path !== "skills/README.md");
if (!skills.some((path) => /^skills\/[^/]+\/SKILL\.md$/.test(path))) {
  throw new Error("No tracked skills found; stage new skills before packaging");
}
const files = new Map([
  ["plugin.json", "plugin.json"],
  ["LICENSE", "LICENSE"],
  ["README.md", "docs/contributing/plugin.md"],
  ["assets/harness.svg", "assets/harness.svg"],
  ...skills.map((path): [string, string] => [path, path]),
]);

function assertRegularSource(path: string): void {
  const parts = path.split("/");
  if (
    isAbsolute(path) ||
    parts.some((part) => /^(?:\.{1,2}|node_modules|dist|logs|credentials|\.env.*|\..*)$/.test(part))
  ) {
    throw new Error(`Unsupported package path: ${path}`);
  }
  for (let index = 1; index <= parts.length; index += 1) {
    const stat = lstatSync(join(ROOT, ...parts.slice(0, index)));
    if (stat.isSymbolicLink() || (index === parts.length ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error(`Package sources must be regular files without symlinks: ${path}`);
    }
  }
}

for (const source of files.values()) assertRegularSource(source);
for (const path of skills.filter((path) => path.endsWith(".md"))) {
  const content = readFileSync(join(ROOT, path), "utf8");
  for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1].split("#")[0];
    if (!target || /^[a-z]+:/i.test(target)) continue;
    const resolved = relative(ROOT, resolve(ROOT, dirname(path), target));
    if (!files.has(resolved)) throw new Error(`Missing bundled reference: ${path} -> ${target}`);
  }
}

const staging = mkdtempSync(join(tmpdir(), "harness-plugin-"));
try {
  const names = [...files.keys()].sort();
  for (const name of names) {
    const source = files.get(name);
    if (!source) throw new Error(`Missing source for ${name}`);
    const target = join(staging, name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(ROOT, source), target);
    chmodSync(target, 0o644);
    utimesSync(target, FIXED_TIME, FIXED_TIME);
  }

  const filename = `${metadata.name}-${metadata.version}.zip`;
  const archive = join(staging, filename);
  // Stored entries avoid compressor-version differences; -X strips host extras.
  execFileSync("zip", ["-X", "-0", "-q", archive, "--", ...names], {
    cwd: staging,
    env: { ...process.env, TZ: "UTC", ZIPOPT: "" },
  });
  const output = join(ROOT, "dist/plugins");
  mkdirSync(output, { recursive: true });
  copyFileSync(archive, join(output, filename));
  const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
  writeFileSync(join(output, `${filename}.sha256`), `${sha256}  ${filename}\n`);
  console.log(JSON.stringify({ archive: join(output, filename), sha256, files: names.length }));
} finally {
  rmSync(staging, { recursive: true, force: true });
}
