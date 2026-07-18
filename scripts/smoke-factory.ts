#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

type JsonObject = Record<string, unknown>;
type ArtifactRef = { base: "repository" | "factory-store"; path: string; sha256: string };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin/harness.ts");
const startedAt = Date.now();
let station = "fixture allocation";
let lastChild = { stdout: "", stderr: "" };

const fixtureRoot = mkdtempSync(join(tmpdir(), "harness-factory-smoke-"));
const workspace = join(fixtureRoot, "workspace");
const storeRoot = join(fixtureRoot, "store");
const toolsRoot = join(fixtureRoot, "bin");
const invocationLog = join(fixtureRoot, "codex-invocations.jsonl");
const ghLog = join(fixtureRoot, "gh-invocations.jsonl");
const prState = join(fixtureRoot, "pr.json");
const remoteRoot = `/tmp/harness-factory-smoke-${randomBytes(6).toString("hex")}.git`;
const projectId = "factory-smoke";
const itemPath = join(workspace, "item.json");
const planPath = "dev/plans/factory-smoke.md";
const implementationPath = join(workspace, "factory-smoke.txt");
const responsePath = join(fixtureRoot, "response.md");
const fakeCodex = join(toolsRoot, "codex");
const fakeGh = join(toolsRoot, "gh");
const homeRoot = join(fixtureRoot, "home");

const cleanEnv: NodeJS.ProcessEnv = {
  PATH: `${toolsRoot}${delimiter}${process.env.PATH ?? ""}`,
  HOME: homeRoot,
  TMPDIR: tmpdir(),
  LANG: "C",
  LC_ALL: "C",
  CI: "1",
  GIT_TERMINAL_PROMPT: "0",
  GH_PROMPT_DISABLED: "1",
  FACTORY_SMOKE_CODEX_LOG: invocationLog,
  FACTORY_SMOKE_GH_LOG: ghLog,
  FACTORY_SMOKE_PR_STATE: prState,
  FACTORY_SMOKE_IMPLEMENTATION_PATH: implementationPath,
};

function fail(message: string): never {
  throw new Error(message);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

function run(command: string, args: string[], cwd = workspace, input?: string): string {
  const result = spawnSync(command, args, {
    cwd,
    env: cleanEnv,
    encoding: "utf8",
    input,
    timeout: 60_000,
  });
  lastChild = { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} exited ${result.status ?? "without status"}`);
  }
  return result.stdout;
}

function git(args: string[], cwd = workspace): string {
  return run("git", args, cwd).trim();
}

const commonArgs = [
  "--workspace",
  workspace,
  "--item-file",
  itemPath,
  "--factory-store-root",
  storeRoot,
  "--factory-store-project-id",
  projectId,
];

function harness(args: string[]): JsonObject {
  const output = run(process.execPath, [BIN, ...args, ...commonArgs], ROOT);
  try {
    return JSON.parse(output) as JsonObject;
  } catch {
    fail(`harness output was not JSON: ${output.slice(0, 500)}`);
  }
}

function inspect(): JsonObject {
  return harness(["factory", "inspect"]);
}

function expectAction(
  output: JsonObject,
  handler: string,
  attempt: number,
  next: { kind: string; phase?: string; handler?: string; reason?: string },
): string {
  assert(output.outcome === "action-completed", `${handler} did not complete an action`);
  const action = object(output.action, `${handler} action`);
  assert(action.handler === handler, `expected ${handler}, received ${String(action.handler)}`);
  assert(action.attempt === attempt, `${handler} attempt was not ${attempt}`);
  const reaction = object(output.next, `${handler} next reaction`);
  assert(reaction.kind === next.kind, `${handler} next kind was not ${next.kind}`);
  if (next.phase) assert(reaction.phase === next.phase, `${handler} next phase mismatch`);
  if (next.handler) assert(reaction.handler === next.handler, `${handler} next handler mismatch`);
  if (next.reason) assert(reaction.reason === next.reason, `${handler} wait reason mismatch`);
  assert(typeof output.phaseRunId === "string", `${handler} omitted phaseRunId`);
  return output.phaseRunId;
}

function expectOutput(
  output: JsonObject,
  expected: {
    outcome: string;
    phase: string;
    phaseRunId: string;
    next: { kind: string; handler?: string; reason?: string };
  },
): void {
  assert(output.outcome === expected.outcome, `expected outcome ${expected.outcome}`);
  assert(output.phase === expected.phase, `expected phase ${expected.phase}`);
  assert(output.phaseRunId === expected.phaseRunId, `${expected.phase} phase run changed`);
  const reaction = object(output.next, `${expected.phase} next reaction`);
  assert(reaction.kind === expected.next.kind, `${expected.phase} next kind mismatch`);
  if (expected.next.handler) {
    assert(reaction.handler === expected.next.handler, `${expected.phase} next handler mismatch`);
  }
  if (expected.next.reason) {
    assert(reaction.reason === expected.next.reason, `${expected.phase} wait reason mismatch`);
  }
}

function object(value: unknown, name: string): JsonObject {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${name} missing`);
  return value as JsonObject;
}

function jsonLines(path: string): JsonObject[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonObject);
}

function listFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function artifactRefs(value: unknown, refs: ArtifactRef[] = []): ArtifactRef[] {
  if (Array.isArray(value)) {
    for (const entry of value) artifactRefs(entry, refs);
    return refs;
  }
  if (!value || typeof value !== "object") return refs;
  const record = value as JsonObject;
  if (
    (record.base === "repository" || record.base === "factory-store") &&
    typeof record.path === "string" &&
    typeof record.sha256 === "string"
  ) {
    refs.push(record as ArtifactRef);
  }
  for (const entry of Object.values(record)) artifactRefs(entry, refs);
  return refs;
}

function resolveArtifact(ref: ArtifactRef, roots: JsonObject): string {
  const root = roots[ref.base];
  assert(typeof root === "string", `missing artifact root ${ref.base}`);
  const path = resolve(root, ref.path);
  const rel = relative(resolve(root), path);
  assert(
    rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith("/"),
    "artifact escaped root",
  );
  assert(existsSync(path) && statSync(path).isFile(), `artifact missing: ${ref.path}`);
  assert(sha256(path) === ref.sha256, `artifact digest mismatch: ${ref.path}`);
  return path;
}

function evidenceSnapshot(events: JsonObject[], inspection: JsonObject): Record<string, string> {
  const roots = object(inspection.artifactRoots, "inspection artifact roots");
  const result: Record<string, string> = {};
  for (const ref of artifactRefs(events)) {
    const path = resolveArtifact(ref, roots);
    result[`${ref.base}:${ref.path}`] = readFileSync(path).toString("base64");
  }
  return result;
}

function expectGitStatus(expected = ""): void {
  assert(git(["diff", "--cached", "--quiet"]) === "", "Git index differs from branch tree");
  assert(
    git(["status", "--porcelain=v1", "--untracked-files=all"]) === expected,
    "Git status mismatch",
  );
}

function lifecyclePath(): string {
  const eventsRoot = join(storeRoot, "projects", projectId, "factory", "events");
  const paths = listFiles(eventsRoot).filter((path) => path.endsWith(".jsonl"));
  assert(paths.length === 1, `expected one lifecycle log, found ${paths.length}`);
  return paths[0]!;
}

function snapshotTerminal(inspection: JsonObject): string {
  const lifecycle = readFileSync(lifecyclePath()).toString("base64");
  const evidence = evidenceSnapshot(jsonLines(lifecyclePath()), inspection);
  const refs = git(["for-each-ref", "--format=%(refname) %(objectname)"]);
  const remote = git(["ls-remote", "origin"]);
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  return JSON.stringify({
    lifecycle,
    evidence,
    inspection,
    refs,
    remote,
    status,
    pr: read(prState),
    codex: read(invocationLog),
    gh: read(ghLog),
  });
}

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

try {
  station = "fixture repository setup";
  mkdirSync(workspace, { recursive: true });
  mkdirSync(storeRoot, { recursive: true });
  mkdirSync(toolsRoot, { recursive: true });
  mkdirSync(homeRoot, { recursive: true });
  git(["init", "--bare", remoteRoot], fixtureRoot);
  git(["init", "-b", "main", workspace], fixtureRoot);
  git(["config", "user.name", "Factory Smoke"]);
  git(["config", "user.email", "factory-smoke@example.test"]);
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(workspace, ".gitignore"), ".harness/\n");
  writeFileSync(join(workspace, "README.md"), "# Factory smoke fixture\n");
  writeFileSync(
    itemPath,
    `${JSON.stringify(
      {
        id: "SMOKE-1",
        source: "file",
        title: "Add the deterministic fixture output",
        body: "Create factory-smoke.txt from the reviewed local plan.",
        labels: [],
      },
      null,
      2,
    )}\n`,
  );

  writeExecutable(
    fakeCodex,
    `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const prompt = readFileSync(0, "utf8");
const log = process.env.FACTORY_SMOKE_CODEX_LOG;
if (!log) throw new Error("missing invocation log");
if (args[0] !== "exec" || !args.includes("--experimental-json")) {
  throw new Error("expected codex exec --experimental-json protocol");
}
const prior = existsSync(log) ? readFileSync(log, "utf8").split(/\\r?\\n/).filter(Boolean).map(JSON.parse) : [];
let role;
if (prompt.includes("# Factory Triage")) role = "triager";
else if (prompt.includes("# Factory Planning Revision")) role = "planner";
else if (prompt.includes("# Factory Planning")) role = "planner";
else if (prompt.includes("read-only spec reviewer")) role = "spec-reviewer";
else if (prompt.includes("# Factory implementation action")) role = "implementer";
else if (prompt.includes("read-only implementation reviewer")) role = "implementation-reviewer";
else if (prompt.includes("read-only code-quality reviewer")) role = "quality-reviewer";
else throw new Error("unexpected prompt");
const count = prior.filter((entry) => entry.role === role).length + 1;
const session = role + "-thread";
if ((role === "planner" || role === "implementer") && count === 2 && (!args.includes("resume") || !args.includes(session))) {
  throw new Error(role + " revision did not resume " + session);
}
let output;
if (role === "triager") output = { route: "ready-to-plan", confidence: "high", rationale: "The small fixture is clear but this smoke exercises planning.", evidence: [{ kind: "tracker", path: null, summary: "The item requests one bounded file." }], questions: [], reconsiderWhen: null };
if (role === "planner") {
  const draft = prompt.split("Draft path:\\n\\n")[1]?.split("\\n")[1];
  if (!draft) throw new Error("planner draft path missing");
  writeFileSync(draft, count === 1 ? "# Fixture plan\\n\\nCreate \\u0060factory-smoke.txt\\u0060 with the first candidate.\\n" : "# Fixture plan\\n\\nCreate \\u0060factory-smoke.txt\\u0060 with the reviewed revised candidate.\\n");
  output = { outcome: "draft-ready", summary: count === 1 ? "Initial plan" : "Revised plan", humanQuestions: [], findingDecisions: count === 1 ? [] : [{ findingId: "spec-001", decision: "implement", rationale: "Pinned the reviewed revised content." }] };
}
const pass = { verdict: "pass", summary: "The candidate satisfies the fixture contract.", findings: [] };
if (role === "spec-reviewer") output = count === 1 ? { verdict: "needs_changes", summary: "Pin the revised fixture content.", findings: [{ title: "Pin revised content", severity: "High", location: "plan", issue: "The initial content is ambiguous.", recommendation: "Require the reviewed revised candidate.", rationale: "The system smoke needs a meaningful revision.", must_fix: true }] } : pass;
if (role === "implementer") {
  writeFileSync(process.env.FACTORY_SMOKE_IMPLEMENTATION_PATH, count === 1 ? "first candidate\\n" : "reviewed revised candidate\\n");
  output = { summary: count === 1 ? "Implemented first candidate" : "Implemented revision" };
}
if (role === "implementation-reviewer") output = count === 1 ? { verdict: "needs_changes", summary: "Revise the fixture output.", findings: [{ title: "Revise output", severity: "High", location: "factory-smoke.txt", issue: "The first candidate is intentionally incomplete.", recommendation: "Write the reviewed revised candidate.", rationale: "Proves implementation continuation.", must_fix: true }] } : pass;
if (role === "quality-reviewer") output = pass;
appendFileSync(log, JSON.stringify({ role, count, args, session }) + "\\n");
if (role === "quality-reviewer" && count === 2) {
  console.error("controlled quality reviewer transport failure");
  process.exit(1);
}
console.log(JSON.stringify({ type: "thread.started", thread_id: session }));
console.log(JSON.stringify({ type: "item.completed", item: { id: role + "-message-" + count, type: "agent_message", text: JSON.stringify(output) } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }));
`,
  );
  writeExecutable(
    fakeGh,
    `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const args = process.argv.slice(2);
const log = process.env.FACTORY_SMOKE_GH_LOG;
const state = process.env.FACTORY_SMOKE_PR_STATE;
appendFileSync(log, JSON.stringify(args) + "\\n");
if (args[0] !== "pr") throw new Error("unexpected gh command");
if (args[1] === "list") {
  console.log(existsSync(state) ? JSON.stringify([JSON.parse(readFileSync(state, "utf8"))]) : "[]");
} else if (args[1] === "create") {
  if (existsSync(state)) throw new Error("duplicate PR create");
  const value = { url: "https://example.test/factory/pull/1", baseRefName: args[args.indexOf("--base") + 1], headRefName: args[args.indexOf("--head") + 1], headRefOid: execFileSync("git", ["rev-parse", args[args.indexOf("--head") + 1]], { encoding: "utf8" }).trim() };
  writeFileSync(state, JSON.stringify(value));
  console.log(value.url);
} else throw new Error("unexpected gh pr command");
`,
  );
  writeFileSync(
    join(workspace, "harness.json"),
    `${JSON.stringify(
      {
        base: "main",
        defaultAgent: "codex",
        factory: {
          triage: { roles: { triager: role(fakeCodex, "read-only") } },
          planning: {
            roles: {
              planner: role(fakeCodex, "workspace-write"),
              reviewer: role(fakeCodex, "read-only"),
            },
          },
          implementation: {
            roles: {
              implementer: role(fakeCodex, "danger-full-access"),
              reviewer: role(fakeCodex, "read-only"),
            },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  git(["add", ".gitignore", "README.md", "harness.json", "item.json"]);
  git(["commit", "-m", "fixture base"]);
  const mainBase = git(["rev-parse", "HEAD"]);
  // Node normalizes file://localhost to an empty hostname; keep a repository-shaped local URL.
  git(["remote", "add", "origin", `file://local.test${remoteRoot}`]);
  git(["push", "-u", "origin", "main"]);
  git(["switch", "-c", "feature/factory-smoke"]);
  expectGitStatus();

  station = "triage";
  const triage = harness(["factory", "triage"]);
  expectAction(triage, "triageWorkItem", 1, { kind: "start-phase", phase: "planning" });
  expectGitStatus();

  station = "planning candidate 1";
  const plan1 = harness(["factory", "planning", "run", "--output-plan", planPath]);
  const planningRunId = expectAction(plan1, "producePlanCandidate", 1, {
    kind: "invoke",
    handler: "reviewPlanCandidate",
  });
  expectGitStatus();

  station = "planning review 1";
  const planReview1 = harness(["factory", "planning", "run"]);
  assert(
    expectAction(planReview1, "reviewPlanCandidate", 1, { kind: "wait", reason: "human" }) ===
      planningRunId,
    "planning phase run changed",
  );
  const firstPlanningInspection = inspect();
  assert(
    object(firstPlanningInspection.state, "first planning state").status ===
      "awaiting-continuation",
    "first planning review did not await continuation",
  );
  assert(
    object(firstPlanningInspection.reaction, "first planning reaction").reason === "human",
    "first planning inspection did not report human wait",
  );
  const firstPlanningEvidence = evidenceSnapshot(
    jsonLines(lifecyclePath()),
    firstPlanningInspection,
  );
  expectGitStatus();

  station = "planning continuation";
  writeFileSync(responsePath, "Apply the blocking finding and preserve the bounded fixture.\n");
  const planContinue = harness([
    "factory",
    "planning",
    "continue",
    "--decision",
    "revise",
    "--response-file",
    responsePath,
  ]);
  expectOutput(planContinue, {
    outcome: "waiting",
    phase: "planning",
    phaseRunId: planningRunId,
    next: { kind: "invoke", handler: "producePlanCandidate" },
  });
  expectGitStatus();

  station = "planning candidate 2";
  const plan2 = harness(["factory", "planning", "run"]);
  assert(
    expectAction(plan2, "producePlanCandidate", 2, {
      kind: "invoke",
      handler: "reviewPlanCandidate",
    }) === planningRunId,
    "planning revision changed phase run",
  );
  expectGitStatus();

  station = "planning review 2";
  const planReview2 = harness(["factory", "planning", "run"]);
  assert(
    expectAction(planReview2, "reviewPlanCandidate", 2, {
      kind: "start-phase",
      phase: "implementation",
    }) === planningRunId,
    "passing plan review changed phase run",
  );
  assert(existsSync(join(workspace, planPath)), "reviewed plan was not materialized");
  const secondPlanningInspection = inspect();
  assert(
    object(secondPlanningInspection.state, "approved planning state").status === "approved",
    "passing planning review did not approve the plan",
  );
  const planningEvents = jsonLines(lifecyclePath());
  const planningCandidates = planningEvents.filter(
    (event) => event.type === "planning.candidate.produced",
  );
  const planningReviews = planningEvents.filter(
    (event) => event.type === "planning.review.completed",
  );
  assert(
    planningCandidates.length === 2 &&
      planningReviews.length === 2 &&
      object(planningReviews[0]!.data, "planning review 1 data").verdict === "needs_changes" &&
      object(planningReviews[0]!.data, "planning review 1 data").candidateEventId ===
        planningCandidates[0]!.id &&
      object(planningReviews[1]!.data, "planning review 2 data").verdict === "pass" &&
      object(planningReviews[1]!.data, "planning review 2 data").candidateEventId ===
        planningCandidates[1]!.id,
    "planning reviews are not bound to their candidates",
  );
  assert(
    JSON.stringify(firstPlanningEvidence) ===
      JSON.stringify(
        Object.fromEntries(
          Object.entries(evidenceSnapshot(planningEvents, secondPlanningInspection)).filter(
            ([key]) => Object.hasOwn(firstPlanningEvidence, key),
          ),
        ),
      ),
    "first planning evidence changed after revision",
  );
  git(["add", planPath]);
  git(["commit", "-m", "approve fixture plan"]);
  const implementationBase = git(["rev-parse", "HEAD"]);
  expectGitStatus();

  station = "implementation candidate 1";
  const implementation1 = harness(["factory", "implementation", "run"]);
  const implementationRunId = expectAction(implementation1, "produceImplementationCandidate", 1, {
    kind: "invoke",
    handler: "reviewImplementationCandidate",
  });
  assert(read(implementationPath) === "first candidate\n", "first implementation edit missing");
  expectGitStatus("?? factory-smoke.txt");

  station = "implementation review 1";
  const implementationReview1 = harness(["factory", "implementation", "run"]);
  assert(
    expectAction(implementationReview1, "reviewImplementationCandidate", 1, {
      kind: "wait",
      reason: "human",
    }) === implementationRunId,
    "implementation review changed phase run",
  );
  const firstImplementationInspection = inspect();
  assert(
    object(firstImplementationInspection.state, "first implementation state").status ===
      "awaiting-continuation",
    "first implementation review did not await continuation",
  );
  assert(
    object(firstImplementationInspection.reaction, "first implementation reaction").reason ===
      "human",
    "first implementation inspection did not report human wait",
  );
  const firstImplementationEvidence = evidenceSnapshot(
    jsonLines(lifecyclePath()),
    firstImplementationInspection,
  );
  expectGitStatus("?? factory-smoke.txt");

  station = "implementation continuation";
  writeFileSync(responsePath, "Apply the blocking output revision exactly.\n");
  const implementationContinue = harness([
    "factory",
    "implementation",
    "continue",
    "--decision",
    "revise",
    "--response-file",
    responsePath,
  ]);
  expectOutput(implementationContinue, {
    outcome: "waiting",
    phase: "implementation",
    phaseRunId: implementationRunId,
    next: { kind: "invoke", handler: "produceImplementationCandidate" },
  });
  expectGitStatus("?? factory-smoke.txt");

  station = "implementation candidate 2";
  const implementation2 = harness(["factory", "implementation", "run"]);
  assert(
    expectAction(implementation2, "produceImplementationCandidate", 2, {
      kind: "invoke",
      handler: "reviewImplementationCandidate",
    }) === implementationRunId,
    "implementation revision changed phase run",
  );
  assert(read(implementationPath) === "reviewed revised candidate\n", "revised edit missing");
  expectGitStatus("?? factory-smoke.txt");

  station = "implementation review 2 controlled failure";
  const implementationReviewFailure = harness(["factory", "implementation", "run"]);
  assert(
    expectAction(implementationReviewFailure, "reviewImplementationCandidate", 2, {
      kind: "invoke",
      handler: "reviewImplementationCandidate",
    }) === implementationRunId,
    "failed implementation review changed phase run",
  );
  const failedReviewEvent = jsonLines(lifecyclePath()).at(-1)!;
  const failedReviewData = object(failedReviewEvent.data, "failed review data");
  const failedReviewEvidence = failedReviewData.evidence;
  assert(
    failedReviewEvent.type === "factory.action.failed" &&
      failedReviewData.failureKind === "retryable" &&
      Array.isArray(failedReviewEvidence) &&
      failedReviewEvidence.length === 2,
    "controlled reviewer failure did not publish checkpoint evidence",
  );
  const checkpointPath = resolveArtifact(
    failedReviewEvidence[1] as ArtifactRef,
    object(inspect().artifactRoots, "artifact roots"),
  );
  const checkpoint = object(JSON.parse(readFileSync(checkpointPath, "utf8")), "review checkpoint");
  const checkpointRoles = object(checkpoint.roles, "review checkpoint roles");
  assert(
    checkpointRoles.implementation !== undefined && checkpointRoles.quality === undefined,
    "controlled failure checkpoint did not retain only implementation evidence",
  );
  expectGitStatus("?? factory-smoke.txt");

  station = "implementation review 2 manual recovery and promotion";
  const implementationReview2 = harness(["factory", "implementation", "run"]);
  assert(
    expectAction(implementationReview2, "reviewImplementationCandidate", 2, {
      kind: "wait",
      reason: "pr-publication",
    }) === implementationRunId,
    "passing implementation review changed phase run",
  );
  expectGitStatus();
  const events = jsonLines(lifecyclePath());
  const candidates = events.filter((event) => event.type === "implementation.candidate.produced");
  const reviews = events.filter((event) => event.type === "implementation.review.completed");
  assert(candidates.length === 2 && reviews.length === 2, "implementation attempts missing");
  const candidate1 = candidates[0]!;
  const candidate2 = candidates[1]!;
  const candidate1Data = object(candidate1.data, "candidate 1 data");
  const candidate2Data = object(candidate2.data, "candidate 2 data");
  const review1Data = object(reviews[0]!.data, "review 1 data");
  const review2Data = object(reviews[1]!.data, "review 2 data");
  assert(
    review1Data.verdict === "needs_changes" && review1Data.candidateEventId === candidate1.id,
    "first review is not bound to first candidate",
  );
  assert(
    review2Data.verdict === "pass" && review2Data.candidateEventId === candidate2.id,
    "passing review is not bound to second candidate",
  );
  assert(
    git(["rev-parse", `refs/harness/factory/${implementationRunId}/1`]) === candidate1Data.commit,
    "attempt 1 ref mismatch",
  );
  assert(
    git(["rev-parse", `refs/harness/factory/${implementationRunId}/2`]) === candidate2Data.commit,
    "attempt 2 ref mismatch",
  );
  assert(
    git(["rev-parse", "feature/factory-smoke"]) === candidate2Data.commit,
    "reviewed attempt was not promoted",
  );
  assert(
    git(["rev-parse", `${String(candidate2Data.commit)}^`]) === implementationBase,
    "reviewed candidate parent differs from implementation base",
  );
  assert(candidate1Data.commit !== candidate2Data.commit, "attempt 1 was promoted");
  assert(
    JSON.stringify(firstImplementationEvidence) ===
      JSON.stringify(
        Object.fromEntries(
          Object.entries(evidenceSnapshot(events, inspect())).filter(([key]) =>
            Object.hasOwn(firstImplementationEvidence, key),
          ),
        ),
      ),
    "first implementation evidence changed after revision",
  );

  station = "implementation publication";
  const publication = harness(["factory", "implementation", "publish"]);
  expectOutput(publication, {
    outcome: "waiting",
    phase: "implementation",
    phaseRunId: implementationRunId,
    next: { kind: "wait", reason: "pr-merge" },
  });
  const pr = object(JSON.parse(read(prState)), "fake PR");
  assert(pr.headRefOid === candidate2Data.commit, "fake PR head differs from reviewed candidate");
  assert(
    git(["ls-remote", "origin", "refs/heads/feature/factory-smoke"]).startsWith(
      String(candidate2Data.commit),
    ),
    "remote head differs from reviewed candidate",
  );
  expectGitStatus();

  station = "local merge";
  git(["switch", "main"]);
  git(["merge", "--no-ff", "feature/factory-smoke", "-m", "merge reviewed fixture"]);
  const mergeCommit = git(["rev-parse", "HEAD"]);
  assert(
    git(["merge-base", "--is-ancestor", String(candidate2Data.commit), mergeCommit]) === "",
    "merge excludes reviewed head",
  );
  assert(git(["rev-parse", `${mergeCommit}^1`]) === mainBase, "merge first parent mismatch");
  assert(
    git(["rev-parse", `${mergeCommit}^2`]) === candidate2Data.commit,
    "merge second parent differs from reviewed head",
  );
  expectGitStatus();

  station = "merge acknowledgement";
  const merged = harness([
    "factory",
    "implementation",
    "mark-pr-merged",
    "--url",
    String(pr.url),
    "--commit",
    mergeCommit,
  ]);
  expectOutput(merged, {
    outcome: "complete",
    phase: "implementation",
    phaseRunId: implementationRunId,
    next: { kind: "wait", reason: "complete" },
  });
  expectGitStatus();

  station = "terminal assertions";
  const terminalInspection = inspect();
  const terminalState = object(terminalInspection.state, "terminal state");
  assert(terminalState.status === "complete", "inspection is not complete");
  const terminalEvents = jsonLines(lifecyclePath());
  const eventTypes = terminalEvents.map((event) => event.type);
  assert(
    JSON.stringify(eventTypes) ===
      JSON.stringify([
        "work_item.imported",
        "triage.requested",
        "triage.work_item.completed",
        "planning.requested",
        "planning.candidate.produced",
        "planning.review.completed",
        "factory.continuation.recorded",
        "planning.candidate.produced",
        "planning.review.completed",
        "implementation.requested",
        "implementation.candidate.produced",
        "implementation.review.completed",
        "factory.continuation.recorded",
        "implementation.candidate.produced",
        "factory.action.failed",
        "implementation.review.completed",
        "implementation_pr.opened",
        "implementation_pr.merged",
      ]),
    `unexpected lifecycle sequence: ${eventTypes.join(", ")}`,
  );
  assert(
    !eventTypes.some((type) => type === "plan_pr.opened" || type === "plan_pr.merged"),
    "plan PR event exists",
  );
  const opened = terminalEvents.find((event) => event.type === "implementation_pr.opened");
  assert(
    object(opened?.data, "publication event data").head === candidate2Data.commit &&
      terminalState.reviewedHead === candidate2Data.commit,
    "reviewed and published heads differ",
  );
  for (const ref of artifactRefs(terminalEvents))
    resolveArtifact(ref, object(terminalInspection.artifactRoots, "artifact roots"));
  const invocations = jsonLines(invocationLog);
  const counts = Object.fromEntries(
    [
      "triager",
      "planner",
      "spec-reviewer",
      "implementer",
      "implementation-reviewer",
      "quality-reviewer",
    ].map((roleName) => [roleName, invocations.filter((entry) => entry.role === roleName).length]),
  );
  assert(
    JSON.stringify(counts) ===
      JSON.stringify({
        triager: 1,
        planner: 2,
        "spec-reviewer": 2,
        implementer: 2,
        "implementation-reviewer": 2,
        "quality-reviewer": 3,
      }),
    "provider invocation counts mismatch",
  );
  assert(
    jsonLines(ghLog).filter((entry) => entry[1] === "create").length === 1,
    "PR creation count mismatch",
  );
  const planningSessions = invocations.filter((entry) => entry.role === "planner");
  const implementationSessions = invocations.filter((entry) => entry.role === "implementer");
  const resumedPlannerArgs = planningSessions[1]!.args;
  const resumedImplementerArgs = implementationSessions[1]!.args;
  assert(
    Array.isArray(resumedPlannerArgs) &&
      resumedPlannerArgs.includes("resume") &&
      resumedPlannerArgs.includes("planner-thread"),
    "planner revision did not retain its producer session",
  );
  assert(
    Array.isArray(resumedImplementerArgs) &&
      resumedImplementerArgs.includes("resume") &&
      resumedImplementerArgs.includes("implementer-thread"),
    "implementation revision did not retain its producer session",
  );

  station = "terminal replay";
  const beforeReplay = snapshotTerminal(terminalInspection);
  const replay = harness(["factory", "implementation", "run"]);
  expectOutput(replay, {
    outcome: "complete",
    phase: "implementation",
    phaseRunId: implementationRunId,
    next: { kind: "wait", reason: "complete" },
  });
  const afterReplay = snapshotTerminal(inspect());
  assert(beforeReplay === afterReplay, "terminal replay changed durable or external state");

  rmSync(fixtureRoot, { recursive: true, force: true });
  rmSync(remoteRoot, { recursive: true, force: true });
  console.log(`Factory smoke PASS (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
} catch (error) {
  const bounded = (text: string) => text.trim().slice(-4000);
  console.error(`Factory smoke FAIL at station: ${station}`);
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  if (lastChild.stderr.trim()) console.error(`--- child stderr ---\n${bounded(lastChild.stderr)}`);
  if (lastChild.stdout.trim()) console.error(`--- child stdout ---\n${bounded(lastChild.stdout)}`);
  console.error(`Retained fixture: ${fixtureRoot}`);
  console.error(`Retained store: ${storeRoot}`);
  console.error(`Retained remote: ${remoteRoot}`);
  process.exitCode = 1;
}

function role(
  executable: string,
  sandboxMode: "read-only" | "workspace-write" | "danger-full-access",
) {
  return {
    agent: "codex",
    model: "fake-codex",
    executable,
    sandboxMode,
    approvalPolicy: "never",
    modelReasoningEffort: "minimal",
  };
}
