<!-- Relocated from AGENTS.md when merging main into update-system-overhaul -->

## THE DEVICE UPDATE SYSTEM [EXISTS; capable-image paths PARTIAL]

The update orchestrator, `apps/backend/src/modules/system/update-orchestrator/`,
tracks package discovery/install, OS staging/activation and slot mirroring for
its own path, alongside legacy package-update RPCs and a periodic loop; D8
supplies stream-start admission against its tracked phase. The implementation reference is
[`docs/DEVICE-UPDATES.md`](../DEVICE-UPDATES.md); the backend's load-bearing
rules are in [`apps/backend/AGENTS.md`](../../apps/backend/AGENTS.md) → THE UPDATE
ORCHESTRATOR. The feature notes, stated at the level a CeraUI change needs:

- **[EXISTS] Orchestrator.** `reduceOrchestrator` and `runtime.ts`; state and
  persistence reference: [`docs/DEVICE-UPDATES.md`](../DEVICE-UPDATES.md).
- **[EXISTS] D8 admission.** Detailed table:
  [`docs/DEVICE-UPDATES.md`](../DEVICE-UPDATES.md#d8-stream-admission).
  See "D8 stream/update admission: what it does NOT cover" under Known gaps below.
- **[EXISTS] Schedule and idle.** 6 h package / 12 h OS checks with jitter and a
  24 h-capped backoff, gated by `packagesAuto` / `systemAuto`. Scheduled installs
  wait for idle (`getIdleStatus()`: 30 minutes without stream, preview, start
  lease, remote command or UI heartbeat, inside the configured window). Remote
  presence is a five-minute command-recency heuristic, not true presence.
- **[EXISTS] Settings, capabilities and RPCs.** `system.getUpdateSettings`,
  `setUpdateSettings`, `getUpdateCapabilities`, `checkUpdatesNow`,
  `installUpdatesNow`, `allowCellularOnce`, `getUpdateDetails`. Launch limits:
  D8 Known gaps (f) below.
  The channel selects system images only, defaulting to beta. Packages always
  use stable APT. `update-image-channel.json` holds the image choice while the
  original six-key settings file keeps `channel: "stable"` for older CeraUI
  after rollback. Its private `allowSystemDownloadsOverCellular` field supplies
  download consent; a missing field means false regardless of the old check-only
  preference. Legacy files migrate once; explicit consent and Stable image choices
  survive restarts and v2026.11.1 rollback because its writer leaves the sidecar alone.
  OS manifest checks always run over cellular. The system cellular switch
  permits bundle/kernel downloads; otherwise an exact one-time approval is
  required. Candidate approval is computed at use, never persisted from the switch.
  Queued OS/kernel downloads re-read consent at dispatch; a successful switch
  revocation invalidates captured permission across preparation awaits. Read
  errors refuse download, while exact-candidate one-job approval remains valid.
  Deferred package checks cannot starve OS checks in the idle scheduler, and a
  waiting package offer (`available`) runs the due OS check in place; a found
  image supersedes the offer. Capable discovery withholds the image's own
  packages (`image-owned-packages.ts`: the image's local-override pin, else a
  fixed list). An image that ships its own signed apt source
  (`image-apt-source.ts`, `/usr/lib/ceralive/image-apt-source.json`) makes it
  the only package origin, passed to every package apt run. On it, the token in
  its URI is shown by host only, checks wait for the clock gate and need a
  refresh of both suites, installs are manual only (queued plans are dropped,
  an install that never launched is a `failed` the next check leaves, see the
  table below), and an invalid record fails closed. See DEVICE-UPDATES.
  A first image offer waiting for cellular download approval also permits due
  package checks. The image candidate and pending approval survive package work;
  OS staging still requires approval and discovery re-admits the held offer.
  Optional details fields expose check deferrals, consecutive failures and an
  unpublished image channel; older backends may omit all three observations.
  See [Settings](../DEVICE-UPDATES.md#settings) and the
  [durable placement map](../CONFIG_PERSISTENCE.md#durable-device-config).
- **[EXISTS] Updates dialog and global surfaces.** Settings → Software Updates
  shows Packages, System image, Kernel, Slots, Automation, Over cellular and Update
  connection, gated by `updateCapabilityView()`; a legacy image states the limit
  instead of hiding it. `UpdateOrchestratorBadge` shows a busy update app-wide;
  `live/UpdateRefusalBand` warns before Go Live (live push first, typed refusal
  as fallback).
  The Kernel section requires capable mode plus `kernel-apt-stage`; mocked RPC
  browser proof and the EN/es-419 label handoff are in the
  [kernel UI contract](../DEVICE-UPDATES.md#kernel-update-dialog-exists--browser-tested).
- **[EXISTS] Recovery.** Quarantine of exact failed candidates
  (`quarantine.json`), idle-only restart of stale services with a protected-unit
  list, and keyed update notifications. Contract:
  [`docs/UPDATE-RECOVERY.md`](../UPDATE-RECOVERY.md).
- **[EXISTS] Package progress.** APT gets no telemetry descriptor, so reading
  progress can never stall or fail it: the phase and number come from the
  unit's own stdout transcript (the plan, `Get:`/`Fetched`, dpkg's
  `Unpacking`/`Setting up`), capped at 99, and only a successful result shows
  100%. A running transaction's phase and number never move back in the
  overlay, across a backend restart included (Settings holds within one
  continuous run of frames and follows the device's state after the restart's
  gap); a number that cannot be confirmed live (unreadable transcript, dropped
  connection) is not shown. See
  [Package update progress](../DEVICE-UPDATES.md#package-update-progress).
- **[EXISTS; host-tested] Outcome after a restart.** A tab that missed an
  install's result asks the device, read-only, whether the exact instances
  that install's own frames carried (`updating.targets`: name, architecture,
  version before) are installed and configured (`system.updateOutcome`); a
  frame with another `updating.run` is a new run; the read-back success says
  **Packages installed**, never **Successfully Updated**; the fixed-name
  unit's exit is only an unattributed hint, never **Update Failed**; unit
  handling stays main's.
- **[EXISTS; host-tested] Download-hold notice.** Genuine D8 package/OS
  interruption captures an opaque attempt before awaits and publishes through a
  detached macrotask and separate strict ledger. Committed intents rehydrate and
  retain acknowledgement; pre-ledger backend death can lose that informational
  notice without losing the safe offer transition. Hold wording in all ten
  locales does not prove media launch or physical network quiescence. See
  [`durability and scheduling limits`](../DEVICE-UPDATES.md#download-hold-notice-exists-host-tested-board-qualification-owed);
  installed both-board proof is still owed.
- **[PARTIAL] APT all-package scope.** Origin-filtered, exact `name=version`
  installs under one flock. Active only on an image declaring `apt-all-packages`;
  every shipping image is legacy (`features: []`) and keeps the exact-name
  15-package roster. The repaired package-policy join and flock-wrapped systemd
  identity were exercised on bench-enabled Rock 5B+ and Orange Pi 5+ boards;
  packages installed, but both installs ended in sticky
  `failed / commit_unit_absent_on_resume`. The legacy completion exit ran before
  the orchestrator persisted `COMMIT_SUCCEEDED`. On this branch a capable,
  orchestrator-owned completion now persists `restarting-services` before exit;
  the fixed build has **not** been re-proven on a board. See
  [`docs/DEVICE-UPDATES.md`](../DEVICE-UPDATES.md) for the ordering and the
  unchanged fail-closed resume rule.
- **[PARTIAL] Signed OS agent.** CMS-verified channel manifests, RAUC staging,
  authenticated discovery distinct from strict installation admission: an
  unexpired current pointer (at any serial watermark), or a non-quarantined
  consumed pointer positively older than booted at exactly the stored serial,
  succeeds with no candidate and normal check cadence. Discovery never advances
  the serial watermark; newer replayed targets still refuse. Trusted-current
  discovery clears only obsolete equality/replay OS-check refusal notices.
  Staging revalidates through strict admission. These discovery regressions are
  hermetically tested, not hardware-qualified. The agent also handles
  deferred activation, post-boot verification by that boot's healthcheck
  verdict (a new slot failing before `mark-good` stays `os-verifying` until the
  bootloader falls back, which is then quarantined as a rollback; a slot marked
  good whose healthy record cannot be written waits in `os-verifying`
  indefinitely, blocking checks, installs and the mirror but not streams). Needs `apt-all-packages` +
  `rauc-verity-streaming` and the release-only `/etc/ceralive/os-release-version`
  stamp. The leaf's RFC2253 issuer is pinned to the production RAUC intermediate
  (`CN=CeraLive RAUC Intermediate CA,O=CeraLive`) or the persistent bench RAUC
  intermediate (`CN=CeraLive RAUC Bench Intermediate CA,O=CeraLive`); root-direct
  and other intermediate signatures are refused after CMS verification.
  Channel lookup maps only exact physical RAUC compatibles:
  `ceralive-rock-5b-plus` → `rock-5b-plus`, `ceralive-orangepi5-plus` →
  `orange-pi-5-plus`. The signed pointer still has to state that product board
  and the unmodified physical compatible exactly; the bundle is installed only
  after RAUC validates its own compatible. The Orange Pi drill pointer still
  needs the separate image-publisher repair and a newly installed CeraUI binary
  before OS staging can resume; this source fix is not board validation.
- **[PARTIAL] Lagged slot mirror.** `slotSyncGate()` with eight typed refusals,
  then the image's `ceralive-slot-sync.service`. Needs `slot-sync`.
- **[PARTIAL] Update transport.** `selectUpdateTransport()` plus
  `updatePinController` (UID-scoped route, 15-minute failover hold). The OS agent
  and, on an image declaring `transport-uidrange`, every package transaction
  (refresh, discovery and install) use it; other images keep the unbound apt
  reachability preflight. Pinned APT is fixture-tested, not board-proven.
  DNS is not pinned. A verified-TLS 404/410 on the expected OS channel signature
  proves the uplink while the pinned manifest fetch reports no publication; it
  cannot become a captive-portal or `no-transport` verdict. The corrected build
  is not yet board-proven. See [`docs/DEVICE-UPDATES.md`](../DEVICE-UPDATES.md).

OS staging now detects pinned-path loss independently of RAUC progress and
refreshes transport selection only after positive writer recovery and pin
teardown, within one three-pair budget. A PID-1 guardian retains the shared
flock through CLI failure, recovery and backend death. Receipt/serial writes
and `OS_STAGED` publication share a synchronous attempt fence under that lock;
startup reconciliation keeps uncertain ownership closed without delaying the
control server. These are hermetic implementation claims, not a device drill.
Publication retains the active attempt until producer release settles; a matching
unsafe release failure remains terminal even after `OS_STAGED`, with the receipt
retained and activation refused. Invalid present recovery metadata preserves the
original file and a terminal startup outcome, never first-boot idle. Manual unsafe
confirmation requires a settled attempt, matching failure reason, one of the two
typed unsafe OS outcomes and positive proof; rejection retains the unresolved notice.
RAUC's bootloader-selected `boot_primary` is retained separately from slot state:
unknown, ambiguous, target-selected or changed activation identity refuses admission,
recovery and final settlement. An inactive slot alone is not a writable target.
Admission rechecks the live producer after reading job files; queued startup
reconciliation cannot adopt that exact attempt while its producer is running.
Preparation-only and acknowledged-release orphans settle only under a separate
short-lived reconciliation flock with fresh writer/resource/activation proof.
Live guardians keep ownership; unknown or foreign state keeps admission closed.
Absent orphan units are recognized by the exact parsed `LoadState=not-found`
property, not by whole-output equality. A previously owned NBD device retains
its tracked identity while configured, even if its creator PID is reused.
Shared admission observation refuses after 10 seconds; that deadline neither
releases a writer nor proves retirement. Late observations cannot change the
expired caller's verdict or clear a replacement probe.
See [bounded failover](../DEVICE-UPDATES.md#bounded-os-staging-failover-partial--hermetic-proof-hardware-drill-owed)
and [lock recovery](../UPDATE-RECOVERY.md#os-staging-lock-and-startup-reconciliation).

A private durable unlaunched-settlement witness now has a state-side consumer.
Future attempts retain optional persistence-only `osStageRecovery.attemptId`;
startup, ticks and manual admission require its exact candidate/attempt plus a
current-boot witness and fresh readiness. Interrupted attempts count once;
already-counted unsafe records keep their count and become operator-only.
Legacy D8 records without that identity remain unsafe. Guard/state integration
is implemented and fixture-tested; board qualification is owed. Settlement and
new-attempt admission share the control lease, compare authoritative recovery
identity and retain admission closure until settlement is durably persisted.
Runtime control-lease acquisition is unconditional: device detection and
development/mock environment settings cannot select a held no-op. Hermetic
tests inject `acquireTestOsStageControl` through the existing dependency port.
Startup is single-flight and hydrates missing recovery notices without replay
remove/show churn; see
[witness settlement](../UPDATE-RECOVERY.md#unlaunched-settlement-witness-partial).

Known gaps, recorded rather than smoothed over:

- **Nothing dispatches `RESET`.** A root-only packaged maintenance tool can
  adjudicate only `failed`/`commit_unit_absent_on_resume` on the current slot,
  after an inactive/effectively masked backend and durable plan-bearing receipt.
  A failed OS stage is not sticky by default: typed `automatic`/`operator`
  failures return to `os-available` under a bounded retry budget, and an
  `unsafe` one (or an older build's exact `rauc_install_failed`) leaves
  `failed` only on positive OS evidence that the RAUC recovery adapter must
  supply through the guarded job's positive quiescence proof. Every other sticky failure still has no product clearance path. The
  tool's root/systemd/APT end-to-end board proof is owed; see
  `docs/UPDATE-RECOVERY.md`.
- **D8 stream/update admission: what it does NOT cover.** This is the one
  canonical statement of D8's limits; the other D8 descriptions point here. D8's
  guarantee (`admitAndPrepareStreamStart`,
  `update-orchestrator/runtime.ts` l.486-522) covers a package unit the
  orchestrator launched itself, whose systemd unit already exists, without the
  deferral in (b), and is tracking in `downloading`. Before the package-unit
  stop it does a forced-fresh wire read and the commit-stage probe; on a wire
  `installing`/`success` or a positive probe it refuses with
  `update_in_progress` and stops nothing (the probe fails closed, e.g. on an
  unreadable process list for a running unit, or a throw). The remaining
  exposure of that unit is the check-then-stop gap (capable image,
  two-stage unit) or the gap before the dpkg spawn (non-capable image,
  single-stage unit). The cases below are outside that guarantee; they are
  launch/admission integration gaps, not fixed by the probe.
  (a) The Packages section requires a current-link capability answer and, for
  capable images, a received orchestrator phase. Unknown/failed/in-flight reads
  disable the trigger and confirmation and direct surface calls dispatch nothing;
  close/link loss revokes authority, old replies cannot restore it, and a failed
  read uses the existing details Retry. The display declaration stays during a
  re-read, separately from install permission; settings/details do not delay the
  capability answer's authority. Capable + `apt-all-packages` + phase
  `available`/`awaiting-idle` uses package-scoped `system.installUpdatesNow`, with
  tracked feedback and the installed notice when backend admission accepts.
  Explicit legacy mode, capable + every other **known** phase (including `idle`,
  `os-available`, `failed`, `quarantined` and busy phases), or capable without
  the APT feature retains `system.startUpdate` exactly as on base. This is the
  documented D478 residual, not governed installation: those calls lack the
  orchestrator's admission/cellular gate and tracked completion/quarantine
  ownership. `system.checkForUpdates` is unchanged and dispatches nothing to the
  orchestrator. Its Check → offer → Update flow in `idle` still uses legacy,
  including with `packagesAuto=false`; it does not wait for orchestrator discovery
  or become a permanent scoped `not_available` refusal. Routing Packages Check
  through the orchestrator is an out-of-scope follow-up. A scoped refusal never
  falls back to legacy. An older backend
  already exposing the orchestrator instead ignores the unknown scoped input
  and runs it unscoped, equivalent to Install now. A stale newer cached tab
  against that backend is a mixed-version window: reload so the device serves
  its matching frontend. If a scoped refusal follows the call's own transition
  to `awaiting-idle` and leaves that phase, the scheduler installs packages at
  the next eligible idle, non-streaming window even with `packagesAuto=false`,
  subject to normal capability, admission and cellular gates. This is intended
  **install when idle** behavior; the operator can retry Update when not
  streaming or let the scheduled install run. No cancellation control is claimed.
  Details: [`Operator actions`](../DEVICE-UPDATES.md#operator-actions). The
  stop is issued only from the orchestrator's `downloading` phase
  (`runtime.ts` l.495-511), so in any other phase D8 does not stop such a
  unit, and admission does not consult it. `isUpdating()`
  (`streamloop/session.ts` l.80, retriable `engine_restarting` /
  `stream_start_suppressed_update`) refuses a start only once the launch has
  set `softUpdateStatus` (`software-updates.ts` l.1201). (b) Launch
  deferral: while `apt-get update` or discovery runs, `startSoftwareUpdate()`
  arms a 3 s timer and returns `{started:true}` without setting
  `softUpdateStatus` (`software-updates.ts` l.1275-1296), so the RPC answers
  `success:true`, `isUpdating()` is false and no unit exists for D8 to find;
  neither refuses a start on the pending launch's account. The orchestrator's
  own launch uses the same function and dispatches `INSTALL_UNIT_STARTED` on
  that answer (`runtime.ts` l.648-653); a start admitted then issues the stop
  for a unit that does not exist yet and moves the phase to `available`
  (`reducer.ts` l.250-251). D8's abort does not cancel the timer (its only
  `clearTimeout` is the test reset, `software-updates.ts` l.261). When it
  fires, the re-entered `startSoftwareUpdate()`'s one stream check is
  now `isStreamConfirmedIdle()` (l.1366, and `doSoftwareUpdate()`'s
  `prepareSoftwareUpdate()` again at l.1630 before awaited preparation), which withholds idle while the stream
  owner's published lifecycle is not idle; a starting stream therefore no
  longer reads as idle, but that synchronous check is not an atomic lease
  against a Start admitted after it, and the
  orchestrator does not track that install (except through the adoption in
  (d)). (c) If a stream is live or updates are disabled when
  `doSoftwareUpdate()` runs, the silent early return in
  `prepareSoftwareUpdate()` at `software-updates.ts` l.1630 leaves `softUpdateStatus` set, so `isUpdating()` stays true and
  later stream starts are refused by `session.ts` l.80 until the backend
  restarts. (d) Adoption race: `startSoftwareUpdate()` has no
  orchestrator-phase guard, and the orchestrator learns that its own install
  ended without success only at its next tick (only a successful
  capable-image commit has a callback, `onCommitSucceeded`). That tick can be
  up to `IDLE_TICK_MS` (60 s, `runtime.ts` l.257) after a
  `system.installUpdatesNow` launch, because `installUpdatesNow()` does not
  reschedule it. A legacy
  launch landing in that window is adopted as the orchestrator's
  `downloading` unit (`pollPackageInstallProgress`, `runtime.ts` l.660-711),
  and a stream start can then stop it, guarded only by the forced-fresh read
  and the probe, with the same exposure as above. The same race in
  `committing` (the orchestrator's own install failed before its next tick
  saw it): the legacy launch clears `lastUpdateFailure`
  (`software-updates.ts` l.1270), so the tick keeps `committing` while the
  wire reads `downloading` (or `checking`/`available` while the legacy launch
  is still deferred; `runtime.ts` l.661-671), starts stay refused as
  `update_in_progress`, and the tick then treats the legacy unit's outcome as
  its own commit: `COMMIT_SUCCEEDED`, or `COMMIT_FAILED`, which records its
  own pending plan as quarantined with the legacy reason (`runtime.ts`
  l.684-708). (e) The stage count follows
  the image, not the RPC: `doSoftwareUpdate()` runs `capable ?
  runDetachedAptAll : runDetachedAptUpgrade` (`software-updates.ts` l.1508,
  l.1620-1631) for every caller. (f) Launch into a starting stream: the explicit
  stream checks in `installUpdatesNow()`, `maybeStartPackageInstall()` and
  `startSoftwareUpdate()` are live-only (`runtime.ts` l.423, l.628;
  `software-updates.ts` l.1263). Scheduled launches also await `isIdle`, which
  treats a held start lease as activity (`runtime.ts` l.629-632;
  `idle-activity.ts` l.33-36). Their remaining window is after that idle reading
  and before launch; `installUpdatesNow` bypasses the idle await. The live flag
  stays false
  until the stream is live (`streaming.ts` l.88-102;
  `stream-session-orchestrator.ts` l.558), whereas D8 runs only at
  start admission. An install launched after admission but before live is not
  stopped by D8; if the stream is live when `doSoftwareUpdate()` runs, (c)
  applies. (g) Pre-unit window: even a non-deferred orchestrator launch enters
  `downloading` before its `apt-get update` callback and preparation finish;
  the unit is created only later by `runDetachedApt*` (`software-updates.ts`
  l.1151-1153, l.1504-1633). A start can then probe an absent unit and issue
  a stop that does not cancel the callback. The phase moves to `available`,
  while the callback may create an untracked unit. (h) Admitted does not imply
  launched: after D8 stops a unit, `streamloop/session.ts` can still refuse
  `stream_start_suppressed_update` while `isUpdating()` stays true until the
  unit's monitor settles (including `apt-get clean`). This timing is inferred
  from the code, not separately tested. A failed stop or (g) can exhaust the
  bounded start retries. The same ordering reaches OS staging: `admittedStart()`
  runs D8 before `request.launch` (`stream-session-orchestrator.ts` l.465-491),
  and launch-time `params`/`spawn-sender` validation errors only then classify
  as `start_invalid` (`start-failure-taxonomy.ts` l.261-267), so in `os-staging`
  D8 REQUESTS the SIGTERM and restart of `rauc.service`
  (`killAndRestartRaucForStream`, `update-orchestrator/stream-abort.ts` l.42-61,
  which propagates submission errors; called from `admitAndPrepareStreamStart` in
  `update-orchestrator/runtime.ts`) before launch validation runs, and an active
  OS stage CAN therefore be interrupted by a start that can never stream (for
  example no SRTLA address) and then fails `start_invalid`. Suggested fix direction, NOT implemented: cancel
  pending launches when D8 aborts, fence the pre-unit callback/preparation,
  gate launches on a starting stream rather than only a live one, clear
  `softUpdateStatus` on the (c) early return, and reconcile D8 with the later
  `isUpdating()` guard.
- **A manual OS install outlives the RPC that started it (separate from the D8
  list above).** For an OS candidate, `installUpdatesNow()`
  (`update-orchestrator/runtime.ts` l.413-426) awaits `maybeStartOsStage(true)`,
  which awaits the whole `rauc install` through `deps.stageOs` /
  `stageOsBundle()` (`runtime.ts` l.963-967, `os-agent.ts` l.359) before
  `system.installUpdatesNow` (`rpc/procedures/system.procedure.ts` l.260-270)
  answers. The frontend has no per-procedure override for it
  (`PROCEDURE_TIMEOUT_MS`, `apps/frontend/src/lib/rpc/client.ts` l.560-562), so
  the 30 s default of `RPCClient.call` (`RPC_CALL_TIMEOUT_MS`,
  `lib/rpc/rpc-timeouts.ts`) rejects with `Request timeout` while the stage
  keeps running server-side and succeeds. The Updates dialog no longer calls
  that a refusal (review 49-C, C-M1; round 2 M1): a lost reply and an error the
  handler raised (`INTERNAL_ERROR`, `VALIDATION_ERROR`) are uncertain, the action
  stays busy until its awaited chain settles, and "Outcome not confirmed" shows
  until a pushed phase or a details read sent after the request settles it
  (`update-action-outcome.ts`). Only a `{ success: false }` answer, the
  pre-effect `UPDATE_ORCHESTRATOR_INITIALIZING` envelope or a request never
  sent renders "Not started"
  (`apps/frontend/docs/agents/an-update-action-outcome-is-decided-by-evidence.md`).
  The backend still answers only after the stage. On the Rock bench the uninterrupted adaptive stage of the
  1.4 GB bundle took 101 s. The awaiting semantics are pinned by `os-agent-runtime.test.ts`:
  "manual install bypasses idle, stages once and arms without immediate
  activation" (expects `os-staged` when the call returns) and "a stage failure
  never becomes staged or armed" (expects `{started:false}` for a failed stage),
  plus the two interrupted-stage tests that `await install`. Proposed remedy,
  an owner decision and NOT implemented: answer `{started:true}` as soon as
  `OS_STAGING_STARTED` is dispatched and run the stage in the background, as
  the package path already does, reporting its outcome through the phase and
  the `os-staged` / `refused` notifications.
- **Historical pre-fix receipt: a stream start during `os-staging` could be refused while RAUC could not be
  restarted (observed once, Rock bench, task-45d D1).** D8 moves the phase to
  `os-available`, then `killAndRestartRaucForStream()`
  (`update-orchestrator/stream-abort.ts` l.42-61) SIGTERMs `rauc.service` and
  awaits `systemctl restart rauc.service` under `SYSTEMD_COMMAND_TIMEOUT_MS`
  (10 s, l.21). On the Rock the kill landed while RAUC's installer thread was
  reading the bundle through `nbd0`; `rauc-nbd` died and that thread stayed in
  uninterruptible sleep until the kernel's NBD dead-connection timeout, so the
  restart outlived the 10 s limit and `spawnWithTimeout` threw
  `SpawnTimeoutError` ("Spawn timed out: systemctl restart rauc.service",
  `helpers/spawn-policy.ts` l.1048-1054). The throw leaves
  `admitAndPrepareStreamStart()` (`update-orchestrator/runtime.ts` l.534-545,
  abort fence released in its `finally`) and `admittedStart()`
  (`streaming/stream-session-orchestrator.ts` l.459-475, before any launch),
  and the RPC adapter answers it as `INTERNAL_ERROR` (`rpc/adapter.ts`
  l.168-176). The operator sees the stream start refused with an internal
  error, and RAUC (status, staging, slot reads) was unusable for 5 min 14 s
  until the NBD timeout reaped the old process; a retry once `rauc.service` is
  active again succeeds. The phase and failure reason were correct
  (`os-available`, no failure), and the target slot was left `bad`/pending with
  no leftover NBD, dm or mount state. n=1: an earlier kill at 46 % restarted
  promptly. The current source queues restart with `--no-block` and propagates
  only submission errors at D8; it no longer waits for daemon recovery there.
  New OS work requires the interrupted job to settle and positive writer
  readiness, not a queue acknowledgement or `active` alone. This fix has not
  been re-drilled on hardware; it does not change the later launch-validation
  limits described in (h).
- **G1: a restart of the healthcheck kills a running slot mirror (observed
  once, Orange Pi 5+ bench, 2026-09-30).** `ceralive-slot-sync.service` has
  `Requires=`/`After=ceralive-healthcheck.service` (image-building-pipeline
  `mkosi/runtime/ceralive-slot-sync.service` l.10-11 at `36d8131`), so a stop
  or restart of the healthcheck propagates to a RUNNING mirror. The healthcheck
  itself only `Wants=ceralive.service` (`ceralive-healthcheck.service` l.13,
  since image `808446d`); what restarts it is the hostname reconcile, whose
  identity-consumer restart names both `ceralive.service` and
  `ceralive-healthcheck.service` (`mkosi/customize/postinst.d/hostname.sh`
  l.71-77, l.378-379). On the bench an Avahi `published=ceralive-2` conflict
  made `ceralive-hostname-reconcile` restart them shortly after boot, about
  20 s into the rsync: the mirror got SIGTERM, exited 143 and left the target slot
  `bad`, then systemd re-ran the unit, which completed. The orchestrator stayed
  clean only by timing: the old backend was stopping and never read the killed
  run's `failed` record. Had the new backend polled before the re-run, the
  documented rules would have read `failed` with exit 143 (`lock.ts` l.69-70
  and l.86-90; `processExitCode`, `software-update-service-state.ts` l.59-62)
  and persisted `failed / slot-sync failed (exit 143)`
  (`failSlotSyncFromUnit`, `update-orchestrator/runtime.ts` l.950-970), which
  is sticky. A plain stop of the healthcheck mid-mirror would leave the other
  slot `bad` with no re-run. Remedies, an OWNER DECISION and NOT implemented:
  in the image, order the mirror after the healthcheck with `Wants=` or
  ordering only instead of `Requires=` (or drop the healthcheck from the
  reconcile's restart list); in CeraUI, treat exit 143 as an interrupted run
  and probe again, with a bound, before persisting a verdict.
- **Credential-date limits.** Independent public-certificate observation now
  produces durable 90/30/7-day and expired notices and the optional details RPC
  block. The Updates dialog renders that block's verdict and date, omitting the
  row for older backends; browser time affects only its approximate day phrase,
  not the device verdict. The observer never reads the private key or establishes key matching, chain trust,
  revocation or mTLS acceptance. It runs independently of automation/live/recovery
  gates. The separate transport-rejection band is probe evidence, not date truth.
  Both-board installed/runtime qualification remains owed; see DEVICE-UPDATES.
- **Board evidence is narrow.** The capable APT candidate/installation above was
  verified on a bench-enabled board, not a released capable image. OS staging,
  slot mirroring and UID-pinned transport are still not qualified by that run.

Planned power and traffic protection: [shutdown contract](../SHUTDOWN-PROTECTION.md).

### Image apt source: every way an install ends before launch

On an image with its own apt source, an install is launched once systemd
accepted the detached unit, or an uncertain `systemd-run` (client error or
timeout) found the fixed unit or could not read it; from then on the unit's own
result decides, as on every other image. Every other end before that leaves
`failed` on the wire once, with its reason, and the orchestrator records
`failed` with `package_install_refused` (through `DOWNLOAD_FAILED`) and the
package check due at once. That failure is package-only: the scheduled tick
runs the due package check (under the usual cellular rule) and the image
check from it, Check now starts from it, and a successful discovery clears
the wire's failure so the offer comes back. Nothing is restored in place. The
pending package list stays until that check clears it; quarantine records only
a failed commit, and nothing here reached dpkg.

**The launch fence** (`install-launch-fence.ts`) is the one place that decides
between "submitted" and "ended". An accepted start is an attempt, `pending`
until one serialized section either submits its unit or ends it:

- The launcher submits there and nowhere else. Looking for an existing unit
  and preparing the output files come before the section; `systemd-run`, and
  what an uncertain result is taken for, run inside it. Right before
  `systemd-run` the section reads once more whether updates are still on and
  no stream is up, and ends the attempt instead if not.
- Stream admission enters the same section, whichever way the install was
  started (the orchestrator's Install now or the start RPC). A pending attempt
  ends there as a refusal with `streaming`, its pinned transfer is aborted and
  a delayed start is cancelled; the launcher then finds the attempt ended and
  submits nothing. No unit exists, so none is stopped. An attempt whose
  submission is in flight is waited for; once submitted, the stream takes the
  post-launch path. An attempt that already ended (a refused unit, a failed
  download) is settled as that refusal, with the failure id the wire gave it.
- An ended attempt writes and publishes nothing more: its preparation checks
  the attempt after every wait, and so does its install-time discovery. Its
  terminal frame is the only `failed` frame; a state-only frame that would
  repeat it is not sent.
- **Ownership** (`helpers/effect-owner.ts`). Whatever an install does before
  launch it does as the pending attempt, its *owner*, and the question
  "may this owner still act?" is asked where the work leaves the process, not
  at each call site:
  - Both spawn primitives (`run()` and `spawnWithTimeout()`) take an `owner`
    next to their `signal` and ask before they spawn. A command for an owner
    that has ended is refused with an `OwnerEndedError` and never started.
    Nothing in flight is killed for it: a running command finishes (the
    draining hold below covers it) and its result goes nowhere.
  - Files and published state written for an install go through `ownedFiles`
    and `ownedWrite`: the unit's output files, the private curl config and
    the fetched index of a probe, the routing journal, the published
    transport selection and the reachability cache. A look that is neither a
    command nor one of those (the board's capabilities, the archive
    directory's `stat`, the routing journal, the image's package list, the
    unit's fragment) asks `assertOwnerMayRead`.
  - The install hands its owner down every layer it uses: its apt runs, the
    space preflight, the unbound reachability probe, the transport selection,
    the pin controller, the routing lease and the launcher.
  - What an ended owner may still do is one list, `OWNER_TEARDOWN`: delete
    the routing rule and the routes of the update tables that a pinned run
    installed, strike them from the routing journal, and remove a private
    file made for one command. A handle that is open is closed. Nothing else,
    reads included. That covers what its own run set up, not what an earlier
    run left in the routing journal: recovering those entries needs a live
    owner before each deletion. Its last fetch failure does not put the
    uplink on the pin controller's shared cooldown either.
  - Code that catches errors to log them lets an owner-ended refusal pass,
    and stays silent for an owner that has ended meanwhile. A teardown that
    failed is still reported, whoever asked: a routing teardown left a rule
    behind, and a private curl config that could not be removed still holds
    the source's access token. Those configs are written only in the
    service's own directory (`/run/ceralive/curl-private`, 0700, never a
    shared temp directory) and removed by their exact path when their probe
    ends. A removal that fails is logged as a security line
    (`curl-private-url.ts`), without the token or the file's name, and the
    probe's result stands. That one directory is wiped when the backend
    starts, before anything can probe; nothing is listed, matched by name or
    age, or removed anywhere else.
- Updates turned off and a stream are looked at by the owner itself, right
  before each effect (`effectOwner` in `software-updates.ts`): the install
  ends there (`discovery_failed`, `streaming`) instead of starting the next
  command, and once more inside the section. `owns(attempt)` still guards
  every state and wire write.
- While `systemd-run` is in flight the section holds the decision
  (`submitting`): nothing ends the attempt from outside, and the launcher's
  second look for the unit after a client error is made whatever changed
  meanwhile, because only that look can tell whether a unit exists.
- **Route repair is not an install's business.** The host's gateway election
  (`updateGwWrapper`) changes the default route of the whole device and is
  shared with the network module, so no install on these images asks for it
  or starts one, at any point. It does not need it: a pinned run routes apt
  through its own table (100000) from the chosen uplink's own default route,
  after probing each uplink bound to its device, and an unbound run goes by a
  fresh probe of the route as it is and is refused (`repos_unreachable`) when
  that finds nothing. A package check with no install behind it asks for the
  repair as on every image; the next check after such a refusal does.
- **Draining.** An ended attempt can still have waits in flight: commands
  that are running, the launcher's spool setup. Where its work fans out (the
  per-uplink probes, the unbound probe's two address families and origins,
  the space preflight's paired looks) every branch that was started is joined
  before a refusal travels on (`ownedAll`), so the hold lasts until the last
  of them has returned, not the first. Until then the updater is not free: a new install is refused (`already_updating`), the
  Packages card's own check answers busy, and the orchestrator's check waits
  for it instead of failing. So what the ended attempt left running never
  meets a newer install, and a retry cannot submit a unit whose output files
  the old launcher would then recreate.
- A failure before launch is settled when it is known. The download under
  the pin publishes apt's failure from inside the pinned run, before its rule
  and routes are taken down, so a stream admitted during that teardown finds
  it settled, with its failure id. (A fetch failure that another transport
  may still mend is not final and is not published.) There is no archive
  cleanup in between either; the next install's preflight cleans.
- A cancelled launch logs none of the apt output fetched before it, and a
  start that is refused after an install ended leaves that install's outcome
  showing: the offer does not come back without a check.
- The planned-shutdown note is written inside the section, right before
  `systemd-run`, so an install that ends first leaves none.

| Path (where it ends) | Wire | Orchestrator | Test (`image-apt-source-paths.test.ts` unless named) |
|---|---|---|---|
| Start refused synchronously (disruptive action, success fence, updates off, stream, busy, recovery unsettled) | unchanged | stays where it was; manual install answers busy or stream | existing start-refusal tests |
| The install's own check cannot start (clock gate shut, a refusal of the check itself): `check_unavailable` | unchanged, no attempt | stays `awaiting-idle`; Install now answers `not_available`, and the request starts on a later tick once the check can run | a start the install's own check cannot begin |
| Install's own check: refresh, reachability, captive portal, `dpkg_interrupted` | `failed`, the check's own reason (`repos_unreachable`, `captive_portal`, …), one terminal frame | `failed` / `package_install_refused` | install's own check refused (counts every `failed` frame) |
| Record or capabilities refused at install | `failed`, `discovery_failed` | `failed` / `package_install_refused` | record stops validating |
| Clock gate or dpkg journal at preparation | `failed`, `check_unavailable` or `dpkg_interrupted` | `failed` / `package_install_refused` | clock gate closes |
| Install-time discovery simulation fails (also when update routing refuses it) | `failed`, `discovery_failed` (the offer is not shown first) | `failed` / `package_install_refused` | discovery simulation fails |
| Install-time hold query fails | `failed`, `discovery_failed` | `failed` / `package_install_refused` | hold query fails |
| Install-time source or package policy fails | `failed`, `discovery_failed` | `failed` / `package_install_refused` | package policy read fails |
| Install network unreachable (the preparation's fresh probe) | `failed`, `repos_unreachable`, on the probe's verdict, before any install-time simulation | `failed` / `package_install_refused` | install's network unreachable |
| Install network captive, probe or certificate refused | `failed`, its reason | `failed` / `package_install_refused` | install's network unreachable (same step) |
| Nothing installable any more | `failed`, its reason | `failed` / `package_install_refused` | nothing is installable |
| Pinned recheck fails, or a standing refusal | `failed`, `discovery_failed` | `failed` / `package_install_refused` | pinned recheck refuses |
| Pinned recheck would remove a package | `failed`, `removals_required` | `failed` / `package_install_refused` | the pinned recheck would remove a package |
| Space preflight: archive cleanup, `apt-config`, probe, `stat`, `statfs`, space | `update_preflight_failed` | `failed` / `package_install_refused` | space preflight refuses |
| Download under the pin fails | `failed`, apt's error (by host), with its failure id, published before the pin's rule and routes are taken down; no archive cleanup first | `failed` / `package_install_refused` | download under the pin fails |
| Download under the pin failed, stream admitted while its routing is taken down | `failed`, apt's error and failure id, unchanged | `failed` / `package_install_refused`; the event carries the wire's id; nothing is stopped | `image-apt-source-ended-install.test.ts`: the download under the pin fails |
| Updates turned off while a pinned run sets up (during the routing journal read) | `failed`, `discovery_failed`; no rule or route is added, none is looked at, `apt-get update` never runs | `failed` / `package_install_refused` | `image-apt-source-ended-install.test.ts`: updates are turned off while a pinned run sets up |
| An install on a board that elects its default route (no pinned transport) | never asks for the gateway election, before or after it ends; it goes by a fresh unbound probe and is refused with `repos_unreachable` when that fails | `failed` / `package_install_refused` when refused | `image-apt-source-ended-install.test.ts`: the host's gateway election is the network module's; the `elected route` install of both harness files |
| An install ends with several of its commands in flight (the per-uplink lookups, the unbound probe) | as it ended | a new install stays refused (`already_updating`) until the last of them has returned, also when one is refused or fails first | `image-apt-source-ended-install.test.ts`: an install ended while several of its commands are in flight; every sequence of `image-apt-source-sequences.test.ts` |
| A stream ends the install during the launcher's first look, and a unit exists | `failed`, `streaming`; the unit's fragment is not read | `failed` / `package_install_refused` | `image-apt-source-ended-install.test.ts`: the launcher's first look for a unit |
| A probe's private curl config cannot be removed | unchanged; a security line is logged, also for an ended install, without the token or the file's name | unchanged; the file stays in the service's own directory until the backend next starts, which wipes that directory | `curl-private-url.test.ts`; `image-apt-source-ended-install.test.ts`: a private curl config that could not be removed |
| A stream is live when the retry after a refused install is due, or starts while that retry clears the pending list or reads the capabilities | unchanged (`failed`) | no package check is dispatched: none fails, no event, no backoff; the due image check runs on that tick, and the retry runs once the stream is over | while a stream is live the scheduled retry waits; a stream that starts while the retry clears the pending list defers it too |
| The install ends while it reads a routing journal that holds an earlier run's rule | as it ended; that rule is not deleted and its entry stays recorded for the next live run to recover | as it ended | `image-apt-source-ended-install.test.ts`: routing rules an earlier pinned run left in the journal |
| The last fetch of an install that has ended fails | as it ended | as it ended; the uplink is not put on the pin controller's cooldown | `effect-owner.test.ts`: the uplink cooldown of the pin controller |
| A launch cancelled after the download under the pin | `failed`, `streaming`; none of the fetched output is logged | `failed` / `package_install_refused` | `image-apt-source-ended-install.test.ts`: a launch cancelled after the download under the pin |
| A retry refused (clock gate shut) after an install ended | unchanged: the ended install's `failed`, not the old offer | unchanged | `image-apt-source-ended-install.test.ts`: a retry that is refused |
| Stream before launch, seen by preparation | `failed`, `streaming` | `failed` / `package_install_refused` | stream starts before launch |
| Stream admission during the pre-launch (pinned) download | `failed`, `streaming` | `failed` / `package_install_refused` at once, never `available` | stream admission during the pre-launch download |
| The pinned transfer aborts on a live stream nobody admitted (liveness only) | `failed`, `streaming` | `failed` / `package_install_refused` (Check now is not left busy) | the pinned download aborts on a live stream nobody admitted |
| Stream admitted, and over, while preparation waits (space preflight) | `failed`, `streaming`; the unit never launches | `failed` / `package_install_refused` | a stream admitted and over while preparation waits |
| Stream admission while the launcher sets up its unit (looking for a unit, preparing the output files) | `failed`, `streaming`; nothing is submitted and nothing stopped | `failed` / `package_install_refused` at once | stream admission while the launcher sets up its unit |
| An install started through the start RPC (`system.startUpdate`) ends before launch, by a stream or any row above | `failed`, its reason, once; nothing is submitted | unchanged: it did not start this install, so it records nothing and keeps its phase. The wire and the orchestrator disagree until the next package check, which clears the wire's failure and lands both on the offer. That check is Check now, or the orchestrator's scheduled package check when it is idle, `packagesAuto` allows it, it is due and the cellular rule lets it run. While the orchestrator holds the offer (`available`) no tick checks packages for it: only Check now does. Image checks run on schedule throughout | the start RPC as the Packages card calls it: a stream ends it, and the next check reconciles; the start RPC beside an offer the orchestrator holds: Check now reconciles, and a due image check is not held up |
| A unit the start RPC launched, stream admitted | the unit is stopped, behind the same fresh read and commit-stage probe as one of the orchestrator's (a commit in progress refuses the stream) | unchanged: there is no plan to return to an offer, nothing is dispatched | the start RPC's launched unit is stopped by a stream like any other; `image-apt-source-interleavings.test.ts`, the last wait |
| An ended install still has a wait in flight (a command, the spool setup) | as it ended; it starts nothing and writes nothing | a new install is refused (`already_updating`) and a check waits until that wait returned | `image-apt-source-sequences.test.ts`: a stream ends it, then it is installed again / then Check now |
| Updates turned off while Check now clears the refused install's pending list | unchanged | no package check is dispatched: no event, no backoff; the image check runs | updates turned off while the pending list is cleared |
| Any single wait of the install fails | `failed` or `update_preflight_failed` with that step's reason, once, or the install launches if it can do without the step | `failed` / `package_install_refused`, or follows the unit | `image-apt-source-sequences.test.ts`: the wait fails, then a stream is admitted |
| Uncertain `systemd-run`, the second look finds no unit | `failed`, the client's error, with a failure id | `failed` / `package_install_refused` | `image-apt-source-sequences.test.ts`: the second look for the unit |
| Uncertain `systemd-run`, a stream admitted while the second look hangs | unchanged until the look returns | the stream waits; then the launched unit is stopped, or the refusal settled with nothing to stop | `image-apt-source-sequences.test.ts`: hangs while a stream is admitted |
| Updates turned off while `systemd-run` is in flight, and its client then fails | the second look is made all the same; the unit it finds is the launch | follows the unit | `image-apt-source-sequences.test.ts`: updates are turned off while systemd-run is in flight |
| Stream admission after the wire already showed the refusal | `failed`, its reason | `failed` / `package_install_refused`, never `available` | stream admission after the wire already settled |
| Stream admission after systemd refused the unit, before the orchestrator looked | `failed`, the error | `failed` / `package_install_refused`, never `available`; the failure keeps the wire's id | stream admission after systemd refused the unit, before the orchestrator looked |
| Stream admission after the download under the pin failed, before the orchestrator looked | `failed`, apt's error | `failed` / `package_install_refused`; the failure keeps the wire's id | stream admission after the download under the pin failed keeps the failure's id |
| Stream admission while the start waits behind a running check | `failed`, `streaming`; the delayed start is cancelled and never runs | `failed` / `package_install_refused` | stream admission cancels the delayed start |
| systemd refuses the unit outright (unit exists, spool, command or source pair, or `systemd-run` fails and no unit is found) | `failed`, the error | `failed` / `package_install_refused` | systemd refuses the unit outright |
| Uncertain `systemd-run` (unit found, or its state unreadable) | the unit's progress | follows the unit | `image-apt-source-transactions.test.ts`: an uncertain submission is a launch |
| Updates turned off once the install started, wherever it is seen (its check, any wait of the preparation, the fence) | `failed`, `discovery_failed` | `failed` / `package_install_refused` | updates are turned off once the install started |
| A throw inside preparation | `failed`, `not_started` (the check logs the rejection) | `failed` / `package_install_refused` | preparation throws |
| Delayed start (behind a running check) cannot start | `failed`, its reason (`streaming` or `discovery_failed` when that is what stops it) | `failed` / `package_install_refused` | a start delayed behind a running check |
| Stream admission while `systemd-run` is in flight | the unit's progress: the admission waits for the result | the post-launch path below | `image-apt-source-interleavings.test.ts`, the last wait |
| Stream admission after the unit launched | the unit is stopped, as today | `DOWNLOAD_ABORTED_FOR_STREAM` → `available` | once the unit launched, a stream takes today's path |
| Launched | the unit's result | follows the wire (`DOWNLOAD_FAILED`, `COMMIT_*`) | once the unit launched |

The table lists paths; two test files test the class. Both step the real
install on one fixture (`helpers/image-apt-install-harness.ts`): the package
code, its probes, the transport selection, the pin, the routing lease, the
launcher and the orchestrator all run as shipped, and the fakes stand only
where the code leaves the process. Every command is answered at the two spawn
primitives, every file written for an install at the owned-file backend, every
owned write to state at its observer; besides those only the few reads that
are neither (the capability files, the routing journal's store, the unit's
fragment, two `stat` calls, the delayed start's timer, the unit's output).
No test of these files starts a process.

Each fake parks on a sequencer. A first run records every wait the install
passes between "start accepted" and "`systemd-run` returned"; a wait on
anything no fake stands for fails the recording. That is done for six
installs: through the orchestrator, on an image that routes apt (the
selection, the pin and the download under it), the start RPC beside an offer
the orchestrator holds, the start RPC as the Packages card calls it (the
card's own check found the offer, the orchestrator is idle), a start delayed
behind a running check, and a board whose default route the backend elects
while its image does not route apt. A new wait in the install is a new step
in both files, or a failed recording.

Everything the fakes see is kept in one ledger, and the rule for an install
that has ended is checked there, whatever a test looks at: any command, file
step, owned write or read of its own that is not on `OWNER_TEARDOWN` fails
the run. The list is read from `effect-owner.ts`, not restated, so nothing
is exempt by name: a look at the routing rules counts like any other
command. What the ended install logs is asserted the same way: nothing, but
for the line `run()` writes for a teardown command and the warning that a
teardown failed (a routing rule, or a private curl config left on disk). A
request for the gateway election by an install fails the run outright,
ended or not.

`image-apt-source-interleavings.test.ts` lets one thing happen at each
recorded wait (a stream is admitted and never seen live, updates are turned
off, a second start arrives) and allows one outcome: before `systemd-run` is
called the install ends as above with exactly one `failed` frame, nothing
submitted and the pending list kept until the next check; with `systemd-run`
in flight the unit counts as launched, and a stream then stops it, whoever
started it; a second start is refused, or is the same attempt while the
delayed start still waits, and never a second unit. Once updates are off the
install starts no further command, file step or owned write.

`image-apt-source-sequences.test.ts` lets a second thing follow, again at
every recorded wait before `systemd-run`: a stream ends the install and then
Check now is asked for (once with the wait the install stood at returning,
once with it failing), or it is installed again, or updates are turned off;
or the wait fails with nobody else involved and a stream is admitted
afterwards. What the ended install still has in flight is released one wait
at a time, and after each the test asserts that it did nothing: it started
no call and logged nothing (its teardown excepted, as above) and nothing
that can be seen of it changed (the wire, the package inventory, the frames
sent, the events logged, the next check's due time and failure count, the
unit, requests for the gateway election), and that the hold is kept while
any of its waits is still parked. The retry is refused while the old install
drains
and then launches exactly one unit over a spool only the new install set up;
Check now waits for the drain and finds the offer with no failed check
counted; a failure that ends the install is published before any archive
cleanup and survives the stream with its id. The uncertain `systemd-run` has
its own cases there: the second look for the unit answering either way,
failing, hanging while a stream is admitted, and being made although updates
were turned off meanwhile.

`image-apt-source-ended-install.test.ts` stands at single waits of the same
fixture for the moments named in the table, and `effect-owner.test.ts`
covers the guard itself: both primitives refuse before they spawn, a command
in flight finishes, branches started side by side are all joined, and what a
pinned run takes down after its owner ended is exactly what the list allows.

Leaving `package_install_refused`: "the scheduled tick runs the package check
at once", "on cellular only, the scheduled check waits and Check now still runs
it", and "Check now still runs the image check" with the clock gate shut or
updates turned off (the package check cannot run then). Every row's test also
runs Check now afterwards and sees the offer again and an image check run;
the stream rows also retry the install and see its pending package versions
recorded. The legacy periodic loop does not run on these images, so no
background discovery brings an offer back behind the orchestrator ("the legacy
periodic loop does not run on such a box"). A check that was already running
when an install was refused may still finish and show the offer again; the
orchestrator follows at its next check. The scheduled tick decides on the
phase it finds after its own waits, with only `package_install_refused`
counted as `idle`, so it never starts a check over an install that began
meanwhile.

The start RPC is still in use on these images: the Packages card calls it
whenever the orchestrator is not holding the package offer (`installPackages`
in `update-surface.svelte.ts`: any phase but `available` and `awaiting-idle`),
which is the ordinary case after the card's own check
(`system.checkForUpdates`), since that check does not go through the
orchestrator. Such an install passes the same launch fence, and its end
before launch shows on the wire like any other. The orchestrator did not
start it and has no transition for it, so it keeps its phase. This is a
deviation from "the orchestrator records every refused install", and it
stands until the next package check: Check now, or the scheduled package
check when the orchestrator is idle and `packagesAuto` allows it. No tick
runs a package check just because the two disagree: a tick that did would
check packages where the settings or the cellular rule say not to, and would
hold up the image check that is due.

Images without the record keep their behaviour throughout: the fence is not
consulted, a stream during the download returns the plan to the offer
(`DOWNLOAD_ABORTED_FOR_STREAM`), install failures keep their own reasons and
the shared `failed`, and the legacy loop runs as before.

`dpkg_interrupted` reaches the wire as an install failure's reason. A package
check that finds dpkg's journal reports `discovery_failed`: the check-failure
field is a closed enum that already shipped frontends parse strictly, so a new
value there needs a coordinated frontend and copy change. Package checks themselves (not installs) end
through `CHECK_FAILED` or `CHECK_SUCCEEDED_*`; a closed clock gate dispatches
nothing.
