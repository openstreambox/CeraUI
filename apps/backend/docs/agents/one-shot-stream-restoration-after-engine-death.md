<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## ONE-SHOT STREAM RESTORATION AFTER ENGINE DEATH [EXISTS]

Failed stop IPC now completes through an optional failure callback. Local sender
and listener cleanup runs on both outcomes, but a failure never publishes a false
idle acknowledgement. Restoration queries through the orchestrator's reconciliation
seam, so authoritative engine idle retires `stop_failed` before new admission.
Its snapshot cannot inherit persisted composition, and successful recovery retracts
an earlier recovery-failed notification. Hardware and mutation evidence are in
[`docs/COMPOSITION-LIFECYCLE.md`](../../../../docs/COMPOSITION-LIFECYCLE.md).

`noteConnectionLoss` retires a session whose control connection died (see SESSION
CONTROL CONNECTION above) and, until now, that was the end of it: systemd
restarted `cerastream`, nothing tried again, and wave3 measured **0/6**
stream-level resumptions after a SIGKILL. `modules/streaming/armed-stream-marker.ts`
(the durable state + the PURE gate table) and `modules/streaming/stream-restoration.ts`
(the wiring + the runner) close that, with a deliberately narrow guarantee:
**exactly one restart attempt, scoped to the current boot.**

**The ARMED-STREAM MARKER is `stream.armed.json`**, written at the orchestrator's
`transition("streaming")` outcome gate — the SAME commit point todo 22's
`noteStreamedSourceCommitted` hooks, through a second dep (`onStreamArmed`)
rather than more work inside the first, because the two answer different
questions and each has to be provable alone. It carries the stream-defining
config snapshot plus the current `boot_id`, and nothing else that matters.

- **The snapshot is the RUNNING config, not `config.json`.** A save with no
  `apply_now` persists a restart-requiring field while the live session keeps
  encoding the previous one, so restoring from disk would apply an edit the
  operator explicitly deferred to their next start. `startStream` therefore takes
  an optional `configOverride` (absent for every other caller — byte-identical
  behaviour) and restoration passes the snapshot.
- **It is schema-parsed on WRITE, not only on read.** The snapshot is built by
  copying from the runtime config, which also holds `password_hash`, `ssh_pass`
  and `remote_key`; Zod strips everything outside the declared shape so a future
  copy-loop mistake cannot put a credential on disk. Do NOT "simplify" the
  write-path `parse()` away — it is the credential barrier, and a test asserts it.
- **The engine session id is DIAGNOSTIC ONLY and can never be a gate.** Four
  facts, each re-verified against current code rather than inherited: the
  adoption seam answers `"streaming" | "idle" | "unknown"` and nothing else
  (`streaming-backend.ts` `EngineRuntimeState`); `CerastreamBackend.start()`
  parses the engine's `StartResult` for its `state` alone and drops the
  `session_id` it really does carry (`grep session_id` across the backend hits
  test fixtures only); the engine's `Event::Status` carries no session identity
  (only the unrelated `Event::Preview` does); and the engine's ids are
  process-local counters (`format!("cs-{}", inner.counter)`), so a restarted
  engine re-issues `cs-1` for a DIFFERENT session — comparing them would be worse
  than not comparing them.

**A RUNNING ENGINE WINS, UNCONDITIONALLY AND FIRST.** The runtime-state check
runs ahead of every marker gate and short-circuits: restoration never launches
beside an engine streaming session. Reconciliation retains (`adopt`) only a
session this process launched and still owns; a predecessor's session after a
backend restart stays unconfirmed (`unknown`), so the run waits, gives up after
its unknown deadline with `runtime_state_unknown`, and leaves recovery to an
operator Stop. This is what makes a backend-only restart safe — a marker survives a
backend restart exactly as it survives an engine death, and only the engine can
say which occurred. Asking about the marker first is how a device ends up with
two sessions.

**Restoration fires only when ALL of these hold**, and each is independently
blocking (one test per condition, each proven load-bearing by neutering it):
marker present ∧ engine authoritatively IDLE ∧ `marker.bootId === current boot_id`
∧ not cleared by an operator stop ∧ no planned-shutdown stamp ∧ no prior attempt.

**STOP-CAUSE PLUMBING.** The engine-loss path calls the SAME
`stopStreamSession()` as an operator Stop, so the stop now carries an explicit
`StreamStopCause` and the orchestrator reports it from the INTENT, ahead of the
outcome (an operator who pressed Stop meant it whether or not the engine
answered, and a stop parked behind a config-change transaction must not leave the
marker armed for the minute it waits). `operator` CLEARS the marker;
`engine_loss` and `reconfigure` PRESERVE it. A parked stop replays its own
recorded cause on release.

**`boot_id` fails CLOSED.** An unreadable `/proc/sys/kernel/random/boot_id` is
treated exactly like a mismatch, and a start that cannot read one arms nothing at
all. Failing closed costs a restoration; failing open auto-restarts a stream
across a power cycle, which is a separate product decision and out of scope.

**The planned-shutdown flag is stamped ONTO the marker**, not kept as a
standalone file, so it can never outlive what it suppresses: no armed stream
means nothing to write, and the next armed stream starts from a clean marker. A
separate flag needs its own clearing rule, and getting that wrong disables
restoration permanently and silently. The update continuation writes it only
AFTER direct cache cleanup and space admission succeed, immediately BEFORE the
detached transaction launch; `startSoftwareUpdate()` stays synchronous and writes
no marker. A preflight refusal preserves the marker and atomically publishes
`updating: null` with `update_preflight_failed`. The `system.reboot`/`system.poweroff`
procedures retain their existing stamp timing. The update case is the real one: an
apt update restarts `ceralive` WITHOUT changing the boot id, so a stream armed
before an engine crash earlier in the same boot would otherwise be restored by
the post-update backend.

**`unknown` triggers NEITHER, with a declared sub-deadline.** The engine answers
`unknown` both while it is down and while a probe is transitional, so the runner
polls at `RESTORATION_POLL_MS` (1 s) for up to `RESTORATION_UNKNOWN_DEADLINE_MS`
(10 s), or `RESTORATION_ENGINE_RESTART_DEADLINE_MS` (30 s, the declared bound) for
the `engine_restart` trigger: that run starts while the engine is still down
(systemd waits 5 s, measured ready at 5.5 s) and an idle restarted engine is only
known to be idle after two silent queries. Resolving to `idle` proceeds to
eligibility, resolving to `streaming`
adopts, and expiry writes a terminal `stream_recovery_failed{runtime_state_unknown}`
that does NOT re-arm on a later restart. A busy LIFECYCLE (a config-change
transaction settling, a stop finishing) waits the same way rather than racing it.

**A REPLACED ENGINE IS EVIDENCE OF IDLE (`session-engine.ts`).** A restarted
engine is idle and sends no status, so before this the engine-restart run could
only see `unknown`. The record is taken from the Start itself: the backend reads
the engine unit's systemd `InvocationID` and main PID before it connects and
after the engine acknowledged the Start, and keeps the invocation only when both
reads name the same running process. The second read and the comparison run
off the Start's own path, and the result is recorded only while that launch's
session is still current (`noteLaunchEngine` → `onLaunchEngine`), never for an
adopted session; it is dropped once the lifecycle is idle. A reconcile with a record reads the unit's serving
identity before its first query; when that invocation differs from the record,
the session is gone (it lived in the old process), and idle is committed after
`SILENT_WITNESS_QUERIES` queries that each heard no status and got a valid EMPTY
session list, provided the serving identity read after the last query is the
same process. An RPC error or unreadable session reply is not silence here, an
engine with no process, the same invocation, a second replacement, a new PID or
any failed read keeps `unknown`, and a streaming status takes the adopt path.
The binding cannot tie the IPC socket to a PID, so the equal reads before and
after are the guard: a session started by another client in the few
milliseconds between the last empty reply and the closing read is the residual
window, and with the already-streaming rollback exception (no rollback Stop when
the engine refuses Start as already streaming) a restoration Start then leaves
that session alone. It never stops anything: an unowned sender keeps the
protection (`canReconcileIdle`), and with our own processes still running it
leaves their cleanup to an ordinary reconcile.

**THE WITNESS'S IDLE KEEPS THE OTA GUARD (restart handoff).** It proves this
process's session gone, not that nobody started one since, so the idle commit
(`commit(..., retainProtection)`) clears `is_streaming` but keeps the encoder OTA
guard. Only restoration's own Start may take that protection over (any other
Start is refused as busy, like in every unconfirmed state). The handoff ends with
restoration: a launch carries the protection into the new session; a Start the
engine refuses as already streaming goes `reconciling` with protection kept for
the operator's Stop; a Start whose rollback Stop was acknowledged releases it as
a confirmed idle; an operator Stop resolves it as today. A run that ends without
any launch calls `settleRestartHandoff`, which reconciles once with the witness
off: only an engine that reports idle releases the guard, a silent one leaves
the session `reconciling` for the operator's Stop. Restoration then takes its ordinary gates
(marker, same boot, one attempt, the operator's Stop intent, recovery barrier),
and for the `engine_restart` trigger the 30 s window is also enforced at the
launch: an idle answer from a query that crossed it gives up as
`runtime_state_unknown`.

**ONE-SHOT IS THE FEATURE.** Both outcomes write a terminal attempted-state onto
the marker, so the answer to "what happens on the next backend restart" is always
"nothing". There is no retry and no backoff; a device that cannot restore lands in
an honest `idle` with a published reason. Typed events:
`stream_recovered` / `stream_recovery_failed` (keyed operator copy in all 10
locales; the machine-readable `reason` rides `params` and is never interpolated
into operator text). Only the engine-loss trigger knows the streaming engine
restarted and uses `notifications.streamRecovered` / `streamRecoveryFailed`; boot
and the reconnect heal use the neutral `streamRecoveredAfterRestart` /
`streamRecoveryFailedAfterRestart` ("after a service restart"). The remote relay
summary for `stream_recovery_failed` is likewise neutral.

**DECLARED RESTORATION BOUND: 30 s** (`RESTORATION_BOUND_MS`) from the reconnect
event, RECORDED per attempt (`elapsedMs` + `withinBound`) rather than enforced as
a second deadline — the launch already owns its own bounded retry machinery, and
racing a competing timer against it would report a healthy-but-slow start as a
failure.

**THREE TRIGGERS, ONE SELF-SERIALISING RUN**: the engine-loss retirement
(`cerastream-backend.ts` — the seam that sees a SIGKILLed engine come back; the
engine-reconnect loop it re-arms only republishes availability and does not run
restoration), backend boot (`main.ts`, immediately AFTER `reconcileStreamSession()`
so adoption has already happened), and the engine-reconnect BOOT heal. A second
caller JOINS the in-flight run.

**It does NOT move todo 22's `last_streamed_source` slot.** Restoration re-runs
the configuration that was already live, and `noteStreamedSourceCommitted` is
idempotent on the same source — so the slot is untouched by construction rather
than by a special case. Restoration deliberately goes through the ordinary commit
hook so that stays true.

**The two markers coexist and neither reads the other.** `config.inflight.json`
(apply-now transaction) and `stream.armed.json` (a stream was live) are different
files with different lifetimes; an engine that died mid-transaction legitimately
leaves both, and each is judged on its own.

Coverage: `tests/stream-restoration.test.ts` — the pure gate table with one case
per independently-blocking condition, the adopt/restore/neither discrimination
table driven through the REAL runner against REAL on-disk markers, the stop-cause
table, one-attempt-only in both outcome directions, planned-shutdown suppression,
boot_id mismatch, the credential-barrier assertion, the two-marker coexistence
pair, and the orchestrator commit/stop seams.

