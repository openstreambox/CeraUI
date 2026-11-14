# Planned shutdown protection

A planned reboot must wait while the box streams or carries a client's traffic.
CeraUI uses logind's `Inhibit("shutdown", ..., "block")` method. A block inhibitor
lasts until the stream and carrying owners both release it; a delay inhibitor
would expire and allow a long session to be cut off.

The shared OTA marker owners also own the shutdown descriptor. Unknown startup,
reconciliation and failed cleanup retain protection. Boot initializes the native
lock before accepting control requests. Own-media launch confirms acquisition
synchronously before launching media, and refuses if protection is unavailable.
Carrying follows the evidence and hold rules in the carrying-liveness feature;
traffic that has not yet met those rules is subject to their detection window.
An acquisition fault does not suppress the separate OTA activation marker, and
carrying publication retries an unconfirmed acquisition.

Bun's FFI calls the installed `libsystemd.so.0` with fixed-signature sd-bus calls.
The bounded Inhibit request returns an actual file descriptor, retained by its
reply object. Normal idle cleanup unreferences that reply. Process exit or crash
closes it in the kernel; there is no helper process that can outlive the backend
and keep an orphan lock. Development and unit-test imports never open the host
bus; production boot explicitly initializes protection.

Local power actions, remote confirmed reboot and legacy update completion use
`systemctl --check-inhibitors=yes`, including when run as root without a terminal.
They retain the existing stream/update admission gates and failure bookkeeping.
A local refused submission tells the operator it was not run and asks for a new
attempt when idle. No forced retry is introduced. The companion image provides
`ceralive-power` as the entrypoint for maintenance and recovery scripts.

The descriptor ends with the CeraUI process, so a backend outage is not covered
by a surviving lock. Carrying startup reacquires protection on restart. Forced
administrative actions, watchdog resets, kernel failure and physical power loss
are outside planned-shutdown protection. Hardware-free tests cover native FD
acquisition/release on a private bus, ordinary exit and SIGKILL, owner interleaving,
failed acquisition, failed idle cleanup and launch refusal. Device continuity
still needs separate qualification.
