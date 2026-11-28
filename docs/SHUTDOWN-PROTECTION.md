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
