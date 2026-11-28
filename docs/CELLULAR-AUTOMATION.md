# Automatic cellular profiles

## English

For an existing automatic profile on an admitted modem/firmware transport,
recognized subscription evidence selects a stored APN. The IP family request is
the one the box already uses for that SIM (IPv4v6 on carriers known to be
IPv6-only, otherwise the IPv4 request it always made). The box records the previous settings before applying the change, holds off
other changes to that modem, and verifies the settings after the write. Manual profiles, unknown
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

### APN for a new SIM

A new SIM's profile normally starts on Automatic APN. NetworkManager then looks
the APN up in the mobile provider database by the network the modem is
registered on and takes the first entry marked for internet use. That is the
wrong APN for a roaming SIM, for an MVNO SIM with its own network code on a host
network, and where the first entry is an IMS APN. In those cases CeraUI applies
the APN the database lists for the SIM's own network itself: the profile stays
on Automatic APN, NetworkManager's own lookup is turned off for it, and the
modem dialog says beside the switch which APN Automatic APN uses and that it
comes from the provider database. Saving the dialog with Automatic APN on keeps
that APN; turning Automatic APN off shows it in the APN field to change. When
the database lists no internet APN for the SIM's network, NetworkManager keeps
picking the APN and the dialog says so beside the switch; if mobile data does
not connect, turn Automatic APN off and enter the provider's APN. Networks that
a qualified row of the carrier table above covers are left to its takeover.

CeraUI records who chose each APN it writes, next to the profile's automatic or
manual intent: the provider database (for which network), the carrier table, or
someone in the modem dialog. A database APN belongs to the SIM it was
looked up for. A new profile for another SIM of the same operator therefore gets
its own lookup instead of a copy; an APN someone entered is copied as
before. Because a database APN keeps the profile automatic, modems admitted for
transport preparation get their QMAP and raw-IP preparation as with any other
automatic profile. Existing profiles are never changed. The check runs once,
when the profile is created: a SIM that was not yet registered is judged as if
on its home network, so if it later roams and mobile data does not connect,
enter the APN from your provider.

### RM520N-GL at USB 2

The RM520N-GL raises its own receiver's noise floor when its USB 3 link is
active: on a US bench one carrier never registered at USB 3 and always did at
USB 2, and another carrier's signal-to-noise improved by about 14 dB. Its
transport entry therefore asks for `AT+QCFG="usbspeed","20"`, for any SIM and in
any modem state, before any carrier-dependent step.

- The read is the USB link speed in sysfs. At 480 Mbit/s or slower nothing is
  done: no inhibition and no AT command.
- At a faster link, and only while no stream runs, CeraUI inhibits that one modem,
  reads the stored value and saves it before sending a setting change. It writes
  `"20"` if needed and reads it back. The box records one attempt before sending
  the setting request. If the box restarts before saving the outcome, that
  attempt stays counted because the request may have reached the modem. A
  failed request also stays counted. On success, the reset uses the same attempt.
  If the setting was already correct, the box counts the reset when it reserves
  it. If Start wins before reset admission, the box logs the deferral and saves
  the previous count.
- You can start a stream while the box waits for the modem or checks its USB setting. Once the box is ready to send the reset, it holds new starts until it releases USB control.
  While the unit is absent, the box waits out its recorded 180-second return
  window before sending another modem a USB speed reset. This also applies after restart.
- The box checks for 480 Mbit/s or slower on the next USB enumeration. It allows
  two attempts per modem, 15 minutes apart. An interrupted attempt can consume
  the budget even if the box never sent the command. Once blocked, automatic USB
  preparation for that modem stays blocked across restarts and re-enumeration.
  Carrier processing continues.
- `/etc/ceralive/no-usbspeed` stops every write; the decision is still logged.

This is a partial implementation. It does not establish
an RNDIS owner, CLAT,
traffic health or carrier/hardware qualification. Existing or synthetic test
results do not establish those capabilities. Verizon remains unqualified.

#### Clearing a blocked USB preparation record

1. Find the latest `usbspeed: blocked` line with
   `journalctl -u ceralive.service -g 'usbspeed: blocked'`. It names the interface,
   the ModemManager index (`modem=`) and the full preparation file (`record=`).
   Use `mmcli -L` to find the current modem and `mmcli -m <index> -K` to check
   its equipment identifier locally. Both the interface name and index can be
   reused. If you need support, send the blocked line and keep the IMEI private.
2. End any stream. In a root shell on the box, run the commands below. Enter the
   current modem index and the exact path after `record=`. The commands check
   the filename against the hash of that modem’s equipment identifier, then stop
   `ceralive.service` and show the file. Check that `kind` is `usbspeed`, `key`
   matches the filename without `.json`, `phase` is `blocked`, and `attempts` is
   at least 2.
3. Type `ARCHIVE` only if those fields match and you want to allow another
   attempt. Press Enter to cancel. The move preserves the original setting in a
   new private directory outside the preparation store. The service restarts on
   exit. Its next eligible idle poll can send a setting change or modem reset.

```sh
(
  printf 'modem= '
  IFS= read -r modem || exit 1
  printf 'record= '
  IFS= read -r record || exit 1
  equipment=$(mmcli -m "$modem" -K | sed -n \
    's/^[[:space:]]*modem\.generic\.equipment-identifier[[:space:]]*:[[:space:]]*\([0-9][0-9]*\)[[:space:]]*$/\1/p')
  case "$equipment" in ''|*[!0-9]*) exit 1 ;; esac
  key=$(printf '["usbspeed","%s"]' "$equipment" | sha256sum | cut -d' ' -f1)
  [ "$record" = "/data/ceralive/cellular-preparation/$key.json" ] || exit 1
  systemctl stop ceralive.service || exit 1
  trap 'systemctl start ceralive.service' EXIT
  [ -f "$record" ] && [ ! -L "$record" ] && cat -- "$record" || exit 1
  printf '\nARCHIVE? '
  IFS= read -r answer && [ "$answer" = ARCHIVE ] || exit 1
  backup=$(mktemp -d /data/ceralive/usbspeed-backup.XXXXXX) &&
    mv -v -- "$record" "$backup/" && sync -f "$backup"
)
```

### IPv6-only carriers (IPv4 translation)

Some carriers, T-Mobile US among them, give the modem IPv6 only. The image's
CLAT service then gives that link an IPv4 address on a translator interface
(`clat<N>`). CeraUI adds that interface to the bond while the service reports it
working (a fresh snapshot, the translator and the modem interface present, the
service running) and takes it out as soon as it doesn't. The modem's own bond
switch also covers its translated link. CeraUI does not run or configure the
translator itself.

### Modem carrier configuration (read-only)

Separate from the APN profile above, a Qualcomm-based modem keeps its own
carrier configuration in firmware (PDC or MBN, for example `GCF`, `ATT` or a
`ROW_Commercial` default). ModemManager publishes the active one as
`CarrierConfiguration` and `CarrierConfigurationRevision`, and the modem details
show both when the modem reports them. CeraUI does not change it; automatic
profiles never touch it.

## Español (Latinoamérica)

Un perfil automático existente puede recibir un APN cuando la suscripción se
reconoce y el transporte del módem y su firmware están admitidos. La familia IP
que solicita es la que el equipo ya usa para esa SIM (IPv4v6 en operadores que
solo ofrecen IPv6; si no, la solicitud IPv4 de siempre). El equipo guarda los ajustes anteriores antes de aplicar el cambio, aplaza
otros cambios en ese módem y verifica los valores escritos. Conserva
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

### APN para una SIM nueva

El perfil de una SIM nueva empieza normalmente con APN Automático. NetworkManager
busca entonces el APN en la base de datos de operadores móviles según la red en
la que está registrado el módem y toma la primera entrada marcada para internet.
Ese APN es incorrecto para una SIM en roaming, para una SIM de un operador móvil
virtual con su propio código de red sobre una red anfitriona y cuando la primera
entrada es un APN de IMS. En esos casos CeraUI aplica él mismo el APN que la base
de datos indica para la red propia de la SIM: el perfil sigue con APN Automático,
la búsqueda propia de NetworkManager se desactiva para él y el diálogo del módem
indica junto al interruptor qué APN usa APN Automático y que viene de la base de
datos de operadores. Guardar el diálogo con APN Automático activado conserva ese
APN; al desactivar APN Automático aparece en el campo APN para cambiarlo. Si la
base de datos no indica ningún APN de internet para la red de la SIM,
NetworkManager sigue eligiendo el APN y el diálogo lo indica junto al
interruptor; si los datos móviles no se conectan, desactiva APN Automático e
introduce el APN de tu operador. Las redes que cubre una fila calificada de la
tabla de operadores de arriba quedan para esa tabla.

CeraUI registra quién eligió cada APN que escribe, junto a la intención
automática o manual del perfil: la base de datos de operadores (para qué red), la
tabla de operadores o alguien en el diálogo del módem. Un APN de la base de
datos pertenece a la SIM para la que se buscó. Por eso, un perfil nuevo para otra
SIM del mismo operador hace su propia búsqueda en lugar de copiarlo; un APN
introducido por alguien se copia como antes. Como un APN de la base de datos
mantiene el perfil automático, los módems admitidos para la preparación del
transporte reciben su preparación de QMAP y raw-IP como con cualquier otro perfil
automático. Los perfiles existentes nunca se modifican. La comprobación se hace
una sola vez, al crear el perfil: una SIM que aún no estaba registrada se evalúa
como si estuviera en su red propia; si después está en roaming y los datos
móviles no se conectan, introduce el APN de tu operador.

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
  ese módem, lee el valor guardado y lo registra antes de enviar un cambio.
  Escribe `"20"` si hace falta y vuelve a leerlo. El equipo registra un intento
  antes de enviar el cambio. Si el equipo se reinicia antes de guardar el
  resultado, conserva ese intento porque la solicitud pudo haber llegado al
  módem. Una solicitud fallida también consume el intento. Si el cambio tiene
  éxito, el reinicio del módem usa ese mismo intento. Si el ajuste ya era
  correcto, el equipo cuenta el intento al reservar el reinicio. Si antes se inicia una transmisión, el equipo registra
  el aplazamiento y guarda el recuento anterior.
- Puedes iniciar una transmisión mientras el equipo espera al módem o comprueba su ajuste USB. Cuando el equipo está listo para enviar el reinicio, aplaza los inicios hasta liberar el control USB. Si el módem
  está ausente, el equipo espera hasta el final del plazo registrado de 180
  segundos antes de enviar a otro módem un reinicio por el cambio de velocidad
  USB. Esto también se aplica después de reiniciar el equipo.
- En la siguiente enumeración USB, el equipo comprueba si la velocidad es de
  480 Mbit/s o menos. Permite dos intentos por módem, separados por 15 minutos.
  Un intento interrumpido puede contar aunque el equipo no haya enviado el
  comando. Una vez bloqueada, la preparación USB automática de ese módem sigue
  bloqueada aunque se reinicie el equipo o se vuelva a enumerar el módem.
  El procesamiento del operador continúa.
- `/etc/ceralive/no-usbspeed` detiene toda escritura; la decisión se sigue
  registrando en el log.

La implementación es parcial. Todavía no incluye control de RNDIS, CLAT ni
comprobaciones del tráfico. Tampoco acredita compatibilidad real con un operador
o hardware. Verizon sigue sin calificar.

#### Cómo volver a permitir la preparación USB de un módem bloqueado

1. Busca la entrada más reciente de `usbspeed: blocked` con
   `journalctl -u ceralive.service -g 'usbspeed: blocked'`. Indica la interfaz,
   el índice de ModemManager (`modem=`) y la ruta completa del archivo
   (`record=`). Usa `mmcli -L` para ubicar el módem actual y `mmcli -m <índice> -K`
   para verificar su identificador de equipo en el propio dispositivo. Tanto el
   nombre de la interfaz como el índice se pueden reutilizar. Si necesitas
   ayuda, envía esa línea a soporte y mantén el IMEI en privado.
2. Finaliza cualquier transmisión. Desde una consola con permisos de root en el
   equipo, ejecuta los [comandos de recuperación](#clearing-a-blocked-usb-preparation-record).
   Introduce el índice actual y la ruta exacta que aparece después de `record=`.
   Los comandos verifican el nombre del archivo con el hash del identificador de
   ese módem, detienen `ceralive.service` y muestran el archivo. Comprueba que
   `kind` sea `usbspeed`, que `key` coincida con el nombre del archivo sin `.json`,
   que `phase` sea `blocked` y que `attempts` sea al menos 2.
3. Escribe `ARCHIVE` solo si los campos coinciden y quieres permitir otro
   intento. Para cancelar, presiona Intro. Se mueve solo ese archivo de
   `/data/ceralive/cellular-preparation` a un directorio privado nuevo que
   conserva el ajuste original. Al salir se inicia de nuevo el servicio. En la
   siguiente comprobación sin transmisión, si se cumplen las condiciones, el
   equipo puede enviar un cambio de ajuste o solicitar el reinicio del módem.

### Operadores solo IPv6 (traducción a IPv4)

Algunos operadores, entre ellos T-Mobile US, solo dan IPv6 al módem. El servicio
CLAT de la imagen asigna entonces a ese enlace una dirección IPv4 en una interfaz
de traducción (`clat<N>`). CeraUI añade esa interfaz al bonding mientras el
servicio indica que funciona (una instantánea reciente, el traductor y la
interfaz del módem presentes, el servicio en ejecución) y la retira en cuanto
deja de hacerlo. El interruptor de bonding del módem también se aplica a su
enlace traducido. CeraUI no ejecuta ni configura el traductor.

### Configuración del operador en el módem (solo lectura)

Aparte del perfil APN, un módem con chip Qualcomm guarda en su firmware su propia
configuración de operador (PDC o MBN, por ejemplo `GCF`, `ATT` o una
predeterminada `ROW_Commercial`). ModemManager publica la activa como
`CarrierConfiguration` y `CarrierConfigurationRevision`, y los detalles del módem
muestran ambas cuando el módem las informa. CeraUI no la cambia; los perfiles
automáticos nunca la tocan.

## Recovery isolation

The warning reports a modem setting change pending recovery. It names the
modem when a current row identifies it and lists the links held from bond
selection. If you have the original modem, reconnect it to its original USB
port. Contact support if recovery is still pending or the original is gone.
The warning clears after verified recovery releases the journal block. Dismissing
a warning or reusing an interface name cannot release a block. An operation still
in progress continues to hold new starts.

If the box cannot read a modem recovery record at startup, it retries after 1,
2 and 4 seconds. It processes readable records for other modems. If the same
record still cannot be read, the box posts a persistent warning and holds new
stream starts. Choose **Review recovery record**, then **Clear recovery record**
to set that record aside. Clearing gives up restoration from its saved settings.
The box keeps the archived bytes and checks the remaining records before
admitting Start. During normal operation this check verifies the journal
without replaying modem commands. While the warning is open, the box keeps
checking at intervals of up to 60 seconds. If a check is incomplete, the box
keeps the warning and the retries already recorded. A complete check withdraws
the warning when the file changes or reads successfully. An unreadable
replacement gets its own retries. A repaired record needs no confirmation.
If the journal directory itself cannot be read or synced, recovery waits for
working storage.

Bond exclusion uses the current USB descriptor scan's physical path, with the
same stable-key derivation as modem recovery. Removal immediately invalidates
that name's scan evidence. An interface-index change invalidates it even when the
name and address stay the same. After a disconnect, a known USB name with a
missing old or new index waits for fresh identity evidence. An unreadable
bus alone cannot establish that a link was USB. Missing indices alone leave
a continuously present link admitted. A recreated virtual link
can rejoin when the kernel confirms its virtual path. The ordinary first-sight
timeout cannot release a replacement. A scan overlapping invalidation cannot
restore the old evidence.

A different modem in the same USB port can have a different link identity. The
recovery journal still owns the port. When the box captured a reliable USB
serial identity before the change, the same journal entry also blocks that unit
if it moves to another port. The journal and live scan normalize USB serials
the same way, including before checking whether devices share a serial. Sender admission enforces both checks, including
for a receiver on the local network. Automatic rollback stays at the original
port and checks the recorded unit when available. Older entries and units
without a reliable identity use the port only. While a recorded unit is
blocked, a candidate with the same USB vendor and product waits for positive
identification, including after a fresh scan on an unblocked port. The same
rule applies when that candidate has no current ID_PATH. A USB mode change
can change the product ID, so its unresolved candidates are scoped by
vendor. A known different
USB model can keep sending. Older entries without model evidence keep a
conservative hold on ambiguous candidates.
The modem roster's retained ID-path cache is not admission authority. Positively
classified USB Ethernet and sysfs-confirmed Wi-Fi stay available without an
ID-path cache entry; unresolved USB candidates stay out while a block exists,
even after the ordinary identity-settlement deadline. Translated IPv4 links
follow their parent modem's exclusion. A fresh scan republishes membership even
when the interface name and address have not changed.

### Support-assisted modem recovery

Use a maintenance window with the stream stopped. Record the modem and links
from the warning, and confirm which physical modem and USB port the owner
intends to recover. Use the signed-in box's authenticated modem RPC with the
owner's confirmation. Call `modems.listMutationBlocks`, wait for
`replayComplete`, and match the affected `stableKey` before proceeding.

- For `failed`, use `modems.acknowledgeMutation` with the matched
  `stableKey` and mode `verified-rollback`. If verification fails, review
  the current hardware with the owner before using `force-rebaseline`.
- For `device-absent-quarantine`, reconnect the original modem to its original
  port and restart the box during the maintenance window so recovery can
  recheck it.
  If the owner confirms the original is permanently gone, call
  `modems.decommissionMutation` with that key. The old port remains held.
- To use a replacement at that port, connect it with the stream stopped
  and restart the box. Wait for recovery to mark the entry
  `recommission-pending`. Confirm
  the replacement's identity and call `modems.rebaselineMutation`.
- Read `modems.listMutationBlocks` again and confirm the selected record's
  state and the expected bond links before restarting the stream. Keep
  the journal under the recovery service's control.

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
Muestra el nombre si el módem aparece en la lista y los enlaces retenidos.
Si tiene el módem original, vuelva a conectarlo a su puerto USB original.
Contacte con soporte si la recuperación sigue pendiente o si ya no tiene
el módem original.
El aviso desaparece cuando una recuperación verificada libera el bloqueo.
Cambiar el nombre de la interfaz no lo libera. Una operación todavía en curso
sigue impidiendo iniciar una nueva transmisión.

Si al arrancar el equipo no puede leer un registro de recuperación, vuelve a
intentarlo después de 1, 2 y 4 segundos. Si sigue sin poder leerlo, muestra
un aviso y mantiene en pausa el inicio de nuevas transmisiones. El equipo
sigue comprobando los registros a intervalos de hasta 60 segundos. Si una
comprobación queda incompleta, conserva el aviso y los reintentos registrados.
Una comprobación completa retira el aviso si el archivo cambia o se puede leer.
Un archivo de reemplazo recibe sus propios reintentos. Si se repara el registro, el equipo continúa
sin pedir confirmación. Para apartar un registro ilegible, selecciona
**Revisar el registro** y confirma con **Retirar el registro de recuperación**.
El equipo archiva el contenido y revisa los demás registros antes de permitir
otra transmisión.

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
Mientras dure ese bloqueo, un candidato del mismo fabricante y producto USB
sin identidad fiable queda a la espera de que la caja pueda identificarlo.
Durante un cambio de modo USB, el producto puede cambiar y la caja usa
el fabricante para delimitar la retención.
Un modelo USB conocido y diferente puede seguir enviando.

#### Recuperación con soporte

Detenga la transmisión durante el mantenimiento. Anote los enlaces del aviso
y confirme con el propietario qué módem y puerto USB desea recuperar. Use el
RPC autenticado de la caja. Consulte `modems.listMutationBlocks`, espere
`replayComplete` y compruebe el `stableKey` antes de cambiar el estado.

- Para `failed`, llame a `modems.acknowledgeMutation` con el `stableKey`
  y el modo `verified-rollback`. Si no se verifica, revise el dispositivo
  con el propietario antes de usar `force-rebaseline`.
- Para `device-absent-quarantine`, vuelva a conectar el módem original al
  puerto original y reinicie la caja durante el mantenimiento para que
  la recuperación lo compruebe. Si el propietario confirma que el original ya
  no se usará, llame a `modems.decommissionMutation`. El puerto queda retenido.
- Para usar un reemplazo en ese puerto, conéctelo con la transmisión detenida
  y reinicie la caja. Espere a que la recuperación marque
  `recommission-pending`. Confirme la
  identidad del reemplazo y llame a `modems.rebaselineMutation`.
- Vuelva a consultar `modems.listMutationBlocks` y compruebe el estado y los
  enlaces esperados antes de reanudar la transmisión. Deje el diario bajo
  control del servicio de recuperación.

Con un emisor compatible, la caja pausa el envío cuando el último enlace
queda excluido. El envío se reanuda cuando se admite y se registra un enlace.
Con el emisor estándar v4.2.0, el reenvío SRT cierra la sesión cuando se queda
sin enlaces y reinicia la escucha. El emisor del codificador puede seguir
enviando por el último enlace. En una pausa larga, el par SRT agota su tiempo
de espera por inactividad. El codificador vuelve a conectarse cuando se reanuda el envío.
