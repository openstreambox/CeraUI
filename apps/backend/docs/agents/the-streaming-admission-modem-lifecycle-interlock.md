<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## THE STREAMING-ADMISSION ↔ MODEM-LIFECYCLE INTERLOCK [PARTIAL]

`modules/streaming/lifecycle-admission.ts` is a process-wide, fail-fast lease with
exactly two mutually-exclusive holders — `"streaming"` and `"modem-transition"`.
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
Right before the `down`, with no await in between, the reconnect checks that the
stream state is still the one its reads began with (no stream started, ended or
was restored) and takes the interlock; either failing skips this poll and leaves
its memory as it was. The hold ends with the `down`: the `up` is an ordinary
background dial. A Stream Start that meets the hold waits for it
(`linkTeardownSettled`, see START-LIFECYCLE.md) rather than failing, because the
refusal is not retried by any start origin. Engine-less forwarding is refused
for that span and retried by the forwarding listener's backoff. Every other
journal-only holder keeps its semantics: it never refuses a Start.

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
link teardown waits and is then admitted, that a teardown is refused during an
admission, and that an operator Stop during the wait cancels the Start;
`modules/modems/dead-bearer-recovery.test.ts` ("a stream never starts into a
teardown") pins a Start admitted, a stream gone live and a stream ended during the
owner reads, restoration during the `down`, and release after a throwing `down`.

