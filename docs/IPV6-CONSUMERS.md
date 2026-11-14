# IPv6 uplinks

IPv6-only carriers can provide a working stream path while IPv4 phone traffic
still needs translation. Interface inventory now retains a preferred global
IPv6 source separately from IPv4. Tentative, failed-DAD, deprecated and link-local
sources are excluded; stable sources precede temporary ones. Address withdrawal
and family changes refresh the bond and connectivity candidates.

The pinned Rust sender supports IPv6 sources. A dual-stack link keeps its IPv4
source for compatibility; an IPv6-only link uses IPv6. An AAAA-only receiver also
selects IPv6 on dual-stack links. Receiver lookup asks the source's preferred
family first. IPv4-only boxes ask for A only. With an IPv6 source, an empty or
failed A answer can fall back to AAAA; a cache hit tries live AAAA only when it
holds no IPv4 address. A validated ENODATA or ENOTFOUND A response is a
fresh empty answer: a bounded AAAA lookup repairs the cache and retires stale
IPv4 in one update only when the AAAA answer contains IPv6 addresses.
Empty answers never create or clear the cache.
Timeouts, SERVFAIL and failed validation retain cached IPv4 without switching
families. A working A answer never waits for AAAA. Cache updates replace records
within the answered family, including an explicitly empty A family, and retain
the other family.
Fresh hostnames are preserved so the sender can resolve a destination for each
source family (including DNS64). Cached fallback prefers a usable IPv4 family, then
IPv6, and selects randomly within that family. With no usable link, start reports
that no network connection is available; a cache with no matching local family
is refused. IPv6 churn on a link retaining IPv4 updates its address snapshot
without triggering an interface topology change, while notifying the running
bond to refresh any IPv6 sources. An IPv4 literal is not
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
IPv6. La consulta usa primero la familia preferida del enlace; una respuesta A
válida no espera la consulta AAAA. Los equipos solo IPv4 consultan únicamente A.
Con una fuente IPv6, si A falla o está vacía se puede intentar AAAA; si se usa
la caché, solo se consulta AAAA en vivo cuando no contiene una dirección IPv4.
Una respuesta A validada ENODATA o ENOTFOUND consulta AAAA con un tiempo
límite y actualiza la caché sin las direcciones IPv4 anteriores en una sola
escritura solo si AAAA contiene direcciones IPv6. Las respuestas vacías no
crean ni borran la caché. Los tiempos de espera,
SERVFAIL y una validación fallida conservan la caché IPv4 sin cambiar de familia.
Cada respuesta actualiza su familia en la caché y conserva la otra. Se conserva
el nombre para que el emisor elija una dirección compatible, incluso con DNS64.
La caché selecciona al azar dentro de la familia compatible. Si no hay enlaces
utilizables, el inicio indica que no hay conexiones de red disponibles. Los
cambios de dirección IPv6 en un enlace que conserva IPv4 actualizan el inventario
sin generar un cambio de topología y notifican al bond activo para actualizar
sus fuentes IPv6.

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

## Draft: stable per-link family selection

The draft selector keeps native IPv4 on dual-stack links. With no native IPv4,
AAAA plus IPv6 uses the native IPv6 source before considering CLAT. An A-only
receiver can use the image's read-only schema-v1 CLAT grant: active service,
fresh `up` snapshot (including one with a diagnostic `last_error`), matching
parent index/allocation, and existing translator TUN are all required. The IPv4 socket binds the TUN while its link identity stays
with the physical parent. Translator interfaces are not independent bond links.

A path remains selected through short flaps: withdraw unavailable sources,
allow ten seconds of sustained loss before choosing another family, and retain
the new family on recovery. A two-second session refresh observes both address
and translation lifecycle. Only path transitions log `Native IPv4`, `Native IPv6`
or `IPv4 via translation`. This is a diagnostic line, not a new UI field.

Mixed A/AAAA hostnames and family changes require
[openstreambox/srtla-send-rs #3](https://github.com/openstreambox/srtla-send-rs/pull/3)
plus [#4](https://github.com/openstreambox/srtla-send-rs/pull/4) at `7b56a4d7`,
or a release containing both. The checked-in netns fixture passes all nine cases
with that stack, each 30/30; 4.1.0 fails the IPv6-to-IPv4 transition, 0/30.
A cached numeric destination supports only its matching source family. Empty IP
reloads also retain the sender's previous pool; publication alone is not socket
retirement. The draft still requires sender review and deployment-specific
listener qualification before mixed-family support is advertised.

Restored streams resolve the receiver before publishing their sources and own the
same two-second timer and source-change subscription as new streams. Status-file
reads are asynchronous and cached; synchronous consumers never run OS commands.
A live A answer can start the IPv4 portion of a mixed bond while AAAA completes;
compatible IPv6 links join on refresh. Publication logs path changes and withdrawals,
while health/preflight reads do not log session transitions.


### Español (Latinoamérica)

El selector conserva IPv4 nativo en enlaces de doble pila. Sin IPv4 nativo,
usa IPv6 directo si el receptor publica AAAA; CLAT queda como alternativa para
receptores IPv4. Solo admite una traducción con servicio activo, estado reciente
`up`, identidad y dirección correctas, y una interfaz TUN existente. Espera diez
segundos de pérdida continua antes de cambiar de familia y no vuelve a la
anterior solo porque reaparezca. El diagnóstico cambia únicamente al cambiar
la ruta. No se añade un campo nuevo a la interfaz de usuario.

La combinación de familias requiere openstreambox/srtla-send-rs #3 más #4
(`7b56a4d7`), o una versión que incluya ambos cambios. Con esa pila, los nueve
casos de la prueba aislada pasan con 30/30 paquetes cada uno; 4.1.0 falla después
del cambio de IPv6 a IPv4 con 0/30. Un estado `up` con un diagnóstico sigue
siendo utilizable; se comprueban también el servicio, la antigüedad y la TUN.

Los streams restaurados resuelven el receptor antes de publicar las fuentes y
usan el mismo temporizador y suscripción que los nuevos. Las lecturas del estado
son asíncronas y usan caché. Una respuesta A en vivo permite iniciar los enlaces
IPv4 sin esperar AAAA; los enlaces IPv6 compatibles se incorporan al actualizar.
El registro de publicación incluye cambios y retiros, sin mensajes de sesión
en las consultas de salud.
