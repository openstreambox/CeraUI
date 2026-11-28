# Home on a box without an encoder

On an image configured with `engine: none`, the first tab is Home. It follows
client upload traffic through the box: Upload seen through the box,
Box ready, or Checking whether a device is sending through the box. The box
checks for active input sessions and sustained incoming traffic from connected
devices. A slow upload may go undetected. After the last detected activity, the
indication stays on for about 2 minutes. These are observations of the box only; they don't say which link carries
a stream or what happens off the box. Check the stream itself.

Connect a device offers Moblin, IRL Pro, another SRT app, or Just internet.
For SRT, configure the listener and an SRTLA receiver first. The screen copies
the configured listener address and passphrase; it never invents credentials.
The wide layout shows Wi-Fi and address QR codes (the Wi-Fi code behind Show
code, see below), except on the box's own touch screen. Copy is available in
every layout. Passwords have no plain-text QR and should be kept off camera and out of screenshots.

Moblin: copy the password from Moblin Settings › Moblink › Password into the
device. A local device operator can save, replace or clear it only while the
device confirms it is idle. It is never displayed again. Saving does not confirm a
connection: check Moblin and the stream itself. If Moblin's password changes,
replace the device's copy too. One password applies to this device; any local
Moblin streamer with that password may authenticate. Clearing stops the
relay managed by this device.
Saving requires an image provisioned for the managed relay. Clear remains
available while idle even if that relay is unavailable or storage needs repair.
Clearing an unsaved password does not create storage. The field asks browsers
and password managers not to fill or save it; their own policies still apply.
If a saved credential is empty or the relay stops unexpectedly, Box health
shows a calm Moblin connection line. Replace or clear the password to recover.

When the box next starts carrying, it remembers only the chosen way (`moblin`, `srt`, `internet`) in
`/data/phone-way.json`. Development uses a checkout-local file. No device identity
is kept. The way is recorded only if chosen in this open page before carrying begins; it is not a source identity. Choosing another app changes these instructions and the remembered
choice for the next carrying session; it does not reroute an active stream.

Box health names the links whose internet probes are current. Details describe
failed parts. Restart is unavailable while carrying or checking; confirmation
names the interruption cost. During the 120-second startup check, power-off is allowed after a confirmation that any stream through the box drops. Restart remains held. An encoder image keeps its existing Live screen.
Per-link sending figures are deliberately withheld without client-session
telemetry; current internet probes remain visible instead.

### The box's Wi-Fi code

The Wi-Fi QR code is hidden until you press **Show code**, here and in the
hotspot settings. While it is shown, keep it off camera. It hides itself after
2 minutes, when the page loses focus, when the password changes and when a new
device joins. The password as text stays behind its own Copy (or the eye
button in the hotspot settings).

When a device the page has not seen before joins the box's Wi-Fi, the app says
"A new device joined". Next to the Wi-Fi code that line offers **Not mine?**;
elsewhere it is a short toast. A device still typing the password does not
count: only a finished join does.

**New Wi-Fi password** makes a new random password for the running hotspot. The
hotspot has one password, so every device on it drops and has to join again with
the new code. The box asks first and says so; if a device may be streaming
through the box, it also says that stream drops.

## Inicio para una caja sin codificador

En una imagen con `engine: none`, la primera pestaña es Inicio. Indica si la caja
ha detectado actividad reciente de algún dispositivo, si está preparada o si
todavía lo está comprobando. La caja comprueba si hay sesiones de entrada
activas o tráfico entrante sostenido de los dispositivos conectados. Es posible
que no detecte una subida lenta. El aviso permanece unos 2 minutos después de la
última actividad detectada. Solo describe lo
que observa la caja; comprueba la emisión directamente.

La conexión ofrece Moblin, IRL Pro, otra aplicación SRT o solo internet. SRT usa
la dirección y la contraseña configuradas en la caja. Los códigos QR de Wi-Fi y
de la dirección aparecen en la vista ancha, excepto en la pantalla táctil de la
caja. Copiar está disponible en todas las vistas.
Mantén las contraseñas fuera de cámara. Sin el relé administrado, el dispositivo
muestra esa limitación y ofrece solo internet.

Moblin: copia la contraseña de Ajustes › Moblink › Contraseña de Moblin en el
dispositivo. Un operador local autenticado puede guardarla, reemplazarla o borrarla
cuando el dispositivo confirme que no transporta una transmisión. Nunca se vuelve a
mostrar. Guardarla no confirma la conexión: comprueba Moblin y la transmisión.
Si cambia en Moblin, reemplázala también en el dispositivo. La contraseña se aplica a
este dispositivo; cualquier emisor Moblin local que la comparta puede autenticarse.
Borrarla detiene el relé de este dispositivo. Guardarla requiere una imagen preparada
para el relé administrado. Borrar sigue disponible cuando el dispositivo está inactivo,
aunque el relé no esté disponible o haya que reparar el archivo guardado.
Si el archivo está vacío o el relé se detiene inesperadamente, la sección Estado de la caja
muestra un aviso de conexión Moblin. Reemplaza o borra la contraseña para recuperarla.
Borrar una contraseña no guardada no crea almacenamiento. El campo pide al
navegador y al gestor de contraseñas que no lo rellenen ni guarden; sus propias
políticas siguen aplicándose.

Solo se recuerda la opción elegida; no se guarda la identidad del dispositivo.
El reinicio permanece desactivado mientras la caja transporta tráfico o lo
comprueba. Durante la comprobación inicial de 120 segundos, se permite apagar tras confirmar que se corta cualquier emisión que pase por la caja; reiniciar sigue bloqueado. Las cajas con codificador conservan su vista Live.

### El código Wi-Fi de la caja

El código QR del Wi-Fi está oculto hasta que pulsas **Mostrar código**, aquí y en
los ajustes del punto de acceso. Mientras se ve, mantenlo fuera de cámara. Se
oculta solo después de 2 minutos, cuando la página pierde el foco, cuando cambia
la contraseña y cuando se une un dispositivo nuevo. La contraseña como texto
sigue detrás de su propio botón Copiar (o del ojo en los ajustes del punto de
acceso).

Cuando un dispositivo que la página no había visto se une al Wi-Fi de la caja, la
app avisa "Se unió un dispositivo nuevo". Junto al código Wi-Fi ese aviso ofrece
**¿No es tuyo?**; en otras pantallas es un aviso breve. Un dispositivo que aún
está escribiendo la contraseña no cuenta: solo una conexión terminada.

**Nueva contraseña de Wi-Fi** crea una contraseña aleatoria nueva para el punto
de acceso activo. Tiene una sola contraseña, así que todos los dispositivos se
desconectan y tienen que volver a unirse con el código nuevo. La caja lo
pregunta antes y lo dice; si un dispositivo puede estar emitiendo a través de la
caja, también avisa de que esa emisión se corta.

## Integration contract

The additive local status fields are `phone_box` and `box_health` (typed part
and first-failure epoch). SRT listener credentials are available only through the
authenticated `system.getPhoneBox` RPC. Moblin credentials use the local-only,
write-only `moblink` procedures; see [the ownership contract](../MOBLINK-CREDENTIAL.md). `system.setPhoneWay` accepts only the
three-valued enum. Phone-only remote status is an allowlist of role, carrying
state, anonymous link counts (`phone_links`, with `sending: null` until known) and typed health entries; local Wi-Fi names, addresses and passwords are
not relayed. Backend engine identity applies this projection to every remote frame, including partial status updates; other frame types are withheld on phone-only boxes. The localized helper lines explicitly ask moderators
to check the stream itself. All ten locales carry the Home copy; a native
read of the non-English wording is still welcome. The copy names no device type
(the page runs on phones, tablets, computers and the box's own screen, and the
carrying check measures client uplink traffic, not the viewing device); the
keys keep their `live.phone` prefix.

The presentation state mapping and QR policy live in `phone-home.ts`. User-facing
copy lives under `live.phone` in all ten catalogs. The ready-state reminder uses
the remembered choice, never an inferred device identity or a parallel timer.

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

Mientras la caja comprueba el tráfico, solo se puede apagar durante la comprobación inicial de 120 segundos que confirma el equipo. Si después se desconoce el tráfico, se bloquean tanto reiniciar como apagar, incluso en una confirmación abierta. Si falta esa confirmación inicial, apagar también queda bloqueado.

Initial connections and reconnect status pulls include the backend startup permission, so opening Home midway through the window preserves confirmed power-off. After expiry, the blocked reason names both restart and power off.

La conexión inicial y las consultas de estado al reconectar incluyen el permiso inicial del equipo. Abrir Inicio durante ese periodo conserva el apagado con confirmación. Al terminar, el motivo del bloqueo menciona reiniciar y apagar.

The Moblin choice reflects relay availability. Clear remains available for storage recovery even when no relay or valid password exists; success states that no password is saved, without claiming a stream stopped.

La opción Moblin refleja la disponibilidad del retransmisor. Borrar sigue disponible para recuperar el almacenamiento aunque no haya retransmisor ni contraseña válida; el resultado indica que no queda una contraseña guardada, sin afirmar que se detuvo una emisión.
