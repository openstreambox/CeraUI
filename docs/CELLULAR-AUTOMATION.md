# Automatic cellular profiles

## English

For an existing automatic profile on an admitted modem/firmware transport,
recognized subscription evidence selects a stored APN. The IP family request is
the one the box already uses for that SIM (IPv4v6 on carriers known to be
IPv6-only, otherwise the IPv4 request it always made). The cellular
poll owner applies it under the modem lifecycle lease and a durable inverse
journal. It verifies the settings after the write. Manual profiles, unknown
subscriptions, unqualified carriers and unknown transport firmware are preserved.
The profile must match both device and SIM; an operator-only match is insufficient.

Automatic intent is stored privately for the exact profile, device and SIM,
separately from NetworkManager's `gsm.auto-config` switch. NetworkManager must
turn that switch off to use the selected APN. A manual save explicitly retires
automatic intent, even when it keeps the same APN. An out-of-band custom APN
that conflicts with the last applied automatic APN is preserved. Unreadable
intent defers reconciliation. Carrier selection always uses fresh subscription
evidence; the saved APN is only a conflict check.

Automatic intent and modem preparation decisions use the persistent data store.
Before default access can treat a record as absent, it checks and migrates the
older OS-slot record. The original remains intact; a durable migration receipt
prevents later updates or deletion from reviving that old baseline. Conflicting,
changed or unreadable authority defers work. A spent EPS attempt remains spent.
Startup inventories all retained pairs, including absent SIMs. Damaged state
keeps the existing recovery wait active until a complete check succeeds.

This changes stored settings for the next activation. It does not disconnect an
active bearer or initiate another call. IPv6 contributes no main default route.
A failed write is restored and verified; an inverse that cannot
be verified leaves the existing mutation block in place. Recovery checks the
current physical identity and SIM before touching the saved profile.

New profiles are created as before, when a modem registers, bound to its
device and SIM.

For admitted RM520 firmware, preparation records and reads back QMAP settings
per physical unit and USB generation. It records the original initial-EPS
settings and spends at most one alignment attempt per equipment/SIM pair before
sending a setter, including a setter that fails. A fresh generation must verify
the result. Failure retains a blocked state and private baseline. Raw-IP setup
requires withdrawn global addresses and precedes the host call. An expected USB
return has a bounded wait; it does not launch repeated resets. Serial endpoints
are rediscovered by USB interface. The inhibition session is revoked if the
service owner changes or its bus connection is lost. Preparation can reset a
module, so it waits through stream starts as well as running streams. A start
before the reset rewinds the QMAP/EPS record to its baseline phase, leaving the EPS attempt
available for the next idle poll. A rejected setter or failed reset still blocks
preparation for explicit recovery.

A profile that preparation takes over is disarmed in NetworkManager first;
CeraUI admits its explicit activation once preparation is done. Manual saves release the original
autoconnect choice (or enable a newly created manual profile). Interrupted
firmware preparation is held for explicit recovery rather than claiming an
unverified restoration. This has host/fixture evidence only.

### RM520N-GL at USB 2

The RM520N-GL raises its own receiver's noise floor when its USB 3 link is
active: on a US bench one carrier never registered at USB 3 and always did at
USB 2, and another carrier's signal-to-noise improved by about 14 dB. Its
transport entry therefore asks for `AT+QCFG="usbspeed","20"`, for any SIM and in
any modem state, before any carrier-dependent step.

- The read is the USB link speed in sysfs. At 480 Mbit/s or slower nothing is
  done: no inhibition and no AT command.
- At a faster link, and only while no stream runs, CeraUI inhibits that one modem,
  reads the stored value, records it as the original and the attempt before any
  setter, writes `"20"` if it differs, reads it back (a mismatch stops before the
  reset) and resets the module. The stream check runs again after the inhibition.
- The link is gone for about 50 seconds. One modem is switched at a time.
- The next USB enumeration verifies it at 480 Mbit/s or slower. Two attempts per
  unit, 15 minutes apart; then the unit is held until its record is removed.
- `/etc/ceralive/no-usbspeed` stops every write; the decision is still logged.

This is a partial implementation. It does not establish
an RNDIS owner, CLAT,
traffic health or carrier/hardware qualification. Existing or synthetic test
results do not establish those capabilities. Verizon remains unqualified.

### IPv6-only carriers (IPv4 translation)

Some carriers, T-Mobile US among them, give the modem IPv6 only. The image's
CLAT service then gives that link an IPv4 address on a translator interface
(`clat<N>`). CeraUI adds that interface to the bond while the service reports it
working (a fresh snapshot, the translator and the modem interface present, the
service running) and takes it out as soon as it doesn't. The modem's own bond
switch also covers its translated link. CeraUI does not run or configure the
translator itself.

## Español (Latinoamérica)

Un perfil automático existente puede recibir un APN cuando la suscripción se
reconoce y el transporte del módem y su firmware están admitidos. La familia IP
que solicita es la que el equipo ya usa para esa SIM (IPv4v6 en operadores que
solo ofrecen IPv6; si no, la solicitud IPv4 de siempre). El proceso
celular actualiza los ajustes guardados con exclusión de mutaciones y un registro
persistente para restaurarlos. Después verifica los valores escritos. Conserva
los perfiles manuales, las suscripciones desconocidas, los operadores sin
calificar y el firmware no admitido. El perfil debe coincidir con el dispositivo
y con la SIM; coincidir solo con el operador no basta.

El modo automático se guarda de forma privada para el perfil, el dispositivo y
la SIM, por separado de `gsm.auto-config` de NetworkManager. Ese ajuste debe
desactivarse para usar el APN seleccionado. Guardar un perfil manual retira el
modo automático incluso si mantiene el mismo APN. Un APN personalizado cambiado
por otra herramienta se conserva si difiere del último APN automático aplicado.
Si el registro privado no se puede leer, la actualización se aplaza. El APN
guardado nunca identifica al operador; se usan datos actuales de la suscripción.

El modo automático y las decisiones de preparación del módem se guardan en el
almacenamiento persistente de datos. Antes de considerar ausente un registro, el
acceso predeterminado comprueba y migra el registro de la partición anterior del
sistema. Conserva el original y registra la migración de forma duradera para que
un cambio o una eliminación posterior no reactive los ajustes antiguos. Un
conflicto, cambio o error de lectura aplaza el trabajo. Un intento EPS ya usado
no se vuelve a habilitar.
Al iniciar se revisan todos los pares guardados, incluso las SIM ausentes. Un
registro dañado mantiene la espera de recuperación hasta completar la revisión.

El cambio se aplica en la siguiente activación. No desconecta una conexión activa
ni inicia otra llamada de datos. IPv6 no agrega una ruta predeterminada al
sistema. Si una escritura falla, se restauran y verifican los
ajustes anteriores. Si la restauración no se puede verificar, el dispositivo
permanece bloqueado para nuevas mutaciones. La recuperación comprueba la identidad
física y la SIM antes de cambiar el perfil guardado.

Los perfiles nuevos se crean como antes, cuando un módem se registra, ligados a
su dispositivo y su SIM.

En el firmware RM520 admitido, se guardan y verifican los ajustes QMAP por unidad
y generación USB. Se conservan los ajustes iniciales EPS y se permite un solo
intento de alineación por equipo y SIM, registrado antes de enviar el cambio,
aunque este falle. Una generación nueva debe verificar el resultado. Un fallo
conserva el bloqueo y los ajustes originales privados. Raw-IP exige retirar las
direcciones globales antes de la llamada de datos. La espera de retorno USB es
limitada y no provoca reinicios repetidos. El puerto serie se resuelve por la
interfaz USB; perder el servicio o la conexión de control revoca la sesión. La
preparación puede reiniciar un módulo, así que solo se ejecuta cuando no hay
ninguna transmisión en curso ni iniciándose. Si una transmisión empieza antes
del reinicio, el registro QMAP/EPS vuelve a su fase base y conserva el
intento EPS para la próxima comprobación en reposo. Un cambio rechazado o un
reinicio fallido sigue bloqueando la preparación hasta la recuperación explícita.

Un perfil que la preparación toma a su cargo se desarma primero en
NetworkManager; CeraUI inicia la conexión cuando termina la preparación.
Guardar un perfil manual restaura la elección anterior de conexión automática,
o la activa para un perfil manual nuevo. Una preparación de firmware interrumpida
requiere recuperación explícita; no se supone que se haya restaurado. Estos
cambios solo tienen pruebas en el host y en entornos de prueba.

### RM520N-GL en USB 2

El RM520N-GL eleva el ruido de su propio receptor cuando su enlace USB 3 está
activo: en un banco de pruebas en EE. UU., un operador nunca registró el módem en
USB 3 y siempre lo hizo en USB 2, y la relación señal/ruido de otro operador
mejoró unos 14 dB. Por eso su entrada de transporte pide
`AT+QCFG="usbspeed","20"`, con cualquier SIM y en cualquier estado del módem,
antes de cualquier paso que dependa del operador.

- La lectura es la velocidad del enlace USB en sysfs. A 480 Mbit/s o menos no se
  hace nada: ni inhibición ni comandos AT.
- Con un enlace más rápido, y solo si no hay ninguna transmisión, CeraUI inhibe
  ese módem, lee el valor guardado, lo registra como original y registra el
  intento antes de cualquier cambio, escribe `"20"` si es distinto, lo vuelve a
  leer (si no coincide, se detiene antes del reinicio) y reinicia el módulo. La
  comprobación de transmisión se repite tras la inhibición.
- El enlace se pierde unos 50 segundos. Se cambia un solo módem a la vez.
- La siguiente enumeración USB lo verifica a 480 Mbit/s o menos. Dos intentos por
  unidad, con 15 minutos entre ellos; después la unidad queda en espera hasta que
  se elimine su registro.
- `/etc/ceralive/no-usbspeed` detiene toda escritura; la decisión se sigue
  registrando en el log.

La implementación es parcial. Todavía no incluye control de RNDIS, CLAT ni
comprobaciones del tráfico. Tampoco acredita compatibilidad real con un operador
o hardware. Verizon sigue sin calificar.

### Operadores solo IPv6 (traducción a IPv4)

Algunos operadores, entre ellos T-Mobile US, solo dan IPv6 al módem. El servicio
CLAT de la imagen asigna entonces a ese enlace una dirección IPv4 en una interfaz
de traducción (`clat<N>`). CeraUI añade esa interfaz al bonding mientras el
servicio indica que funciona (una instantánea reciente, el traductor y la
interfaz del módem presentes, el servicio en ejecución) y la retira en cuanto
deja de hacerlo. El interruptor de bonding del módem también se aplica a su
enlace traducido. CeraUI no ejecuta ni configura el traductor.

## Recovery isolation

The warning reports a modem setting change pending recovery. It names the
modem when a current row identifies it and says “a modem” otherwise.
The warning clears after verified recovery releases the journal block. Dismissing
a warning or reusing an interface name cannot release a block. An operation still
in progress continues to hold new starts.

Bond exclusion uses the current USB descriptor scan's physical path, with the
same stable-key derivation as modem recovery. Removal immediately invalidates
that name's scan evidence. An interface-index change invalidates it even when the
name and address stay the same. After a disconnect, a known USB name with a
missing old or new index waits for fresh identity evidence. Missing indices
alone leave a continuously present link admitted. A recreated virtual link
can rejoin when the kernel confirms its virtual path. The ordinary first-sight
timeout cannot release a replacement. A scan overlapping invalidation cannot
restore the old evidence.

A different modem in the same USB port can have a different link identity. The
recovery journal still owns the port. When the box captured a reliable USB
serial identity before the change, the same journal entry also blocks that unit
if it moves to another port. Sender admission enforces both checks, including
for a receiver on the local network. Automatic rollback stays at the original
port and checks the recorded unit when available. Older entries and units
without a reliable identity use the port only. While a recorded unit is
blocked, a modem with an unreadable or unreliable serial waits for positive
identification, including after a fresh scan on an unblocked port.
The modem roster's retained ID-path cache is not admission authority. Positively
classified USB Ethernet and sysfs-confirmed Wi-Fi stay available without an
ID-path cache entry; unresolved USB candidates stay out while a block exists,
even after the ordinary identity-settlement deadline. Translated IPv4 links
follow their parent modem's exclusion. A fresh scan republishes membership even
when the interface name and address have not changed.

When the sender advertises intentional empty reloads, the box opts in at
launch. The last held link can then leave the live bond without replacing the
sender. Sending resumes when a link is admitted and registers again. Older
senders, including stock v4.2.0, retain the previous pool on an empty reload.
With these senders, SRT forwarding closes an empty session and restarts its
listener. The encoder sender can keep sending through the last held link.
The image must ship a sender with intentional empty reloads to enable the pause. During a long
pause the SRT peer receives no replies and its idle timeout expires. The
encoder then reconnects after sending resumes.

The host-plane replay, displacement and recovery-wait mechanisms from the older
recovery drafts remain outside this implementation. The box fixture covers real
USB classification, failed roster refresh/name reuse, journal block projection,
and a Start through the production admission and start-stream composition, with
OS reads, journal entries, sender spawning and engine I/O substituted.

### Aislamiento durante la recuperación

El aviso indica que hay un cambio de configuración pendiente de recuperación.
Muestra el nombre si el módem aparece en la lista. En caso contrario, dice
«un módem».
El aviso desaparece cuando una recuperación verificada libera el bloqueo.
Cambiar el nombre de la interfaz no lo libera. Una operación todavía en curso
sigue impidiendo iniciar una nueva transmisión.

Los adaptadores USB Ethernet y Wi-Fi identificados siguen disponibles aunque no
haya una ruta guardada. Un dispositivo USB sin identificar permanece excluido
mientras exista un bloqueo, hasta obtener evidencia física actual. La interfaz
IPv4 traducida de un módem sigue el bloqueo de ese módem.

Si se reutiliza un nombre de interfaz USB y no se puede confirmar su identidad,
la caja espera una lectura física actual. Si se conecta otro módem al mismo
puerto, su identidad de enlace puede ser distinta. La caja mantiene el puerto
fuera de los enlaces que usa para enviar, también en la red local, hasta que
la recuperación verifique la entrada del diario o se establezca explícitamente
una nueva configuración de referencia. Cuando el diario guarda una identidad
USB fiable, el bloqueo también sigue a ese módem si cambia de puerto.
Mientras dure ese bloqueo, un módem sin un número de serie fiable queda a la
espera de que la caja pueda identificarlo.

Con un emisor compatible, la caja pausa el envío cuando el último enlace
queda excluido. El envío se reanuda cuando se admite y se registra un enlace.
Con el emisor estándar v4.2.0, el reenvío SRT cierra la sesión cuando se queda
sin enlaces y reinicia la escucha. El emisor del codificador puede seguir
enviando por el último enlace. En una pausa larga, el par SRT agota su tiempo
de espera por inactividad. El codificador vuelve a conectarse cuando se reanuda el envío.
