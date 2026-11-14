# Heat adjustments during a stream

A warm device asks for airflow. Sustained SoC heat can reduce the live bitrate
ceiling to 75%, then 50% of your chosen maximum. The floor is 2 Mbit/s,
but a ceiling never increases your chosen bitrate. Adaptive bitrate still works
below that ceiling. Open the bag or find shade.

**Keep quality** requests your chosen maximum until the stream ends. A known
critical temperature retains the critical safety ceiling. Heat warnings stay
visible. It cannot override kernel thermal protection or independent power
protection. The saved bitrate stays unchanged. Stopping the stream or restarting
the backend clears this session policy. A short loss of the engine's control
connection does not: the ceiling, Keep quality and the history carry on with
the same stream.

Some sources cannot lower their bitrate (passthrough or a fixed-rate source).
The panel then says so instead of claiming a cap. It shows the maximum the
engine reports it applied.

The live panel includes a bounded session history of confirmed ceiling changes.
An unavailable SoC reading pauses automatic changes and recovery; it does not
mean the device is cool. Missing modem readings block recovery while SoC heat
can still raise the stage. A reading outside −20…125 °C, or a thermal zone that
reads exactly 0, counts as unavailable; the supervisor parser uses the same
range. One unreadable sample pauses the cool-down timer without restarting it;
more than 5 s without a readable sample restarts it. A failed engine change is
reported without claiming it was applied; it is retried after 5 s, doubling up
to 60 s, and logged once rather than every second. Any confirmed send of the
session ceiling, including one that follows your own bitrate change, clears
that warning and the backoff.

The 1 s sensor loop never waits on the engine or the modems. At most one heat
change is in flight and it always sends the latest ceiling. Modem temperature
reads run in the background, one per modem at a time. A stream that survived a
backend restart is adopted first; the reset to your maximum follows as a
best-effort call. If the engine rejects it, it is retried with the same backoff
even while the temperature is unavailable, because it only repeats your own
maximum. Keep quality switched on while another change is in flight is applied
as soon as that change answers, also while the temperature is unavailable.
Rejection retains this explicit request and retries on sensor ticks with the
same 5–60 s backoff, including unreadable ticks. Turning Keep quality off
cancels that request; no automatic recovery runs without temperature evidence.
A successful restoration clears the warning and stops further sends.

## Implementation boundary

HEAT_SETTINGS in heat-ladder.ts owns proposed ordering, cap percentages,
floor, trigger temperatures, filter/dwell, hysteresis, minimum hold, reverse undo,
flap stop and override duration. Spare-link policy has a memory-only actuator
with fail-closed capacity admission.
Resolution remains a future offer.
The critical ceiling remains until the hot step can be undone, restoring the
operator maximum in one step rather than gradually raising quality.

The existing real SoC reader feeds the pure reducer. A missing reading clears
the previous sensor value. Supervisor OSB1 parsing remains fixture-tested.
Pack and bank thresholds await transport admission. Modem thresholds use QTEMP.
Physical thermal savings and streamer-visible encoder behavior still need
hardware measurement.

The supervisor parser accepts appended sequence, boot/reset, alive-pin, hottest
probe, shutdown-counter and firmware fields. Unknown future keys are ignored.
When present, the final CRC-16/CCITT-FALSE field must match the exact UTF-8 bytes
before it. Legacy lines without CRC remain readable; a future transport must
require a verified checksum before trusting newly connected hardware. No such
transport is installed by this change.

## Modem temperature and spare links

RM520N-GL temperature is sampled with read-only AT+QTEMP every ten seconds, only
while a stream runs, on the modem's second AT port, the one
`ceralive-modem-support` releases from ModemManager (see
[FREE-AT-PORT.md](FREE-AT-PORT.md)). Stock ModemManager answers
`mmcli --command` only in debug mode, which restarts it and opens every AT
command to every authorised caller, so the reader does not use it, and it never
inhibits the modem. A reply counts only after its complete final OK. Known
sensors contribute their hottest valid reading; ERROR, a timeout, unknown
sensors, malformed readings and values outside −20…125 °C supply no modem
trigger. Proposed modem levels are 65/70/75 °C in HEAT_SETTINGS.

**When the port is not available.** The port is used only when it is released in
udev, ModemManager does not list it as its own, and no other process holds it.
Otherwise that modem is not read: the reason (for example `not-released` or
`owned-by-modemmanager`) is logged once, the port is looked at again every ten
minutes without anything being sent, and if no modem can be read the heat panel
says "Modem temperature isn't available on this box. Heat steps use the SoC
temperature." The SoC input works either way.

Expectation is per modem. A modem that has given readings and then goes quiet
blocks cooling, while SoC heat can still raise the stage; a modem that is
unplugged, or that never answered, leaves no expectation behind. An implausible
modem value is missing evidence for that modem only and never pauses the SoC
input.

A separate memory-only bond exclusion supports one spare modem. Admission needs
two other healthy links, each with at least 30% known spare capacity, and the
engine must have applied the bitrate cap first (a source that kept its rate
rests no link). This branch has no capacity source, so admission stays closed
and the panel says capacity is unknown; it names capacity only when that is the
reason. The return check runs on every sensor tick and on every link change,
also while a heat change is failing or pending and while the engine's control
connection is down. Keep quality and stream/session cleanup remove the
exclusion. Saved bond preferences are independent, and the cellular panel shows
a resting link as resting for heat, not as switched off. On cooling, the link
returns before the ceiling is removed at the next reverse step.

The OSB1 fixture parser also exposes pack calibration, start reason and the full
16-bit protection-gap mask. Every nonzero mask, including future bits, reports
reduced protection, and so does a gaps field that is present but malformed. Datasheet calibration (including pack flag 10) is explicit.
The fixture/source seam expires its display after five seconds and supplies no
supervisor temperatures to the reducer until a transport owns freshness/epoch.

The additional four-hex-digit `gaps2` mask follows the same rule: unknown bits
and malformed fields mean reduced protection. Bit 0001 reports that the board's
65 °C reserve-pack cut-off is paused because supply cannot be confirmed. Bit
0002 or pack flag 40 reports a sudden temperature jump delaying the cut-off
for up to a minute. Both reasons reach heat status and the panel independently
of stream heat stage; neither says that the stream stopped. Legacy frames
without `gaps2` remain accepted. The extended CRC fixture verifies 296D.

## Idle USB Wi-Fi at warm

At the warm step, a proven USB Wi-Fi adapter may be lowered with `ip link set dev <interface> down`. This is per-interface rather than rfkill, which can
silence a sibling AP. Admission requires one interface on the physical radio,
no active NetworkManager connection, no bond membership, no hotspot or upper
virtual interface, no IPv4
or IPv6 address (including link-local), and no route in any table. Failed or
unknown observations leave it alone. An onboard radio never qualifies.

Only an interface lowered by this owner is raised. Cooling uses the existing
ladder dwell and hysteresis. A Wi-Fi action wakes it under the adapter lock
before dispatch, a bond request wakes it, and newly observed use wakes it even
with unknown temperature. Hotplug identity includes sysfs device path and
ifindex. A demand prevents another rest until the next known normal stage.
Keep quality does not disable this invisible step. The existing single warm
notice remains: “The box is warm. Give it air.” Actions log their method and
reason; they do not claim the stream stopped. This is link administration,
not USB power switching; power savings remain unmeasured.

A root-private record under `/run/ceralive` is saved atomically before lowering
the link. A backend restart first restores matching recorded links, even if
warm; boot identity fences stale records after reboot. A failed record write
prevents a new rest. Temperature and interface evidence are rechecked before
the command; a pending wake survives failed observations or commands.
Recovery attempts each owned radio independently: an unplugged radio or failed
link-up retains its pending ownership without blocking later radios. Failures
are reported together after the recovery attempts, before admitting new rest.

## Carrying without an encoder

The carrying-only sensor path has its own SoC heat reducer with the same dwell,
minimum hold and cooling hysteresis. It does not call the encoder or cap the
phone's bitrate. Warm can rest a positively unused USB radio through the existing
journal/adapter-lock owner; unknown carrying is a final veto before link-down.
The hot notice keeps the phone's links available while capacity is checked.

`planLinkBoxHeat` specifies the remaining order: lend one link fewer at hot,
then pause other hotspot clients at critical. Its measured-share session policy
protects the largest leg, large legs and
the phone uplink, requires two healthy peers with proven spare rate, and
protects the phone and management clients. A legacy main-link label or
headroom snapshot alone cannot authorize either step. Stale, duplicate or
absent identity and capacity evidence withholds those steps. Keep quality
withdraws both visible
restrictions while permitting an unused USB radio to rest.

**Runtime boundary:** this topic has no complete measured-share producer or
native lending adapter. The per-client pause primitive remains dormant. Lending
and client pause are policy only;
they are not applied to live traffic. The runtime keeps every used link and
client available. Do not connect this planner to saved bond opt-outs, stop the
hotspot, or infer the main path from interface names or carrying alone. A future
owner must re-read evidence under its mutation lock and restore owned exclusions
on lost evidence, demand or Keep quality before enabling those effects. No
thermal savings or driver behavior has been measured.

### Español (Latinoamérica)

Cuando la caja transporta tráfico del teléfono sin codificar, usa los mismos
umbrales y tiempos de enfriamiento. Puede dejar descansar una radio USB que se
haya confirmado sin uso. Nunca cambia la tasa de bits del teléfono. El orden
previsto después es prestar un enlace menos y luego pausar a otros clientes del
punto de acceso, conservando el teléfono y la administración. Sin datos completos
de uso por enlace,
capacidad medida y adaptadores que confirmen cada efecto,
esos dos pasos no se aplican al tráfico. El aviso pide ventilación y mantiene
los enlaces disponibles; no afirma que terminó la transmisión.

## Measured-share link-box policy (mock source only)

All numerical thresholds in this policy are proposals, not hardware measurements.

`heat-link-box-share.ts` adds the session policy and an injected effect-owner
boundary. It sits above the carrying-only warm step and the bounded client
lease. It does not register a production producer, a native effect adapter or
new UI. The current notification and hardware behavior remain unchanged.

The policy uses the existing SoC thresholds, ten-second entry dwell,
five-minute hold, sixty-second cooling dwell and two-minute reverse steps.
It admits a loan only after sixty continuous seconds of fresh observations:
leg counters no older than two seconds, stream observations no older than
three, SoC observations no older than two seconds, a candidate share at most
15%, two healthy peers, and proven spare rate
of at least 130% of the candidate's traffic. Loss must be at most 2%, and RTT
at most 150% of its own five-minute median. The stream must remain within 5%
of its sixty-second rate and 130% of its median RTT. Never count the phone's
own cellular as capacity. The producer must include the phone's routed flow in
leg rate and identify its current hotspot uplink; a relay-only counter is not
a complete snapshot and must not be supplied here.

The largest leg and every leg carrying at least 40% are protected. A previously
large leg must stay below 30% for sixty seconds before starting the candidate
dwell. The phone uplink and recovering legs are always protected. Candidate
ranking prefers the hottest known modem, then the smallest rate, then stable
identity. Unknown temperatures sort last; they do not manufacture a reading.

A 15% stream-rate fall restores the loan immediately. Stream RTT at 150% of
its pre-loan value, peer loss above 5%, or peer RTT at twice its median trigger
rollback after five continuous seconds. These checks continue throughout the
loan, including its first thirty seconds. Peer dropout, new phone-uplink use,
large-leg protection, session change, stream end, encoder takeover, Keep
quality and unknown traffic observations release restrictions immediately. Failed
loans lock that link for fifteen minutes; two rollbacks disable lending for
the session. Thermal-only missing, invalid or stale readings hold existing
restrictions for up to three seconds, then restore without spending that rollback
budget or imposing a link lock. No new loan or pause starts during the grace;
stream rollback and client protection checks continue. A fresh thermal reading
ends the grace. This avoids repeated undo/redo on isolated missed samples.
Unknown observations reset admission dwell and large-leg release dwell.

Client identity must be cross-checked by the producer against the authenticated
streamer and the data plane. Only a bound, IPv4-only client that joined at
least two minutes ago qualifies. The phone, management sessions, possible
streamers, receiver-directed traffic, recent carrying and ambiguous clients
remain online. A candidate must exceed 100 kbit/s over the last sixty seconds.
The busiest eligible client is selected. After lifting a client, wait two minutes
before pausing another; pauses also have at least two minutes between starts.
Let back on exempts that client for
the session; any other release locks it for ten minutes.

Conservative choices pending review: at most one client may be paused (the
existing lease owns one target); a pause follows a loan, rather than preceding
it when lending is withheld; unknown traffic measurements undo immediately,
while thermal-only gaps have the three-second grace described above. The design
allows pauses without lending, including
when stream statistics
are missing (C6). This draft deliberately withholds both: the mock owner has
no separate pause-only admission and rollback contract yet. That integration
must be reviewed before enabling independent pauses. There is no
phone protocol extension, saved opt-out, radio power-down or AP shutdown.

`LinkBoxHeatSession` serializes effects and rechecks current admission at the
owner's mutation boundary. Only acknowledged actions enter its status. Client
release precedes link return; pending return blocks new restrictions and is
retried. A real return adapter must bound each attempt to ten seconds and
confirm relay identity, open tunnel and flowing ACKs before returning true.
A real pause adapter must renew the existing five-second kernel lease only
while its supplied predicate still holds. Neither adapter exists in production
on this topic; tests inject memory-only owners and synthetic thermal sequences.
The plain status copy is a contract for later UI integration, not a rendered
screen. When only temperature is unknown and restrictions have been restored,
status names the missing temperature reading rather than blaming stream data.
Reasons are retained in a bounded local timeline, not repeated notices.

Thermal timestamps must come from the sensor observation, never from polling a
cached number. USB owners receive eligibility and known-temperature separately,
including while a link return is pending. Admission rechecks use a copy of policy
state, so checking permission cannot spend rollback budget or advance dwell.

### Español (Latinoamérica): política con datos simulados

La política agrega pasos reversibles sin activar efectos nuevos en producción.
Primero permite descansar una radio USB sin uso; después presta un enlace menos
y, con calor crítico, permite pausar un solo cliente adicional. Nunca reduce
la tasa del teléfono ni cambia sus preferencias guardadas.

Protege el enlace más usado, los enlaces grandes, la salida Wi-Fi del teléfono,
los enlaces en recuperación, el teléfono, los posibles emisores y los clientes
de administración o de identidad incierta. Exige datos recientes, capacidad
comprobada y sesenta segundos continuos de condiciones seguras. Si faltan los
datos o empeora la transmisión, retira las restricciones. Al enfriarse, libera
primero al cliente y después devuelve el enlace, con los tiempos de espera de
la escala térmica. «Dejar entrar» protege al cliente durante esa sesión.

Solo se prueban fuentes térmicas y controladores simulados. No hay nuevos
contadores reales, integración visual ni activación del controlador de pausa.
Antes de activarlo se necesitan mediciones completas del tráfico y adaptadores
que confirmen cada acción y restauración. Las cifras son propuestas sin
mediciones de ahorro térmico.

Español (Latinoamérica): la lectura térmica lleva su hora de observación; una
lectura de más de dos segundos es desconocida. Una falta solo térmica devuelve
las restricciones después de tres segundos continuos, sin gastar los dos
intentos de protección de la transmisión. Durante esa espera conserva los pasos
actuales, no agrega otros y sigue comprobando la transmisión y los clientes
protegidos. Una lectura válida termina la espera; así una lectura aislada perdida
no corta y restablece repetidamente un enlace ni el internet de un invitado.
Si solo falta la temperatura, el estado indica esa lectura ausente y no atribuye
el problema a los datos de transmisión.
Después de liberar un cliente, espera dos minutos antes de pausar otro.
El diseño permite pausar sin retirar un enlace, incluso sin estadísticas de
transmisión (C6); este borrador exige ambas cosas juntas hasta revisar un
contrato independiente de admisión y restauración para la pausa.
