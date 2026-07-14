# Make Factory lifecycle semantics an explicit store-version contract

## Goal

Cut Factory over to store format version 2 because accepted restart guidance
changed which persisted `implementation.requested` histories are valid. Reject
version-1 state before parsing its events, preserve the strict current reducer,
and make incompatible future lifecycle changes require another explicit store
version bump. No migration or compatibility path is required.

## Changes

1. `lib/factory-store-format.ts:FACTORY_STORE_FORMAT` and
   `lib/factory-state-machine.ts:reduceFactoryLifecycleEvents` — bump the store
   contract to version 2, create markers from the exported constant, and remove
   the historical look-ahead exception from PR #154. Within one store version,
   every event prefix keeps the same streaming reducer semantics.
2. `test/factory-action-kernel.test.ts` — prove an earlier marked store is
   rejected before malformed event content is parsed, empty/concurrent stores
   initialize at the exported current version, and a fresh unguided pre-review
   restart remains invalid.
3. `docs/contributing/factory.md`, `docs/contributing/harness-engineering.md`,
   and `skills/factory-operator/SKILL.md` — document version 2 and the durable
   engineering rule: preserve replay semantics for the current version or bump
   the format and require archive/reset between controller contracts.

## Verify

- `pnpm exec vitest run test/factory-action-kernel.test.ts test/docs-contracts.test.ts`
- `pnpm check`
- From the exact final controller, initialize a disposable store and confirm its
  marker is version 2; point inspection at a preserved version-1 store and
  confirm it fails before lifecycle parsing with archive/reset guidance.

## Boundaries

- No event upcaster, migration framework, historical look-ahead, state rewrite,
  controller version manager, or automatic deletion.
- Preserve FER-80's existing store, refs, runs, and stashes as read-only evidence;
  restart it later in a fresh version-2 store.
