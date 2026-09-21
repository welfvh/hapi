# Durable adjacent queue moves

Radiant's Move up/down sends an operation UUID plus the currently adjacent left
and right local IDs. It never cancels/reinserts prompts or changes transcript seqs.
Schema 28 adds a separate integer queue_order and a durable queue_moves ledger.

The hub creates a 30-second pending intent, then asks the single current session
wrapper to prepare it. MessageQueue2 refuses a nonadjacent/consumed pair or any
outstanding async reservation. Accepted preparation holds queue consumption,
Cancel and Steer while preserving the inputs in memory. New tail inputs can still
arrive. An unchanged socket owner must ACK before the hub atomically swaps the two
ranks and commits the intent. No origin receipt, local ID or delivery claim changes.

The wrapper polls its authenticated CLI operation endpoint. Pending expiry becomes
a durable abort. Committed/applied swaps the live pair once, updates FIFO restore
keys, releases consumption, and acknowledges applied. Network timeout is never an
abort or permission to replay; reserved inputs stay held until a durable decision
can be read. The phone reports an unconfirmed/pending move truthfully. Repeating
an operation UUID is idempotent. SSE publishes updated queue ranks; Android stores
and sorts them independently of transcript positions.

Old wrappers and backends without MessageQueue2 reject preparation visibly.
Existing live wrappers gain this behavior only after ordinary session reopen; do
not terminate active user turns to upgrade them. Pi has a separate prompt queue
and does not yet implement this reorder contract. Wrapper death does not replay
claimed messages: existing explicit unknown-delivery resolution still applies.

Verification is deferred until the combined shipment: run queueOrder.test.ts and
MessageQueue2.reorder.test.ts, then exercise two waiting messages on an upgraded
wrapper from DC1, a too-late move, dropped prepare ACK, disconnect during commit,
and reconnect. Confirm one delivery per local ID and unchanged receipt provenance.
