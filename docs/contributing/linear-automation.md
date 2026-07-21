# Linear automation

Harness runs Linear triage through a local self-hosted Inngest server and one
long-running Connect worker. It does not need Inngest Cloud, a public endpoint,
or a Linear webhook.

```text
one-minute Inngest cron
  -> list configured project Backlog revisions
  -> linear/issue.revision-observed
  -> reload complete Linear context
  -> classify readiness
  -> work/triage.requested
  -> triage decision and Linear projection
```

Linear remains the queue. A Backlog issue without a Next action label needs
triage. Successful triage moves it out of Backlog, and unchanged revision event
IDs converge within Inngest's deduplication window.

## Configure the target repository

The target repository's `harness.json` owns stable team, project, state, and
Next action label IDs plus the triage execution profile. It contains no secrets.

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
        "inReview": "in-review-state-id",
        "done": "done-state-id",
        "canceled": "canceled-state-id",
        "duplicate": "duplicate-state-id"
      },
      "nextActionLabelIds": {
        "plan": "plan-label-id",
        "implement": "implement-label-id",
        "needsInput": "needs-input-label-id"
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

The initial worker composes one configured project. The standalone Linear read
operation accepts explicit team, project, and state IDs so another worker can
reuse it without adding a shared scheduler or project registry.

## Start the SQLite pilot

Generate local keys once in the target repository's ignored `.harness/`
directory. Both the server and worker shells source the same protected file.
Set `HARNESS_ROOT` to the Harness checkout, which owns the pinned Inngest CLI.

```sh
export HARNESS_ROOT="/path/to/harness"
export TARGET_ROOT="$PWD"
mkdir -p .harness/inngest
umask 077
printf 'export INNGEST_EVENT_KEY=%s\nexport INNGEST_SIGNING_KEY=%s\n' \
  "$(openssl rand -hex 32)" \
  "$(openssl rand -hex 32)" \
  > .harness/linear-automation.env
. .harness/linear-automation.env

pnpm --dir "$HARNESS_ROOT" exec inngest start \
  --host 127.0.0.1 \
  --port 8288 \
  --connect-gateway-port 8289 \
  --sqlite-dir "$TARGET_ROOT/.harness/inngest" \
  --event-key "$INNGEST_EVENT_KEY" \
  --signing-key "$INNGEST_SIGNING_KEY"
```

In another shell, pass the same keys to the worker:

```sh
export TARGET_ROOT="$PWD"
. "$TARGET_ROOT/.harness/linear-automation.env"
export LINEAR_API_KEY="..."
export INNGEST_DEV=0
export INNGEST_BASE_URL="http://127.0.0.1:8288"
export INNGEST_CONNECT_GATEWAY_URL="ws://127.0.0.1:8289/v0/connect"

harness linear worker --workspace "$TARGET_ROOT"
```

Run both blocks from the target repository root. Keep `.harness/` ignored so
the local keys and SQLite state cannot be committed. The worker also accepts
`HARNESS_WORKER_HOST` and `HARNESS_WORKER_PORT` for its health server, plus optional
`HARNESS_WORKER_INSTANCE_ID` and `HARNESS_APP_VERSION` metadata.

The worker exposes `/health` for process liveness and `/ready` for Connect
readiness. Stop it and `inngest start` with their normal termination signals.
The initial pilot uses SQLite and self-contained Redis snapshots. Docker
Compose packaging is planned after the local workflow is validated.

## Function boundary

The worker registers exactly three functions:

- the poller lists at most 250 matching issue revisions every minute and fails
  visibly if that bound is exceeded;
- the readiness router reloads complete current context and emits a
  provider-neutral work request; and
- the triage consumer invokes the configured agent and projects the decision.

Plan and Implement routes remain disabled. The poller accepts an explicit
`linear/poll.requested` event for deterministic smoke coverage and immediate
operator checks, but cron is the only automatic trigger.

`make smoke-linear-automation` starts a disposable real `inngest start`
process, connects the worker, sends the explicit poll event, proves the full
fake-boundary journey, checks unchanged-revision deduplication, and cleans up
SQLite state on success. It does not call live Linear or a real model.
