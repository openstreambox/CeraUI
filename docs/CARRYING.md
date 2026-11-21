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

A restarted backend checks whether a sender its predecessor left running could
be adopted, and on this version it never adopts one. The check reads, in order:
the lifetime record from this boot; the process at the recorded PID with the
recorded start time, name, executable and arguments, running and not stopped;
a host that outlives the backend (its own systemd unit) with the live invocation
matching the record, the sender alone in that cgroup with no child cgroups, and
alone in its own process group; the armed stream's configuration equal to the
current one; the published map equal to the map on disk; the control socket
held by that same PID. Only then does it read the socket twice (map applied,
the same links, a connected link, a moving byte counter), and only then would it
ask the engine. Three facts have no source yet, so the check always refuses at
one of them: the unit's live invocation, the map generation and SHA the sender
has applied, and an identity for the engine session. A refusal is logged with
the first failing check and changes nothing; no socket is read and the engine is
not asked before the local facts agree, so startup is unchanged. Today the
sender also runs inside the backend's own service and dies with it.

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

Un backend reiniciado comprueba si podría adoptar un emisor que su predecesor
dejó en marcha, y en esta versión nunca adopta ninguno. La comprobación lee, en
orden: el registro de vida de este arranque; el proceso con el PID registrado,
con la hora de inicio, el nombre, el ejecutable y los argumentos registrados, en
ejecución y no detenido; un anfitrión que sobrevive al backend (su propia unidad
de systemd) cuya invocación actual coincide con el registro, con el emisor solo
en ese cgroup, sin cgroups hijos, y solo en su propio grupo de procesos; la
configuración de la transmisión armada igual a la actual; el mapa publicado igual
al del disco; el socket de control en manos de ese mismo PID. Solo entonces lee
el socket dos veces (mapa aplicado, los mismos enlaces, un enlace conectado, un
contador de bytes que avanza), y solo entonces consultaría al motor. Tres datos
todavía no tienen fuente, así que la comprobación siempre se rechaza en uno de
ellos: la invocación actual de la unidad, la generación y el SHA del mapa que el
emisor ha aplicado, y una identidad para la sesión del motor. Un rechazo se
registra con la primera comprobación que falló y no cambia nada; no se lee ningún
socket ni se consulta al motor antes de que coincidan los datos locales, así que
el arranque no cambia. Hoy el emisor además corre dentro del propio servicio del
backend y termina con él.
