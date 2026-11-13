# Remote persistent notifications

The control socket and the legacy remote socket now reconcile persistent
notifications from the authoritative on-device store after connection. The
legacy path starts only after encoder authentication succeeds. Local delivery
and the existing remote control/authentication protocols remain unchanged.

The cloud envelope is `kind: status`, `type: notification`, with increasing
`seq`. The legacy envelope is `{ notification: { show, remove } }`. A successful
connection sends the current list; subsequent 250 ms reconciliation sends a
complete `show` list when state changes and revisioned removals for previously
sent entries. Disconnected changes coalesce into current state. A reconnect
repeats the list and clears entries removed during the disconnection. Clients
deduplicate by name and revision. There is no event replay or delivery receipt.

Only persistent notification state is added to either transport. The generic
status/config bridge stays unwired. The projection accepts a closed set of
fields and replaces producer text with reviewed category summaries or a generic
local-details notice. It drops translation keys, interpolation parameters,
actions and any extra fields. Names are process-keyed HMAC identifiers, so
embedded device identities never cross the notification boundary. Remote
notices are read-only; local dismissal remains available on the device.

A missing, throwing or backed-up peer cannot affect local broadcasts. The
adapter refuses frames above 64 KiB or sockets with more than 64 KiB already
buffered, retaining only the last accepted snapshot for reconciliation. A
snapshot too large for one frame is withheld until it fits; no unbounded event
queue is created. The advisory timer stops on disconnect and teardown.

A hub must preserve the singular type, cache the current list, fan out removals,
and hydrate a newly subscribing client from that list. A client should treat
reconnection as state reconciliation, fence stale frames by sequence/revision,
and reset its notification state when the device process/session changes (names
and revisions are process-scoped). This change supplies the device-side path;
it does not implement a hub, mobile app, Web Push, OS alerts or acknowledgements.
A closed or suspended phone page still needs a native/background delivery path.

## Español (Latinoamérica)

Las notificaciones persistentes se sincronizan con la conexión de control y con
la conexión remota anterior. Al conectarse se envía la lista actual; los cambios
y las eliminaciones se actualizan cada 250 ms. Al reconectarse se vuelve a
enviar la lista y se eliminan los avisos retirados durante la desconexión.

La vista remota muestra resúmenes seguros. Los mensajes originales, parámetros,
acciones e identificadores privados permanecen en el dispositivo. Para ver los
detalles o descartar un aviso, abra la interfaz local. Una conexión lenta o
caída no detiene la transmisión ni las notificaciones locales.

El servidor remoto debe distribuir los cambios y proporcionar la lista actual a
cada cliente que se conecte. La aplicación debe evitar duplicados y reiniciar
su lista cuando cambie la sesión del dispositivo. Esto no agrega notificaciones
push ni alertas del sistema operativo: una página cerrada o suspendida necesita
una vía de entrega en segundo plano.
