# Linear webhook source

Harness uses an Inngest-hosted webhook source as the public endpoint for Linear
webhooks. Harness does not host a Linear webhook route.

The source transform is versioned in
`lib/inngest/linear-webhook-transform.ts`. It preserves the exact raw body,
`Linear-Signature`, and `Linear-Delivery` header in an explicitly untrusted
`linear/webhook.received` event. A later Inngest function must verify that event
through `lib/linear` before using any payload field.

## Configure the source

Print the plain-JavaScript transform:

```sh
node --input-type=module -e \
  'import("./lib/inngest/linear-webhook-transform.ts").then((m) => process.stdout.write(m.LINEAR_WEBHOOK_TRANSFORM_SOURCE))'
```

Then:

1. In the Inngest dashboard, open **Manage → Webhooks** and create a webhook
   named `Harness Linear`.
2. Paste the printed function into the webhook transform and save it.
3. Copy the generated Inngest webhook URL.
4. In Linear workspace settings, open **API → Webhooks** and create an
   `Issue` webhook using that URL.
5. Store the Linear signing secret in the runtime configuration used by the
   future router. Do not add it to the transform or repository.

Leave the transform event timestamp unset. Inngest will set it to the time the
HTTP request was received, and the verifier uses that receipt time for Linear's
freshness window.

## Current boundary

The source itself persists an untrusted event only. It does not read or mutate
Linear and it does not start an agent.

`lib/linear-readiness-router.ts` defines the independent function that can
verify this event, reload current Linear context, classify readiness, and emit a
provider-neutral work request. It remains read-only with respect to Linear:
Inngest event identity and concurrency own execution safety, while later
consumers own any lifecycle projection.

`lib/linear-triage.ts` defines the independent triage consumer that can handle
the router's triage request and project one decision through the standalone
Linear service. No Connect worker registers these functions yet, and no
planning or implementation consumer is currently available.

The event ID is namespaced with the Linear delivery ID so provider retries
converge during Inngest's event-deduplication window. Missing headers remain
empty untrusted data and do not receive a caller-selected event ID.

For local tests, send a representative `linear/webhook.received` event directly
to the Inngest Dev Server. The hosted transform itself is covered by the
colocated unit test and can also be exercised with the Inngest dashboard's
transform tester.
