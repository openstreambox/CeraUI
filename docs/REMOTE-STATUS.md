# Remote status privacy boundary

Remote status crosses an account/service boundary. A type-name allowlist alone
is insufficient: status and config objects contain network identities and secrets.
Both legacy initial hydration and later socket sends now construct explicit DTOs.
Cloud status does the same before validating the complete frame with the pinned
control-protocol strict parser. Local browser frames retain the original data.

## Inventory and decisions

`remote-status-inventory.json` enumerates every leaf of every payload passed to
`buildMsg`, `broadcastMsg`, `broadcastMsgExcept` and `broadcastMsgLocal`, including
initial hydration, updates and direct replies. It records source, message type,
union alternatives and an allowlist decision. Dynamic record keys are `*`, arrays
are `[]`, and open records/opaque types remain default-denied. Local-only producers
are included conservatively because a future socket registration can change who
receives them. Run `node scripts/remote-status-inventory.mjs` only after reviewing
changes. A freshness test pins producer and type declaration sources and the lock.

| Surface | Needed remotely | Withheld or substituted |
| --- | --- | --- |
| status | streaming boolean and closed lifecycle state, cellular initialization, password-required boolean | all other top-level fields default-denied |
| Wi-Fi | distinguish adapters and saved profiles, connection present/absent | process-scoped Wi-Fi/Profile labels; no interface/MAC/radio identity, SSID, profile UUID, BSSID, passwords, nearby scan results, hotspot clients or future identity fields |
| modem | connection, radio technology, signal, roaming | neutral modem label; no SIM/operator/account/APN/config, serial, interface, device or USB path |
| netif | enabled and throughput metrics | neutral Link labels; no IP, subnet, hardware markers, operator information or error text |
| config and config results | bitrate, latency, delay, overlay, FEC, autostart; typed DHCP/roaming/slot/band acknowledgements | every other field, including stream ID, passphrase, relay account/host, custom provider, pairing/device identity, SSH credentials, source paths |
| sensors | no free-form formatted sensor strings | withheld; numeric system metrics remain on device-stats |
| device-stats | CPU load, temperature, total/available memory | paths, interface keys and free-text slot information withheld |
| link telemetry | measured rate, bytes, freshness, RTT/NAK/weight and per-link numeric metrics | device IDs, interface names, serials, physical port names replaced/withheld |
| buffering/engine bitrate | counters, active/disk-warning flags, applied and ceiling bitrate; null retractions | unknown fields withheld |
| active profile | published preset enum, latency, FEC, recovery enum | unknown fields withheld; invalid presets are absent rather than invented |
| pipelines, sources, relays, revisions, acodecs, encoder-load, fan, cpu, bluetooth and all other legacy/direct reply types | not needed for core remote start/stop and bitrate control | withheld at this boundary; detailed source/network/settings management stays local |
| notification(s) | separate bounded, fixed-text projection | unstructured notifications are withheld; see integration below |

All numbers must be finite numbers, flags must be booleans and forwarded strings
must belong to a closed enum. Keys containing identities are never copied.
Identifiers cannot become safe by moving into an unrelated or future field.
Labels persist across reconnects in a backend process, and reset on restart.
Labels are display identifiers, not permission or device identity for mutations.

## Transport coverage and UI

Legacy `sendInitialStatus` emits config, pipelines, sources, optional relays,
status, netif, sensors, encoder-load, fan, cpu, bluetooth, revisions, acodecs and
persistent notifications. Its remote socket send wrapper now covers that entire
sequence and every subsequent send, including direct replies. Numeric sequence
metadata survives; arbitrary request IDs and unknown envelopes do not. Encoder
authentication remains a separate transport exchange; its credential is necessarily
presented to the selected authentication service and is not a status field.

Cloud's generic broadcast bridge admits status/config/sensors/netif/modems/
device-stats/notifications/device.activeProfile. At this base no production code
calls `setControlChannel`: this is a latent cloud status path, not evidence that a
running cloud service has received these frames. Active-profile reporting requests
a reconnect snapshot, but the generic cloud path has no full initial hydration.
The separate hello, command results, telemetry and authentication paths are not
status frames. Config-result consumers already call the shared config projection.

A literal `remote_status: true` selects a dedicated read-only network view with local-management guidance in all ten locales; its render test verifies labels, connection state and the absence of mutation controls. The frontend ingestion regression uses the actual subscription handlers: streaming
state, neutral Wi-Fi and modem labels and numeric link throughput survive. Wi-Fi
rows pass the published Wi-Fi schema. Saved profiles are labelled, passwords and
hotspot names are absent. This is intentionally a reduced remote view: source,
network and credential editors that require the withheld fields must remain local.
Opaque display labels must never be sent back as NetworkManager or modem targets.
No external hosted remote UI or browser E2E was exercised.

## Integration with notification delivery

The notification relay change (#53 in the fork) owns bounded fixed-text summaries,
opaque names, epochs, revision/coalescing and full replacement. This change does
not replace that projection or copy free-form producer messages into generic status.
At integration, its cloud sender can continue using the dedicated validated channel.
Its legacy peer must use the captured original socket sender after its own projection,
rather than feed its already projected notification frame through this default-deny
status wrapper. Otherwise this change correctly withholds `notification` as an
unreviewed generic legacy type. That integration requires its fake-peer regression;
do not simply allow arbitrary notification frames at the generic boundary.

The log-export privacy change is independent: journal format allowlists protect
exported text; this DTO allowlist protects status, including fields that never
appeared in a journal. Neither boundary should rely on searching for secret-shaped
substrings in arbitrary producer text.
