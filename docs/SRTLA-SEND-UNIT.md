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

At startup the backend checks the unit is loaded, the directory is root-owned
and closed to group and others, and the sender executable is
`/usr/bin/srtla_send`. If any check fails it logs a warning and uses the child
path. The decision holds for the life of the process.

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

Publication and unit transitions run one at a time.

1. Take the update lock (`/run/lock/ceralive-update.lock`, `flock` exclusive,
   non-blocking, the lock the manual `ceralive-update` takes). Busy refuses the
   start (`update_in_progress`).
2. Read the unit. Anything but `inactive` or `failed` refuses (`unit_busy`): a
   second sender never starts beside a running, starting, restarting or
   stopping one.
3. Remove the stale argument file, stats file and socket (the unit is down, so
   no sender owns them).
4. Write the arguments, each followed by a NUL byte, to a fresh 0600 file in
   the same directory (`O_EXCL`, fsynced) and rename it over `argv`.
5. `systemctl start srtla-send.service`.
6. Wait for readiness (below), at most 5 s. Release the lock.

Any failure after the start stops the unit again and removes the launch state,
so a refused start leaves nothing running. The start then fails in the
`spawn-sender` phase with error `sender_unit_start_failed` and one of these
reasons: `update_in_progress`, `unit_busy`, `unsafe_directory`,
`invalid_arguments`, `launcher_refused` (launcher exit 78), `sender_usage`
(sender exit 2), `start_refused` (systemd refused, for example the start
limit), `not_ready`, `unit_unreadable`.

The backend never runs `systemctl reset-failed`. After `start-limit-hit` a new
start succeeds once the 60 s interval has passed.

## Readiness

`Type=exec` reports the unit started once the launcher runs, before it has
checked anything. The backend counts the sender as ready only when all of
these hold on one pass:

- the unit is `active`/`running` with a MainPID and an InvocationID;
- that PID's `comm` is `srtla_send` (the launcher has replaced itself) and its
  cgroup is the unit's ControlGroup;
- a fresh `get_capabilities` call succeeds on a control-socket connection whose
  SO_PEERCRED PID is that MainPID and whose UID is root (the connection is
  closed before any request otherwise);
- InvocationID and MainPID read after the call equal those read before it.

The same check runs after every automatic restart.

## Supervision, reload and stop

The handle reads the unit once a second.

- **Restart by systemd.** A new InvocationID or MainPID means the sender
  exited and systemd is restarting it (`Restart=on-failure`). The backend
  reports the exit to stream health, stops treating the sender as its own
  (the census and reload refuse until it is ready), waits for the new process
  to be ready, then reattaches the telemetry reader, clears the exit report and
  records the new PID and invocation. It never restarts the sender itself
  (ADR-0005).
- **Final exit.** A unit that is `inactive` or `failed` without a stop from the
  backend (a refused argument file, a usage error, the start limit) ends the
  handle with the last exit status. The normal exit path runs: telemetry stops
  and health reports the stream process gone. The launch state is removed.
- **Reload.** A bond change still reaches the sender as SIGHUP, sent to the
  unit's MainPID only while the handle is ready and the PID's `comm` and
  cgroup still match.
- **Stop.** Stopping the stream, a rollback and the backend's graceful
  shutdown run `systemctl stop srtla-send.service` (final: systemd does not
  restart after a stop), confirm the unit is down with no MainPID, then remove
  the argument file, stats file and socket. The SIGKILL escalation becomes
  `systemctl kill --signal=SIGKILL`.

## Ownership

The sender census subtracts a unit-run sender only when the handle is ready,
the PID is the handle's MainPID and `/proc/<pid>/cgroup` is the unit's
ControlGroup. A child is still subtracted by its parent PID. The continuity
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
restart by systemd does not change it.

## Known gaps

- **No adoption.** See above.
- **No stderr notifications.** The child path turns two sender stderr lines
  ("Failed to establish any initial connections", "no available connections")
  into notifications. The unit's output goes to the journal, so unit mode does
  not raise them. Link state still shows through telemetry.
- **The update guard's snapshot.** The start holds the update lock, so it never
  overlaps `ceralive-update`. An automatic restart is started by systemd, not
  the backend; the guard's `systemctl is-active` misses a unit in
  `activating`/`auto-restart`. That check belongs to the image.
- **SRT forwarding** still spawns its sender as a child.
- **`srtla_path`** other than `/usr/bin/srtla_send` keeps the child path; the
  launcher runs only that binary.
