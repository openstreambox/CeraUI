# Phone-only Home

On an image configured with `engine: none`, the first tab is Home. It follows
client traffic through the box: Carrying your phone's stream, Ready for your
phone, or Checking whether your phone uses the box. These are observations of
the box, not promises about what viewers see. Check the stream itself.

Connect your phone offers Moblin, IRL Pro, another SRT app, or Just internet.
For SRT, configure the listener and an SRTLA receiver first. The screen copies
the configured listener address and passphrase; it never invents credentials.
Computer screens offer Wi-Fi and address QR codes. Phone and touch layouts use
Copy. Passwords have no plain-text QR and should be kept off camera and out of screenshots.

Moblin's password goes from Moblin to its relay. This build does not supply a
Moblink relay service or a credential-writing endpoint for one. The Moblin path
says so and offers Just internet. It never claims that an unavailable relay is
connected. The relay integration must supply that owner before enabling the
password field.

When the box next starts carrying, it remembers only the chosen way (`moblin`, `srt`, `internet`) in
`/data/phone-way.json`. Development uses a checkout-local file. No phone identity
is kept. The way is recorded only if chosen in this open page before carrying begins; it is not a source identity. Choosing another app changes these instructions and the remembered
choice for the next carrying session; it does not reroute an active stream.

Box health names the links whose internet probes are current. Details describe
failed parts. Restart is unavailable while carrying or checking; confirmation
names the interruption cost. During the 120-second startup check, power-off is allowed after a confirmation that any phone stream through the box drops. Restart remains held. An encoder image keeps its existing Live screen.
Per-link sending figures are deliberately withheld without phone-session
telemetry; current internet probes remain visible instead.

## Inicio para una caja sin codificador

En una imagen con `engine: none`, la primera pestaña es Inicio. Indica si el
tráfico del teléfono pasa por la caja, si está preparada o si todavía lo está
comprobando. Esto no confirma lo que ven los espectadores: comprueba la emisión.

La conexión ofrece Moblin, IRL Pro, otra aplicación SRT o solo internet. SRT usa
la dirección y la contraseña configuradas en la caja. Los códigos QR de Wi-Fi y
de la dirección solo aparecen en pantallas de ordenador; el teléfono usa Copiar.
Mantén las contraseñas fuera de cámara. Este borrador no incluye el servicio
Moblink: muestra esa limitación y ofrece solo internet.

Solo se recuerda la opción elegida; no se guarda la identidad del teléfono.
El reinicio permanece desactivado mientras la caja transporta tráfico o lo
comprueba. Durante la comprobación inicial de 120 segundos, se permite apagar tras confirmar que se corta cualquier emisión que pase por la caja; reiniciar sigue bloqueado. Las cajas con codificador conservan su vista Live.

## Integration contract

The additive local status fields are `phone_box` and `box_health` (typed part
and first-failure epoch). Connection credentials are available only through the
authenticated `system.getPhoneBox` RPC. `system.setPhoneWay` accepts only the
three-valued enum. Phone-only remote status is an allowlist of role, carrying
state, anonymous link counts (`phone_links`, with `sending: null` until known) and typed health entries; local Wi-Fi names, addresses and passwords are
not relayed. Backend engine identity applies this projection to every remote frame, including partial status updates; other frame types are withheld on phone-only boxes. The localized helper lines explicitly ask moderators
to check the stream itself. New non-English strings carry `[EN]` until translated.

The presentation state mapping and QR policy live in `phone-home.ts`. User-facing
copy lives under `live.phone` in all ten catalogs. The ready-state reminder uses
the remembered choice, never an inferred phone identity or a parallel timer.

The forwarding implementation publishes carrying changes after connection.
These screens consume the shared subscription store; they do not poll or replace
unknown with a client-side timer. The backend owns the startup checking window.
Browser and ingestion tests exercise partial status changes without rewriting
WebSocket frames.

Home follows carrying changes from the shared status subscription, including
forwarding and unknown states. The SRT app instructions use the listener's
persisted generated passphrase (or the explicitly configured passphrase).
No separate phone credential is created.

Home sigue los cambios de tráfico de la suscripción de estado compartida,
incluidos el reenvío y el estado desconocido. Las instrucciones SRT usan la
contraseña generada y persistida del receptor, o la configurada explícitamente.

Power off is available during Checking only while the box reports its initial 120-second startup check. Later unknown traffic holds both restart and power off, including an already-open confirmation. Missing startup evidence also holds power off.

Apagar solo está disponible durante la comprobación inicial de 120 segundos que confirma el equipo. Si después se desconoce el tráfico, se bloquean tanto reiniciar como apagar, incluso en una confirmación abierta. Si falta esa confirmación inicial, apagar también queda bloqueado.

Initial connections and reconnect status pulls include the backend startup permission, so opening Home midway through the window preserves confirmed power-off. After expiry, the blocked reason names both restart and power off.

La conexión inicial y las consultas de estado al reconectar incluyen el permiso inicial del equipo. Abrir Inicio durante ese periodo conserva el apagado con confirmación. Al terminar, el motivo del bloqueo menciona reiniciar y apagar.
