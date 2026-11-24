<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## THE STREAMING-ADMISSION ↔ MODEM-LIFECYCLE INTERLOCK [PARTIAL]

`modules/streaming/lifecycle-admission.ts` is a process-wide, fail-fast lease with
exactly two mutually-exclusive holders — `"streaming"` and `"modem-transition"`.
Acquisition never waits. The one waiter sits outside it: a Stream Start waits,
within a budget, for a dead-bearer link teardown to release before it asks (see
below).
A USB-composition switch re-enumerates a modem and tears its bond link down
mid-flight, so it must never overlap a stream, in EITHER order.

**`getIsStreaming()` cannot express the dangerous half of that.** It is false for
the whole ADMISSION window — from the moment a start is admitted until the engine
confirms PLAYING — which is exactly the window a transition must not land in: by
then `startStream` has already spawned `srtla_send` against a link list a
re-enumeration is about to invalidate. The interlock covers that window; the live
guard covers the rest. Nothing else changes: `modems.setUsbMode`'s existing
`getIsStreaming()` gate is untouched.

- **The acquisition point is load-bearing.** It sits in
  `stream-session-orchestrator.ts` `start()` AFTER the `state !== "idle"`
  duplicate-start rejection — so a genuine duplicate keeps its own `busy` →
  `START_IN_PROGRESS` instead of decaying into a generic lease-busy answer — and
  BEFORE the attempt goes in-flight (`generation`/`active`/`starting`). It is at
  the ORCHESTRATOR rather than in `streaming.procedure.ts` because all five
  launch origins (ui / autostart / remote-control / set-profile / restoration)
  enter through that one mutex.
- **Refused as a typed, non-retriable `failed` StartResult** carrying
  `code: MODEM_TRANSITION_ACTIVE`, which `startResponse` surfaces as the wire
  `error`. `leaseRefusal()` is the ONE table both directions read, so the
  streaming side and the modem side can never disagree about what happened; the
  modem side's token is deliberately the SAME `streaming_active` the procedure
  already answers for a LIVE stream.
- **Released in a `finally`, and idempotently.** Release is keyed on a per-grant
  TOKEN, not on the holder, so a double-release and a stale `finally` are no-ops
  rather than a way to free whoever holds it now. Note the coverage subtlety a
  mutation exposed: a throwing LAUNCH is caught by the retry runner and returned
  as a typed `failed`, so it exercises the ordinary return path — the `finally`
  needs its own fixture (a dep that throws mid-admission).
- **`admitLifecycle` is an OPTIONAL orchestrator dep, wired only at the
  production singleton.** The lease is process-wide. The pinned Bun 1.4.5 `--parallel`
  runs files in isolated worker processes, but tests within each file still
  share module state: a pending start can strand later admissions in that file.
  Keep explicit lease cleanup and use a per-file `mkdtemp` root for persisted
  fixtures; worker isolation does not isolate shared filesystem paths.

**The `"modem-transition"` holder is now acquired by `modems.setUsbMode`**
(`rpc/procedures/modems.procedure.ts`, gate 4 — see USB-COMPOSITION SWITCH above).
Both directions are therefore live in production.

**The dead-bearer reconnect takes it across its `down`** (`tryAcquireLinkTeardown`,
called from `modules/modems/dead-bearer-recovery.ts`). The reconnect's own
background lease (`withBackgroundModemLease`) is a journal-only key, which this
interlock does not count, and its owner reads await; without the hold, a Start
admitted during those reads launched onto a link that went down a moment later.

- **Before the `down`**, with no await in between, the reconnect checks that the
  stream state and the stream admission count (`streamingAdmissionCount`) are
  still what its reads began with, takes the interlock and marks the link pending
  in `network/link-teardown-pending.ts`, which `isBondCandidate` refuses (a CLAT
  TUN through its modem). A changed stream or a held interlock skips this poll.
- **Until it settles.** The hold lasts until NetworkManager shows the device has
  let go of the connection (disconnected, or carrying another one), at most
  `LINK_TEARDOWN_MAX_HOLD_MS` (6 s), and releases itself at that bound whatever is
  still awaited. A device still activated with this connection counts as "the
  `down` did not take" only at the bound, because an `nmcli` that gave up
  (exit 3) can leave NetworkManager about to deactivate. Settled or not taken:
  the pending mark is lifted. Not settled (an `nmcli` timeout, a device stuck
  deactivating, an unreadable device): the link is re-marked at the outcome, no
  `up` follows, and a status poll lifts the mark only once it reads the device no
  longer deactivating. Status polls are not serialized, so a poll skips links
  whose teardown is still in flight. A poll also lifts marks no profiled modem
  owns (re-enumerated without a profile, or gone) and marks whose profile no NM
  device carries any more. At startup, right after modem discovery, a scan marks
  any modem link NetworkManager still shows deactivating, so a backend that
  restarted mid-teardown does not offer it to the bond either. Accepted residual:
  a Start in the seconds before that scan finishes at boot.
- **The `up`** follows only onto a free device (disconnected, no active
  connection), checked right before; another profile that activated after the
  `down` is left alone, as is a device that is not yet free. The `up` itself is
  not held: it is an ordinary background dial. Accepted residual: an NM
  autoconnect between that check and the `up`.
- **The outage hold** restarts after a skip caused by stream activity and
  whenever a stream was admitted since the outage began, so a stream that came
  and went between two polls is not counted as quiet time. A skip because another
  modem change holds the interlock (`linkTeardownRefusal() === "transition"`)
  neither restarts nor counts. At most `DEAD_BEARER_MAX_HOLD_RESTARTS` (3) restarts
  per outage, counted afresh when the outage ends: a stream flapping at every
  eligible poll would otherwise keep a dead link dead. Past the cap only the
  checks before the `down` still apply.
- **A waiting Start.** A Stream Start that meets the hold waits for it
  (`linkTeardownSettled`, budgeted, see START-LIFECYCLE.md) rather than failing,
  because no start origin retries the refusal, and no new teardown begins while
  it waits. Engine-less forwarding is refused for the span and retried by the
  forwarding listener's backoff. Every other journal-only holder keeps its
  semantics: it never refuses a Start.

**The refusal has its OWN failure class and its own operator copy.**
`MODEM_TRANSITION_ACTIVE` used to ride the generic `start_invalid` class, which the
frontend renders as "The stream configuration or device is invalid. Check your
settings." — wrong advice for a modem that is merely re-enumerating, and the reason
the class split exists. `START_FAILURE_CLASSES` gained `modem_transition_active`
(non-retriable on every phase: the transition is bounded and operator-initiated, so
an automatic retry would race a mutation of the very links the start is bonding),
with copy in all 10 Paraglide catalogs
(`live.startFailure.class.modem_transition_active` +
`notifications.streamStartModemTransitionActiveFailed`).

Coverage: `tests/streaming-lifecycle-interlock.test.ts` — the primitive's refusal
table and both exclusion directions, race order A (a start during a transition is
refused and NEVER launches), race order B (a transition during an admitted start
is refused until it settles), the duplicate-start ordering lock, finally-release
under a throw, the idempotent/stale release, and the production `streaming.start`
wiring driven through the REAL procedure. The same suite pins that a Start during a
link teardown waits and is then admitted, that it asks again after every wake,
that no teardown begins while it waits, that a spent budget refuses it as
`modem_transition_active`, that a wall-clock step does not end the wait, that a hold
releases itself at its bound, that the test
reset wakes waiters, that a teardown is refused during an admission, and that an
operator Stop during the wait cancels the Start.
`modules/modems/dead-bearer-recovery.test.ts` pins a Start admitted, a stream gone
live, ended, or admitted and ended during the owner reads, restoration during the
`down`, release after a throwing `down` or failed bookkeeping, the hold until the
device settles, the bond exclusion for an unsettled or unreadable device and after
a restart, the free-device check before the `up`, and the capped hold restarts.
`modules/network/link-teardown-pending.test.ts` pins the bond refusal.

