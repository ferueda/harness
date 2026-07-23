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
triage. Successful triage moves it out of Backlog. Work identity includes the
issue revision, so repeated observation of one revision converges while a later
human change can request new work.

Open is observed only when the worker composition enables Spec or Implement and
registers the matching consumer. Each poll cycle gives an Open readiness check
new delivery identity because blocker state can change without changing the
blocked issue's revision. The router reloads current labels, state, and blockers,
then emits a work request whose identity comes from that current readiness
snapshot. Repeated checks of an unchanged snapshot therefore converge, while a
resolved blocker produces new work.

## Workflow contract

Statuses say who owns the next move. Agent action labels say what an agent
should do, and only apply when an issue is ready or claimed for agent work.

| Status                       | Agent action                     | Meaning                                    |
| ---------------------------- | -------------------------------- | ------------------------------------------ |
| Backlog                      | None                             | Awaiting triage                            |
| Open                         | Exactly one of Spec or Implement | Ready for an agent                         |
| In Progress                  | None, Spec, or Implement         | Human work or claimed agent work is active |
| Needs Input                  | None                             | A prerequisite human answer is missing     |
| Needs Review                 | None                             | An agent artifact awaits human judgment    |
| Done, Canceled, or Duplicate | None                             | Terminal                                   |

An unresolved Linear blocker is separate from both status and action. It keeps
an otherwise actionable issue waiting.

After answering a Needs Input issue, a human moves it to Backlog to request
triage again. The resulting Linear revision gives that request new identity; a
comment alone does not start triage. When reviewing an artifact, a human either
returns it to Open with one action or moves it to a terminal status. Apply the
Spec or Implement label before moving the issue to Open so the ready snapshot is
complete. For example, an approved spec returns as Open + Implement, while a
spec needing revision returns as Open + Spec.

## Configure the target repository

The target repository's `harness.json` owns stable team, project, state, and
Agent action label IDs plus the triage execution profile. It contains no
secrets.

```json
{
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
      }
    },
    "triage": {
      "agent": "codex",
      "model": "gpt-5.6-sol",
      "modelReasoningEffort": "high",
      "maxRuntimeMs": 1800000
    }
  }
}
```

The initial worker composes one configured project. Its route map controls both
which consumers exist and which states the poller observes. The standalone
Linear read operation accepts explicit team, project, and state IDs so another
worker can reuse it without adding a shared scheduler or project registry.

## Run the local Compose stack

The deployment contains one self-hosted Inngest service and one Harness worker.
It is intentionally scoped to one configured target repository. Inngest keeps
its SQLite database in a named volume, while the worker reads the target checkout
through a read-only bind mount.

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
  printf 'INNGEST_EVENT_KEY=%s\n' "$(openssl rand -hex 32)"
  printf 'INNGEST_SIGNING_KEY=%s\n' "$(openssl rand -hex 32)"
} > "$LINEAR_AUTOMATION_ENV"
```

`CODEX_API_KEY` is the recommended auth path for an unattended worker. Compose
passes it only to the worker, and Harness forwards it only to the Codex child
process. The protected environment file remains outside the target repository.

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

# Stop containers while preserving SQLite and Codex credentials
docker compose --env-file "$LINEAR_AUTOMATION_ENV" --file "$HARNESS_ROOT/compose.linear-automation.yaml" down
```

Do not add `--volumes` to normal shutdown. It deliberately deletes Inngest
history and the dedicated Codex login. Both services use restart policies, and
the Connect worker automatically reconnects after an Inngest restart. The
worker's stop grace period is longer than the configured maximum triage runtime
so an active agent step can drain.

To run another target project, create another environment file with a distinct
`COMPOSE_PROJECT_NAME`, workspace path, and dashboard port. Keep one configured
project per Compose stack until app and function identities become project-aware.

## Function boundary

The worker registers exactly three functions:

- the poller lists at most 250 issue revisions per observed state every minute
  and fails the whole poll visibly if any state exceeds that bound;
- the readiness router reloads complete current context and emits a
  provider-neutral work request; and
- the triage consumer invokes the configured agent and projects the decision.

Spec and Implement routes remain disabled, so the current composition observes
Backlog only. Enabling either route adds Open observation in the same composition
change that registers its consumer. The poller accepts an explicit
`linear/poll.requested` event for deterministic smoke coverage and immediate
operator checks, but cron is the only automatic trigger.

## Live Linear cutover

The code configuration does not rename or delete workspace labels. During the
deployment cutover, stop and drain the worker, rename the **Next action** group
to **Agent action**, rename its **Plan** label to **Spec** without changing that
label's ID, and remove the old **Needs Input** label. Confirm that the Needs
Input and Needs Review workflow statuses match the configured IDs before
restarting the worker. There is no compatibility path for the old config shape.

`make smoke-linear-automation` starts a disposable real `inngest start`
process, connects the worker, sends the explicit poll event, proves the full
fake-boundary journey, checks unchanged-revision deduplication, and cleans up
SQLite state on success. It does not call live Linear or a real model.

`make smoke-linear-automation-compose` is the explicit Docker packaging smoke.
It validates and builds the Compose model, starts both containers on a blocked-
egress smoke network, checks service health, restarts each service, proves the
worker reconnects and accepted event history survives, then removes all
disposable containers and volumes. It also does not call live Linear or a model.
