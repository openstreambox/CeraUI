<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## STREAMING ENGINE SEAM [EXISTS]

`stream-session-orchestrator.ts` is the sole owner of public start/stop state.
UI, autostart, remote control, and set-profile restarts enter the same synchronous
admission boundary; only one launch can move `idle → starting`, and stop during
start cancels that generation before a later launch can be admitted. The legacy
`is_streaming` flag changes only after the awaited engine start confirms success.
The cancellable generation exists before the awaited D8 check. A Stop during
admission fences the later answer before OTA marking or launch; cancellation,
refusal and throws release the lifecycle lease. Every Stop caller reports its
intent before joining or parking cleanup. Operator intent requests marker disarm
and immediately revokes pending commitment and delayed arming authority;
engine-loss/reconfigure intent retains it. Cancellation settlement waits for the
parked Stop, rather than racing the engine mutex. Current subscription events
remain eligible to release the latch until the deferred Stop runs. Successful
marker removal prevents restoration across a fresh factory; marker I/O/corruption
is a separate recovery limitation. Joining operator cause is preserved
for cancelled launches and parked release. Restoration reads its marker after the
awaited runtime observation, not from a pre-await intent snapshot.
`operator-stop-intent.ts` provides a process-local monotonic intent token, not
engine evidence. Every operator Stop invalidates it even when joining cleanup.
Default restoration preparation checks it after imports, validation and IP
preparation; stale settlement publishes no recovered/failed outcome. Internal
Start checks the token after recovery/reconciliation waits, at commitment, and
through the final predicate given to both delayed bookkeeping/arming hooks.
Intent is cancellation authority, not evidence that the physical stream stopped.
The profile reconnect flight captures that intent before its machine Stop await
and checks it before submitting replacement Start; a joining operator cancels
the restart, not just the old session's marker.
The OTA sentinel follows physical liveness: retain through parked,
failed or unknown stops and clear only on confirmed idle/cleanup. Reconciliation
sets/clears that sentinel on authoritative streaming/idle and retains it on unknown.
Host regression coverage does not qualify image activation on either board.
At boot and after an engine reconnect, `reconcileRuntimeState()` subscribes to the
engine's actual status. Production reconciliation retains a streaming session only
with three pieces of evidence from this backend process: it still retains a launch
attempt it began, the engine client that acknowledged this process's Start is
unchanged, and a live, unreaped sender child handle with the configured executable
runs. They are not bound to one generation number; together they rule out a
predecessor's session, not a stale attempt of this same process. A
replacement/adopted engine connection cannot prove that identity. An engine-held
session alone is not data-path proof: without sender ownership, lifecycle stays
`reconciling`, liveness stays `unknown`, and shutdown protection is retained.
Operator Stop is the explicit recovery path; no automatic replacement sender is
started. While liveness is `unknown` the session publishes that state to the
interlocks that otherwise read only `is_streaming` (USB modem mode and its offer,
FCC unlock, modem transition disruption, exclusive hotspot start and Wi-Fi mode
switch/restore), so they refuse as for a live stream; `is_streaming` itself stays
false and the UI never shows the session as live. Only concordant
`streaming` or `idle` status is authoritative. A successful subscription that sees
no event for 2.5 seconds remains UNKNOWN: the published 2026.11.1 client has no
current-status snapshot and the engine heartbeat is streaming-only. Query failure,
transitional state and contradictory fields also remain `reconciling`. An explicit
operator Stop uses a fresh connection even without a locally owned session; only
its acknowledged idle reply clears protection. Reconciliation never Stops an
unknown engine automatically. Late events from a completed probe are fenced;
an adopted subscription instead follows current client/session identity and keeps
receiving subsequent status even when its original probe epoch expires. The additive
`status.stream_lifecycle` field exposes `idle | starting | streaming | stopping |
stop_failed | reconciling`; `is_streaming` remains backward compatible.
State-only composition seeds that projection from the owner before hydration:
retained protection is `reconciling`; absent/unprotected boot is `idle`. It does
not broadcast or wait for an engine query before server bind. The first safe
transition still broadcasts, including a same-state reconciliation.

The launch transaction owns rollback and phase deadlines. Rollback completion is
not idle proof: internal failure liveness is confirmed only before Start dispatch
or after the matching rollback Stop acknowledges idle. A Start refused as
`already_streaming` sends no rollback Stop (the unscoped Stop would end the
session that caused the refusal, which may be another client's) and stays
unknown; a leftover session of our own then also waits for the operator's Stop.
The original failure
class/code is preserved when cleanup is unknown; no retry or replacement Start
is admitted. Connect/subscribe acquisitions and Start submission recheck launch
ownership. The retry runner starts the next connect attempt only after confirmed
rollback, caps attempts and elapsed
time, and exposes a cancellable timer to the same generation. Reporting suppresses
transient toasts only during existing update/restart/boot windows; terminal
failures are never suppressed and carry keyed 10-locale copy plus journal guidance.

After B3 integration, disruptive consumers must use `streamLiveness()` from the leaf `stream-liveness.ts`, not the
legacy `getIsStreaming()` boolean, for disruptive/update admission. It returns
`streaming | idle | unknown`; failed sentinel writes are unconfirmed, never latched
as protection, and retry on the next current streaming status as well as protection calls. Production initializes UNKNOWN
when the `/run` sentinel is present or unreadable. A fresh boot with positively absent
sentinel and no surviving/adopted session admits Start and does not block package/OTA
admission. This empty baseline is not a claim that a silent engine reported idle.
An in-flight probe temporarily gates admission; its silent completion cannot create
standing protection on that empty baseline. Confirmed cleanup restores the same
baseline at any generation: engine-death restoration can relaunch after a silent
reconnect rather than wait for an idle heartbeat the pinned engine never sends.
Once a launch, adoption or uncertain
rollback requires protection, only positive current idle evidence releases it.
The remover reports clearance to the owner. Failed clearance retains UNKNOWN and
retries on the next acknowledged operator Stop or current idle status; leaf idle
also requires current sentinel absence. No Start may bypass that leaf veto.
Operator-cancelled admitted starts carry settled launch liveness and the cancelling
Stop's acknowledgement/cause. A settled pre-dispatch/acknowledged-rollback launch
plus acknowledged cancellation needs no blind second Stop. Uncertain settlement
retains protection; only an explicit operator cause permits unknown-engine Stop.
Read-only probes have a separate token and advance client epoch only on adoption,
so an unused probe cannot make a launched session deaf to later idle status.
Cached runtime evidence has the producing subscription's client/epoch predicate;
it is separate from display telemetry and invalidated at new Start, acquisition
and Start acknowledgement. Old-session idle and pre-Start replay cannot release
new-session protection. Missing current evidence stays UNKNOWN.
Queued bitrate/reload failures retain their submitting client identity; an old
connection rejection cannot retire a newly adopted subscription.
The orchestrator binds its live reader after initialization; the leaf imports no
runtime orchestrator dependency, so system/update consumers cannot create a cycle.
The existing update-refusal catalogs describe an active or unconfirmed stream and
the Stop confirmation path. Reboot removes the `/run` tmpfs sentinel; it does not
make a later silent IPC subscription an affirmative idle snapshot.
The Start taxonomy has no honest existing engine-state-unconfirmed member. With
wire changes forbidden, unknown still returns `busy`/`START_IN_PROGRESS`; a truthful
typed refusal and rendered Stop availability are owner/integration decisions, not
closed by this core correction. Production-path host tests cover these transitions;
cross-connection Stop versus in-flight Start and real media remain unqualified.

### Follow-up: engine status snapshot [GREENFIELD; cross-repo, not done]

The minimal producer addition is current status hydration on subscribe or a
read-only `get_status` method with a producer-exported result and published binding.
It must report idle honestly while Start/retirement is outstanding. Publish/tag the
binding before consumer fields or methods are referenced (root publish-before-consume
rule). Engine release/delivery is owner-gated and outside this consumer-only lane.

The `StreamingBackend` interface (`modules/streaming/streaming-backend.ts`) has
**one** implementation behind the seam (the legacy ceracoder engine is fully
retired):

- `CerastreamBackend` (`cerastream-backend.ts`, Task 32) — the Rust `cerastream`:
  every op is a structured JSON-RPC call over the control socket via the
  `@ceralive/cerastream` npm package (NOT a sibling `link:` — see below). Config
  is the unified config serialized by the binding + pushed over IPC (no INI);
  errors arrive as **structured** Tier-2 events mapped onto Task-7's code table by
  `cerastream-error-mapping.ts` (zero stderr regex on this path); telemetry /
  device / status events are bridged into the existing `status` broadcast, and the
  engine telemetry snapshot is surfaced through the optional `getTelemetry()`
  hook. cerastream is systemd-owned (ADR-0005) — CeraUI connects, never spawns, so
  `start`/`stop` drive the pipeline over IPC. Additive cerastream-only RPC
  passthroughs (`switchInput`, `listDevices`) live on the concrete class, off the
  frozen seam. All effectful collaborators are injected (`CerastreamBackendDeps`)
  so the contract suite drives a real backend against an in-memory fake client.

**Engine selection** is the `engine` flag in `setup.json` (`"cerastream"` only,
schema in `helpers/config-schemas.ts`; a persisted legacy value is coerced to
`"cerastream"` at parse time with one warning — boot never crashes on it). Every
streaming call site still routes through `getStreamingBackend()`
(`streaming-engine.ts`) so a future engine can slot in behind the same seam.

**`@ceralive/cerastream` is a public-npm registry dependency** (`@ceralive` scope on
npmjs.org, pinned to a CalVer version — `2026.6.1` at time of writing) — NOT a
sibling `link:` like srtla and no longer a vendored `file:` tarball (cerastream
ARCHITECTURE §7 / ADR-0002 Decision 13: it ships to CeraUI as a published npm
package, so the backend builds standalone with no sibling checkout).
`tests/cerastream-bindings-skew.test.ts` guards the exact imported surface against
drift on a version bump.

Contract coverage: `tests/streaming-backend-contract.test.ts` runs the
structural contract over the production singleton + the cerastream behavioural
contract, error-mapping, status-bridge, passthroughs, engine-crash, and engine
selection.

### Sender lifetime limits

Startup never kills a sender by process name. A read-only process census is a
conservative presence interlock for Start and confirmed cleanup, not identity or
media proof. It subtracts a `srtla_send` process only when one of this backend's
supervised handles, stream session or SRT forwarding, has that exact PID, is
still unreaped, and the kernel names this process as its parent. A stale handle,
a reused PID or an unreadable row still counts. An unowned sender, or unreadable
census, blocks a replacement even when the engine reports idle. The Start
refusal (`start_invalid`, `sender_ownership_unproven`) is checked after the
lifecycle interlock and changes neither lifecycle nor protection. Operator Stop
can stop the engine but does not signal an unowned sender or claim cleanup while
one remains. External sender recovery therefore requires its actual owner to
retire it before Start is safe.

When the engine ends a session itself (an idle status, an idle reconcile, or a
`rollback_failed` that went idle) while children of this backend's own session
still run, the session stays `reconciling`/`unknown` and protected, retires those
children through the normal session cleanup (their handles, never a name), and
only then settles idle. A Start meanwhile answers busy. If that cleanup fails,
protection remains and operator Stop is the recovery. SRT forwarding children are
never retired by this path.

The census reads `CERALIVE_SENDER_CENSUS_PROC_ROOT` when set, else `/proc`. The
backend test preload points it at an empty private directory, so ordinary unit
tests never observe host processes; the restart service regression sets `/proc`
explicitly inside its own transient unit.

This does not provide continuity across backend service restarts. The sender is
still a backend child. Independent lifetime requires a sender host/unit contract,
boot/invocation/cgroup and session/destination identity, current owner leases and
source witnesses, durable publication generation and applied-map proof, and
reattached telemetry/control. Sender existence and engine streaming status do not
prove media delivery or an uninterrupted receiver connection.
