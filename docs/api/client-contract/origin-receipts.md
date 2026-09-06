# Origin receipts (#151)

Implementation base: production fork `welfvh/hapi`, `feat/radiant-github-issues`,
`8f1b000a`. Schema 27. Parent owns integration, build, publication and cutover.
This contract acknowledges durable hub insertion, not provider execution.

## Wire contract

All endpoints use the existing bearer authentication and JWT namespace. Do not
send a namespace in the request. Keep the original hub, original session ID and
local ID unchanged in the client outbox, including after session replacement.

- `GET /api/message-receipts/capability` returns `{version:1, localIdPrefix}`.
- For a **new, never-attempted** operation, append a fresh UUIDv4 to that prefix
  and durably save the complete local ID before the first POST. Never relabel an
  attempted legacy operation with a new local ID or prefix.
- `POST /api/sessions/:originalSessionId/messages` retains existing fields;
  add `originReceiptVersion:1` and the saved `localId`. Success remains
  `{ok:true}`, with `receipt` added for local-ID messages.
- `GET /api/message-receipts?originalSessionId=…&localId=…` returns an exact
  receipt without requiring the original session to exist or be active.

Accepted receipt:

```json
{"version":1,"status":"accepted","originalSessionId":"origin","localId":"saved-id","messageId":"durable-message","acceptedAt":123,"resolvedSessionId":"destination","messageState":"retained"}
```

`messageState` becomes `deleted` when the message no longer exists. Acceptance
remains permanent; this is not permission to reinsert. Destination follows
message moves. Clear, cancellation, truncation and deletion do not erase proof.

Non-accepted lookup returns `{version:1,status,originalSessionId,localId}`:

- `absent`: ID matches this database's permanent randomly generated capability
  prefix and a UUIDv4 suffix; no acceptance is committed at this observation.
  A concurrent original request may still commit. Retrying the **same key** is
  safe through the transaction, not because lookup reserves absence.
- `legacy-unknown`: no receipt and no provable post-migration ID provenance.
  No history scan or timestamp inference. Versioned POST refuses insertion with
  HTTP 409 `legacy_unknown` unless a retained row in the original session itself
  proves acceptance and no receipt already attributes that row to another key.
  Only that unclaimed, in-place legacy row can be backfilled. Shared-destination
  collisions, routed legacy rows without origin proof, and covered IDs lacking
  receipt provenance return HTTP 409 `origin_conflict`, never an acceptance for
  another origin. Do not replace the local ID to evade a conflict.

There is no server `sending` state: uncommitted transactions are not acceptance;
client transport state remains separate. Errors/timeouts are never absence.
HTTP 200 without a matching receipt from older servers is not this contract's
ACK. Do not use a capability from another hub/database to rewrite an outbox ID.

## Invariants and lifecycle

- SQLite `BEGIN IMMEDIATE` encloses original-key lookup, same-namespace routing,
  existing-row deduplication, insertion and receipt. WAL uses synchronous FULL.
- Accepted duplicate returns before active-session checks or delivery. New text,
  schedule or steer flags never change the original acceptance or emit again.
  Verified legacy backfill persists its receipt, then takes the same no-delivery,
  no-activity/SSE/thinking path; it does not revive an idle session.
  Explicit existing queue edit/steer APIs retain their separate semantics.
- Merge persists the old-to-new route atomically with message moves. Routing
  validates each metadata/retained route hop in the insertion transaction;
  changed destination, cycles and unavailable targets fail closed. Explicit
  deletion writes a permanent tombstone, never recreating a session via POST.
- Receipts/routes have no foreign keys, cascade, TTL, payload, attachment paths,
  fingerprints or credentials. Minimal identifiers/timestamps remain personal
  metadata protected by namespace authentication and the private database.
- Legacy unversioned clients remain compatible but cannot claim safe replay of
  pre-feature missing operations. Migration does not invent their origin IDs.
- Back up receipts, capability and routes with the database. Restoring an older
  snapshot loses deduplication history; downgrade to schema-26 binaries is not a
  safe rollback. Namespace erasure needs explicit policy, not receipt expiry.

Release checklist: isolated store/concurrency/crash and authenticated route
tests; independent review; client persists versioned new IDs and reconciles exact
receipts; parent full mechanical/build gates; separately authorized cutover.
No provider execution or live migration is performed by these tests.
