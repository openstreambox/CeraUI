# Power status

CeraUI consumes schema 1 of the optional local power service at
`/run/ceralive/power/supervisor.json`. It only reads this snapshot. It never
opens the supervisor device, writes a command, changes power or controls a
stream. The event ring is diagnostic history and does not establish current
state.

The live page includes a plain power status line and collapsed Bank A, Bank B
and Reserve pack temperature details. It uses the existing sensor subscription.
A changing local Power sample marker refreshes delivery age even when readings
are unchanged; remote power-only deliveries refresh their own delivery age;
disconnected or stalled clients show unavailable instead of retained warnings.
Current warnings appear as dismissible persistent notices on authenticated local
browsers, including a phone. Repeated samples do not re-toast; changed warning
levels update the notice and recovery retracts it. The sensor summary includes
these same warnings for remote moderators. Both remote transports receive a
fresh power-only snapshot (Power, Bank A, Bank B and Reserve pack) each second
while connected and authenticated; a remote send failure cannot interrupt local
monitoring. This dedicated fan-out does not wire the generic status relay.
Remote delivery is covered by fake peer and protocol tests; deployed relay and
phone qualification remains separate.

Freshness reads Linux CLOCK_MONOTONIC through Bun FFI clock_gettime from glibc,
never a process-relative clock or wall time. Clock failure gives unknown. A
sample must have schema 1, link ok, stale false, no ambiguous device, and an age
from zero up to but excluding 5000 ms. A killed writer therefore expires
independently. Missing, unreadable, corrupt, unsupported or stale snapshots
quietly show **Power data not available**, remove old readings and retract power
warnings. Missing services and absent boards that have never been expected omit
the power row. Expected but unavailable boards retain a quiet unavailable row.
Device-open errors distinguish permission denial, a busy device and other errno
values; marker persistence errors explain that readings continue while saving is
retried. Mock/development mode does not read the optional service or start the
poller.

Warnings describe power and the affected parts, without changing the stream's
live verdict. A running feed is described as still powered, not as evidence of
viewer delivery. The UI uses the supervisor's levels rather than duplicating
thermal thresholds. Missing fields remain unknown. Unknown nonzero protection
bits indicate reduced protection. Estimated pack temperatures are labelled.
Reported bank temperatures require a present bank state. Normal bench and
datasheet-estimate gap bits do not add protection warnings; known gaps explain
the specific limitation, and unknown bits remain reduced protection. Resting-
bank notices suppress duplicate heat and backup notices. No numeric thermal
threshold is copied into UI logic. The reader restart count includes boot
changes and recovered same-boot sequence regressions.

Rebooted supervisors replace the full state; retained data from before a host
reboot with a future monotonic timestamp is unavailable. No shutdown receipt
acknowledgments or persistent device writes are added.

## Estado de alimentación (es-419)

La lista de sensores muestra Alimentación, Banco A, Banco B y Reserva. Los
avisos indican qué parte necesita atención y qué sigue encendido. No cambian el
estado de la transmisión. Los moderadores remotos reciben el mismo resumen de
alimentación; el teléfono recibe avisos mientras CeraUI está abierto.

Si se espera una placa y faltan datos o tienen cinco segundos de antigüedad, se
muestra «Datos de alimentación no disponibles», sin alarma. Se retiran las
mediciones y los avisos anteriores. Si no hay servicio o nunca se ha detectado
una placa, no se muestra la fila de alimentación. El modo de desarrollo sigue
funcionando. CeraUI solo lee los archivos del servicio: no envía órdenes al
dispositivo ni cambia su alimentación. Las temperaturas estimadas se identifican
como tales. Una falla del canal remoto no interrumpe la supervisión local.

## Localization

All power vocabulary has parameterized keys in all ten catalogs. The status row
and persistent notices resolve those keys through the existing facade; wire
strings retain English fallback compatibility. English and neutral LATAM Spanish
copy are supplied; the other eight catalogs initially use English fallback text
pending locale review. No new namespace is loaded eagerly.
