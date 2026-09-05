# Isolated interrupted queue-upgrade rehearsal (#73)

Run from this checkout with cached dependencies, including `@hapi/protocol`
resolved to this checkout's `shared` directory:

```sh
timeout --kill-after=10s 175s env -i PATH="$PATH" \
  REHEARSAL_OUTPUT=/mnt/build/private-fresh-rehearsal-directory \
  bun scripts/queueUpgradeRehearsal.ts
```

Output directory must be fresh. The harness uses a new private HOME, HAPI_HOME,
CODEX_HOME, database, workspace, synthetic authentication and allocated loopback
port. It runs actual hub, runner, Codex wrapper and a synthetic stdio native
process. The fixture does not implement provider calls or execute MCP requests.
It deliberately leaves the first synthetic turn active until interruption.

This is a source-runtime rehearsal, not a compiled HAPI release qualification.
Receipts identify git source/tree, Bun executable hash, actual owner executable
hashes, fixture/harness hashes, routing result, queue readback and survivor audit.
They must not be relabeled as a tested production binary or native model run.

## Executed invariants

- Default/explicit queue does not steer the active fixture; only one native turn
  has started before the interruption.
- Editing follows the existing cancel-and-resubmit contract (`edit-old` becomes
  `edit-new`); removal deletes `remove-me`. Remaining insertion order, edited text,
  model/effort, service tier and stored configuration survive restart.
- Exact checkpoint pending IDs: `keep-first`, `keep-second`, `scheduled-kept`,
  `edit-new`, `unknown-kept`. Full stored snapshots match after process reopen,
  followed by real authenticated queued-state readback before any new wrapper.
- The old generation is intentionally frozen with SIGSTOP, the test hub is stopped,
  and only uniquely marked test-owned PIDs are killed. All old owners must exit
  before replacements start. No broad process-name kill or production cgroup use.
- Resume routes to the same HAPI ID and synthetic native ID. Three known-undelivered
  fixture messages are explicitly retried and consumed exactly once in order.
  `scheduled-kept` and unresolved `unknown-kept` remain unconsumed.

## Findings and limitations

Baseline `9276d355` exposed a queue cancellation bug: the wrapper returned a
positive removal ACK but the hub treated every dispatch-claimed row as ambiguous.
Fix `16bbf0d0` honors only positive removal with one current CLI owner, preserves
invoked-state races, and keeps ambiguous or multiple-owner outcomes unresolved.
Regression tests accompany the fix; it requires independent release review.

The follow-on owner-race correction supersedes the count-only check in 16bbf0d0:
capture the sole socket ID before requesting cancellation, address that socket,
invalidate on any session-room join/leave during the request, require exactly one
error-free response from unchanged membership, and recheck the captured ID before
dispatch-claimed deletion. Partial ACK plus timeout never proves removal. Tests
cover two owners shrinking to one, disconnection, replacement and transient overlap.

The native fixture rejects all undeclared methods (including steer/interrupt),
with negative tests using its actual child process. Rehearsal asserts no steer or
interrupt anywhere in its native log and exact equality of the complete replacement
delivery text sequence, not just a prefix or the first pair's relative order.

A naive hub-stop followed by graceful SIGTERM is not this tested boundary: an
exiting wrapper can dispatch queued work during cleanup. The interruption fixture
therefore freezes the owned generation before stopping the hub, then terminates
the frozen processes. This is explicitly interrupted maintenance, not automatic
drain and not a promise that an active model turn survives.

Source `9276d355` leaves delivered-but-not-consumed immediate rows in dispatching
state. Readback classifies these as indeterminate; this harness preserves them,
does not downgrade them to safely queued or automatically replay them. Only the
test's three positively known-undelivered fixtures are explicitly retried after
readback. Production requires native reconciliation or explicit user resolution
for those IDs. A backup is never permission to replay an uncertain prompt.

Queue edit/remove/order is tested through real HTTP/CLI operations, with existing
QueuedMessagesBar component tests covering draft/schedule recovery. No drag-reorder
feature is added or claimed; exact Desktop UI parity and compiled-artifact staging
remain separate release checks. No live operation is authorized by this harness.
