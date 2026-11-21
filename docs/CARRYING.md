# Client carrying liveness

A stream can use the box without using its encoder. `getStreamLiveness()` combines
encoder ownership with `CarryingTracker`: either positive source is streaming;
only two confirmed idle answers permit an idle-only action. Unreadable evidence
is unknown and withholds permission.

Client-facing hotspot/shared-LAN RX counters are sampled every five seconds.
An upload above 1,000,000 bits/s starts 20-second qualification. Samples above
250,000 bits/s keep qualification and an existing hold alive, tolerating adaptive
bitrate dips. A new upload below the entry threshold does not qualify on its own
unless real session/upload protection is already held. Counters
are per interface, so resets, additions and removals do not manufacture a delta.
Gaps above ten seconds restart qualification. Recent entry-level traffic withholds
idle for 20 seconds even if a short dip resets qualification. An isolated burst
therefore has bounded checking time, while repeated stalls cannot open idle gaps.
A backend restart within the same boot seeds a separate two-minute checking
window. It reports unknown, never carrying without real evidence, and ambient
keep-level traffic cannot extend it. A restart therefore cannot lose the
remaining protection. The first start after a boot takes no such window: no
earlier process held evidence to lose, anything carried before the reboot was
already cut, and new client traffic is measured from the first sample interval.
The first readable sample is only a baseline: it clears "unreadable", and the
first rate needs a second sample of the same interfaces, five seconds later.
A phone already forwarding when the backend starts is therefore reported idle
for up to one heartbeat before it counts as qualifying traffic.
The backend tells the two apart by creating `/run/ceralive/carrying-boot-claim`
(`CERALIVE_CARRYING_BOOT_CLAIM`): `/run` is empty after every boot, and the unit
keeps its runtime directory across restarts. A claim that already exists or
cannot be created counts as a restart. Without this, every boot refused restart,
power-off and the SSH switch for about two minutes after the backend started.
Packages from before the claim never wrote it, so the package's postinst writes
it before restarting the backend on every upgrade while systemd runs: that is a
restart within the boot. It does not ask systemd whether the backend ran, because
an old prerm may already have stopped, disabled and unloaded the unit, which
clears that record. At worst a backend that had not run yet gets the restart
hold. A fresh install and an image build write nothing.
A two-minute hold after the last
positive evidence covers reconnects. While an above-threshold upload is still
qualifying, liveness is unknown, so idle actions wait without calling a short burst
a carried stream. This is deliberately conservative: local
uploads to the box may also hold idle actions. Uplink RX/TX and the box's own
background downloads never qualify. Unlike a shaper-child counter, client RX is
available before any streaming root is installed and through the NM sharing floor.

SRT connection events and RTMP publisher polling provide immediate session
protection. Session owners call `carryingTracker.session(source, true|false|null,
performance.now())`; null means unreadable. Independent bonding senders and relay
supervisors must report their owned session through that same seam when added;
this change does not launch or discover a new relay/sender service.

For `srt-forward`, report true only while a publisher is connected and the owned
forwarding sender is alive. Report false immediately on disconnect or intentional
stop, and null on a process fault. Do not stack another carrying grace period on
top of the central 120-second hold. Register initially with null until the first
verified observation. Reports are event-driven and persist until replaced; a
source owner must report faults rather than silently abandon its state.

The OTA sentinel has two owners. Clearing encoder protection cannot remove
carrying protection, and ending carrying cannot remove encoder protection.
The stream session reads the sentinel through `encoderOtaStreamLiveness()`: a
marker this process wrote only for carrying (created from absence, or kept by
carrying after a confirmed encoder idle) is not stream evidence. Otherwise the
startup hold, which is published before the first reconciliation, would make
every clean boot look like an inherited marker; an idle engine pushes no status
on subscribe, so the session would stay `reconciling` until an operator Stop.
A carrying-only marker holds the line `carrying`; a stream's marker is empty,
and the image checks existence only. `/run` outlives a backend restart, so a
new process that finds that line learns that its predecessor held the file for
carrying alone, as far as that process knew at its last write. Without it, a
restart inside the hold or while carrying (a crash, or the image restarting
the service early in boot) stayed `reconciling` and refused Start until a Stop.
Any other marker present before carrying wrote it still counts as unknown, so a
restart beside a running stream stays unconfirmed and protected: a restarted
backend never owns its predecessor's sender (see below).

The line alone is not idle. A stream can begin after it was written (another
control client, while the file could be neither rewritten nor replaced), and a
dead process cannot report that. So a restarted backend keeps the line as it
is, holds the encoder inhibitor and stays `reconciling` until the engine
agrees: two separate status subscriptions that are accepted and hear nothing
(an idle engine is silent, a running session reports status about every two
seconds) commit `idle`; a running session makes the file the stream's and stays
unconfirmed (`reconciling`, protected) until an operator Stop, because a
restarted backend does not own that session's sender. Engine silence without the line keeps its old meaning (unknown).

"Heard nothing" is proven, not assumed. After a silent window the query sends
`list-switch-targets` on the same connection, and only a reply with still
nothing heard counts: the client tells pending requests about a dropped
connection but not subscriptions, and a status sent in time can sit unread
behind a timer that fired during an event-loop stall. Lines are written and
read in order, so a reply means the connection held and every earlier status
was handled. The reply is the engine's own snapshot of its session: one that
names a `session_id`, an `active_input` or any `switch_targets` is a running
session, never silence. An empty snapshot is treated as no session on any schema,
subject to the unverified assumption below. A reply that reports nothing (a typed
error from an engine without the method, or a result the binding cannot
parse) counts only from an engine whose schema is not newer than the
binding's, because the binding drops statuses it cannot parse without a trace.

A query that cannot reach the engine proves nothing either way, unless the
engine's systemd unit has no process at all (`cerastream.service` loaded,
`MainPID=0`, and inactive, failed or waiting to restart after a crash): a
stream runs inside that process, so this counts like a silent answer. An
engine that stays down therefore does not hold the line, the marker and every
update until reboot. While the engine stays unreachable, each failed recheck
of the engine reconnect loop (about every 30 s) reconciles again as long as a
line waits, so an engine that dies after the boot reconciliation is caught
too; once the engine is reachable the loop reconciles as before.

Limits: it is an unverified assumption, not measured engine behaviour, that every
running session supplies a session id, active input or live switch targets.
Passthrough and composition always have an empty target list; their protection
still depends on the engine supplying `session_id` or `active_input`. A running
engine reads as silent if it sends no status for two windows on a working
connection and omits all three signs from its snapshot, or answers with an error
on a schema the binding reads. A positive idle answer from the engine would close
that gap.

One owner (`createOtaMarkerOwner`) writes the file, and its content follows
from who holds it at each change: a stream keeps it empty, carrying alone keeps
the line, nobody removes it. Every commit to `streaming`, and every running
session a restarted backend finds, makes the file the stream's. A Start changes nothing until its last admission
step, which runs in the same tick as the launch: the stream takes the file
(rewritten, or replaced by rename when it cannot be rewritten), and the launch
goes only if the file is then seen without the line. Otherwise Start is refused
as for unavailable shutdown protection. A cancelled or refused Start therefore
leaves the marker as it was. Content already on disk is never written again,
and the line is written through a renamed sibling first, so a torn write
cannot leave half a line (which would read unknown anyway).
`ota-marker-owner.test.ts` walks every sequence of holder changes, engine
answers, outside starts, write failures (torn writes included) and restarts to
a fixed depth against these rules.
The idle clock includes carrying and its last hold boundary. Updates retain all
existing control leases and final admission checks. A persistent informational
notice explains why updates, reboot, power-off and idle link changes wait, without
asserting whether a platform broadcast has ended.

`idleActionPolicy()` is the shared check for home AP pause, home SIM exclusion and
heat's idle-only link rest. Call it at decision time and again immediately before
mutation. Only confirmed idle permits these actions. While carrying or unknown,
keep the AP and SIM links available and use the live heat path. Independent
emergency thermal safety limits are unaffected. Home detection and the heat
ladder are separate topics; no new home/thermal automation is enabled here.

Host coverage includes engine-less boot reconciliation, upload qualification,
reconnect hold, counter faults, OTA owner interleavings, idle actions and a private
network namespace with a veth phone uploading through a shaped forwarding path.
No hardware continuity or field threshold calibration is claimed.

## Español (Latinoamérica)

La caja puede transportar una transmisión sin usar su propio codificador. Una
sesión SRT/RTMP o una carga de clientes de más de 1 Mbit/s durante 20 segundos
protege las actualizaciones y los cambios de enlaces por inactividad. La protección
se mantiene dos minutos después de la última evidencia. Si no se puede leer una
fuente, los cambios esperan. El punto de acceso y los enlaces SIM siguen disponibles;
los límites térmicos de emergencia conservan su autoridad. Los contadores de entrada
de los puertos de clientes también pueden proteger una carga local grande. Estas
pruebas son del host; falta medir los umbrales y la continuidad en hardware.

## Optional legacy RTMP statistics

A refused loopback connection or absent HTTP resource means no legacy RTMP
statistics owner. This does not claim knowledge of a different gateway's sessions;
client counters and other session owners still protect traffic. MediaMTX session
reporting remains a separate integration. Malformed XML, HTTP failures and timeouts
are unknown for at most 120 seconds of consecutive failures, then this optional
probe releases its claim. Each full probe, including body reading, is bounded to
two seconds; overlapping polls are skipped. Valid observations reset the failure
budget. A previous active session still gets the central reconnect hold.

The marker is updated only when protection changes, with failed writes retried.
Qualification samples count as idle-clock activity; after carrying ends the clock
ages from the hold boundary rather than remaining pinned to the current time.

Al iniciar o reiniciar el servicio, la protección dura al menos dos minutos.
Una carga superior a 1 Mbit/s inicia la comprobación de 20 segundos; más de
250 kbit/s mantiene la comprobación y una protección existente. Las actualizaciones,
los reinicios y el apagado esperan tanto las transmisiones de clientes como la propia.
Si no existe el servicio RTMP heredado, no aporta actividad. Los errores de esa
sonda mantienen un estado desconocido durante un máximo de 120 segundos seguidos.

## Action refusal feedback

A manual reboot, power-off, SSH, add-on or display action refused by the disruptive
gate is not queued. For power and SSH, the device sends one named, localized
refusal notification;
the frontend retains or reverts the control without adding a second toast. Add-on
and display refusals use the same localized copy in their existing frontend toast. Try
again when stream traffic is idle and no update is in progress. A refusal never
asserts that any stream has ended. Transport and execution failures still have
frontend feedback.

Al iniciar, la caja comprueba la actividad durante dos minutos sin afirmar que
transporta una transmisión. El tráfico de fondo de más de 250 kbit/s no prolonga
esa ventana. Una muestra breve de baja velocidad durante la comprobación no
permite acciones por inactividad mientras haya evidencia reciente de tráfico.
Una acción manual rechazada no queda en cola: se muestra un solo aviso y debes
intentarlo de nuevo cuando el tráfico esté inactivo y no haya una actualización
en curso. El rechazo no afirma que una transmisión haya terminado.

## Backend restart and sender ownership

An engine session can remain active after its sender has died. After a backend
restart, that engine status alone does not establish a live stream: the session
stays unconfirmed and shutdown protection remains held. Use Stop to confirm engine
cleanup before starting again. An unowned sender is never stopped by name; while
one remains, or its absence cannot be checked, a replacement Start is refused.
The sender used for SRT forwarding belongs to the backend and does not count.
While the session is unconfirmed, actions that would drop a network link (USB
modem mode, FCC unlock, an exclusive hotspot or a Wi-Fi mode change) are refused
as during a live stream, but the stream is not shown as live. An earlier stream
is not started again; its restoration reports that it could not be restored after
a service restart. When the engine ends a session itself, the backend first stops
its own sender for that session, then reports idle.
This does not preserve media delivery across a backend service restart.

After a restart the backend also judges, read only, whether a sender its
predecessor left running could be adopted, and logs the verdict with the first
failing check. By default it never adopts, signals or stops anything (see the
optional takeover below). It runs after the
stream session has been reconciled, and startup continues without waiting for
it; it leaves an unreadable armed-stream marker in place for restoration. A
record that could never qualify (every record today, because the sender runs
inside the backend's own service and dies with it) is judged from the record
alone, so on this version the check reaches neither the sender's control socket
nor the engine.

When a sender starts, the backend records its PID and start time from one read
of the process (the boot ID is read separately), made while a pidfd holds it
and while the backend's own handle for the child shows it has not exited, so a
sender that is already gone records no PID. Without a pidfd no PID or unit is
added to the record prepared before the spawn, so it keeps a null PID. After the
unit lookup the process is captured again and its start
time must be the same. It records a systemd unit only when the sender is the main process of
its own active unit, alone in that unit's cgroup, outside the backend's cgroup.
For such a sender it also records the session ID from the engine's reply to
that Start, once the engine still reports it as streaming on the same
connection, with the engine unit's invocation ID and main PID.

For a record that could qualify, the check holds a pidfd on the recorded PID and
refuses when there is none or its answer is not "alive". It reads the process
(start time, name, the configured executable, arguments, not stopped); the
recorded unit through systemd (the same invocation ID, the sender as its main
process, active and running, no restart policy, the recorded cgroup with the
sender alone in it and in its process group); the armed stream's
configuration; the published map against the map on disk, including each row's
`id_path`; and whether that PID holds the control socket. Only then does it
connect to the socket. It sends nothing until SO_PEERCRED names the recorded PID
and SO_PEERPIDFD shows that listener alive under that number, and the pidfd still
shows the sender alive; a kernel without SO_PEERPIDFD (before Linux 6.5) is
refused. Both options name the process that listened, not whoever answers, so
the check assumes the sender does not share or pass on its listening socket.
Over that one connection it reads the sender's capabilities and two stats
snapshots, and requires bind-map contract 2 or later with required binding
advertised and requested, a mapped bond with the published links, a live link,
rising bytes, nothing pending, and an applied map generation and SHA equal to
the published ones. A missing pending field is read as nothing pending, which
relies on the contract-2 sender omitting it only then. The applied identity
covers the generation and the IP list's hash only, not `id_path`. It then reads
every local fact again on the same pidfd and requires the same values (the
process state only has to still qualify). Next it asks the engine for its
session ID once, on the session connection reconciliation holds, and requires
it to equal the recorded one. It reads the engine unit's invocation ID and main
PID from systemd before and after that question, with the unit still active,
and requires both to equal the recorded ones; this brackets the question in
time but does not prove that the connection reaches that main process. The
cached streaming status of that connection must be unchanged across the
question. Last, it checks that the pidfd still shows the sender alive, that
`/proc` does not show it stopped or exiting, and that the armed marker and
configuration are unchanged. A positive verdict is agreement
of these samples within a window of 3 seconds, not a guarantee about the
instant it is logged; a longer collection refuses. A sender older than contract
2 is refused at the contract check.

#### Optional takeover (`stream_continuity_takeover`)

Everything above describes the default. With `stream_continuity_takeover: true`
in `config.json` (absent by default) the sender runs in its own transient
systemd unit, `ceralive-srtla-send-<id>.service`, with no restart policy. Its
standard output goes to the journal and its standard error to a file, and the
backend follows both. The backend holds a pidfd on the sender for its whole
lifetime and sends every signal (reload, stop) through it, so a PID that now
belongs to another process is never signalled. A clean backend restart leaves
this sender running; a reboot stops it with every other unit; a backend
stopped by hand leaves the stream running.

After a restart the backend then acts on the check above, all or nothing. It
also refuses while a modem mutation journal entry, an internal-call lease or a
cellular host record exists, or cannot be read. When every check passes it
commits in this order, and any failure undoes what was done: operator intent
and the stream session (still reconciling) unchanged, the armed configuration
unchanged, the same pidfd still alive with the same start time and an eligible
state, the engine session taken over on the connection that answered, the
sender registered under that pidfd, map generations continued above the
applied one, telemetry reattached to the recorded stats file and control
socket, one reconciliation that must report streaming, then the session's
interface and USB listeners and reload checks. The adopted session is then
handled like one this backend started: Stop, reload and the sender check reach
it, and its exit is reported the same way.

On any refusal or failure the backend stops the recorded sender unit by its
name through systemd (never by PID), and with the flag also every other sender
unit, waits until systemd reports it gone, reconciles again and continues as
described at the start of this section. A unit that cannot be confirmed
stopped keeps the session unconfirmed and protected. Without the flag, a record
naming such a unit (left by a backend that had the flag) is also stopped this
way. Takeover writes nothing to disk, so a backend that dies during it leaves
the same evidence for the next start. On a sender without the contract-2
applied identity, or a kernel without SO_PEERPIDFD, the check refuses, so the
flag then only changes how the sender is hosted.

### Reinicio del backend y propiedad del emisor

La sesión del motor puede seguir activa aunque su emisor haya terminado. Después
de reiniciar el backend, ese estado por sí solo no confirma una transmisión en
vivo: la sesión queda sin confirmar y se mantiene la protección contra el apagado.
Usa Detener para confirmar la limpieza del motor antes de iniciar otra vez. Nunca
se detiene un emisor ajeno por su nombre; mientras siga presente, o no se pueda
comprobar su ausencia, se rechaza un nuevo inicio. El emisor que usa el reenvío
SRT pertenece al backend y no cuenta. Mientras la sesión no esté confirmada, se
rechazan las acciones que cortarían un enlace de red (modo USB del módem, desbloqueo
FCC, un punto de acceso exclusivo o un cambio de modo Wi-Fi) como durante una
transmisión en vivo, pero la transmisión no se muestra en vivo. La transmisión
anterior no se inicia otra vez; su restauración indica que no se pudo restaurar
tras reiniciarse un servicio. Cuando el motor termina una sesión por su cuenta, el
backend primero detiene su propio emisor de esa sesión y luego informa inactividad.
Esto no mantiene el envío de contenido durante el reinicio del servicio del backend.

Tras un reinicio el backend también evalúa, solo leyendo, si podría adoptar un
emisor que su predecesor dejó en marcha, y registra el resultado con la primera
comprobación que falló. De forma predeterminada nunca adopta, envía señales ni
detiene nada (ver la adopción opcional más abajo). Se ejecuta
después de reconciliar la sesión de transmisión, y el arranque continúa sin
esperar a que termine; deja en su sitio un marcador de transmisión armada
ilegible para la restauración. Un registro que nunca podría cumplir (hoy todos,
porque el emisor corre dentro del propio servicio del backend y termina con él)
se evalúa solo con el registro, así que en esta versión la comprobación no llega
ni al socket de control del emisor ni al motor.

Cuando un emisor arranca, el backend registra su PID y su hora de inicio con una
sola lectura del proceso (el ID de arranque del sistema se lee aparte), hecha
mientras un pidfd lo sostiene y mientras el propio manejador del backend para
ese hijo indica que no ha terminado; un emisor que ya no existe no registra PID.
Sin pidfd no se añade PID ni unidad al registro preparado antes del arranque,
que conserva un PID nulo. Después de consultar la unidad el proceso se lee
otra vez y su hora de inicio debe ser la misma. Registra una unidad
de systemd solo cuando el emisor es el proceso principal de su propia unidad
activa, solo en el cgroup de esa unidad, fuera del cgroup del backend. Para un
emisor así registra también el ID de sesión de la respuesta del motor a ese
inicio, cuando el motor todavía lo informa en transmisión por la misma conexión,
junto con el ID de invocación y el PID principal de la unidad del motor.

Para un registro que podría cumplir, la comprobación sostiene un pidfd sobre el
PID registrado y rechaza si no lo hay o si su respuesta no es "vivo". Lee el
proceso (hora de inicio, nombre, el ejecutable configurado, argumentos, no
detenido); la unidad registrada a través de systemd (el mismo ID de invocación,
el emisor como proceso principal, activa y en ejecución, sin política de
reinicio, el cgroup registrado con el emisor solo en él y en su grupo de
procesos); la configuración de la transmisión armada; el mapa publicado frente
al del disco, incluido el `id_path` de cada fila; y si ese PID tiene el socket de
control. Solo entonces se conecta al socket. No envía nada hasta que SO_PEERCRED
indique el PID registrado, SO_PEERPIDFD muestre a ese proceso que escucha vivo
con ese mismo número y el pidfd siga mostrando vivo al emisor; un kernel sin
SO_PEERPIDFD (anterior a Linux 6.5) se rechaza. Ambas opciones indican el
proceso que escuchó, no quién responde, así que la comprobación supone que el
emisor no comparte ni entrega su socket de escucha. Por esa misma conexión lee
las capacidades del emisor y dos lecturas de estadísticas, y exige el contrato
de mapa de enlaces 2 o posterior con el modo obligatorio anunciado y pedido, un
enlace agrupado mapeado con los enlaces publicados, un enlace activo, bytes en
aumento, nada pendiente, y una generación y un SHA del mapa aplicado iguales a
los publicados. Un campo de pendiente ausente se entiende como nada pendiente,
lo que depende de que el emisor del contrato 2 lo omita solo en ese caso. La
identidad aplicada cubre solo la generación y el hash de la lista de IP, no
`id_path`. Luego vuelve a leer todos los datos locales con el mismo pidfd y
exige los mismos valores (el estado del proceso solo tiene que seguir siendo
válido). Después pide al motor su ID de sesión una sola vez, por la conexión de
sesión que mantiene la reconciliación, y exige que sea igual al registrado. Lee
de systemd el ID de invocación y el PID principal de la unidad del motor antes y
después de esa pregunta, con la unidad todavía activa, y exige que ambos sean
iguales a los registrados; esto delimita la pregunta en el tiempo, pero no
prueba que la conexión llegue a ese proceso principal. El estado de transmisión
guardado de esa conexión no debe cambiar durante la pregunta. Por último,
comprueba que el pidfd siga mostrando al emisor vivo, que `/proc` no lo muestre
detenido ni terminando, y que el marcador de transmisión armada y la
configuración no hayan cambiado. Un resultado positivo es el acuerdo
de estas muestras dentro de una ventana de 3 segundos, no una garantía sobre el
instante en que se registra; una recolección más larga se rechaza. Un emisor
anterior al contrato 2 se rechaza en la comprobación del contrato.

#### Adopción opcional (`stream_continuity_takeover`)

Todo lo anterior describe el comportamiento predeterminado. Con
`stream_continuity_takeover: true` en `config.json` (ausente de forma
predeterminada) el emisor corre en su propia unidad transitoria de systemd,
`ceralive-srtla-send-<id>.service`, sin política de reinicio. Su salida
estándar va al journal y su salida de error a un archivo, y el backend sigue
ambas. El backend sostiene un pidfd sobre el emisor durante toda su vida y envía
cada señal (recarga, detención) a través de él, así que nunca envía una señal a
un PID que ahora pertenece a otro proceso. Un reinicio limpio del backend deja
este emisor en marcha; un reinicio del sistema lo detiene junto con las demás
unidades; un backend detenido a mano deja la transmisión en marcha.

Tras un reinicio el backend actúa entonces según la comprobación anterior, todo
o nada. También rechaza mientras exista, o no se pueda leer, una entrada del
registro de cambios de módem, una concesión de llamada interna o un registro de
host celular. Cuando todo cumple, confirma en este orden, y cualquier fallo
deshace lo hecho: la intención del operador y la sesión de transmisión (todavía
en reconciliación) sin cambios, la configuración armada sin cambios, el mismo
pidfd todavía vivo con la misma hora de inicio y un estado válido, la sesión del
motor adoptada en la conexión que respondió, el emisor registrado con ese pidfd,
las generaciones del mapa continuadas por encima de la aplicada, la telemetría
conectada otra vez al archivo de estadísticas y al socket de control
registrados, una reconciliación que debe indicar transmisión, y después los
escuchas de interfaces y USB y las comprobaciones de recarga de la sesión. La
sesión adoptada se trata entonces como una iniciada por este backend: Detener,
la recarga y la comprobación del emisor llegan a ella, y su fin se informa igual.

Ante cualquier rechazo o fallo, el backend detiene la unidad del emisor
registrada por su nombre a través de systemd (nunca por PID), y con la opción
activa también cualquier otra unidad de emisor, espera hasta que systemd la
indique terminada, reconcilia otra vez y sigue como se describe al inicio de
esta sección. Si no se puede confirmar que una unidad se detuvo, la sesión queda
sin confirmar y protegida. Sin la opción, un registro que nombra una unidad así
(dejada por un backend que tenía la opción) también se detiene de esta manera.
La adopción no escribe nada en disco, así que un backend que termina durante
ella deja la misma evidencia para el siguiente arranque. Con un emisor sin la
identidad aplicada del contrato 2, o un kernel sin SO_PEERPIDFD, la comprobación
rechaza, así que la opción solo cambia cómo se aloja el emisor.
