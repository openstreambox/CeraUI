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
Every backend start seeds a separate two-minute checking window. It reports
unknown, never carrying without real evidence, and ambient keep-level traffic
cannot extend it. A restart therefore cannot lose the remaining protection.
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
