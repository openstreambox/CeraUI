# Receiver paths on the Links screen

When the device reports paths, each reported eligible link has one quiet line and a “Details” disclosure. The line describes the selected source path, independently of receiver delivery or overall broadcast health. It never changes the stream controls or raises an alert.

- **Native IPv6:** a native IPv6 source and receiver IPv6 address were selected.
- **IPv4:** a native IPv4 source and receiver IPv4 address were selected.
- **IPv4 through translation (CLAT):** an IPv6 link uses a validated IPv4 translator for the IPv4 receiver.
- **Unused: receiver address in use is IPv4; translation unavailable:** the IPv6-only link has no usable translator for the receiver's IPv4 address.

Waiting, incompatible, explicitly unknown and stale selections have their own lines and explanations. An IPv6-only eligible link remains visible. These are source-selection facts, not a guarantee that the receiver has accepted packets. Family changes use the existing selector's withdrawal, grace period and session stickiness.

## Wire and freshness

`status.link_paths` is an optional, complete map from physical interface name to the shared `LinkPathStatus` enum. Inventory reads used for health checks do not publish or resurrect session selections. The map is published on change and included in both authentication snapshots and status RPC snapshots. `{}` retracts all selections; a removed key retracts that link. Older backends leave it absent. The translator TUN stays internal and is omitted from the operator inventory; its physical parent owns the path. The UI joins by interface identity and marks the paths as out of date when the device connection is lost. It never derives a path from an address string or telemetry rate.

The read-only CLAT consumer uses image schema v1. Admission requires the matching physical interface/index and allocated IPv4/TUN name, `up`, no last error, a recent timestamp, an active service and an existing TUN. A JSON file alone is insufficient. The fixture in `apps/backend/src/modules/streaming/fixtures/clat-status-v1.json` exercises this boundary; no image service is controlled by the UI.

Absent or retracted path maps add no line while idle or with an older backend. The `no-source` value remains reserved in the shared schema to keep its wire contract stable; current bond admission and the Links inventory filter those links out, so the current producer cannot emit it. Unknown means an explicitly reported unknown selection, rather than an absent report.

Cached DNS can select a single IPv4 receiver address even when the cache also contains IPv6. The unused-link reason describes the address in use, not all addresses the receiver may have.

## Español (Latinoamérica)

Cuando el dispositivo informa de rutas, cada enlace indicado muestra una línea discreta y la opción «Detalles». Puede indicar «IPv6 nativo», «IPv4», «IPv4 mediante traducción (CLAT)» o «Sin usar: la dirección del receptor en uso es IPv4 y no hay traducción disponible». Los estados de espera, incompatibilidad e información desconocida o desactualizada tienen textos propios. La línea describe la selección de direcciones de este enlace; no confirma la entrega ni determina el estado de toda la transmisión. No genera alertas ni cambia los controles.

Los mapas de rutas ausentes o vacíos no añaden texto en reposo ni con versiones anteriores del dispositivo. El motivo de enlace sin usar describe la dirección del receptor en uso, incluso si la caché DNS también contiene una dirección IPv6.
