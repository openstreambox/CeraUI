# Retained FM350 internal calls

The existing ModemManager path remains the default for FM350-GL, including
firmware `81600.0000.00.29.18.01`. This layer adds an alternative internal call
owner for that exact firmware and RNDIS composition. It does not change modem
polling, activate the alternative at startup, or remove existing FM350 support.

`fm350_internal_calls` is a device-local configuration map from physical modem
key to boolean. Missing, false, another modem's key, unknown firmware and other
USB compositions all refuse new internal calls. There is no global enable flag
or operator control in this layer. Leave the map absent until the alternative
has been qualified on that firmware and the cellular runtime has been composed.
The setting is separate from the capability-module gates and reports no new
support or certification claim.

## Composition boundary

`InternalCallOwner` takes the current carrier policy, including its requested
family, from the existing profile planner; it does not own
a second carrier/family table. Its injected `current` callback must verify the
profile, automatic intent, physical instance and subscription after awaited
work. The owner also rechecks its switch at admission and publication boundaries.
Call effects use the existing modem lifecycle lease and durable mutation journal.
There is no new poller, timer, start-admission interlock or sender publisher.

The runtime supplies a retained unit lease, `InternalCallAuthoritySession`,
`createInternalCallContext`, and a host implementing `InternalCallHost`.
`CellularHostHandoff` captures RA defaults, NM management and link state before
inhibition; `fm350-control` keeps a dedicated non-reconnecting system-bus
connection for the inhibition lifetime. Four stable registration reads precede
activation. A grant is not a claim of packet-flow health.

The native host owner can use `createInternalNativeAddressEffects` for its
optional `ownedAddress` step: fence, address, routes on apply, reversed on
withdrawal. Persist the physical tuple, boot ID and /32 before dispatch. The
address adapter uses exclusive indexed writes, refuses foreign matching tuples,
and never flushes the interface. NetworkManager-observed grants omit this step.
The same native host inverse must retain the address until sender/consumer
withdrawal is positively acknowledged; do not create a second address owner.

## Durable authority and recovery

A context baseline belongs to the physical unit and context number. It retains
its subscription reference, complete context settings, activation ownership and
an effects cursor. SIM changes park the predecessor's context instead of writing
its APN onto a replacement SIM. Unreadable identity is never absence.
The whole-owner record binds the context to its boot, USB generation, link index
and host handoff. It cannot be replaced by a newly enumerated modem or MM index.

`createInternalCallRecovery(adapters)` composes with the existing startup replay
owner. Migrate/inventory internal authority first, replay internal withdrawal
before ordinary modem rollback, and retain deferred rollback entries whenever
withdrawal is incomplete. An incomplete replay throws; it must never be counted
as a completed or skipped rollback pass. `verify()` is read-only and cannot run
hardware or migration. Recovery is independent of the new-call switch.

The adapters provide fresh physical/unit lookup, synchronous source withdrawal,
and **authority-scoped** host and consumer census. They must not return all host
slots or fence another live slot's interface. Use `acquireCellularInverseControl`
for replay: it accepts only the retained physical tuple under the existing
recovery barrier and cannot activate a call, reset a modem or change QMAP.
The outer recovery owner supplies bounded startup admission and operator notices;
this layer has no independent autostart wait. A held slot remains deferred for
that owner rather than starting another recovery loop.

Withdrawal order is publication removal, grant/consumer release, context
inverse, durable context-release acknowledgement, host inverse, control closure,
and whole-owner retirement. An uncertain control close retries only closure.
An already-withdrawing retry writes no identical transition. Slot cursor writes
have their own revision and do not invalidate unrelated global journal readers;
real read/schema faults still raise the existing recovery barrier.

Private records use the shared fd-anchored private writer,
with 0600 files, 0700 directories and parent fsync. Raw subscription identifiers
are not filenames. Invalid/misfiled records are preserved and refuse recovery.
The host/inverse interfaces are additive seams for the cellular runtime; this
layer deliberately makes no change to the production composition root.
