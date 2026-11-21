# Planned shutdown protection

A planned reboot must wait while the box streams or carries a client's traffic.
CeraUI uses logind's `Inhibit("shutdown", ..., "block")` method. A block inhibitor
lasts until the stream and carrying owners both release it; a delay inhibitor
would expire and allow a long session to be cut off.

The shared OTA marker owners also own the shutdown descriptor. Unknown startup,
reconciliation and failed cleanup retain protection. Boot starts native
lock acquisition without delaying control readiness. A slow logind does not abort boot: both
owners remain set, and carrying publication or the next stream start retries. Own-media launch awaits acquisition
asynchronously before launching media, and refuses if protection is unavailable.
Carrying follows the evidence and hold rules in the carrying-liveness feature;
traffic that has not yet met those rules is subject to their detection window.
An acquisition fault does not suppress the separate OTA activation marker, and
carrying publication retries an unconfirmed acquisition.

Bun's FFI calls the installed `libsystemd.so.0` with fixed-signature sd-bus calls.
The nonblocking sd-bus exchange has a 200 ms deadline covering connection,
authentication, Hello and Inhibit. It yields to the main loop between bounded
processing batches, so a silent bus cannot stall readiness or watchdog pulses.
Only one acquisition is in flight; a failed asynchronous attempt backs off for
one second before a later owner publication or admission retries. A pending
acquisition is not confirmed protection. Stream admission awaits its result and
checks cancellation again before launching media. Boot seeds owners without
waiting; acquisition completes in the background. If all owners disappear or
the controller is disposed while acquisition is pending, its eventual descriptor
is closed immediately.

The reply returns an actual file descriptor, retained by its
reply object. Normal idle cleanup unreferences that reply. Process exit or crash
closes it in the kernel; there is no helper process that can outlive the backend
and keep an orphan lock. Development and unit-test imports never open the host
bus; production boot explicitly initializes protection.

Local power actions, remote confirmed reboot and legacy update completion use
`systemctl reboot` or `systemctl poweroff` as root. On systemd 257, logind
honours strong block inhibitors for root without requiring polkit. Explicit
`--check-inhibitors=yes` is deliberately omitted: it also refuses an idle
box when a non-root support user is logged in over SSH.
They retain the existing stream/update admission gates and failure bookkeeping.
The dialog shows the emergency override only after a shutdown-lock refusal.
A local refused submission uses a typed, translated reason for shutdown
protection, other logged-in users, command unavailability or an uncertain result. No forced retry is introduced. The companion image provides
`ceralive-power` as an opt-in entrypoint for maintenance and recovery scripts;
there are no automatic update callers because staging and activation do not reboot.

## Emergency override and hung owners

The supported emergency override is to run **as root**:

```sh
systemctl stop ceralive
systemctl reboot
```

Only continue if stopping the service succeeds. Stopping disconnects streams,
carried clients and the web interface; it also closes the inhibitor. The second
command still checks other strong shutdown locks through logind. The power
dialog shows this override and its consequences in every supported locale.
Do not rely on `systemctl reboot -i` or `--check-inhibitors=no`: with a strong
block on systemd 257 they require polkit, which the image does not ship. Plain
`reboot` and scheduled `shutdown` are also refused while the block is held.
Direct target activation and `--force` bypass logind and are not this supported
procedure.

The service has a 30-second watchdog. After readiness, its main event loop sends
`WATCHDOG=1` through `sd_notify` every half interval. A hung or stopped owner
cannot pulse; systemd sends SIGKILL, drops the descriptor and restarts it after
two seconds. It may reacquire protection for retained/unknown activity on restart.
A deliberate `systemctl stop ceralive` suppresses that automatic restart.

The image's power-key policy deliberately ignores shutdown inhibitors for both
short and long presses, so a safety shutdown is not delayed until a hard cut.
It does not ignore low-level `handle-power-key` locks held by another key handler.

The descriptor ends with the CeraUI process, so a backend outage is not covered
by a surviving lock. Carrying startup reacquires protection on restart. Forced
administrative actions, watchdog resets, kernel failure and physical power loss
are outside planned-shutdown protection. Hardware-free tests cover native FD
acquisition/release on a private bus, ordinary exit and SIGKILL, owner interleaving,
failed acquisition, failed idle cleanup and launch refusal. Device continuity
still needs separate qualification.

## Stopping the service: helper children

`ceralive.service` uses `KillMode=mixed`: systemd sends SIGTERM to the backend
only and SIGKILLs whatever is left in the cgroup once it exits. The SIGTERM
path therefore stops the backend's long-lived helpers itself. All of it is
best effort within fixed bounds; anything still running when a bound expires
is left to systemd, as before.

- The SIGTERM and SIGINT handlers are installed at the top of boot, before the
  singleton guardian or any monitor exists. Steps for subsystems that have not
  started yet do nothing. Once shutdown began, the boot ladder starts no
  further step, and a step that was already running when the signal arrived
  does not hand control back to the ladder. A step's own work that was already
  in flight can still complete; SRT ingest checks the flag again before it
  starts a helper.
- At the signal, a process-wide shutdown flag is set before anything else.
  The `nmcli monitor` and `udevadm monitor` supervisors check it: neither starts
  nor respawns a child once shutdown began.
- Both monitors get SIGTERM and up to one second to exit, in parallel with the
  streaming teardown. The udev monitor publishes nothing from a stopped run and
  waits up to the same second for its inventory read; the export it runs has
  its own ten-second bound and is not cancelled, so it can outlive that wait.
  Nothing here sends SIGKILL; a child that ignores SIGTERM is left to systemd.
- Taking an OS stage or update flock guardian is admitted as guarded work
  before the guardian is spawned. Once shutdown began, a new acquisition is
  refused as ordinary contention, and one whose guardian becomes ready after
  the signal releases it before the lease is handed out. Work that already
  holds a lease is not interrupted: it may go on to its next write after the
  signal. Admitted work stays guarded until its owner disposes the lease, even
  if the guardian helper dies first, and the backend waits up to ten seconds
  for it before exiting.
- The backend singleton guardian (`flock` on the backend lock) is released last,
  with an explicit release and a two-second bound, after teardown and guarded
  work. Until then it still keeps a restarted backend from writing beside this
  one. If the singleton is still being acquired at that point, the release
  waits for the acquisition within the same two seconds and then releases the
  new guardian; if acquisition takes longer, the guardian is left to systemd.

When guarded work is still running after ten seconds, the backend logs it,
releases the singleton and exits anyway; that work is cut short as it would
have been before. A long OS staging step (download, install proof) holds its
lease for minutes and so uses the whole ten seconds. Its writer runs under
PID 1 and keeps its existing durable handoff and recovery. The new waits add
at most about 13 seconds after the existing cleanup (about 12 when the
monitors finished during teardown), and there is no shared deadline across
the existing cleanup steps. The unit inherits the manager's stop timeout
(90 seconds by default). During a manager-driven stop systemd no longer
enforces the 30-second watchdog; a SIGTERM sent directly while the unit is
running leaves it armed, and the backend keeps pulsing it while its main loop
runs, since these waits are asynchronous.

Tests: `apps/backend/src/tests/sigterm-child-shutdown.test.ts`.

## Reproduce the real-systemd contract

`scripts/ci/test-real-logind.sh` takes `CERALIVE_LOGIND_TEST_CONTAINER` naming an
exclusive disposable systemd 257 container. It requires the safety sentinel
`/run/logind-contract-disposable`, masked reboot/poweroff targets, no polkit,
Bun 1.4.4 at `/usr/local/bin/bun`, and no device passthrough or host mounts.
It uses the shipped native inhibitor and watchdog modules, and the shipped
service settings with only binary/working-directory paths replaced by a fixture.
The checks cover root refusal, the supported override, a stopped logind timeout
and SIGSTOP of the owner with the full 30-second watchdog interval. Masked target
acceptance is checked from the real journal, not the command exit status.
The companion image contract covers short/long synthetic power-key events.
