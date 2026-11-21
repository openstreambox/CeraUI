# Coordinator composition

`two_radio_enabled` is an optional runtime-config boolean. Missing and false
are disabled; the schema adds no default or serialized key to existing files.
The existing network-interface monitor connects the enabled setting to the native
route-only runtime. See [live enablement](LIVE.md) for required installation,
witness and carrying-receipt configuration.

`TwoRadioCoordinator` composes normalized ingress, the pure reducer, the effect
adapter and a supplied journal. `startTwoRadioCoordinator` checks the flag before
constructing any dependencies. The coordinator serializes event admission without
holding the network owner's non-reentrant transaction while awaiting effects.
ACKs enter the reducer only after the effect adapter releases that transaction.
The designated holder is resolved and compared with the policy epoch before
dispatch. An unknown completion closes admission; create a new session and
reconcile the journal before admitting more events. Each successful coordinator
instance can start once. State views are copies. The journal retains the last designated holder across
empty session rotation; legacy snapshots recover it from their last operation.
Startup validates its current physical identity and epoch before seeding policy.

The timing defaults use a 4160 ms effect IO ceiling, 3000 ms associated linger
and 16640 ms total operation budget. These are configuration inputs rather than
a reliability claim. The reducer still emits an explicit disconnect after linger;
a live route-only owner must distinguish logical carrying-path release from
station disassociation. The native owner maps demotion/release to logical policy ownership only.

## Native integration

`native-owner.ts` supplies exact owned policy-route plans and live readback.
`runtime.ts` supplies the boot loop, serialized owner, persistent installation
claim, FileJournal and trusted ingress. `probe.ts` performs a bounded same-socket
nonce exchange with binding readback. See [LIVE.md](LIVE.md) for the independent
carrying-receipt contract and operational limits. Logical demotion/release retain
both associations; no NM mutation or default-route election runs in this path.

## Checks and replay

Run `bun test apps/backend/src/modules/network/two-radio/`. Synthetic tests drive
normal ingress through reducer, NM binding, shared physical lock, journal and
ACK feedback. They cover fresh proof, traffic-before-demotion, linger, one token,
common-target suppression, disabled construction, external-ACK rejection and
restart drainage/restoration with foreign-resource preservation. Native-owner and epoch tests additionally qualify host readback and settling.
The real namespace check in LIVE.md exercises the enabled kernel path. No host
check establishes on-device handover or media performance.

For private recordings, set `TWO_RADIO_REPLAY_FILE` to a caller-owned JSON array
of `{rows, unknown}` objects. `rows` are normalized ingress records. Sequence-only
`swap` requests can be represented at ordinal logical times, with physical/socket
identity, common clock, challenge/response, traffic and completion mappings listed
in `unknown`. Such replay must cause no transfer. Ordinal time is not measured
elapsed time. Keep original traces and converted evidence outside this repository;
do not invent events to make a recording exercise effects. Full synthetic effect
coverage is separate from recorded-evidence replay.
