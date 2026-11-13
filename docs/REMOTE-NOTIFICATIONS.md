# Remote persistent notifications

The control socket and the legacy remote socket now reconcile persistent
notifications from the authoritative on-device store after connection. The
legacy path starts only after encoder authentication succeeds. Local delivery
and the existing remote control/authentication protocols remain unchanged.

The cloud envelope is `kind: status`, `type: notifications` (the plural that
the pinned `@ceralive/control-protocol` status-type set requires; its
`strictParseFrame` rejects the singular), with `seq` increasing per process.
Local broadcasts keep their own event name, `notification`; that name is not a
wire type. The legacy envelope is `{ notification: { … } }`. Both carry the same
payload:

```json
{ "show": [...], "remove": [{ "id": "…", "revision": 7 }],
  "epoch": "<per-process UUID>", "full": true }
```

`show` is always the complete current list, so every frame is a full replace
(`full: true`). `remove` also names entries this process sent earlier and has
since cleared. `epoch` changes when the backend restarts. Names, revisions,
`seq` and the record of what was sent are all scoped to it, so a consumer resets
its seq fence and drops older notices when the epoch changes, instead of merging
the new list into the old one. The protocol strips unknown envelope fields, so
the epoch rides in the payload.

A successful connection sends the current list. After that, a 250 ms
reconciliation sends a frame when the projected content changes (the set of
notices, or a notice's severity or summary); a producer re-raising the same
condition bumps its local revision but does not re-send the list. Changes made
while disconnected coalesce into the current state. A reconnect repeats the
list. There is no event replay or delivery receipt. The cloud path writes
through the control channel's `sendFrame`; both paths refuse a frame when more
than 64 KiB is already buffered.

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

A hub must route the `notifications` status type, keep the latest list per
device, replace (not merge) on each frame, and hydrate a newly subscribing
client from that list. A client fences stale frames by `seq` within one epoch and
treats a new epoch as a fresh device session. The CeraUI client applies `full`
frames by replacing its persistent notices. The pinned protocol has no typed
payload for this status type and no device-session field, so `epoch` and `full`
are conventions inside the open payload, not part of the shared contract yet.
Remote summaries are English only: they are fixed device-side strings, not
translation catalogue keys. This change supplies the device-side path; it does
not implement a hub, mobile app, Web Push, OS alerts or acknowledgements. A
closed or suspended phone page still needs a native/background delivery path.

## Español (Latinoamérica)

Las notificaciones persistentes se sincronizan con la conexión de control y con
la conexión remota anterior. Al conectarse se envía la lista actual; los cambios
y las eliminaciones se actualizan cada 250 ms. Al reconectarse se vuelve a
enviar la lista y se eliminan los avisos retirados durante la desconexión.

La vista remota muestra resúmenes seguros. Los mensajes originales, parámetros,
acciones e identificadores privados permanecen en el dispositivo. Para ver los
detalles o descartar un aviso, abra la interfaz local. Una conexión lenta o
caída no detiene la transmisión ni las notificaciones locales.

Cada envío contiene la lista completa (`full: true`) y un identificador de
proceso (`epoch`) que cambia al reiniciar el equipo. El servidor remoto debe
reemplazar la lista guardada con cada envío y proporcionarla a cada cliente que
se conecte. La aplicación reinicia su lista cuando cambia `epoch`. Los
resúmenes remotos solo están en inglés. Esto no agrega notificaciones
push ni alertas del sistema operativo: una página cerrada o suspendida necesita
una vía de entrega en segundo plano.
