# NetworkManager checkpoint preparation

This draft contains a confirmation-policy owner and a bounded D-Bus adapter.
They are not connected to the RPC handlers or UI. Existing network behavior is
unchanged. This is not yet a safe-network-edit feature.

The policy creates a 90-second NetworkManager checkpoint before a supplied
in-memory apply operation. It permits one pending operation, rejects overlapping
operations, and accepts confirmation only from an authenticated session opened
after apply completed, with a different identity, on an affected interface.
The future transport integration must supply that interface from trusted
arrival evidence. A browser field, HTTP header, local-address lookup or route
lookup is not sufficient.

The daemon owns the rollback deadline. Process-local state cannot confirm a
checkpoint that NetworkManager no longer reports. The owner destroys the live
checkpoint before calling persistence callbacks, so expiration cannot race a
persistent candidate write. Persistence errors are surfaced; the callbacks are
not an atomic multi-profile commit and are not retried automatically. Callers
must provide a complete persistence and failure policy before using this owner.

NetworkManager documents the runtime-keyfile semantics in its
[Update2 flag reference](https://www.networkmanager.dev/docs/api/latest/nm-dbus-types.html).

## What the isolated contract establishes

`scripts/integration/network-checkpoint-contract.sh` runs a real NetworkManager
and private system D-Bus in a disposable container, with a dummy interface and
synthetic addresses. It checks:

- An active profile changed with `nmcli connection modify --temporary` rolls
  back on timeout, with identical profile-file hashes.
- Explicit checkpoint destruction followed by `Settings.Connection.Save` keeps a
  confirmed edit beyond the former deadline.
- An inactive profile changed in memory remains changed after the same device
  checkpoint expires. A device checkpoint does not snapshot every inactive
  profile that might later be activated on that device.
- The restart requirement currently fails: NetworkManager reloads the unconfirmed
  candidate from its runtime keyfile under `/run`, rather than the old persistent
  profile. `--temporary` means nonpersistent across reboot, not across daemon restart.
- `DELETE_NEW_CONNECTIONS` removes newly added temporary candidate profiles
  when a checkpoint rolls back.

The inactive-profile check records a limitation, not acceptance of that
behavior for the future UI. It is a required design input: editing inactive duplicates directly
would leave unconfirmed configuration eligible for later activation.

Run only in a disposable container with no host device passthrough or host
system-directory mounts, a private network/PID namespace, and `NET_ADMIN`.
Install NetworkManager, D-Bus, systemd's `busctl`, iproute2 and coreutils. Set
`NM_CHECKPOINT_CONTRACT=1` explicitly and run the script as container root.
The script refuses radio-device access and physical network interfaces. It
creates no container image and uses no real radio or modem.

The integration script exits nonzero for the unmet daemon-restart requirements
for both active and dormant pending edits. It is not a passing acceptance gate.
The TypeScript unit tests use the ordinary test runner with
`--parallel=1 --max-concurrency=1`.

## Required before runtime wiring

1. Resolve daemon-restart rollback: the standard in-memory update stores a
   shadow keyfile under `/run`, while the checkpoint disappears with the daemon.
   `Update2` with `IN_MEMORY_ONLY` is not a solution: it also removes the original
   persistent profile.
2. Stage inactive profiles as new temporary candidates, or provide a separately
   verified stock restore mechanism for them. Preserve profile identity and
   duplicate-profile policy across confirmation and failure.
3. Cover non-profile effects in existing edits, including virtual-interface
   teardown, local hotspot identity/role persistence and modem radio-mode writes.
   A NetworkManager device checkpoint alone cannot undo every such effect.
4. Bind a fresh authenticated UI session to trustworthy arrival-interface
   evidence. Reject unavailable, ambiguous, old-session and other-uplink proof.
5. Make asynchronous station/hotspot completion part of the apply transaction;
   a dispatch acknowledgement cannot establish that a candidate is ready.
6. Add RPC/UI wiring, localized confirmation and expiry handling, and isolated
   integration/browser coverage of every mutation entry point.

No image, streaming, hardware or deployment changes are included here.
