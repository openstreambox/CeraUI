<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## THE CELLULAR SUBSYSTEM — ONE COMPOSITION ROOT, ONE WIRE [PARTIAL]

`modules/cellular/` plus the `modem-wire-*` trio under `modules/modems/` are one
subsystem, and this is the section to read before touching any part of it. It
exists because "which backend describes this device's modems" stopped being a
constant: the legacy answer is `mmcli` shelling out per poll, the Phase-B answer
is a read-only `@ceralive/modem-control` D-Bus observer, and a router-mode dongle
is described by NEITHER — it is claimed into a netns by the image and reported
through a metadata file.

```
config.modem_backend ──▶ initCellularStack()        ─┐  boot, guardNonCritical
config.modem_shadow  ──▶ startModemShadowIfEnabled() ─┘  BEFORE initModemUpdateLoop
                                   │
       ┌───────────────────────────┴───────────────────────────┐
       ▼                                                       ▼
  modem-wire-producer.ts  (composition root)          cellular/shadow.ts
       │  mmcli modems + ID_PATH cache                 (mutation-free evidence,
       │  D-Bus views                                   never on the wire)
       │  netns dongles (dongle-metadata.ts)
       ▼
  modem-wire-adapters.ts ──▶ modem-wire-projection.ts ──▶ buildModemsWireMessage()
```

### BOOT ORDER IS A CONTRACT, NOT A PREFERENCE

`main.ts` runs, in this order and no other:

```ts
await guardNonCritical("cellular-stack", initCellularStack);
await guardNonCritical("cellular-shadow", startModemShadowIfEnabled);
void initModemUpdateLoop({ monitor: networkMonitor });
```

- **The stack MUST precede the loop.** `initModemUpdateLoop` runs its first
  discovery and `modems` broadcast immediately, and every modem RPC gates on the
  readiness snapshot the stack commits. A loop that wins that race publishes a
  snapshot built by whichever backend happened to be default and refuses every
  modem procedure with `CELLULAR_STACK_INITIALIZING` until the stack lands.
  That refusal window is REAL and not hypothetical: `initCellularStack` publishes
  `{ready:false}` synchronously and only commits after an awaited backend start.
- **The stack MUST precede shadow.** Shadow snapshots the mmcli side through
  `getModems()`; started first, its first heartbeat window would cover a backend
  selection that had not been made yet.
- **Both are NON-critical, and both stay after the critical WS bind (S6).** The
  dbus→mmcli fallback lives INSIDE `initCellularStack`, so a throw reaching
  `guardNonCritical` means the whole cellular subsystem is unavailable — the
  device must still reach its modem loop and keep its UI.

**AND THE WINDOW IS NOW ON THE WIRE.** That refusal window used to be invisible
to the operator: the roster is legitimately empty while it lasts, so the Network
destination reported "No SIM cards detected" — a claim the device cannot make
about hardware its own modem service has not finished enumerating.
`status.cellular_initializing` (additive-optional, `statusResponseSchema`) is
`!getCellularStack().ready`, emitted by BOTH status producers
(`modules/ui/status.ts` `sendStatus`, `rpc/procedures/status.procedure.ts`
`getStatusProcedure` + `buildInitialStatus`).

It is published as an EXPLICIT boolean on every frame, never present-only-when-
true. The frontend status merge preserves an omitted field, so a true-only flag
could be raised and never lowered — the `policy_route_missing` latch, exactly.
Absence therefore means "an older backend", and the frontend reads it strictly
`=== true`. On the default mmcli backend it is `false` from process start, so a
device that never opts into `dbus` sees the band never once. Frontend half:
`apps/frontend/AGENTS.md` → "A BOOTING cellular stack is a STATE".

**One modem path does NOT run through `cellularReadyMiddleware`:** the remote
`modem.reconfig` command. `command-router.ts` intercepts it at the self_fencing
branch, so it never reaches `modemProcedure`. Its gate lives in
`modules/remote-control/self-fencing.ts` (`isSubsystemReady` /
`READINESS_GATED_TYPES`) and is checked BEFORE `snapshot`/`apply` — see the
control-plane section for the full contract. Gating a modem surface means asking
which of the TWO routes it arrives on.

Pinned two ways in `tests/cellular-boot-order.test.ts`, and neither half is
sufficient alone: a STATIC assertion over `main.ts`'s own source (the device
`udev-rules-sigusr2-scope.test.ts` uses, because a top-level-`await` entry module
cannot be imported and run), plus a behavioural `simulateBoot` model of the
consequences. A behavioural model alone stays green through a reorder inside the
real file.

### THE PROJECTION IS WHAT REACHES THE WIRE — AND THE LEGACY BUILDER IS THE ORACLE

`modem-status.ts` exports TWO builders, and picking the wrong one is silent:

| Function | Role |
|---|---|
| `buildModemsWireMessage()` | what every consumer gets — broadcast, post-login push, `modems.get`, `status.get` |
| `buildModemsMessage()` | the PRE-Phase-B builder. NOT on the wire, deliberately NOT deleted |

The legacy builder is retained because `tests/modem-wire-projection.test.ts`
asserts the projection is byte-identical to it. Rewrite it in terms of the
projection — the obvious "de-duplication" — and that assertion silently starts
comparing the projector to itself. It is also the wire builder's FAIL-SAFE: a
throwing projection serves the legacy message rather than blanking the modem
list, because the additive fields are enrichment and the legacy ones are how an
operator sees their modems at all.

### THE COMPOSITION ROOT OWNS THE THREE THINGS THE PURE MODULES REFUSE TO

`modem-wire-producer.ts` is the only stateful half:

1. **`ID_PATH` resolution is ASYNC; the wire build is SYNC.** `stable_key` needs
   the udev `ID_PATH` behind each modem, and `buildModemsWireMessage` is called
   from a post-login push and a monitor-driven diff — neither can await a
   `udevadm` spawn. So it follows the `policy-route-check.ts` precedent exactly:
   `refreshModemIdPaths()` writes a cache, `getModemIdPath()` reads it. An
   unresolved ifname yields NO `stable_key`, which is the pre-Phase-B wire and the
   honest answer for a device we cannot anchor — never a fabricated key.
   A failed refresh RETAINS the previous map: an unreadable udev database is a
   statement about the read, not about the devices, and clearing it would make
   every row look like new hardware to a frontend correlating a mode switch.

   **THE MAP IS BUILT FROM udev's NET RECORDS** (`modem-id-path-source.ts`
   `readModemIdPaths` / the pure `parseNetIdPaths`), NOT from
   `@ceralive/modem-control`'s `createUsbEnumerator()`. That enumerator's
   `UsbDeviceSnapshot.ifname` is declared on the type and **never populated** —
   `parseUdevDatabase` keeps only `DEVTYPE=usb_device` records, and a
   `usb_device` record does not carry `INTERFACE`; the netdev is a separate child
   record under the `net` subsystem. Board-measured on `ceralive2`
   (2026-08-18): **24** `usb_device` records, **0** of them carrying an
   `INTERFACE`. So the map was EMPTY on every real board, `getModemIdPath()`
   answered `undefined` for every interface, no modem resolved a `stable_key`,
   and the fail-closed mutation contract therefore refused EVERY modem mutation —
   config save, network scan, SIM unlock, USB-mode switch — with
   `identity_unresolved`, on hardware whose modems all publish a good `ID_PATH`.
   The guard was right; its input was dead. A ZERO-length result is now logged at
   `warn`, because "no modem has an identity" and "this board has no modems" were
   otherwise indistinguishable. The netdev's interface-level path
   (`…-usb-0:1.4.4:1.4`) reduces through the unchanged `deriveModemStableKey` to
   the SAME `usb_device` parent MM's sysfs `Modem.Physdev` mints, so the two
   sources still agree by construction. A netdev with no `ID_PATH` (the
   duplicate-MAC HiLink twin, whose rename collides and leaves udev with only
   `ID_RENAMING=1`) is OMITTED — never keyed on its name.
2. **It refreshes on PRESENCE edges only** — `discoverModems()` and
   `handleModemAdded`, never the 30 s status poll. An `ID_PATH` names where a
   device is plugged in, so a poll cannot move it.
3. **It retains `syntheticIds` across snapshots.** `projectModemWire` returns the
   allocation it made and expects it back as `previousSyntheticIds`; drop that
   round-trip and every poll renumbers the dongles under the operator.

4. **It joins the mmcli-side 3GPP SCAN RESULTS onto a D-Bus row**
   (`withScanResults`). A scan is an mmcli operation writing into mmcli state,
   MM publishes no scan-result property for the fold to read, and `"dbus"` is the
   default backend — so a scan ran, succeeded, and reached the operator as an
   unchanged (empty) network list. The composition root is the only place that
   sees both halves. A modem the mmcli side never scanned is left UNCHANGED
   rather than given an empty list, which would claim a scan found nothing.

**Which adapter produces a radio row follows the backend that COMMITTED, never
the config key.** A `dbus` request that fell back to mmcli must project mmcli
rows — advertising the additive detail block would put confident values on the
wire that nothing observed.

**The fold now EXISTS, and it reads the TREE, not the `ObservationList`.**
`readDbusViews()` serves `modules/cellular/dbus-modem-cache.ts`, which is filled
by `dbus-view-fold.ts` from the decoded `GetManagedObjects` payload the observer
hands to `onEpochRefresh`. Two upstream facts force that input choice and both
are easy to get wrong: the package's `mapModem` is deliberately conservative
(registration always `unknown`, empty RAT set, no signal / operator / ifname /
modes at all — a row folded from it would be strictly POORER than the mmcli row
it replaces), and the observer emits a list ONLY when a row FINGERPRINT changed,
a fingerprint that ignores signal quality — so a signal-only refresh delivers a
tree and NO list, and a list-driven cache would never publish the single most
frequent update on the wire. The `ObservationList` is used for exactly two
things: `start()`'s `ok` commit test, and telling the two failure classes apart.

Full contract — snapshot/subscription API, the fold's field-by-field source
table, the bounded refresh + publication coalescing, the two SEPARATED failure
classes, source precedence / authoritative keys, the cutover and its rollback,
and the startup cancellation contract — is
[`docs/DBUS-OBSERVATION-CONTRACT.md`](../../../../docs/DBUS-OBSERVATION-CONTRACT.md).
Read it before changing any part of this path.

### THE POST-RESTART EMPTY SNAPSHOT MUST NEVER REACH THE WIRE

Measured on real hardware (todo 16, gate 4): a ModemManager restart's resnapshot
fires **18 ms** after MM re-acquires its bus name — before the daemon has
re-probed a single port — and legitimately answers `modemCount: 0`. The roster
then refills over the next **~20 s** via `InterfacesAdded` from the new owner.

**A consumer that published that snapshot verbatim would blank the operator's
modem list for ~20 s on every MM restart.** So `dbus-modem-cache.ts` does not
give a new epoch authority immediately: it enters `settling`, keeps serving the
retained rows marked `availabilityReason: "mm-restarting"`, MERGES each partial
refill over them (matching on the `ID_PATH` anchor, because MM renumbers the
whole roster across a restart — measured `11,13,14,15 → 0,1,2,3`), and only
commits when the roster refills or `EPOCH_SETTLE_MS` (25 s, chosen above the
measured ~20 s) elapses. A genuine "everything was unplugged during the restart"
therefore takes up to 25 s to reach the wire — the deliberate trade against a
guaranteed 20 s false blanking on every restart.

### THE TWO FAILURE CLASSES ARE NOT INTERCHANGEABLE

They look identical in a log line and have OPPOSITE correct responses:

| `ObservationList` reason | What it means | Response |
|---|---|---|
| `bus-error` | our client failed while MM stayed answerable | mmcli IS a real second opinion — demote below it, serve `[]`, let the wire producer project mmcli rows |
| `source-unavailable` | the MM bus name has no owner (or the bus dropped) | **mmcli talks to the same dead daemon** — there is NO backstop. Retain the rows, mark them `availabilityReason: "mm-unavailable"`, make NO fallback-healthy claim, and require a full resnapshot to complete (per the settle rule above) BEFORE authority returns |

### SIGNAL CADENCE — A DOCUMENTED DEVIATION, WITH EVIDENCE

The plan called for `Signal.SetupThresholds` (else `Signal.Setup` at 5-10 s).
**Neither is called on the shipped path, deliberately.** `dbus-audit-transport.ts`
is fail-closed and refuses `Modem.Signal.Setup` BY NAME because it WRITES, and
that fail-closed guarantee is the single property that makes it safe to point the
fleet default at a path observing the same daemon mmcli drives — opening a write
member in the very commit that flips the default would remove the reason the flip
is safe. It costs nothing measurable: `Modem.SignalQuality` is MM's own polled
property and is published via `PropertiesChanged` with no `Setup` call at all
(todo 16 recorded 66 such signals in a session that issued none), and
`DbusModemView.signal` reads that 0-100 value, not the extended `Modem.Signal`
interface `Setup` governs. Adopting extended metrics means adding the member to
`CELLULAR_READ_ONLY_MEMBERS` as its own reviewed change, never as a side effect.

### SHADOW MODE IS EVIDENCE, NEVER A SOURCE

`config.modem_shadow === true` starts a mutation-free comparison of the D-Bus
observer against the live mmcli reads (`docs/MMCLI-RETIREMENT-GATE.md`). It never
touches the wire — a boot-integration test asserts the projected message is
byte-identical with shadow on and off. The opt-in is strict: absent, `false`, and
a non-boolean truthy all return BEFORE the D-Bus client is imported.

### DEV MOCK SEAMS (cellular)

`mocks/providers/cellular.ts` makes all three surfaces reachable with no
hardware, and every seam is deliberately placed so the PRODUCTION rule still
runs:

| Seam | Where it enters | What still runs for real |
|---|---|---|
| `getMockModemIdPaths()` | the producer's `ModemIdPathReader` | `deriveModemStableKey`'s parent-`usb_device` strip |
| `listMockDongleFiles` / `readMockDongleFile` | `dongle-metadata.ts`'s OWN deps seam, as file CONTENT | the real schema, staleness and ambiguity rules — and it feeds BOTH the netif marker and the modems row from one place |
| `getMockDbusModemViews()` | `setMockDbusModemViews()`, installed by `main.ts`'s dev block | the full adapter + projection path |
| the mock dbus BACKEND | `loadDbusBackendFactory()` | the same try, `withDeadline` race and `result.ok` commit test |
| `getMockShadowDeps()` | `startModemShadowIfEnabled` | the audit wrapper, classifier, redactor and evidence writer — `startModemShadow` applies the wrapper itself, so the fake stays BELOW the guard |

Two fixture rules are load-bearing and were both learned the hard way:

- **`updated_at_ms` is stamped at READ time.** A frozen timestamp reads as stale
  within 90 s and the dongle rows silently vanish from the dev UI.
- **The mmcli side's `deviceKey` must go through `opaqueDeviceKey`**, because the
  observer side does. A raw ifname produces a matched `only-in-mmcli` +
  `only-in-dbus` PAIR every cycle instead of the one field divergence the fixture
  demonstrates — which is the "the two sides never actually joined" state the
  retirement runbook calls a gate blocker.

The fixtures also reproduce the bench's duplicate-MAC HiLink pair verbatim (two
physically distinct dongles, ONE factory MAC `0c:5b:8f:27:9a:64`): that collision
is the reason identity is `ID_PATH`-keyed, so a fixture that quietly gave them
different MACs would teach the opposite lesson.

Coverage: `tests/cellular-boot-order.test.ts` (the source-order lock + the
fail-soft consequences) and `tests/cellular-boot-integration.test.ts` (the
`bootLikeCellular` parity harness — `stable_key` reaching the wire through the
real composition root, both dongle rows with their honest omissions, synthetic-id
stability, backend selection in BOTH directions, the refusal window, and shadow's
non-interference). The per-module suites from the wave below it are unchanged:
`cellular-stack`, `cellular-audit-transport`, `cellular-gate`,
`cellular-shadow-{divergence,audit,redaction,retention}`,
`modem-wire-projection`, `modem-set-usb-mode-gate`,
`modem-usb-mode-transition`, `streaming-lifecycle-interlock`.

### THE `dbus` PATH IS NOW THE DEFAULT — AND THE FULL PATH IS STILL BOARD-UNPROVEN

`config.modem_backend` (`z.enum(["mmcli","dbus"])`, `.optional()`, still no
`RUNTIME_CONFIG_DEFAULTS` entry) now resolves through `DEFAULT_MODEM_BACKEND`,
which is **`"dbus"`**. Absence is what every board in the field has, so an
UNMODIFIED production config takes the cutover; `"modem_backend": "mmcli"` is the
operator's explicit rollback value and still selects the byte-identical legacy
path (synchronously ready, no D-Bus import). CI proves the cutover the way a
field device experiences it — `tests/cellular-dbus-adoption.test.ts` deletes the
key rather than setting it.

**Read what IS and IS NOT hardware-proven, because they are different claims.**

- **PROVEN on the bench** (`ceralive2`, todo 16, 6/6 gates): the D-Bus TRANSPORT
  under Bun in the real packaged service identity — system-bus connect, a
  `GetManagedObjects` roster identical to `mmcli -L`, all four signal classes
  received AND decoded across a real USB port cycle, survival of a ModemManager
  restart, clean SIGTERM with no orphaned match rules, and a full observed hour
  with zero fd or subscription growth.
- **NOT proven on a board**: everything ABOVE the transport — this cache, the
  fold, the settle guard, the failure-class split, and the flipped default
  serving real `modems` rows to a real operator. Every assertion about them is a
  unit/integration test against a fake bus. That is a gap in HARDWARE EVIDENCE,
  not in coverage, and the two are not interchangeable.

**Two things are owed before this default should be trusted in the field:**

1. **Board-run the flipped default.** Deploy, restart `ceralive` WITHOUT editing
   `/etc/ceralive/config.json`, and confirm: `status.cellular_initializing`
   clears, the `modems` broadcast carries every real modem with `stable_key`
   populated, a `systemctl restart ModemManager` does NOT blank the list (the
   settle guard's whole purpose), and an unplug still removes its row.
2. **The ≥ 8 h soak.** Todo 16's one-hour soak was leak-free on descriptors and
   match rules but left an unresolved ≈5.6 MiB/h residual RSS slope a one-hour
   window cannot distinguish from heap warm-up. It was measured against the raw
   transport harness, not this cache. ~5 MiB/h sustained is ~120 MiB/day on a
   device that runs for weeks.

**And note the tension with the retirement gate below, honestly.** That gate's
condition 5 describes flipping the default away from `"mmcli"` as a later
decision gated on ≥14 days of shadow evidence on ≥2 devices plus a HIL parity
run. **The flip has now shipped ahead of that evidence, by plan decision.** What
that changes is which safety net is load-bearing: it is no longer the shadow
comparison but the runtime fallback — a `dbus` start that rejects, returns a
non-authoritative snapshot, or outlives `DEFAULT_INIT_TIMEOUT_MS` commits mmcli
in a ready-but-degraded state visible at `/api/health`, and the operator rollback
value is one config line. `buildModemsMessage` therefore stays exactly where it
is; condition 5 has NOT been satisfied, it has been overtaken, and deleting the
legacy builder is further away rather than closer.

### THREE PARALLEL MODEM-TOUCHING PATHS NOW EXIST, AND ONLY ONE IS LIVE

This session's audit surfaced that CeraUI's backend now carries three
independent code paths that each talk to modem hardware for a DIFFERENT purpose.
They do not compete for the same job, but they DO overlap in the sense that a
future reader could reasonably ask "why are there three ways this backend talks
to a modem" — so the answer is recorded here rather than left to be
re-discovered:

1. **`modules/modems/` — the original Phase-A direct-`mmcli` path.** This is the
   ONLY one of the three actually exercised on real hardware. Every modem row on
   the wire today (this session's live Quectel/SIMCom/HiLink/ZTE verification, the
   todo 45 PIN2 flow, the todo 43 router-cellular classification) came from this
   path. It shells out to `mmcli`/`qmicli` per poll (`mmcli.ts`,
   `modem-update-loop.ts`, `sim-pin2.ts`, `sim-autounlock.ts`, `sim-secrets.ts`)
   and is what `modem_backend: "mmcli"` (now the operator ROLLBACK value, no
   longer the default) selects inside `initCellularStack`. It also still runs
   under the D-Bus default as the 30 s reconciliation backstop, so a demotion has
   warm rows to serve. Everything it reads from `-K` output passes through
   `mmcliUnescapeValue` — mmcli escapes EVERY value it prints, so this is a
   property of the CLI and not of any one command (SMS INBOX §5).
2. **`modules/cellular/` — the Wave-4 composition root over
   `@ceralive/modem-control`'s D-Bus observer.** `cellular-stack.ts`,
   `dbus-backend.ts`, `dbus-audit-transport.ts`, `shadow.ts`,
   `modem-wire-adapters.ts`, `modem-wire-projection.ts`, plus the observer
   adoption layer (`dbus-modem-cache.ts`, `dbus-view-fold.ts`,
   `dbus-mm-enums.ts`). This is now the DEFAULT path — its transport is
   board-proven (todo 16) but everything above it is still fixture-proven only;
   see the section above for exactly which claim is which.
3. **`modules/modems/sim-pin2.ts` — a direct-`qmicli` path, found this session
   (todo 45), that neither of the other two paths can reach.** Neither `mmcli`
   (ModemManager's own D-Bus API declares exactly five `Sim` methods —
   `SendPin`/`SendPuk`/`EnablePin`/`ChangePin`/`SetPreferredNetworks`, all
   PIN1-only, confirmed against both the MM 1.24.2 source and a live `busctl
   introspect` on `ceralive2`) nor `@ceralive/modem-control`'s D-Bus surface
   exposes SIM **PIN2** submission at all — MM's own maintainers say so
   explicitly ("we really don't care about PIN2 in MM, at least for now"). So
   `sim-pin2.ts` bypasses BOTH modem-facing abstractions and calls `qmicli
   --uim-verify-pin=PIN2,<code>` directly over the shared `qmi-proxy` socket,
   deliberately alongside a live ModemManager rather than through it. This is not
   a design inconsistency to "fix" by routing PIN2 through one of the other two
   paths — as of this writing NEITHER can carry it, so a third, narrower path was
   the only available option for a real operator need (see todo 45's full
   write-up in the session notepad for the PIN2/PIN1 distinction and why boot
   auto-unlock deliberately excludes it).

The three paths are NOT redundant with each other: (1) is the live production
path, (2) is evidence-gathering infrastructure for a FUTURE production path, and
(3) fills one specific real gap neither (1) nor (2) can reach. A future reader
tempted to "consolidate" them should first re-read this paragraph — consolidating
(1) into (2) is exactly what the mmcli-retirement gate below exists to make safe,
and consolidating (3) into either is blocked by an upstream ModemManager
limitation, not a CeraUI design choice.

### WHY `buildModemsMessage` (LEGACY) STAYS ALONGSIDE THE PROJECTION — AND WHEN IT CAN GO

The "PROJECTION IS WHAT REACHES THE WIRE" section above already states the
mechanical reason `buildModemsMessage` is retained: it is the fail-safe a
throwing projection falls back to, and the oracle `modem-wire-projection.test.ts`
asserts against. Restated plainly for anyone weighing whether to delete it: it is
a **byte-compat regression guard for the `mmcli` path** — the path that is
actually running on every real device today (see above). Deleting it would remove
both the safety net AND the only independent check that the new
projection/adapter/wire-producer trio (todo 22) reproduces the pre-Phase-B wire
exactly, for the backend that 100% of the fleet currently uses.

**Retirement condition (dated, measurable — not "someday" or "when ready"):**
`buildModemsMessage` may be deleted only once ALL of the following hold
simultaneously, mirroring the shadow-mode retirement gate's own N-day/
divergence-count mechanism (todo 21, `docs/MMCLI-RETIREMENT-GATE.md`):

1. `config.modem_backend: "dbus"` has actually run in production (not fixtures)
   on **at least one** real CeraLive board for **at least 14 consecutive days**
   (`MIN_HEARTBEATS_PER_COMPLETE_DAY = 72` per the shadow evidence retention
   rule already documented above), collecting shadow evidence the entire time
   via `config.modem_shadow: true`.
2. Zero unexplained divergences recorded in that evidence window — a
   `field-mismatch`/`only-in-*` entry is "explained" only if it is one of the
   already-known, already-documented absent-dimension gaps (see "the observer and
   mmcli do NOT observe the same dimensions" above); any NEW divergence class
   blocks retirement until it is understood.
3. `unjoinable` count in the shadow heartbeat stays at (or returns to) zero for
   that same window — a persistently non-zero `unjoinable` count means parts of
   the fleet were never actually compared, which the runbook already calls a gate
   blocker.
4. The MMCLI-RETIREMENT-GATE runbook's own `distinctModems ≥ 2` criterion is met
   across **separate physical CeraLive units**, not two modems on one board (the
   runbook's own explicit distinction, restated above in "COMPOSITION ROOT").
5. `mmcli` retirement itself (flipping the DEFAULT away from `"mmcli"`) is a
   SEPARATE, later decision gated on a successful HIL parity run and one full
   dbus-default release cycle (per the root plan's binding annex — "mmcli-
   retirement criteria: ≥14 days shadow on ≥2 devices, zero unexplained
   divergences, HIL parity, rollback drill, one dbus-default release"). Deleting
   `buildModemsMessage` may happen only AFTER that flip has shipped and proven
   stable — the legacy builder is the safety net for exactly the transition
   window between "default flipped" and "confidently redundant", not for the
   flip decision itself.

**None of these five conditions have been met as of this session.** Condition 1
alone requires the NEXT STEP two sections above (setting `modem_backend: "dbus"`
on a real board) to have even started, and it hasn't. This todo documents the
condition; it does not — and must not — trigger any part of it.


### Existing automatic profile APNs

`automatic-carrier-profile.ts` converges the stored APN and bearer-family fields
for an existing, exact device+SIM profile on an admitted NM transport. It uses
subscription evidence and preserves manual, unknown and unqualified policy.
It retains versioned inverses alongside the earlier family-only inverse.

The private `automatic-carrier-intent.ts` store keeps logical operator intent
separate from NM's auto-config bit, which must be off for an explicit APN. Its
profile/equipment/SIM key is hashed; files are private, atomically replaced and
fsynced. Pending intent precedes the NM write; applied intent follows verified
readback. A manual save persists manual intent before its NM write, including
when the APN is unchanged. Corrupt authority defers rather than assuming absence.
An applied APN is a conflict witness, never carrier identity.

The isolated real-NM fixture uses a private system bus, state/config directories,
network and mount namespaces, with host rfkill hidden. It verifies profile writes,
intent rehydration and manual retirement. It does not model a modem, initial
activation, transport preparation, grants, CLAT or data-path qualification.

### Disarmed creation and transport preparation

Registration is read-only. The late-SIM owner creates a profile only with an
identity-resolved lifecycle lease and a journaled preallocated UUID. Creation
always uses autoconnect=no; it retains private automatic intent and verifies the
exact pair/name/flag. Its inverse removes only that inactive, disarmed exact
profile, verifies absence, then retires intent. A lost create reply is recoverable
without guessing a UUID. Other SIMs' operator-code settings are never copied.

`cellular-preparation.ts` owns automatic NM activation admission. It retains the
original profile/autoconnect policy in private durable state and leaves owned
automatic profiles disarmed across USB and process return. Manual saves release
the original flag; a profile born under this owner becomes autoconnectable when
saved manually. A new generic owned profile can delegate APN lookup to a positively
probed NM capability. Existing unknown/manual/unqualified policy is preserved.

The existing modem transport facade verifies driver/composition, current physical
pair, USB generation and interface index. Its serial session selects an observed
USB interface (udev's primary AT marker resolves multiple candidates), never a
tty number. A dedicated non-reconnecting inhibition connection uses a 300 s
acquisition timeout, validates acknowledgement and whole-field numeric subscriber
identity, and revokes on service-owner change or bus loss. Serial IO is bounded,
descriptor-anchored, and handles EAGAIN without treating it as a lost device.

QMAP baseline is per equipment and readback per USB generation; EPS baseline and
spent-attempt authority are per equipment/SIM. Failed setters consume the EPS
attempt. Reset return must verify the result, otherwise it blocks. Raw-IP's
private baseline precedes its write; global addresses must be absent, link down,
and readback successful before explicit activation. Firmware effects whose
restoration is unverified retain the existing mutation block and private baseline
for explicit recovery. No automatic repeated reset is used to escape that state.

The private JSON file primitive is shared with carrier intent: anchored directory,
no-follow bounded reads, strict JSON/UTF-8, private ownership, atomic replacement
and file/parent fsync. The required real-NM fixture includes disarmed creation and
its exact inverse. Unit replay covers QMAP unit/generation behavior, EPS spent
attempts, raw-IP ordering and control-session revocation. Hardware qualification,
internal-call ownership, CLAT and per-path traffic health are separate gates.


### Retained internal-call handoff (partial)

`internal-call-owner.ts` retains acknowledged inhibition independently of MM's
absent object roster. Four consecutive registration reads precede a call; there
is no host registration setter. It honors roaming, preserves foreign active
contexts and records the complete understood context baseline before definition
or activation. Unqualified subscriptions never enter this adapter.

`cellular-host-handoff.ts` captures per-link RA, physical NM device and link-up
baselines durably. RA/default suppression and NM handoff precede inhibition;
kernel-index link-up follows stable registration and precedes activation. The
system-bus session originates at the existing modem facade, addresses the unique
NM owner, and refuses another device or a replaced service. A disconnected
physical Ethernet object can have an empty IP interface; its physical Interface,
UDI and object identity remain required. The actual NM namespace fixture proves
managed on/off/on and RA/link restoration without creating a default route.

`durable-inverse.ts` records the inverse cursor before each effect and retains
lost replies or foreign conflicts. Cleanup withdraws publication, commits its
intent, fences packets and waits for actual consumer release before reversing
exact effects. The caller holds the private kernel state lease and existing
modem lifecycle admission. Host guard cleanup follows modem restoration; MM is
released last. A partial handoff failure retains inhibition until host cleanup
can finish. Missing/replaced physical devices remain unresolved until recovery
can prove the old resources gone; a reused name is never restoration authority.

Read-only native bearer observation is separate from firmware write admission.
It uses the actual bearer's DNS/family/gateway and rechecks device, SIM, subscriber,
USB generation and ifindex across observation. An unlisted firmware does not gain
AT commands from this read. Scope/zone suffixes and partial dotted addresses
cannot redirect an internal grant to another device.

These owners are not yet composed with production activation, a data-plane host
adapter or startup recovery. CLAT, health and physical qualification remain
separate gates. No hardware/carrier pass follows from this fixture evidence.

### Per-uplink data-plane primitives (partial)

`cellular-source-state.ts` fences publication by physical parent, pair/USB epoch
and observed grant. A translated source binds its TUN while retaining the physical
parent's sender identity. A native grant invalidates translated readiness. A fresh
producer snapshot must prove old sockets absent; republishing a map is insufficient.
Legacy snapshots without identity cannot acknowledge partial withdrawal.

Probe reservations are pair-scoped across USB/process return and cannot be refilled
by a backward clock. Bound UDP uses source plus device, fixed questions, finite
payload/response limits and no resolver fallback. HTTPS uses libcurl's nonblocking
multi API, a literal source bind and a SO_BINDTOIFINDEX socket callback. Certificate/IP
verification, an independent deadline and bounded response headers are mandatory;
unavailable bindings remain unknown. The namespace gate proves both bindings
against local TLS, including wrong-device/source and untrusted-certificate refusals.
These allowances are conservative probe accounting, not billing certification.

The route planner uses private tables and local/ingress-specific selectors before
existing steering rules. Source-only rules do not close Linux's explicit-device
on-link output fallback after a FIB error. The independent nft output fence closes
before routing teardown. Native duplicate carrier addresses are fenced by kernel
device index; translated source slots are unique. Another firewall owner's policy
is never overridden with an accepting rule. Full inventories are verified before
replacement or deletion; foreign edits retain the inverse rather than being flushed.

Production host composition, translator supervision and startup recovery remain
incomplete. The disconnected routing/HTTPS checks are host evidence, not physical
carrier qualification. These helpers alone do not enable RNDIS, CLAT or recovery.

### Persistent cellular authority

Default carrier-intent and preparation access uses `/data/ceralive`, shared across
OS slots. `cellular-authority-store.ts` checks the previous `/var/lib/ceralive`
slot under a short kernel lease before either reading absence or updating state.
It validates the complete record and hashed slot, durably copies it, then commits
a per-slot source digest receipt. The legacy file is retained. A lost copy or
receipt acknowledgement never authorizes an effect; an identical copy can retry.
The receipt permits later current-state updates/deletion without resurrecting old
intent or an EPS baseline. Conflicting copies, changed legacy authority, damaged
records and lock contention defer work. Explicit store overrides are independent.
The old writer must be stopped during upgrade; this does not grant two controller
versions concurrent ownership or make an older version understand the new store.
The existing mutation replay inventories all retained pairs before lowering its
boot barrier, including absent SIMs. Damaged or changing inventories keep that
same capped retry owner active. Default-store faults invalidate its existing
revision and raise the same barrier; runtime verification reads inventories and
never migrates or repeats hardware. Current-state writes participate in that
revision. This is storage/recovery host evidence, not modem reboot qualification.

### Host composition and required device binding (partial)

`cellular-native-host.ts` composes the actual route/firewall primitives and durable
inverse for a native grant. The retained actor must own its slot lease until
cleanup completes. Writes serialize; installation is fenced unready; cleanup
withdraws once, denies, waits for actual consumers and removes exact owned tuples.
Uncertain effects retain their cursor. The kernel fixture covers complete link
loss: nft's vanished decimal-string oif requires two positive inventories, while
iproute2's null detached-selector marker admits inverse cleanup only, never ready.
Scoped virtual-link sysctls use owner/index checks; no USB identity is fabricated
for a TUN and global forwarding is untouched. These are host component proofs.

An explicit native `ownedAddress` plan retains the internal-call adapter's
physical USB/index generation and adds its exact `/32` after the durable output
fence. It shares the host inverse and slot; it does not create another owner.
Pre-existing addresses cannot be adopted. Cleanup waits for actual consumers,
deletes by index and preserves foreign/reused-name or changed-attribute state.
Two complete index-absence reads can retire vanished physical resources. The
ordinary NM plan owns no address. This component does not activate FM350.

Managed paths require an integer `capabilities.bind_map_contract >= 2`, literal
`bind_map_required === true` and `bind_map_required_empty_reload === true`, and
`--require-bind-map` alongside `--bind-map`. Ordinary bind-map support permits
source-only startup degradation and is insufficient. The required resolver has
typed refusals, never a legacy fallback. Its producer fixture is copied exactly
and preserves byte parity through the private sender helper, with the additive
`required_binding_refused` disposition carried by RPC and localized operator copy.
The ordinary legacy resolver retains its behavior for unmanaged paths. Production
actor/startup cleanup composition and translated host effects remain incomplete.

### Indexed translated effects and packet proof (partial)

Address/proxy effects use acknowledged NETLINK_ROUTE index selectors, never a
name-based mutation. Dispatch permission is checked after asynchronous FFI load;
the caller retains its slot lease and durable cursor throughout. Address adds
use CREATE|EXCL and host prefixes with no prefix route; proxy adds require exact
absence first because the kernel can acknowledge duplicates. Readback rejects
unknown identity, extra proxy attributes and changed address prefixes/lifetimes.
Unrelated addresses remain in place. A renamed link's inverse cannot touch its
same-named replacement.

The independent-provider packet fixture proves both translations and the
computed-zero UDP wire correction. A translated IPv4 lookup omits oif so reverse
path validation can use its private route. The translated ready fence returns
only for the owned oif, then drops every other egress for that source. It remains
necessary even when the rule is terminal: explicit-oif IPv4 fallback exists.
Native duplicate-source behavior stays device-specific. No rp_filter relaxation
or main-default/DNS mutation is introduced. Keep linkMtu separate from the
adjusted IPv4 route mtu: the minimum link is 1280, not 1260.

Admission requires both per-link force_forwarding capabilities; global forwarding
alone is not a fallback. There are no global/default forwarding writes. A missing
key or contradictory/current-identity failure refuses admission. Both ingress
directions, wrong-device fallback and withdrawal are kernel-tested in isolated
namespaces, not physically qualified. Production CLAT composition, persistent
startup/process recovery and NM/RA/hotspot coexistence are still incomplete.

### Runtime grant and host composition (partial)

The retained modem poll calls `runCellularRuntime` after preparation/activation,
outside its update lock. Boot installs automatic source admission before network
interface discovery: an address alone cannot publish an unresolved automatic
modem. Manual policy and noncellular links retain their behavior. Carrier policy
requires subscription home evidence; serving identity is diagnostic only.

Each runtime owner joins the actual connected MM grant, active exact NM profile
and healthy indexed kernel source. It installs MM/NM revocation subscriptions
before capture, tied to both unique service owners. IP/SIM/owner changes withdraw
synchronously; radio-only updates do not. An uncertain installation retains its
actual wrapper, bootstrap/host inverse and slot. Discovery completely withdraws
before final host acquisition. Probe cancellation never means socket closure;
cleanup waits for actual settlement and exact sender withdrawal proof. A fresh
DNS64 prefix change invalidates the session without charging carrier hysteresis.
Ten-MiB pair-scoped daily reservations survive USB and process loss.

Qualified service consumer census allows only the main backend and actual owned
fixed-command NM observers with stable process identity and positively non-INET
descriptors. Arbitrary PIDs/commands, socket families, subgroups and unreadable
state remain unknown. Runtime no-sender cleanup holds the existing lifecycle
interlock through the inverse; startup holds the existing recovery barrier.
Stored inverse, birth and auxiliary receipt schema failures report the same
protected read fault as malformed JSON. Changed global forwarding context
retains scoped inverses; this owner never writes global forwarding.

Native reconnect uses the existing journal and per-key lifecycle lease after
complete host/consumer withdrawal. Fresh pair/home/profile/USB and exact NM
active-or-idle evidence precede each call; registration and transport preparation
remain required. The old bearer lifetime is deliberately not reused after its
own disconnect. Unknown effects retain the ordinary failed mutation block and
exclude runtime publication. Startup restoration never disconnects and cannot
invent missing cold-boot preparation. USB availability never triggers a reset.
NM's requested activation wait has a client deadline at least five seconds
longer, within the transaction's bounded dispatch window; the generic command
cap must not silently truncate a 45-second activation at 30 seconds.

FM350 activation, installed translator packaging and
physical service/USB/reboot/NM/RA/hotspot qualification remain open. Verizon is
unqualified. Host fixtures do not close these gates.

The sender contract revision is independent of the two older booleans. Require
all three predicates for strict Start arguments and runtime host admission;
absent/zero/noninteger/string revisions refuse managed publication. Future
integer revisions at least two preserve the revision-two contract. A fresh
`pending_apply` frame, even with empty connections, cannot acknowledge socket
closure. The frozen producer fixture preserves this state through telemetry,
RPC and localized UI; only an applied frame can settle withdrawal.


Revision two requires the exact `bind_map_applied` generation and raw IP-file
SHA from the latest successful local publication. A newer local publication
invalidates an older receipt even if both exclude the same path. An obsolete
receipt is refreshed; a merely pending receipt keeps waiting. Producer wall
clock timestamps are not causal evidence. Monotonic consumer read freshness,
the supervised process epoch and unique per-producer file/socket endpoints
bound acknowledgement to one process. A confirmed departing process cannot
release a replacement process's resources. No-op publications retain identity;
failed or changed publications force a new generation and reload.


### Internal context authority (partial)

A retained internal-call definition is keyed by proven unit and context slot,
with the original subscription/context baseline preserved across later SIMs.
The desired APN/family is an explicit current subscription-policy input. A
transfer or same-SIM policy change requires a positively inactive context that
exactly matches the parked owned definition. Unknown activity, active foreign
contexts, unrecognized settings, wrong keys and unexplained definition changes
cannot authorize transfer. Parking does not issue a setter or restore an old
SIM's APN onto a new SIM.

Context files use the existing cellular authority migration, shared-data store,
mutation revision and recovery read-fault barrier; the startup census includes
all stored units/slots. This component has no mutation or recovery loop and must
be persisted before a caller submits definition/activation effects. A retained
AT control now exposes the digit-only subscriber observation separately from
matching the original subscriber: unreadable cannot be treated as a new SIM,
and positive change does not authorize a setter for the old subscription.
Actual retained-owner context transactions and runtime composition remain open.
