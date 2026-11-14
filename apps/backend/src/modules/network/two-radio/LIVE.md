# Route-only live coordinator

The existing network-interface monitor starts this owner when runtime config
contains `"two_radio_enabled": true`. Missing/false does not construct the owner,
read its files, install a timer, or change existing networking. Restart the service
after configuring it. This feature does not connect stations: provision both
station connections in NetworkManager first. Each must have one IPv4 lease,
a gateway and a distinct connected subnet. No default route is changed.

Put `two-radio.json` beside the service's `config.json`, or set
`CERAUI_TWO_RADIO_CONFIG` to its absolute path. It has this shape (all values below
are synthetic examples; choose unused tables, priorities, mark and your target):

```json
{
  "target": "203.0.113.7",
  "port": 47831,
  "mark": 48000,
  "table": 48000,
  "priority": 18000,
  "radios": {
    "a": { "permanentMac": "02:00:00:00:00:01", "phy": "phy0", "usbPath": "/sys/devices/example/usb/radio-a", "table": 48001, "priority": 18001 },
    "b": { "permanentMac": "02:00:00:00:00:02", "phy": "phy1", "usbPath": "/sys/devices/example/usb/radio-b", "table": 48002, "priority": 18002 }
  }
}
```

Get permanent MAC from the radio's `phy80211/macaddress`, PHY from the resolved
`phy80211` symlink and USB path from the resolved `device` symlink under
`/sys/class/net/<current-interface>/`. Names are discovered afresh; they are never
the ownership identity. The service needs NetworkManager/iw read access, Perl
with core Socket/JSON::PP, iproute2, and privileges for policy routes and
SO_BINDTODEVICE. Reverse-path filtering must permit the configured return paths;
the owner does not change sysctls or firewall rules.

Every radio gets an owned table with its connected subnet and target `/32` via
its gateway, and `ip rule add priority <priority> oif <interface> lookup <table>`.
The carrying table contains both connected routes and one target `/32`. Its
fixed `fwmark` rule selects that table. Promotion is one atomic kernel
`ip route replace table <carrying-table> <target>/32 via <gateway> dev <interface>`.
There is no rule delete/add gap. Rules/routes carry protocol 186; empty-slot
preflight plus an fsynced exclusive installation manifest establish ownership.
Other resources are never flushed or adopted. Operation cleanup restores the
journaled holder and checks the persistent installation; it creates no temporary
resources to delete. Both associations and both device-bound probe paths remain.
Changing installation configuration requires an operator-managed migration.

Activation identity also includes the D-Bus generation and unique NM owner, so
reused object paths after a daemon restart cannot reuse proof. NM is read twice
around association/lease observation and physical identity is
rechecked after IO. Settling retries have bounded cancellation/deadlines.
The owner sends **no NM mutation requests**, so no server-side NM activation can
outlive a canceled operation. All route children are awaited under the owner
transaction. Unknown completion closes admission. Restart drains, restores and
reads back the designated holder before admitting events; it never replays
commands from an interrupted swap. Foreign or unexplained state fails closed.

## Witness and carrying traffic

Use a controlled IPv4 UDP witness at `target:port`. The wire contract is
`ISSUE <request-id>` → a fresh 48-character lowercase hex nonce, then
`PROBE <nonce>` → `ACK <nonce>` on the **same connected device-bound socket**.
The peer must bind nonces to the source address/port and expire them. An optional
reference responder is `witness.ts`; on a separately administered host with Bun,
run `WITNESS_BIND=<listen-ip> WITNESS_PORT=<port> bun witness.ts`. It opens no
listener unless explicitly invoked with both settings. Provision and limit its
network exposure separately; the device never starts a remote responder. Unissued,
wrong-peer and stale responses are not proof. A missing nonce leaves usefulness
unknown; an issued challenge that times out is disproved. A completed round with
two disproved paths latches target suspicion and cannot trigger a swap. A split
result waits the policy emergency interval before promotion. No public target
is embedded in this repository. A normal media receiver is not automatically a
nonce witness; provision the witness separately before enabling live operation.

Promotion then waits for **independent carrying traffic**, never a probe arrival.
The sender must mark its carrying socket with the configured SO_MARK and target
this IPv4 address. Its trusted receiver integration atomically replaces
`two-radio/traffic.json` beside config with a mode-0600, service-owned receipt:

```text
{session, operation, identity, receivedBytes}
```

Copy `session`, the live operation `op.id`, and the candidate's complete
`identity` from the live session/status and sender binding; `receivedBytes` must
be a positive independently acknowledged byte count for that operation and
physical epoch. The producer is trusted local code and must invalidate receipts
on sender/receiver/epoch change. Do not write this file from a connectivity
probe. Without this producer the owner conservatively times out and restores the
old holder. No sender is automatically redirected or claimed to be qualified.
`/run/ceralive/two-radio/status.json` exposes the full policy state and session
for diagnostics. It is disposable tmpfs state, recreated after restart, and is
not read for recovery. `CERALIVE_RUN_DIR` overrides `/run/ceralive` in tests.
The former config-directory `two-radio/status.json` is no longer updated.
The durable `journal.json` records intent before each route effect.

After the receipt, logical demotion and at least 3000 ms linger precede holder
commit and logical release. Release never disconnects either station. No hardware
handover latency or media reliability is implied by host tests. On any runtime
error the timer stops and records the error; restart performs reconciliation.
Evidence history has a bounded session lifetime; restart when exhausted.

## Host checks

```sh
bun test apps/backend/src/modules/network/two-radio/
TWO_RADIO_NETNS=1 unshare -rn bun test apps/backend/src/modules/network/two-radio/live.netns.test.ts
```

The second command creates two veth paths and an independent target namespace,
runs the flag-true owner with real kernel rules/routes and bound nonce sockets,
and verifies a distinct marked carrying data exchange by receiver byte count,
SHA-256 and source path. It exercises complete swap/retained-holder restart,
crash during linger, and common-target no-swap. Fake NM tests additionally cover
activation drift, unresolved physical identity, foreign resources and readback
failure. All namespace sysctl changes are confined to the test namespace.
