# Power status

CeraUI consumes schema 1 of the optional local power service at
`/run/ceralive/power/supervisor.json`. It only reads this snapshot. It never
opens the supervisor device, writes a command, changes power or controls a
stream. The event ring is diagnostic history and does not establish current
state.

The live page includes a plain power status line and collapsed Bank A, Bank B
and Reserve pack temperature details. It uses the existing sensor subscription.
A changing local Power sample marker refreshes delivery age even when readings
are unchanged; the live view requires that local marker; disconnected or stalled
clients show unavailable instead of retained warnings. Current warnings appear
as dismissible persistent notices on authenticated local browsers, including a
phone. Repeated samples do not re-toast; changed warning levels update the
notice and recovery retracts it. The sensor summary includes these same warnings
for remote moderators. Both remote transports receive a fresh power-only
snapshot (Power, Bank A, Bank B and Reserve pack) each second while connected
and authenticated; a remote send failure cannot interrupt local monitoring. This
dedicated fan-out does not wire the generic status relay. The initial legacy
relay snapshot retains existing hardware sensors but excludes the local Power
sample marker. Remote delivery is covered by fake peer and protocol tests;
deployed relay and phone qualification remains separate.

Freshness reads Linux CLOCK_MONOTONIC through Bun FFI clock_gettime from glibc,
never a process-relative clock or wall time. Clock failure gives unknown. Every
snapshot first requires a finite, non-negative integer publication heartbeat
with age in [0, 3000) ms, even before interpreting link or expected. Missing,
invalid, future or expired heartbeats and stopped writers show unavailable. A
current measurement must have schema 1, link ok, stale false, no ambiguous
device, and an age from zero up to but excluding 5000 ms. A killed or frozen
writer therefore expires at three seconds, independently of the five-second
status window. Missing, unreadable, corrupt, unsupported or stale snapshots
quietly show **Power data not available**, remove old readings and retract power
warnings. Missing services omit the power row. Only live absent snapshots omit
it when no board has been expected and the device is unambiguous. Silent,
bootloader and unknown-version snapshots retain the quiet unavailable row. A
frozen absent snapshot shows unavailable, never no board. Expected but
unavailable boards retain a quiet unavailable row.
Device-open errors distinguish permission denial, a busy device and other errno
values; marker persistence errors explain that readings continue while saving is
retried. Mock/development mode does not read the optional service or start the
poller.

Warnings describe power and the affected parts, without changing the stream's
live verdict. A running feed is described as still powered, not as evidence of
viewer delivery. The UI uses the supervisor's levels rather than duplicating
thermal thresholds. Missing fields remain unknown, including a missing primary
gaps field; older firmware may omit gaps2. A shutdown request needs no cause to
raise a notice. Unknown nonzero protection bits indicate reduced protection.
Estimated pack temperatures are labelled. Reported bank temperatures require a
present bank state. Normal bench and datasheet-estimate gap bits do not add
protection warnings; known gaps explain the specific limitation, and unknown
bits remain reduced protection. Resting bank notices suppress duplicate heat
and backup notices. No numeric thermal threshold is copied into UI logic. The
reader restart count includes boot changes and recovered same-boot sequence
regressions.

Rebooted supervisors replace the full state; retained data from before a host
reboot with a future monotonic timestamp is unavailable. No shutdown receipt
acknowledgments or persistent device writes are added.

## Estado de alimentación (es)

La lista de sensores muestra Alimentación, Banco A, Banco B y Reserva. Los
avisos indican qué parte necesita atención y qué sigue encendido. No cambian el
estado de la transmisión. Los moderadores remotos reciben el mismo resumen de
alimentación; el teléfono recibe avisos mientras CeraUI está abierto.

Si falta el latido del servicio, es inválido, está en el futuro o tiene tres
segundos de antigüedad, o el servicio está detenido, los datos no están
disponibles. Esto también se aplica cuando la última instantánea indica que no
hay placa. Si se espera una placa y faltan datos o tienen cinco segundos de
antigüedad, se muestra «Datos de alimentación no disponibles», sin alarma. Se
retiran las mediciones y los avisos anteriores. Si no hay servicio, o una
instantánea vigente y sin ambigüedad indica ausencia sin una placa esperada,
no se muestra la fila de alimentación. Los estados de silencio, cargador de
arranque y versión desconocida mantienen la fila de datos no disponibles. El
modo de desarrollo sigue funcionando. CeraUI solo lee los archivos del servicio:
no envía órdenes al dispositivo ni cambia su
alimentación. Las temperaturas estimadas se identifican como tales. Una falla
del canal remoto no interrumpe la supervisión local. La instantánea inicial del
canal remoto conserva los sensores de hardware existentes, pero excluye el
marcador local «Power sample».

## Localization

All power vocabulary has parameterized keys in all ten catalogs. The status row
and persistent notices resolve those keys through the existing facade; wire
strings retain English fallback compatibility. English and neutral LATAM Spanish
copy are supplied; the other eight catalogs initially use English fallback text
pending locale review. No new namespace is loaded eagerly.
