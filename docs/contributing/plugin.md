# Harness skills plugin

Harness packages its canonical `skills/` tree as a skills-only OpenAI-compatible
plugin. Root `plugin.json` uses the
[Agent Plugins 1.0.0 schema](https://agent-plugins.org/schemas/1.0.0/plugin.schema.json).
The portable format discovers `skills/<name>/SKILL.md` directly; it does not need
a legacy `skills` field or a second `.codex-plugin` manifest. See the official
[packaging](https://developers.openai.com/plugins/build/plugins) and
[skills](https://developers.openai.com/plugins/build/skills) guides.

## Build and inspect

In a Harness Git checkout, with Node 24+, pnpm, and Info-ZIP `zip` on PATH:

```bash
make setup-worktree
make check
make package-plugin
unzip -l dist/plugins/harness-0.1.0.zip
cd dist/plugins
shasum -a 256 -c harness-0.1.0.zip.sha256
```

`pnpm package:plugin` runs the same packaging command. The manifest version owns
the archive name; change `plugin.json` for a new plugin version independently of
the CLI's package version. Build/full checks clear `dist/`, so package after
running them. ZIPs and checksum sidecars are generated in ignored `dist/plugins/`;
keep them with the reviewed source revision when sharing a private build. This
repo has no automated plugin release or upload job.

The archive has one plugin root: `plugin.json`, `LICENSE`, this guide as
`README.md`, the icon, and every Git-tracked file inside the skill directories.
The contributor catalogue `skills/README.md` is omitted because it links to
unbundled repository docs. Stage new skill files before packaging. File bytes
come from the working tree; package a reviewed clean revision for distribution.
The packer rejects symlinks, hidden/cache paths, and missing Markdown references.
It excludes the runner, dependencies, development skills, tests, repository
history, credentials, and unrelated untracked files.

Entries are sorted with fixed UTC timestamps and regular-file permissions,
stored without compression, and without host extra fields. Repeated builds of
the same inputs produce the same SHA-256 with the same Info-ZIP implementation.
The repository tests this property on each CI/local platform; compare checksums explicitly
before claiming reproducibility across platforms.

## Private installation and updates

For an authorized private cloud/workspace installation, use the account's
private plugin ZIP upload/import surface when available and choose the generated
ZIP as a skills-only package. Review metadata and skill checks, keep access
private, and enable the plugin. Workspace administration, labels, and upload
availability depend on account policy; confirm the private destination before
uploading. This repository has not tested an account installation.
Follow the current
[plugin management](https://learn.chatgpt.com/docs/enterprise/plugin-management)
and [upload validation](https://developers.openai.com/plugins/deploy/submission-errors)
guides if labels or access differ. The developer portal's public directory
submission flow is a separate action.
If the account exposes no private ZIP import, use the local marketplace route
below for local testing; a fresh cloud installation remains unverified.

For local authoring, extract the ZIP into a dedicated plugin directory and point
a supported personal/repo marketplace entry at that directory, following the
official packaging guide. A local marketplace is a local-client distribution
surface; it does not establish a cloud installation.

For an update, keep the manifest `name`, increment its `version`, rerun checks,
rebuild, verify the checksum, and upload the replacement ZIP to the existing
private plugin. Verify which version is enabled and test in a fresh task.
A private archive upload is a snapshot: later GitHub commits do not automatically
sync to it. GitHub-backed workspace imports are a separate distribution choice.
Keep the previous ZIP/checksum if a rollback is needed.

## Skills and runtime requirements

All 13 skills are included: `adversarial-review`, `architect`,
`change-review-workflow`, `code-quality-review`, `create-plan`, `diagnose-issue`,
`explain-change`, `handoff-work`, `planning-workflow`, `review-implementation`,
`review-spec`, `shape-requirements`, and `triage`. Their `agents/openai.yaml`
files and six local references are copied unchanged. Eleven skills are
explicit-only; `change-review-workflow` and `review-spec` also allow implicit
invocation. Use the host's discovered names/paths (which may be namespaced),
for example `$triage` in Codex or the skill picker in ChatGPT.

The plugin distributes instructions and references. Repository-dependent work
requires access to the target repo and its tools in the execution environment.
The ZIP installs no Harness CLI, Node dependencies, provider authentication,
MCP server, lifecycle hooks, cloud environment, or permissions.

For independent structured reviews, install Harness separately in that same
execution environment: Node 24+, pnpm, a Harness checkout/install, Git and
target-repository access, plus an authenticated Codex or Cursor provider.
See the repository's
[setup guide](https://github.com/ferueda/harness/blob/main/docs/contributing/setup-manifest.md).
If the runner is unavailable, `change-review-workflow` reports that limitation
and may use an available direct reviewer when permitted; it must not claim a
Harness run. A successful plugin import alone does not prove runner readiness.

## Verification and remaining installation test

The repository gate covers archive extraction, all skill bytes, frontmatter,
local Markdown references, invocation policies, allowed contents, and repeated
build checksums. These checks prove package structure, not host model behavior.

After an authorized fresh cloud installation, confirm all 13 discovered skills
and their metadata, invoke each explicitly with a representative request, and
load its bundled references. Check negative/indirect requests for the 11
explicit-only skills and implicit selection for the two opted-in skills.
Exercise missing inputs, unavailable repository tools/runner, and a separately
provisioned Harness review. Finally upload a newer version and confirm a fresh
task sees the update. Record the installed version and observed behavior;
local extraction does not replace this test.
