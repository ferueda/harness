# Linear automation

Harness runs Linear triage through a local self-hosted Inngest server and one
long-running Connect worker. It does not need Inngest Cloud, a public endpoint,
or a Linear webhook.

```text
one-minute Inngest cron
  -> list the configured project's observed states
     -> Backlog: linear/issue.revision-observed
     -> Open: linear/issue.readiness-check.requested
  -> reload complete Linear context and classify readiness
     -> work/triage.requested
     -> work/spec.requested or work/implementation.requested
```

Linear remains the queue. A Backlog issue without an Agent action label needs
triage, whether or not a stale Agent Ready label is present. Successful triage
removes Agent Ready and moves the issue out of Backlog. Work identity includes
the issue revision, so repeated observation of one revision converges while a
later human change can request new work.

Open is observed only when the worker composition enables Spec or Implement and
registers the matching consumer. Each poll cycle gives an Open readiness check
new delivery identity because blocker state can change without changing the
blocked issue's revision. The router reloads current labels, state, and blockers,
then emits a work request whose identity comes from that current readiness
snapshot. Repeated checks of an unchanged snapshot therefore converge, while a
resolved blocker produces new work.

## Workflow contract

Statuses say who owns the next move. Agent action labels say what an agent
should do. The independent Agent Ready label is a one-use human permission for
Open Spec or Implement work; it never gates Backlog triage.

| Status                       | Agent action                     | Agent Ready | Meaning                                       |
| ---------------------------- | -------------------------------- | ----------- | --------------------------------------------- |
| Backlog                      | None                             | Ignored     | Awaiting automatic triage                     |
| Open                         | Exactly one of Spec or Implement | Absent      | Classified and waiting for human release      |
| Open                         | Exactly one of Spec or Implement | Present     | Dispatchable when unblocked and route-enabled |
| In Progress                  | None, Spec, or Implement         | Absent      | Human work or claimed agent work is active    |
| Needs Input                  | None                             | Absent      | A prerequisite human answer is missing        |
| Needs Review                 | None                             | Absent      | An agent artifact awaits human judgment       |
| Done, Canceled, or Duplicate | None                             | Absent      | Terminal                                      |

An unresolved Linear blocker is separate from both status and action. It keeps
an otherwise actionable issue waiting.

After answering a Needs Input issue, a human moves it to Backlog to request
triage again. Agent Ready is not required. The resulting Linear revision gives
that request new identity; a comment alone does not start triage. When reviewing
an artifact, a human either returns it to Open with one action or moves it to a
terminal status. Apply the Spec or Implement label before moving the issue to
Open, then add Agent Ready when that specific work may start. For example, an
approved spec becomes Open + Implement and waits until a human adds Agent Ready.

## Configure the target repository

The target repository's `harness.json` owns stable team, project, state, Agent
action label, and Agent Ready label IDs, the triage execution profile, and
repository-run setup. It contains no secrets.

```json
{
  "repositoryRuns": {
    "remote": "https://github.com/example/project.git",
    "maxTrees": 2,
    "setup": {
      "command": ["pnpm", "install", "--frozen-lockfile", "--prefer-offline"],
      "timeoutMs": 900000
    }
  },
  "linearAutomation": {
    "readiness": {
      "teamId": "team-id",
      "projectId": "project-id",
      "stateIds": {
        "backlog": "backlog-state-id",
        "open": "open-state-id",
        "inProgress": "in-progress-state-id",
        "needsInput": "needs-input-state-id",
        "needsReview": "needs-review-state-id",
        "done": "done-state-id",
        "canceled": "canceled-state-id",
        "duplicate": "duplicate-state-id"
      },
      "agentActionLabelIds": {
        "spec": "spec-label-id",
        "implement": "implement-label-id"
      },
      "agentReadyLabelId": "agent-ready-label-id"
    },
    "triage": {
      "agent": "codex",
      "model": "gpt-5.6-sol",
      "modelReasoningEffort": "high",
      "maxRuntimeMs": 1800000
    },
    "spec": {
      "agent": "codex",
      "model": "gpt-5.6-sol",
      "modelReasoningEffort": "high",
      "maxRuntimeMs": 1800000
    },
    "implementation": {
      "implementer": {
        "agent": "codex",
        "model": "gpt-5.6-sol",
        "modelReasoningEffort": "high",
        "maxRuntimeMs": 1800000
      },
      "reviewers": {
        "agent": "codex",
        "model": "gpt-5.6-sol",
        "modelReasoningEffort": "high",
        "maxRuntimeMs": 1800000
      }
    }
  }
}
```

`linearAutomation.spec` is optional and is the Spec route's enable switch. When
neither Spec nor Implementation is enabled, the worker remains triage-only and
does not require `repositoryRuns` or GitHub credentials. When Spec is present,
every Spec execution field is required explicitly; there are no model,
reasoning, or timeout fallbacks. Either repository-backed profile requires
`repositoryRuns`, registers its consumer, and adds Open observation in the same
worker composition.

`linearAutomation.implementation` is an independent enable switch. It requires
separate explicit `implementer` and `reviewers` profiles; the reviewer profile
is used by both existing change-review steps. When present, the worker registers
the bounded implementation consumer and adds Open observation. It uses one
initial implementation pass, at most one resumed revision, at most two reviews,
and publishes only the selected checkpoint. An exhausted review cycle publishes
an explicitly unapproved pull request for human review.

The initial worker composes one configured project. Its route map controls both
which consumers exist and which states the poller observes. The standalone
Linear read operation accepts explicit team, project, and state IDs so another
worker can reuse it without adding a shared scheduler or project registry.

## Run the local Compose stack

The deployment contains one self-hosted Inngest service and one Harness worker.
It is intentionally scoped to one configured target repository. Inngest keeps
its SQLite database in a named volume, while the worker reads the target
checkout through a read-only bind mount.

Write-capable operations use a separate persistent repository-data volume. It
contains a writable controller clone plus Grove's reusable worktrees; the
read-only source bind is never fetched, checked out, or cleaned. Grove reset
keeps ignored `node_modules`, and a separate package-manager-cache volume keeps
downloaded packages. The setup command runs after every acquisition so those
warm dependencies are reconciled with the checked-out lockfile before an agent
receives the workspace.

Keep deployment secrets outside the target repository. The triage agent can read
the workspace, so an ignored file inside that workspace is not a safe secret
boundary. Create one protected environment file per Compose stack:

```sh
export HARNESS_ROOT="/path/to/harness"
export TARGET_ROOT="/path/to/target-repository"
export LINEAR_AUTOMATION_ENV="${XDG_CONFIG_HOME:-$HOME/.config}/harness/linear-automation/target.env"

mkdir -p "$(dirname "$LINEAR_AUTOMATION_ENV")"
umask 077
{
  printf 'COMPOSE_PROJECT_NAME=harness-linear-target\n'
  printf 'HARNESS_LINEAR_WORKSPACE=%s\n' "$TARGET_ROOT"
  printf 'INNGEST_DASHBOARD_PORT=8288\n'
  printf 'LINEAR_API_KEY=%s\n' 'replace-with-linear-api-key'
  printf 'CODEX_API_KEY=%s\n' 'replace-with-codex-api-key'
  printf 'GITHUB_TOKEN=%s\n' 'replace-with-github-token'
  printf 'INNGEST_EVENT_KEY=%s\n' "$(openssl rand -hex 32)"
  printf 'INNGEST_SIGNING_KEY=%s\n' "$(openssl rand -hex 32)"
} > "$LINEAR_AUTOMATION_ENV"
```

`CODEX_API_KEY` is the recommended auth path for an unattended worker. Compose
passes all worker credentials only to the worker, and Harness forwards only the
Codex credential subset to the Codex child process. `GITHUB_TOKEN` stays in the
checkpoint publication boundary. The protected environment file remains outside
the target repository.

If you prefer ChatGPT-backed Codex login, omit `CODEX_API_KEY` from the file and
initialize the worker's dedicated credential volume once:

```sh
docker compose \
  --env-file "$LINEAR_AUTOMATION_ENV" \
  --file "$HARNESS_ROOT/compose.linear-automation.yaml" \
  run --rm --no-deps worker codex login --device-auth
```

That login survives normal container restarts because the writable Codex home is
stored in a named volume. The worker verifies either the API key or `codex login
status` before it connects to Inngest, so a missing credential fails startup
instead of waiting for a Backlog issue to fail during triage. Do not copy or bind
your full host Codex home into the container.

The target path must be absolute and point to a normal Git checkout. A linked
worktree whose `.git` file refers to an unmounted parent checkout is not a valid
container workspace.

Then start both services and wait for their health checks:

```sh
docker compose \
  --env-file "$LINEAR_AUTOMATION_ENV" \
  --file "$HARNESS_ROOT/compose.linear-automation.yaml" \
  up --build --detach --wait
```

The dashboard and Event API are available at `http://127.0.0.1:8288` by
default. The Connect gateway and worker health port stay inside the Compose
network.

Use the same `--env-file` and `--file` prefix for routine operations:

```sh
# Status and health
docker compose --env-file "$LINEAR_AUTOMATION_ENV" --file "$HARNESS_ROOT/compose.linear-automation.yaml" ps

# Follow logs
docker compose --env-file "$LINEAR_AUTOMATION_ENV" --file "$HARNESS_ROOT/compose.linear-automation.yaml" logs --follow

# Stop containers while preserving SQLite, repository data, caches, and Codex credentials
docker compose --env-file "$LINEAR_AUTOMATION_ENV" --file "$HARNESS_ROOT/compose.linear-automation.yaml" down
```

Do not add `--volumes` to normal shutdown. It deliberately deletes Inngest
history, repository leases and warm dependencies, package-manager caches, and
the dedicated Codex login. Both services use restart policies, and the Connect
worker automatically reconnects after an Inngest restart. The worker's stop
grace period is longer than the configured maximum triage, Spec, or
implementation runtime so an active agent step can drain.

To run another target project, create another environment file with a distinct
`COMPOSE_PROJECT_NAME`, workspace path, and dashboard port. Keep one configured
project per Compose stack until app and function identities become project-aware.

## Function boundary

The configured Harness worker registers the poller, readiness router, triage,
and each enabled repository-backed consumer:

- the poller lists at most 250 issue revisions per observed state every minute
  and fails the whole poll visibly if any state exceeds that bound;
- the readiness router reloads complete current context and emits a
  provider-neutral work request; and
- the triage consumer invokes its configured agent and projects the decision;
  and
- the optional Spec consumer claims one released issue, uses separate author
  and read-only reviewer sessions, and runs at most three reviews and two
  author revisions in one isolated Grove run; and
- the optional Implement consumer claims one released issue, runs one
  implementer profile, resumes the original author for at most one revision,
  runs the existing implementation and quality reviewers, and publishes the
  selected checkpoint or an explicitly unapproved result.

Only an updated revision creates a child checkpoint. An unchanged revision
keeps the reviewed checkpoint, while Needs Input stops without publication.
Approval publishes the exact approved checkpoint. If the third review still
requests changes, the consumer publishes the latest exact checkpoint as
explicitly unapproved so a human can review the Spec and unresolved findings.
Every terminal path attempts repository cleanup; a failed cleanup adds bounded
operator evidence instead of changing the already projected Linear outcome.

The current Harness configuration enables Spec and leaves Implement disabled,
so the poller observes Backlog and Open. A triage-only target omits
`linearAutomation.spec`, registers three functions, and observes Backlog only.
The poller accepts an explicit
`linear/poll.requested` event for deterministic smoke coverage and immediate
operator checks, but cron is the only automatic trigger.

## Live Linear cutover

The code configuration does not rename or delete workspace labels. During the
deployment cutover, stop and drain the worker, rename the **Next action** group
to **Agent action**, rename its **Plan** label to **Spec** without changing that
label's ID, and remove the old **Needs Input** label. Create one independent
workspace-level **Agent Ready** label and record its ID in `harness.json`.
Confirm that the Needs Input and Needs Review workflow statuses match the
configured IDs before restarting the worker. There is no compatibility path for
the old config shape.

`make smoke-linear-automation` starts a disposable real `inngest start`
process, connects the worker, sends explicit poll events, proves the full
fake-boundary triage and Spec publication journeys, checks unchanged-revision
deduplication, retries one transient Spec-review failure, and cleans up SQLite
state on success. It does not call live Linear, GitHub, or a real model.

`make smoke-linear-automation-compose` is the explicit Docker packaging smoke.
It validates and builds the Compose model, starts both containers on a blocked-
egress smoke network, checks service health, restarts each service, proves the
worker reconnects and accepted event history survives, and runs a real Grove
repository lease across worker restart. The repository probe verifies
post-acquire setup, secret-free setup environment, dirty-work recovery, change
inspection, reset cleanup, warm ignored dependency reuse, and persistent named
volumes. The smoke then removes all disposable containers and volumes. It does
not call live Linear, GitHub, or a model.
