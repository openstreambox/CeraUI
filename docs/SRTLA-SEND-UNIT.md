# srtla_send through its own systemd unit

By default the backend spawns `srtla_send` as its own child. Every stop or
restart of `ceralive.service` (`KillMode=mixed`) then kills the sender with it.
With `"srtla_send_unit": true` in `setup.json`, the backend starts, stops and
supervises the sender through `srtla-send.service` instead, so the sender lives
in its own cgroup. A restart of the backend (a crash, a watchdog kill,
`systemctl restart`, a package update) then leaves the sender running: the
restarted backend holds it (below) instead of killing it or starting a second
one.

The flag is off unless set to `true`. With it off, nothing below runs: no unit
is read, the paths stay where they were, and the sender is a child as before.

Code: `apps/backend/src/modules/streaming/streamloop/sender-unit.ts`. Tests:
`src/tests/sender-unit.test.ts`, `src/tests/start-stream-sender-unit.test.ts`,
`src/tests/sender-unit-held-session.test.ts`.

## What the image must provide

The unit, launcher and directory come from the image (`docs/srtla-send-unit.md`
in image-building-pipeline):

| Path | Expected |
| --- | --- |
| `srtla-send.service` | loaded (installed, never enabled) |
| `/usr/libexec/ceralive/srtla-send-launch` | reads `/run/srtla-send/argv` and execs `/usr/bin/srtla_send` |
| `/run/srtla-send` | directory owned by root, mode 0700, created at boot by tmpfiles |

**Before the flag is turned on in an image,** the manual `ceralive-update`
guard must treat `srtla-send.service` as busy in every state but `inactive` and
`failed` (today its `systemctl is-active` misses `activating`/`auto-restart`).
A start by the backend holds the update lock, but an automatic restart is
started by systemd. That check belongs to the image.

## Mode at startup

With the flag on, the backend publishes "sender host not decided yet" before
the control server takes any request (no I/O, so nothing can treat a unit-run
sender as absent meanwhile), then, right after the bind and before anything
writes the IP list, reads the unit (three attempts). The load state decides
only whether this backend can start the unit; whether a sender runs is the
runtime state's question (below):

| Unit | Mode |
| --- | --- |
| loaded, directory root-owned and closed to group and others, sender `/usr/bin/srtla_send` | unit |
| not loaded (`not-found`, `masked`, ...) | child; a sender the unit may still run is held or seen down like any other |
| installed, but the directory or the sender executable does not fit | child, after a leftover unit is confirmed down |
| cannot be read | no sender of either kind starts until a later read settles it |

Before the stream session is reconciled at startup, the backend checks the
unit again ("A backend that finds the unit running" below). Until the unit is
confirmed down or positively absent (and after that, whenever a stop could not
be confirmed, and for as long as a sender is held):

- automatic stops (engine connection loss, reconfiguration) are refused
  with `sender_held`, so only the operator can end the session;
- every stream start fails in the `spawn-sender` phase with reason
  `unit_unresolved` (`unit_held` while a sender is held), and SRT forwarding
  refuses to start;
- the sender census reads `unknown`, never `absent`, so reconciliation does
  not commit idle and disruptive actions stay protected (a sender between a
  crash and systemd's restart has no process to find);
- the check is retried every 5 s.

**Confirmed down** means `inactive` or `failed`, no MainPID and no queued or
running job (`Job=` present and empty), from a complete `systemctl show`
reply. A start job can sit behind an inactive state; a reply without `MainPID`
is unreadable, never "no process", and a reply without a `Job=` row is never
"no job". The same rule is used for stop confirmation, start
admission, the startup check and a final exit.

Turning the flag off while a sender unit still runs is not supported: with the
flag off the backend reads nothing about the unit, and the census then sees an
unowned sender (protected, Stop fails). Stop it first
(`systemctl stop srtla-send.service`) or reboot (the unit has no `[Install]`).
Since a graceful backend stop leaves the sender running, this applies after
`systemctl stop ceralive` too.

## Files

In unit mode every file the sender touches is in `/run/srtla-send`, and the
writers and readers move together (the IP list writer, the bind map writer, the
telemetry reader and the reload check all read the same `setup` values):

| File | Path |
| --- | --- |
| argument file | `/run/srtla-send/argv` |
| IP list | `/run/srtla-send/ips` |
| bind map sidecar | `/run/srtla-send/ips.bindmap.json` |
| stats file | `/run/srtla-send/stats.json` |
| control socket | `/run/srtla-send/control.sock` |

`setup.json` `ips_file` and `bind_map_file` are replaced in unit mode. Every
path in the argument file is absolute; the unit's working directory is not the
backend's.

## Start

Publication, starts, stops and cleanup run one at a time.

1. Take the update lock (`/run/lock/ceralive-update.lock`, `flock` exclusive,
   non-blocking, the lock the manual `ceralive-update` takes). Busy refuses the
   start (`update_in_progress`).
2. Read the unit. Anything but confirmed down refuses (`unit_busy`): a second
   sender never starts beside a running, starting, restarting or stopping one,
   or beside a queued start job.
3. Validate the arguments as the launcher will (listen port 1 to 65535, the IP
   list and every path flag absolute, no NUL, at most 8192 bytes).
4. Remove the stale argument file, stats file and socket (the unit is down, so
   no sender owns them). A file that cannot be removed refuses the start.
5. Write the arguments, each followed by a NUL byte, to a fresh 0600 file in
   the same directory (`O_EXCL`, fsynced) and rename it over `argv`.
6. `systemctl start srtla-send.service`.
7. Wait for readiness (below). Release the lock.

Any failure after step 5 runs `systemctl stop` (which also cancels a start job
still queued) and removes the launch state only once the unit is confirmed
down. If that cannot be confirmed, the
launch state stays, the start fails with `stop_unconfirmed`, and no sender
starts until the unit is seen down.

Start failures come back as error `sender_unit_start_failed` with a reason:
`update_in_progress`, `unit_busy`, `unsafe_directory`, `invalid_arguments`,
`launcher_refused` (launcher exit 78), `sender_usage` (sender exit 2),
`start_refused` (systemd refused, for example the start limit, or a file
operation failed), `not_ready`, `unit_unreadable`, `stop_unconfirmed`,
`unit_unresolved`.

The backend never runs `systemctl reset-failed`. After `start-limit-hit` a new
start succeeds once the 60 s interval has passed.

## Readiness

`Type=exec` reports the unit started once the launcher runs, before it has
checked anything. The backend counts the sender as ready only when, within one
5 s deadline that covers every read, connect and call:

- the unit is loaded, `active`/`running`, with a MainPID, an InvocationID and a
  non-empty ControlGroup;
- that PID's `comm` is `srtla_send` (the launcher has replaced itself) and its
  cgroup is the unit's ControlGroup;
- a fresh `get_capabilities` call succeeds on a control-socket connection whose
  SO_PEERCRED PID is that MainPID and whose UID is root (the connection is
  closed before any request otherwise);
- InvocationID, MainPID and ControlGroup read after the call equal those read
  before it.

A pidfd taken right after the first read pins the process the checks
describe; signals go through it. The same check runs after every automatic
restart.

## Supervision, reload and stop

The handle reads the unit once a second. Every change of process identity
(InvocationID, MainPID or ControlGroup) goes through the restart steps below,
also one that appears while readiness is re-probed after an unreadable read,
and the stats file is cleared for the invocation that is finally followed.
Readiness is published, and telemetry reattached, only while the pinned
process is still alive after that cleanup (the pidfd is not readable, and any
poll event, including an invalid descriptor, counts as not alive).

- **Readiness is current, not cached.** A failed read, or a unit that is not
  `active`/`running` (for example `deactivating`), takes readiness away until a
  good read passes the readiness check again. A sender that stays unready for
  15 s is stopped, and the stream ends through the normal exit path.
- **Restart by systemd.** A new InvocationID or MainPID means the sender
  exited and systemd is restarting it (`Restart=on-failure`). The backend
  reports the exit to stream health, stops the telemetry reader and removes the
  dead sender's stats file (if that file cannot be removed, the sender is
  stopped rather than read blind), waits for the new process to be ready, then
  reattaches telemetry, clears the exit report and records the new PID and
  invocation, each only if the handle is still this stream's sender and still
  on that invocation. It never restarts the sender itself (ADR-0005).
- **Final exit.** A unit that is confirmed down without a stop from the backend (a refused argument file, a usage error, the
  start limit) ends the handle with the last exit status. The normal exit path
  runs. Its launch state is removed unless a newer start owns it by then.
- **Reload.** A bond change reaches the sender as SIGHUP through the pidfd,
  only while the handle is ready. The reload counts as delivered only when the
  kernel took the signal; otherwise the publication's retry applies. Without
  pidfd support the PID's `comm` and cgroup are checked first.
- **Stop.** Stopping the stream and a rollback run
  `systemctl stop srtla-send.service` (final: systemd does not restart after a
  stop), confirm the unit is down with no MainPID, then remove the argument
  file, stats file and socket. A stop that cannot be confirmed is
  retried every 2 s and the handle stays live, so the stream stays protected
  and the stop path keeps waiting. A retry never stops a unit that a newer
  start owns (it only started once this one was confirmed down). The SIGKILL
  escalation goes through the pidfd only; without a pin, systemd's stop job
  sends SIGKILL after `TimeoutStopSec`.

## Ownership

The sender census subtracts a unit-run sender only when the handle is ready,
the PID is the handle's MainPID and `/proc/<pid>/cgroup` is the unit's
ControlGroup. Reconciliation counts the sender as owned only while the handle
is ready and its pinned process has not exited (the pidfd is not readable; a
pidfd turns readable at exit, before the process is reaped, while signal 0
would still succeed; without a pin, its `comm` and cgroup still match), so a
sender that died after the last monitor read is not claimed. A change of ControlGroup under the same PID and
invocation is treated as a new process and verified from scratch. A child is still subtracted by its parent PID. The continuity
lifetime record says `host: "systemd"` with the InvocationID.

## Backend shutdown

A graceful shutdown of the backend (SIGTERM from `systemctl stop` or
`restart`, a package postinst) leaves an owned sender running in its unit and
logs it; it neither stops the unit nor waits for it, and its monitor stops
acting at once, also a read already in flight (no restart steps, no
stop for a wedged sender). A stop already in progress is not abandoned. A reboot or poweroff stops the unit with
everything else. A crash or watchdog kill leaves it running anyway, since the
unit is not in `ceralive.service`'s cgroup.

## A backend that finds the unit running

At startup (before the stream session is reconciled), a unit that is not
confirmed down was started by an earlier backend: running, starting, waiting
for systemd's restart, or still stopping. Nothing adopts it in this version.
It is **held**:

- nothing signals or stops it, and its argument file, IP list, bind map,
  stats file and socket stay in place;
- every start is refused (`unit_held`), so no second sender runs beside it;
- the census reads `unknown`, so reconciliation never commits `streaming`
  (this backend did not launch it) or `idle` (a sender may run): with the
  engine still streaming the session is "unconfirmed" and protected;
- no telemetry is attached and no bond change reaches it (the IP list and
  bind map files are still written, so a sender systemd restarts reads them);
- `status.stream_sender_held` is true; the Live view explains that a sender
  started before the restart may still run, that changed settings do not reach
  it, and that Stop ends it, and the HUD shows "checking", never "Idle".

The hold ends in one of two ways:

- **Operator Stop.** It stops the engine first, then takes one fresh look at
  the unit and, unless it is confirmed down, runs
  `systemctl stop srtla-send.service`; it succeeds only once the unit is
  confirmed down, and launch state is then removed. Engine and unit share the
  stop's 12 s budget (the unit part keeps at least 7 s, enough for
  `TimeoutStopSec` and the kill). An unconfirmed unit stop fails with
  `sender_unit_stop_unconfirmed`, an unreadable manager with
  `sender_unit_unresolved`; the hold stays either way. If the Stop's answer
  times out while the cleanup goes on, the session looks again once the cleanup
  settles, so a unit that comes down late still ends in idle. The same Stop
  also works before the startup check has run (the unit's state is then read
  on that press), and it finishes a stop that an earlier backend started and
  did not live to confirm. Any other stop (engine connection loss,
  reconfiguration, remote profile change) is refused while held: only the
  operator ends a session a held sender may carry. Restoration also stays out
  of the way: it neither launches nor uses up its one attempt while held.
- **On its own.** The unit is re-read every 5 s. A load state is never
  runtime evidence: a `not-found` or `masked` unit can still run its main
  process, so only a confirmed down counts. Once it is confirmed down
  (the start limit, a refused argument file, an earlier backend's stop job
  finishing), launch state is removed, the hold is released and the session is
  reconciled again: with an idle engine it becomes idle and Start works; with
  the engine still streaming it stays unconfirmed until Stop.

A unit that is down with an argument file left over (the backend died
between publishing and starting) has that file removed at startup.

Adoption would replace the hold with a verified handle over the running
sender (telemetry, reloads, a confirmed streaming state) and keep the hold as
its fallback.

## The activation marker

`/run/ceralive/streaming` keeps following the stream lifecycle in the backend,
as with a child sender. Neither the unit nor the launcher touches it, and a
restart by systemd does not change it. Since a stop that is not confirmed keeps
the handle live, the stream (and the marker) stays protected until it is.
A backend restart does not remove it either, so a held sender's session keeps
the same protection as any engine session the restarted backend cannot
confirm.

## Known gaps

- **No adoption.** A held sender runs without telemetry or bond updates until
  Stop; see above.
- **Idle engine beside a held sender.** A backend that died between starting
  the sender and starting the engine leaves a held sender beside an idle
  engine; the session stays protected until Stop.
- **No stderr notifications.** The child path turns two sender stderr lines
  ("Failed to establish any initial connections", "no available connections")
  into notifications. The unit's output goes to the journal, so unit mode does
  not raise them. Link state still shows through telemetry.
- **The update guard** (see "What the image must provide").
- **SRT forwarding** still spawns its sender as a child.
- **`srtla_path`** other than `/usr/bin/srtla_send` keeps the child path; the
  launcher runs only that binary.
- **Stream continuity's evidence** (open in a separate change) requires
  `Restart=no`; with this unit's `Restart=on-failure` it refuses, which is
  safe but means the two need one policy before any adoption.
- **One backend at a time.** Serialization and launch generations are per
  process, and only a start takes the shared update lock. A second backend
  with the flag on (a development process beside the service) could delete the
  other's launch files; this is not supported.
- **Graceful shutdown cleanups** still reset the host's default-route
  preference and stop the uplink shaper while the sender keeps running; their
  effect on a surviving sender has not been measured on hardware.
