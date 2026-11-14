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
| Wi-Fi | distinguish adapters and saved profiles, connection present/absent | separate process-scoped Wi-Fi/Network/Profile labels; no interface/MAC/radio identity, SSID, profile UUID, BSSID, passwords, nearby scan results, hotspot clients or future identity fields |
| modem | connection, radio technology, signal, roaming | neutral modem label; no SIM/operator/account/APN/config, serial, interface, device or USB path |
| netif | enabled and throughput metrics | neutral Link labels; no IP, subnet, hardware markers, operator information or error text |
| status config | bitrate, latency, delay, overlay, FEC, autostart; typed DHCP/roaming/slot/band acknowledgements | every other field, including stream ID, passphrase, relay account/host, custom provider, pairing/device identity, SSH credentials, source paths |
| sensors | fixed SoC numeric text | all other keys/text withheld; numeric system metrics remain on device-stats |
| device-stats | CPU load, temperature, total/available memory | paths, interface keys and free-text slot information withheld |
| link telemetry | measured rate, bytes, freshness, RTT/NAK/weight and per-link numeric metrics | device IDs, interface names, serials, physical port names replaced/withheld |
| buffering/engine bitrate | counters, active/disk-warning flags, applied and ceiling bitrate; null retractions | unknown fields withheld |
| active profile | published preset enum, latency, FEC, recovery enum | unknown fields withheld; invalid presets are absent rather than invented |
| pipelines, sources, relays, acodecs | schema-valid empty lists/maps, closed hardware platform (`jetson`/`rk3588`/`n100`/`generic`) and the shared codec catalog | detailed identities withheld; cloud pipeline command has a separate DTO |
| revisions, encoder-load, fan, cpu, bluetooth and other legacy/direct reply types | none | withheld |
| notification(s) | separate bounded, fixed-text projection | unstructured notifications are withheld; see integration below |

All numbers must be finite numbers, flags must be booleans and forwarded strings
must belong to a closed enum. Keys containing identities are never copied.
Identifiers cannot become safe by moving into an unrelated or future field.
Adapter and saved-network counters are separate. Interface labels are allocated
by interface name, never link position, and persist across reconnects. Display
numbers deliberately restart at 1 on reboot, so deterministic enumeration can
repeat them; they are not claimed to prevent cross-session correlation. Bond row
keys use a separate random per-process HMAC key for each transport/legacy endpoint.
They change on restart, remain stable across reorder and never disclose connection or physical identity.
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
Batched telemetry is a status frame on this same relay, with numeric samples
and neutral link IDs. Hello and authentication remain separate. Command results
use command-specific DTOs: enum pipeline IDs and capabilities, safe config enums,
numeric controls and source/relay presence flags; unknown-only pipeline lists
return `ok:false, error:withheld` rather than an empty success. The strict parser
checks the envelope, not every status payload; published RPC schemas are checked
separately in regression tests. Protocol rejection logs once per process.

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
Its cloud sender continues using the dedicated validated channel. The legacy
wrapper accepts only its exact full-replacement wire format: UUID epoch,
`full: true`, 64-hex opaque names, bounded revisions, fixed summaries and fixed
notice flags. Unknown keys, text, actions and names are rejected. The overflow
summary accepts only the producer's numeric-count sentence. No raw sender bypass
is exposed. A trial merge must retain the legacy fake-peer regression.

The log-export privacy change is independent: journal format allowlists protect
exported text; this DTO allowlist protects status, including fields that never
appeared in a journal. Neither boundary should rely on searching for secret-shaped
substrings in arbitrary producer text.

## Reduced helper diagnostics

`status.remote_diagnostics` publishes audio presence, SSH active/enabled/password-set
flags, update availability/activity and a closed update-state enum. Bond mapping
keeps its state/disposition/source/reason and drops collision addresses. Netif
retains only the fixed `policy_route_missing` warning. Pipeline/source/relay
legacy snapshots carry schema-valid empty collections; the
audio-codec snapshot carries only the fixed published codec catalog. Sensor text
accepts fixed SoC keys and numeric formats, with an unavailable temperature
sentinel when absent. Device statistics use null for withheld required fields.
Unknown fields remain withheld.
Empty legacy projections are not transmitted. Labels are display-only.

Regression coverage includes two-link schema validation, reorder stability,
interface replacement collisions, telemetry strict frames, command DTOs and
exact notification rejection. Hardware, a hosted hub and browser E2E remain
unqualified.

## Projection regressions

Bond row keys derive from the producer connection ID, preserving distinct rows
when connections share an interface or physical link. Keys are random per process
and transport; each legacy endpoint has its own key, stable across reconnects.
Display labels remain process-wide and are not unique device identities.
Command pipeline IDs share the registry's runtime catalog; control enums come
from the published RPC schemas, including Decklink and auto/force/off passthrough.

Every emitted type has payload or protocol schema coverage. The frontend test
ingests the projected initial lists through real subscriptions and mounts Live.
The notification integration test is explicitly skipped without the independent relay; it compares both complete summary catalogs when
the independently delivered relay is present, then validates every summary.
DTO-rejected legacy payloads increment a process-local counter; intentionally withheld types and the base unrevisioned notification format do not. The socket warns
once without recording content. Callback completion still means local processing,
not remote delivery. The counter is diagnostic and is not a delivery receipt.

Malformed connection rows use a separate index-fallback HMAC namespace. Telemetry retains the closed `identity_state: unmappable` flag. The unused top-level policy-route diagnostic is omitted; the producer-owned netif warning remains. Failed command acknowledgements retain their existing error envelope but always clear `applied`.

Hotspot roster changes retain their measured client count in remote status.
Station rows are empty on remote transports; MAC addresses and radio lifetime
tokens stay local. A client block is omitted until a valid roster was observed,
so an unknown count is distinct from a measured zero.
