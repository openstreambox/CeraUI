# Two-radio hold/search/swap policy

`reducer.ts` extends the network owner's policy surface without creating a runtime
or installing effects. It imports no hardware, process, gateway or experiment code.
The initial designated holder is `a`; neither path is useful before evidence.
Radio slots must map to stable physical devices, not reusable interface names.

Call `reduce(state, {version: 1, at, event})`. Time is finite monotonic milliseconds
relative to a trace origin; equal timestamps preserve recorded order. `replay`
accepts the same JSON-serializable rows (for example JSONL from a event recorder)
and returns all effects. Start each trace with identities for both slots. Record
challenge dispatch, response, identity, round closure, requests, traffic receipts,
command completion, cancellation and clock ticks. This is a typed replay format,
not a parser for untrusted event logs; an ingress adapter must validate JSON,
map live physical identities and correlate original receiver records. Never
synthesize missing acknowledgements. Keep raw event evidence outside product code.

A challenge id is a receiver-issued nonce, unique for this reducer lifetime. Its
socket id names one actual device-bound socket; a successful response on that
same socket proves receive as well as transmit. `deviceBound` is an adapter
attestation, not an observation the reducer can independently verify. A proof
retains radio, full epoch, target, round, socket, start/completion times and expiry.
Bonding receiver acknowledgements should feed the traffic receipt when available;
a probe alone cannot produce `traffic`. Expiry is exclusive. An identity update
invalidates outstanding challenges and unfinished round results. Epoch activation
ids and route generations must never be reused for a different live incarnation.

Close a target/round only after both radios have completed challenges. Incomplete
rounds remain unknown. A split result can start the holder's emergency timer; a
common failure marks the target suspect and cancels a pending transfer. The suspect
latch is conservative for this reducer lifetime (explicit new session required to
clear it). Expiry/identity changes never start an emergency timer. A voluntary
`swap` requires a useful searcher; a tick after a split-failure deadline requests
the same transfer. Neither bypasses token ownership.

Every departure action, including scanning, is admitted only for the searcher,
under one token. Swap promotion also reserves this token. Promotion acknowledgement
must precede a correlated live-epoch real-traffic receipt, then old-holder demotion
must complete, then linger must elapse before disconnect is emitted. Cancellation
or timeout before that disconnect leaves the old designated holder and emits
`cancel-drain-restore`. Once disconnect is dispatched the new holder is committed;
cancellation/timeout cleans up while preserving that holder. No effect is retried
implicitly. Failed cleanup retains the token for explicit recovery/completion.

## Effect adapter contract (not implemented here)

Execute commands under the existing network owner and physical-adapter lock.
Validate the effect's exact epoch immediately before each effect. A stale identity
must never act on a replacement device. Each acknowledgement echoes **both**
operation and command numbers; duplicate/late completions cannot advance phases.
`cancel-drain-restore` closes admission, cancels and drains all commands from the
operation, restores the named holder when that exact identity still exists, and
removes only operation-owned candidate resources. A positive cleanup ACK means
all that work is verified and no canceled command can subsequently apply. If
identity or restoration is unknown, do not ACK success; retain the token and
reconcile under the existing owner. Token timeout never pretends cleanup finished.
This contract is necessary: ignoring a late ACK cannot undo a late Linux effect.
A production adapter still needs bounded IO, durable crash reconciliation and
measured device qualification; this module does not claim those exist.

The model retains nonce/round history for deterministic finite replay. A runtime
must bound session length or rotate the reducer only after quiescent reconciliation;
it must not prune history while delayed callbacks can still arrive.

`reducer.test.ts` uses a fake clock and bounded exhaustive event words/permutations.
The four guarantee regressions cover fabricated/unbound/stale proof, premature
release/cancel/timeout, overlapping interrupting actions/holder scan, and
expiry-driven/common-target emergency. Additional controls cover command fencing,
live identity changes and cleanup settlement. Run from the checkout root:

```sh
bun test apps/backend/src/modules/network/two-radio/reducer.test.ts
```
