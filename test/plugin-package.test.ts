import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaces: string[] = [];

afterEach(() => {
  for (const root of workspaces.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-plugin-test-"));
  workspaces.push(root);
  for (const path of [
    "plugin.json",
    "LICENSE",
    "assets",
    "skills",
    "scripts/package-plugin.ts",
    "docs/contributing/plugin.md",
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(ROOT, path), join(root, path), { recursive: true });
  }
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["add", "skills"], { cwd: root });
  return root;
}

function packagePlugin(root: string, env = process.env): { archive: string; sha256: string } {
  return JSON.parse(
    execFileSync(process.execPath, [join(root, "scripts/package-plugin.ts")], {
      cwd: root,
      encoding: "utf8",
      env,
    }),
  ) as { archive: string; sha256: string };
}

test("the ZIP extracts one portable plugin with every canonical skill and invocation policy", () => {
  const root = fixture();
  // Local development dependencies, history, caches, and secret-shaped files stay out.
  for (const path of [
    "skills/triage/.env",
    "skills/triage/node_modules/cache",
    ".env",
    "notes.md",
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), "untracked fixture\n");
  }
  const result = packagePlugin(root);
  const names = execFileSync("unzip", ["-Z1", result.archive], { encoding: "utf8" })
    .trim()
    .split("\n");
  const tracked = execFileSync("git", ["ls-files", "-z", "--", "skills"], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\0")
    .filter((path) => path && path !== "skills/README.md");
  expect(names).toEqual(
    ["LICENSE", "README.md", "assets/harness.svg", "plugin.json", ...tracked].sort(),
  );
  expect(names.filter((path) => path.endsWith("/SKILL.md"))).toHaveLength(13);
  const extracted = join(root, "extracted");
  execFileSync("unzip", ["-q", result.archive, "-d", extracted]);
  for (const path of tracked) {
    expect(readFileSync(join(extracted, path))).toEqual(readFileSync(join(ROOT, path)));
  }
  expect(readFileSync(join(extracted, "LICENSE"))).toEqual(readFileSync(join(ROOT, "LICENSE")));
  expect(readFileSync(join(extracted, "README.md"))).toEqual(
    readFileSync(join(ROOT, "docs/contributing/plugin.md")),
  );
  const manifest = JSON.parse(readFileSync(join(extracted, "plugin.json"), "utf8"));
  expect(manifest.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  expect(manifest.name).toBe("harness");
  expect(result.archive).toBe(
    join(realpathSync(root), "dist/plugins", `harness-${manifest.version}.zip`),
  );
  expect(manifest.license).toBe("MIT");
  const portableFields = [
    "$schema",
    "name",
    "version",
    "description",
    "author",
    "homepage",
    "repository",
    "license",
    "keywords",
    "extensions",
  ];
  expect(Object.keys(manifest).filter((key) => !portableFields.includes(key))).toEqual([]);
  const openai = manifest.extensions["com.openai"];
  expect(Object.keys(openai)).toEqual(["interface"]);
  expect(openai.interface.shortDescription.length).toBeLessThanOrEqual(30);
  for (const key of ["logo", "composerIcon"]) {
    expect(existsSync(resolve(extracted, openai.interface[key]))).toBe(true);
  }

  const implicit: string[] = [];
  for (const name of readdirSync(join(extracted, "skills"))) {
    const skill = join(extracted, "skills", name);
    const content = readFileSync(join(skill, "SKILL.md"), "utf8");
    expect(content).toMatch(new RegExp(`^---\\nname: ${name}\\ndescription: .+\\n---\\n`));
    const metadata = readFileSync(join(skill, "agents/openai.yaml"), "utf8");
    expect(metadata).toContain(`$${name}`);
    expect(metadata).toMatch(/display_name: "\S.+"/);
    expect(metadata).toMatch(/allow_implicit_invocation: (?:true|false)/);
    if (/allow_implicit_invocation: true/.test(metadata)) implicit.push(name);
    for (const path of names.filter(
      (path) => path.startsWith(`skills/${name}/`) && path.endsWith(".md"),
    )) {
      for (const match of readFileSync(join(extracted, path), "utf8").matchAll(/\]\(([^)]+)\)/g)) {
        const target = match[1].split("#")[0];
        if (!target || /^[a-z]+:/i.test(target)) continue;
        const resolved = resolve(extracted, dirname(path), target);
        expect(isAbsolute(target)).toBe(false);
        expect(relative(skill, resolved)).not.toMatch(/^\.\.(?:[/\\]|$)/);
        expect(existsSync(resolved), `${path} -> ${target}`).toBe(true);
      }
    }
  }
  expect(implicit.sort()).toEqual(["change-review-workflow", "review-spec"]);
});

test("package bytes and checksum ignore source timestamps, modes, timezone, and ZIPOPT", () => {
  const root = fixture();
  const first = packagePlugin(root);
  const bytes = readFileSync(first.archive);
  chmodSync(join(root, "skills/triage/SKILL.md"), 0o755);
  utimesSync(join(root, "skills/triage/SKILL.md"), new Date(), new Date());
  const second = packagePlugin(root, { ...process.env, TZ: "Pacific/Honolulu", ZIPOPT: "-9" });
  expect(readFileSync(second.archive)).toEqual(bytes);
  expect(second.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(readFileSync(`${second.archive}.sha256`, "utf8")).toBe(
    `${second.sha256}  ${basename(second.archive)}\n`,
  );
});

test.each(["symlink", "hidden", "reference"])(
  "rejects a tracked %s hazard without an archive",
  (hazard) => {
    const root = fixture();
    const path = join(root, "skills/triage/SKILL.md");
    if (hazard === "symlink") {
      rmSync(path);
      symlinkSync(join(ROOT, "skills/triage/SKILL.md"), path);
    } else if (hazard === "hidden") {
      writeFileSync(join(root, "skills/triage/.env"), "fixture\n");
      execFileSync("git", ["add", "skills/triage/.env"], { cwd: root });
    } else {
      writeFileSync(path, `${readFileSync(path, "utf8")}\n[Missing](references/missing.md)\n`);
    }
    const result = spawnSync(process.execPath, [join(root, "scripts/package-plugin.ts")], {
      cwd: root,
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(
      /regular files|Unsupported package path|Missing bundled reference/,
    );
    expect(existsSync(join(root, "dist/plugins"))).toBe(false);
  },
);
