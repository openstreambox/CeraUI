# srtla_send through its own systemd unit

By default the backend spawns `srtla_send` as its own child. Every stop or
restart of `ceralive.service` (`KillMode=mixed`) then kills the sender with it.
With `"srtla_send_unit": true` in `setup.json`, the backend starts, stops and
supervises the sender through `srtla-send.service` instead, so the sender lives
in its own cgroup.

The flag is off unless set to `true`. With it off, nothing below runs: no unit
is read, the paths stay where they were, and the sender is a child as before.

Code: `apps/backend/src/modules/streaming/streamloop/sender-unit.ts`. Tests:
`src/tests/sender-unit.test.ts`, `src/tests/start-stream-sender-unit.test.ts`.

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

With the flag on, the backend reads the unit (three attempts) before anything
writes the IP list:

| Unit | Mode |
| --- | --- |
| installed, directory root-owned and closed to group and others, sender `/usr/bin/srtla_send` | unit |
| positively not installed | child |
| installed, but the directory or the sender executable does not fit | child, after a leftover unit is confirmed down |
| cannot be read | no sender of either kind starts until a later read settles it |

After the startup observer has run, the backend checks the unit again
("leftovers" below). Until the unit is confirmed down, positively absent or
running this backend's own sender, every stream start fails in the
`spawn-sender` phase with reason `unit_unresolved`, and the check is retried
every 5 s.

Turning the flag off while a sender unit still runs is not supported: with the
flag off the backend reads nothing about the unit. Stop it first
(`systemctl stop srtla-send.service`) or reboot (the unit has no `[Install]`).

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
2. Read the unit. Anything but `inactive` or `failed` refuses (`unit_busy`): a
   second sender never starts beside a running, starting, restarting or
   stopping one.
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
`inactive`/`failed` with no main process. If that cannot be confirmed, the
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

The handle reads the unit once a second.

- **Readiness is current, not cached.** A failed read, or a unit that is not
  `active`/`running` (for example `deactivating`), takes readiness away until a
  good read passes the readiness check again. A sender that stays unready for
  15 s is stopped, and the stream ends through the normal exit path.
- **Restart by systemd.** A new InvocationID or MainPID means the sender
  exited and systemd is restarting it (`Restart=on-failure`). The backend
  reports the exit to stream health, stops the telemetry reader and removes the
  dead sender's stats file, waits for the new process to be ready, then
  reattaches telemetry, clears the exit report and records the new PID and
  invocation, each only if the handle is still this stream's sender and still
  on that invocation. It never restarts the sender itself (ADR-0005).
- **Final exit.** A unit that is `inactive` or `failed` with no main process
  and no stop from the backend (a refused argument file, a usage error, the
  start limit) ends the handle with the last exit status. The normal exit path
  runs. Its launch state is removed unless a newer start owns it by then.
- **Reload.** A bond change reaches the sender as SIGHUP through the pidfd,
  only while the handle is ready. The reload counts as delivered only when the
  kernel took the signal; otherwise the publication's retry applies. Without
  pidfd support the PID's `comm` and cgroup are checked first.
- **Stop.** Stopping the stream, a rollback and the backend's graceful
  shutdown run `systemctl stop srtla-send.service` (final: systemd does not
  restart after a stop), confirm the unit is down with no MainPID, then remove
  the argument file, stats file and socket. A stop that cannot be confirmed is
  retried every 2 s and the handle stays live, so the stream stays protected
  and the stop path keeps waiting. The SIGKILL escalation goes through the
  pidfd, or by unit name only while the unit is on the same invocation.

## Ownership

The sender census subtracts a unit-run sender only when the handle is ready,
the PID is the handle's MainPID and `/proc/<pid>/cgroup` is the unit's
ControlGroup. Reconciliation counts the sender as owned only while the handle
is ready. A child is still subtracted by its parent PID. The continuity
lifetime record says `host: "systemd"` with the InvocationID.

## A backend that finds the unit running

At startup (after the continuity observer has logged its verdict), a unit that
is not down was started by an earlier backend, for example one that crashed or
was killed by its watchdog. Nothing adopts it in this version: the backend
stops it, confirms it is down and removes the launch state before anything
streams. A unit that is down with an argument file left over (the backend died
between publishing and starting) has that file removed.

So a backend crash no longer kills the sender at once, but the next backend
still stops it. Keeping the stream across the restart needs adoption, which
replaces this step.

## The activation marker

`/run/ceralive/streaming` keeps following the stream lifecycle in the backend,
as with a child sender. Neither the unit nor the launcher touches it, and a
restart by systemd does not change it. Since a stop that is not confirmed keeps
the handle live, the stream (and the marker) stays protected until it is.

## Known gaps

- **No adoption.** See above.
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
