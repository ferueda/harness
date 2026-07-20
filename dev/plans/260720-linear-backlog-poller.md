# Poll Linear Backlog through self-hosted Inngest

## Goal

Implement FER-248 as the local replacement for the active Inngest Cloud webhook
path. One independent function polls the single configured Linear project's
Backlog every minute, publishes revision-scoped internal events, and lets the
existing readiness router refetch current Linear truth before requesting
triage. The same function may accept an explicit internal poll event for an
immediate operator run and deterministic smoke coverage; the cron remains the
only automatic trigger.

Linear remains the durable queue: successful triage moves an issue out of
Backlog, while Inngest retries failed work and deduplicates the deterministic
revision event for its 24-hour window. Do not add a cursor database or another
lifecycle owner. Exercise this implementation against a disposable local
`inngest start` process with SQLite. FER-222 owns the later live cutover and
pilot; FER-249 owns Docker packaging only after that pilot validates the
concept.

## Changes

1. `lib/linear/read.ts:listIssueRevisions`, `lib/linear/client.ts:LinearService`,
   and `lib/linear/read.test.ts` — add one standalone bounded read operation
   accepting exact team, project, state, and limit inputs. Query the official
   SDK with all three stable-ID filters, paginate through the existing
   `readLimited` boundary with `limit + 1`, and return at most `limit` sorted
   plain records containing only
   `id`, `identifier`, and ISO `updatedAt` plus an explicit truncation flag.
   This makes exactly `limit` records complete and `limit + 1` records
   truncated despite `readLimited`'s conservative boundary behavior.
   Validate inputs and upstream pages with the current `LinearError` patterns;
   never resolve comments, labels, relations, or other lazy issue fields. The
   API is parameterized for later reuse but must not know about polling,
   Inngest, readiness, triage, or multiple configured projects.

2. `lib/inngest/linear-revision-events.ts` and
   `lib/linear-backlog-poller.ts:createLinearBacklogPoller` — define strict Zod
   contracts for an explicit `linear/poll.requested` event and a
   `linear/issue.revision-observed` event. Build the observed-event ID from the
   event name/version, issue ID, and ISO `updatedAt`; do not use list position
   or poll time. Create one Inngest function with both `cron("* * * * *")` and
   the explicit poll event as triggers. Set `LINEAR_BACKLOG_POLL_LIMIT` to 250.
   In one read step, list the configured team/project/Backlog revisions and
   reject a truncated result instead of silently omitting work. Cover 250 as a
   successful maximum and 251 as rejected. In one `step.sendEvent` step, send
   the typed observed events, or return an empty result without a send step.
   The poller performs no full issue read, provider call, or Linear mutation.
   Follow the existing Inngest typed-event and strict-boundary patterns; use
   the repo's Zod and Vitest guidance for schema inference and isolated async
   tests.

3. `lib/linear-readiness-router.ts:createLinearReadinessRouter` and its tests —
   cut the active router from `linear/webhook.received` to the trusted
   revision-observed event. Remove webhook secret and organization verification
   from this function's config and first step. Refetch `getIssueContext()` and
   require matching issue ID and identifier. Proceed only when `updatedAt`
   matches; return the locked stale-revision outcome for every mismatch and
   cover both older and newer refetches. Preserve the existing readiness
   classifier, fresh confirmation for Plan/Implement, disabled-route behavior,
   and snapshot-based work-event identity. Use the deterministic revision event
   ID as `causationEventId`.
   Leave the standalone `lib/linear/webhook.ts` verification primitive and
   transform source available but unregistered; they no longer own active
   delivery.

4. `lib/schemas.ts:LinearAutomationConfigSchema`, `lib/config.ts`, configuration
   and CLI tests, and worker fixtures — remove the now-unused `organizationId`
   from `harness.json` and `LinearAutomationSettings`. This is an intentional
   clean configuration cut with no compatibility field or replacement
   organization check.

5. `lib/linear-automation-worker.ts:createLinearAutomationFunctions` and its
   tests — compose exactly the poller, readiness
   router, and triage consumer for the one configured project. Remove
   `LINEAR_WEBHOOK_SECRET` from worker startup and pass no webhook policy into
   the router. Parse and freeze the self-hosted Inngest API base URL alongside
   local event/signing keys, require it outside SDK development mode, pass it
   explicitly to the v4 `Inngest` client, and
   keep `INNGEST_CONNECT_GATEWAY_URL` as the SDK's optional environment escape
   hatch rather than a new Harness setting. Preserve the app ID, health server,
   maximum worker concurrency, provider construction, and Connect shutdown.
   Function-order assertions must prove the explicit three-function
   composition and that Plan/Implement remain disabled.

6. `scripts/smoke-linear-automation.ts`, `Makefile`, and focused tests — change
   the system smoke from the Dev Server/webhook event to the pinned local
   `inngest start` binary with disposable SQLite storage and fake Linear/agent
   dependencies. Send the explicit poll event rather than waiting for cron and
   prove `poller -> revision observed -> readiness -> triage -> projection`,
   all three registered function IDs, deterministic unchanged-revision
   identity, and clean worker/server shutdown. Keep unit coverage for the cron
   trigger itself; do not make the smoke wait 60 seconds or call live Linear or
   a real model.

7. `docs/project-intent.md`, `docs/contributing/architecture.md`,
   `docs/contributing/index.md`, `docs/contributing/script-command-surface.md`,
   README/setup/testing contracts, and linked doc tests — rename the
   webhook-specific runbook to `docs/contributing/linear-automation.md` and
   make the landed local-first path current: self-hosted Inngest, a one-minute
   configured-project Backlog poll, and a Connect worker.
   Remove Cloud webhook-source and `LINEAR_WEBHOOK_SECRET` setup from the active
   runbook, document local key generation plus `INNGEST_DEV=0` and
   `INNGEST_BASE_URL`, keep secrets out of `harness.json`, and remove
   `organizationId` from current setup examples. Remove webhook verification
   and transform guidance from the active docs while retaining their standalone
   source and focused tests. Describe only the disposable SQLite setup and
   fake-boundary smoke, and point to FER-222 as the owner of live cutover and
   pilot validation. Docker, Redis, Postgres, supervision, and multi-project
   composition remain planned follow-ups.

## Verify

- `pnpm exec vitest run lib/linear/read.test.ts lib/linear-backlog-poller.test.ts lib/linear-readiness-router.test.ts lib/linear-automation-worker.test.ts lib/inngest/linear-revision-events.test.ts`
- `make smoke-linear-automation`
- `make smoke-factory`
- `make check`
- `rg -n "linear-webhook-source|signed webhook|webhook source" README.md docs lib scripts test`

## Boundaries

- Do not add a public endpoint, tunnel, webhook-source sync, Inngest Cloud
  dependency, persistent cursor, or second state store.
- Do not add a project array, dynamic function registry, broad Linear search,
  label mutation in the poller, or Plan/Implement consumers.
- Do not add Docker, Redis, Postgres, launchd, Kubernetes, or deployment
  abstraction; FER-249 starts only after the FER-222 pilot go decision.
- Do not remove the standalone Linear webhook verification primitive or combine
  this cutover with Factory cleanup.
