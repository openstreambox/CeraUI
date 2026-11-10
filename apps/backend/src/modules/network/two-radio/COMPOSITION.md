# Coordinator composition

`two_radio_enabled` is an optional runtime-config boolean. Missing and false
are disabled; the schema adds no default or serialized key to existing files.
The setting is reserved for owner composition and is not yet connected to the
backend startup path. Setting it true alone does not enable handovers.

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
station disassociation. No such reinterpretation is hidden in this composition.

## Remaining live integration

The caller must supply the existing owner's `NetworkOwner` and `IngressAuthority`,
plus a `FileJournal` under an existing private persistent state directory and a
unique session. The generic NM binding can construct the owner, but its plans,
server-side drain, ownership checks and holder readback still require native
implementations. Never substitute a successful nmcli exit or a connected-state
poll for NM quiescence. The existing native captive-portal readers can provide
bracketed D-Bus/kernel identity observations; they do not cancel mutations or
fence pending server work. No timer, RPC, socket, route or NM mutation is installed
by this module. Live policy-route composition remains unfinished.

Future live route swaps must move only an explicitly owned policy route/rule,
retain both associations, await independent carrying-traffic confirmation, linger
and release only the logical old path. They must never call the host default-route
election as a swap effect. Bound nonce challenge/response dispatch and receive
records must come from a trusted socket source; arrival-only receiver logs cannot
supply them. The media path supplies independent real-traffic receipts.

## Checks and replay

Run `bun test apps/backend/src/modules/network/two-radio/`. Synthetic tests drive
normal ingress through reducer, NM binding, shared physical lock, journal and
ACK feedback. They cover fresh proof, traffic-before-demotion, linger, one token,
common-target suppression, disabled construction, external-ACK rejection and
restart drainage/restoration with foreign-resource preservation. They qualify the
library composition, not native NM callbacks or on-device handovers.

For private recordings, set `TWO_RADIO_REPLAY_FILE` to a caller-owned JSON array
of `{rows, unknown}` objects. `rows` are normalized ingress records. Sequence-only
`swap` requests can be represented at ordinal logical times, with physical/socket
identity, common clock, challenge/response, traffic and completion mappings listed
in `unknown`. Such replay must cause no transfer. Ordinal time is not measured
elapsed time. Keep original traces and converted evidence outside this repository;
do not invent events to make a recording exercise effects. Full synthetic effect
coverage is separate from recorded-evidence replay.
