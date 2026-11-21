# eSIM host helper

`apps/backend/ceralive-esim-helper` is a separately provisioned Python 3 adapter for exclusive consumer-eUICC access. It depends on the [pinned lpac runtime](LPAC.md), ModemManager and udev. Installing the helper does not enable any CeraUI feature.

An administrator installs the helper as `/usr/libexec/ceralive/esim-helper`, owned by root and mode 0750, and the lpac prefix as `/usr/libexec/ceralive/lpac`. A root-owned `/etc/ceralive/esim-devices.json`, mode 0600, maps each physical `stable_key` to independently verified device facts. Keep this host-specific mapping outside source control.

```json
{
  "physical-topology-key": {
    "uid": "ModemManager generic.device value",
    "port": "/dev/ttyUSB0",
    "portIdPath": "udev ID_PATH of this serial port",
    "backend": "at_csim",
    "eid": "00000000000000000000000000000000"
  }
}
```

Replace every placeholder before use. The helper checks the live ModemManager UID, refuses an active data session, verifies the serial port topology, acquires an inhibition and checks the expected EID. It restores the original serial configuration and reaps the inhibition child before returning.

The caller sends one JSON request through stdin. Common fields are `device` (the numeric ModemManager identifier as a string), `stableKey`, `acknowledged: true` and `action`. `inspect` returns a snapshot. All writes require its current `snapshot` token. `download` also requires `activationCode` and accepts `confirmationCode`; `enable`, `disable` and `delete` require an opaque `profileId`. Credentials pass to lpac over stdin.

A successful response is `{ "success": true, "snapshot": { "token": "…", "profiles": [] } }`. Each profile has an opaque `id`, `name`, `provider` and `state` (`enabled` or `disabled`). Responses omit raw EIDs, ICCIDs, activation codes and profile payloads. Failure responses use `{ "success": false, "error": "…" }`; a dispatched write or failed cleanup returns `outcome_unknown`. Treat missing responses and caller timeouts as uncertain too.

The snapshot binds operations to the exact card and profile-list state. Reads allow three bounded attempts; writes execute once. Downloads verify one new disabled profile. Enabled profiles must be disabled before deletion. Only notifications created during the current operation are processed. None of these checks establishes carrier connectivity or makes profile downloads/deletions reversible.

The calling control plane owns authentication, the streaming/modem mutation lease, durable journaling and recovery admission. It must retain an uncertainty block after an interrupted operation and inspect the card before permitting another write. The helper's lock and ModemManager inhibition do not replace those caller responsibilities.

Run the hardware-free helper tests with:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/esim/tests -v
```

The eSIM host helper workflow runs these tests independently of application builds. Physical modem/eUICC qualification and host installation remain separate checks.
