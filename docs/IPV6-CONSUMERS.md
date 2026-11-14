# IPv6 uplinks

IPv6-only carriers can provide a working stream path while IPv4 phone traffic
still needs translation. Interface inventory now retains a preferred global
IPv6 source separately from IPv4. Tentative, failed-DAD, deprecated and link-local
sources are excluded; stable sources precede temporary ones. Address withdrawal
and family changes refresh the bond and connectivity candidates.

The pinned Rust sender supports IPv6 sources. A dual-stack link keeps its IPv4
source for compatibility; an IPv6-only link uses IPv6. An AAAA-only receiver also
selects IPv6 on dual-stack links. Receiver lookup asks A and AAAA together; fresh
hostnames are preserved so the sender can resolve a destination for each source
family (including DNS64). Cached fallback prefers a usable IPv4 family, then
IPv6, and refuses a cache with no matching local family. An IPv4 literal is not
converted to NAT64: use a DNS64 hostname or an IPv6 receiver on IPv6-only links.
Older IPv4-only senders and receivers do not gain native IPv6 support.

Hotspot IPv4 routing remains IPv4-specific. The sharing surface explains each
IPv6-only WAN calmly: “Devices on the box's Wi-Fi can't reach IPv4 sites through
this link yet.” Other IPv4 links remain available to sharing. The notice does
not gate, diagnose or change streaming. There is no translator or CLAT policy
in this change. Once per-link CLAT exists, those links get IPv4 too; native IPv6
can avoid the translation hop.

## Español (Latinoamérica)

Un enlace solo IPv6 puede transportar el stream aunque el tráfico IPv4 de los
teléfonos todavía necesite traducción. El inventario conserva por separado las
direcciones IPv4 e IPv6 globales utilizables. Los enlaces de doble pila prefieren
IPv4 por compatibilidad; los enlaces solo IPv6 y los receptores solo AAAA usan
IPv6. La consulta del receptor incluye A y AAAA y conserva el nombre para que el
emisor elija una dirección compatible, incluso con DNS64.

El panel de conexiones compartidas indica: «Los dispositivos conectados al Wi-Fi
del equipo todavía no pueden acceder a sitios IPv4 a través de este enlace».
Los demás enlaces IPv4 siguen disponibles. Este aviso no indica que el stream
esté caído. No se implementa traducción ni una política CLAT. Con CLAT por enlace,
estos enlaces también tendrán IPv4; IPv6 nativo puede evitar la traducción.

## Qualification and remaining work

See the contained transport fixture under
`apps/backend/src/tests/fixtures/ipv6-consumers/`. Native IPv6 client sharing
(RA/prefix delegation and firewall), per-family source policy routes, scoped
link-local gateways, simultaneous multi-modem/family-loss failover, cloud cached
reconnect/replay, external add-on transport, time sync and live repository TLS
qualification remain separate work. Local LAN ingest deliberately keeps IPv4
address discovery and URL construction together; it has not been extended to
IPv6. Resolver validation keeps its existing security check. No modem profile,
IP-family default, reconnect policy or NetworkManager setting changes here.
