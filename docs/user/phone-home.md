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

Moblin: copy the password from Moblin Settings › Moblink › Password into the
box. A local device operator can save, replace or clear it only while the box
confirms idle. It is never displayed again. Saving does not confirm a connection:
check Moblin and the stream itself. If Moblin's password changes, replace the
box's copy too. One password applies to this box; any local Moblin streamer with
that password may authenticate. Clearing stops this box's owned relay.
Saving requires an image provisioned for the managed relay. Clear remains
available while idle even if that relay is unavailable or storage needs repair.
Clearing an unsaved password does not create storage. The field asks browsers
and password managers not to fill or save it; their own policies still apply.
If a saved credential is empty or the relay stops unexpectedly, Box health
shows a calm Moblin connection line. Replace or clear the password to recover.

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
Mantén las contraseñas fuera de cámara. Sin el relé administrado, la caja
muestra esa limitación y ofrece solo internet.

Moblin: copia la contraseña de Ajustes › Moblink › Contraseña de Moblin en la
caja. Un operador local autenticado puede guardarla, reemplazarla o borrarla
cuando la caja confirme que no transporta una transmisión. Nunca se vuelve a
mostrar. Guardarla no confirma la conexión: comprueba Moblin y la transmisión.
Si cambia en Moblin, reemplázala también en la caja. La contraseña se aplica a
esta caja; cualquier emisor Moblin local que la comparta puede autenticarse.
Borrarla detiene el relé de esta caja. Guardarla requiere una imagen preparada
para el relé administrado. Borrar sigue disponible cuando la caja está inactiva,
aunque el relé no esté disponible o haya que reparar el archivo guardado.
Si el archivo está vacío o el relé se detiene inesperadamente, Estado de la caja
muestra un aviso de conexión Moblin. Reemplaza o borra la contraseña para recuperarla.
Borrar una contraseña no guardada no crea almacenamiento. El campo pide al
navegador y al gestor de contraseñas que no lo rellenen ni guarden; sus propias
políticas siguen aplicándose.

Solo se recuerda la opción elegida; no se guarda la identidad del teléfono.
El reinicio permanece desactivado mientras la caja transporta tráfico o lo
comprueba. Durante la comprobación inicial de 120 segundos, se permite apagar tras confirmar que se corta cualquier emisión que pase por la caja; reiniciar sigue bloqueado. Las cajas con codificador conservan su vista Live.

## Integration contract

The additive local status fields are `phone_box` and `box_health` (typed part
and first-failure epoch). SRT listener credentials are available only through the
authenticated `system.getPhoneBox` RPC. Moblin credentials use the local-only,
write-only `moblink` procedures; see [the ownership contract](../MOBLINK-CREDENTIAL.md). `system.setPhoneWay` accepts only the
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
