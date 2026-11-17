# Support log downloads

Settings → System Logs exports retained journal entries across boots, including
previous boots, for the last **7 days**, limited to the **newest 10,000 entries**
per download. The application download filters its service; the system download
does not. Each line shows a boot label, an ISO timestamp and its source. Boot
labels count back from the running boot: `[boot 0]` is this boot, `[boot -1]`
the one before it, and so on, using journald's own boot list, so a boot with no
shown record still counts; the header names such boots. If the running boot
has no records in the download, its newest boot is `[boot -1]`. Host names, raw boot ids are not included. Bounded process ids remain in OOM and systemd kill diagnostics.

## Limits

- Collection has a **15-second timeout** and a **10 MiB raw output ceiling**.
- If the history read times out, collection retries once for the current boot
  only, with the same limits. If the history exceeds 10 MiB, the single retry is
  the current boot's **newest 400 entries**, which always fit (the journal shows
  fields over 4096 bytes as empty, so one record stays near 25 KB). The file
  states this reduced scope. Two attempts share a 30-second timeout budget; the
  log RPCs allow 45 seconds for redaction and delivery. Other read failures do
  not retry.
- One download runs at a time. A second request while one is collecting gets a
  "already in progress" notice instead of a second journal read.
- Records over **8 KiB**, records the journal split at its line limit and the
  continuation that follows them are withheld before any shape is tried.
  `journalctl` prints a field over 4096 bytes as empty, which includes the
  first piece of such a split; the split is still recognised from its
  line-break marker, so the continuation is withheld too. Backend events over
  4 KiB (large stack traces, for example) are therefore withheld entirely.
- The redacted journal is clipped at 9 MiB with an explicit marker, leaving the
  complete file below 10 MiB. Partial raw output is never sent. Timeout, size,
  read and delivery failures have distinct fixed messages without exception
  text.

Only history still retained by the host journal is available. This does not
enable persistent journaling, restore vacuumed logs, or change disk retention.
A host with a volatile journal cannot supply previous boots.

## Carrier summary

The carrier summary uses existing observations, without running modem commands.
It discloses APN presence as `[custom APN]` and the IMEI's first eight digits
(the type allocation code, **TAC**, not a tracking area code), for at most 64 modems. Invalid or missing values are omitted; they
never imply a successful observation. Rows use export-local ordinals, not
subscriber, device or cell identities. The APN is a configured profile value,
not proof of the bearer actually used. The summary describes the current
snapshot, not the historical journal entries. If it fails, the journal still
downloads with an explicit summary-unavailable marker.

## What is included and what is withheld

The system download asks the journal only for the admitted sources, so the
10,000-entry budget is spent on candidate evidence: the CeraUI service,
ModemManager, NetworkManager, wpa_supplicant, hostapd, the kernel and systemd
itself (PID 1). A record is admitted only when both its unit and its command
name match, using fields journald sets from the sending process rather than
from the message. Other processes inside an admitted unit, such as the DHCP
server NetworkManager runs for the hotspot (it logs client host names), `pppd`,
`sudo` and audit records, are withheld. Runs of withheld records appear as one
counted marker, for example `[REDACTED 12 support log lines]`, and the file
header states how many records were shown and withheld. Downloading the log of
a unit outside this set yields only such markers.

**Every value in the file is typed.** The download carries no free text from a
record: only this code's own fixed text, members of closed vocabularies,
bounded numbers, interface names by the kernel naming grammar, and fixed
placeholders such as `[name]` or `[address]`. A value outside its vocabulary is
shown as its placeholder (`[state]`, `[reason]`, `[interface]`, `[process]`,
`[unit]`, `[value]`); the rest of the line stays.

ModemManager, NetworkManager, wpa_supplicant, hostapd and kernel lines must
match a **line shape**: state and registration changes, network rejections,
bearer and connection failure reasons, supplicant and hotspot events, USB
connect, disconnect, reset and over-current, undervoltage, OOM kills and
similar. The shapes are taken from the format strings the daemons log at info
level or above, for both generations devices run: Debian bookworm
(ModemManager 1.20, NetworkManager 1.42) and trixie (the CeraLive ModemManager
1.24 build, NetworkManager 1.52). Debug-only lines never reach the journal and
have no shape. ModemManager 1.24 logs only msg, warning and error by default;
on trixie the export also reads its lines that explain a failed connection (SIM
lock, failed PIN, enable, registration and attach failures, QMI call-end
reasons, `couldn't start IPv4/IPv6 network`, critical SIM errors).
NetworkManager runs the hotspot through wpa_supplicant, so access-point events
are read from wpa_supplicant as well as hostapd. A line that matches no shape
is withheld, so an unfamiliar line costs diagnosis, never privacy. Kernel text
must also match a kernel shape, because any root process can write to the
kernel log.

A recognised line is rebuilt from the shape's own text and typed fields:

- **Closed vocabularies from the producers' sources:** ModemManager modem,
  registration and packet-service states, access technologies, connect steps,
  lock types, network-rejection reasons, plugin names and D-Bus error names;
  NetworkManager device states, reasons, managed types, supplicant,
  connectivity and global states and device types; wpa_supplicant and hostapd
  states, ciphers and temporary-disable reasons; 802.11 reason names. They are
  generated from the Debian source packages (ModemManager 1.20.4/1.24.2, libqmi
  1.32.2/1.36.0/1.38.0, NetworkManager 1.42.4/1.52.1, wpa 2.10), whose SHA-256
  sums are recorded in the generated file
  (`apps/backend/scripts/support-daemon-vocabulary.ts`).
- **libqmi nicknames keyed by code:** a call-end reason, verbose call-end
  reason or QMI protocol error keeps its number, and its nickname only if it is
  libqmi's name for that number; otherwise `[reason]`.
- **Modem error text** after "couldn't …:" or "failed to connect modem:"
  keeps ModemManager's own fixed error phrases segment by segment (generated
  from its sources, `apps/backend/scripts/support-reason-vocabulary.ts`), valid
  D-Bus error names, QMI protocol errors valid for their code and libqmi
  call-end nicknames; the first other segment and everything after it become
  `[reason]`.
- **Numbers** in positions the shape names (signal, codes, counts, USB paths).
- **Interface names** only if they follow the kernel's naming grammar (`wlan0`,
  `wwan0mbim0`, `cdc-wdm0`, `ttyUSB2`, predictable names such as `enp1s0u1u2`,
  which are letter+digit pairs); any other name is `[interface]`.
- **Never copied:** addresses (`[address]`), network, connection, operator and
  USB product names (`[name]`), connection UUIDs and operator codes (`[id]`),
  USB serial numbers (`[serial]`). A kernel release keeps its version numbers
  (`6.1.0-28-[release]`); process names are kept only for the box's own
  processes, unit names only for its own and the admitted services.

systemd (PID 1) lines are rebuilt from systemd's grammar: unit transitions,
`Main process exited` with code and status (status names from systemd's
exit-status table), `Failed with result` (systemd's result names), killed
processes, consumed CPU time and restart counters. Units outside the box's own
and the admitted services are `[unit]`; a template instance is
`name@[instance]`.

Structured CeraUI events keep a message only if it is one this code writes. The
list of message texts is generated from the backend's logger calls, including
`logger["warn"](…)` element calls (`apps/backend/scripts/support-log-messages.ts`;
a test fails until it is regenerated, for messages, error texts and reasons
alike). **Every gap where the code interpolates a value is `[value]`**, unless
the text is a fixed token (a start-failure class or phase, a known state or
code); numbers and names inside a message never pass. The output therefore
depends only on the template, not on the runtime string, so a call that logs
runtime text matching a template cannot add anything. Values a helper needs
travel as typed metadata instead: error name and code, a **failure class**
(`timeout`, `missing-executable`, `permission`, `rejected-configuration`,
`network-unreachable`) set where a tool is run or derived from the error's name
and code, exit code, signal, a supervised process, interface name, known
states, bounded counts and timings, and for a stream start failure its class,
phase, capture cause and retry state. An error message is kept only if it is an
error text the code throws (gaps `[value]`), a fixed runtime text, or a
system-call error whose call and error code are real ones (`spawn
/usr/bin/srtla_send ENOENT`, `connect ECONNREFUSED [value]`); a tool's own
error text is `[value]`. A reason is kept only if it is a known code or a value
the code assigns. RPC traces keep a procedure only if it is in the RPC
contract. Unknown or nested fields, correlation ids and detached JSON fragments
are withheld, as is other plain text on the service's output. Command errors
from the backend's process runner mask secret-looking argument values (PINs,
passwords, keys, stream ids, accounts, `-u user:password`, URL credentials) in
their own message.

The fixture corpora in `apps/backend/src/tests/support/` are journal records
with the trusted fields set, run through the same renderer as the download:
lines that must never appear (including every value the reviews planted),
diagnostics that must survive, and a sample of
three incidents (a modem that does not connect, Wi-Fi that drops, a stream that
stops) for each daemon generation. The sample is assembled from the daemons'
format strings and the backend's own warn/error messages; it is not a device
capture. It checks that the evidence for those incidents survives (105 of 110
records on bookworm formats, 110 of 114 on trixie). It is not a measure of how
much of a real device journal is shown: a real journal holds many lines without
a shape, and those are withheld. Production writes backend events at warn level
and above, so info events do not appear in a download. A crafted record can
still choose among vocabulary members and numbers; it cannot put words into the
file. No unredacted export mode is offered. Configured APN text is always masked. Review exports before sharing. Existing authentication requirements still apply.

Normalized QMI/MBIM prefixes and libmbim status/protocol errors retain source-generated nicknames keyed by code. AP deauthentication/disassociation reasons, AP loss, beacon loss and network-not-found events are typed. Metadata timings are rounded to integer milliseconds; journal timestamps replace caller-supplied `ts`.

# Descargas de registros de soporte

En Configuración → Registros del sistema se exportan las entradas conservadas
de los **últimos 7 días**, incluidos los arranques anteriores, con un máximo de
**10 000 entradas recientes** por descarga. El registro de la aplicación filtra
su servicio; el del sistema no. Cada línea muestra una etiqueta de arranque, la
fecha ISO y su origen. Las etiquetas cuentan hacia atrás desde el arranque en
curso: `[boot 0]` es este arranque y `[boot -1]` el anterior, según la lista de
arranques de journald, así que un arranque sin entradas mostradas también cuenta
y la cabecera lo indica. Si el arranque en curso no tiene entradas en la
descarga, el más reciente es `[boot -1]`. No se
incluyen el nombre del equipo ni los identificadores de arranque. Los PID
acotados se conservan en los diagnósticos OOM y de terminación por systemd.

## Límites

- La recopilación tiene un límite de **15 segundos** y **10 MiB de salida sin
  procesar**.
- Si el historial agota el tiempo, se intenta una sola vez con el arranque
  actual, con los mismos límites. Si el historial supera 10 MiB, ese único
  intento recoge las **400 entradas más recientes** del arranque actual, que
  siempre caben (el registro muestra vacíos los campos de más de 4096 bytes). El
  archivo indica este alcance reducido. Ambos intentos comparten 30 segundos; las
  llamadas RPC permiten 45 segundos para redactar y entregar. Otros errores de
  lectura no se reintentan.
- Solo se ejecuta una descarga a la vez; una segunda solicitud recibe un aviso
  de que ya hay una en curso.
- Las entradas de más de **8 KiB**, las que el registro partió por su límite de
  línea y su continuación se retiran antes de probar ningún formato.
- El texto redactado se recorta a 9 MiB con una marca explícita; el archivo
  completo queda por debajo de 10 MiB. Nunca se envía una salida parcial sin
  redactar. Los errores tienen mensajes distintos, sin el texto de la excepción.

Solo se incluye el historial que el equipo conserve. No se activa la persistencia
del registro ni se recuperan registros borrados. Un registro volátil no conserva
los arranques anteriores.

## Resumen del operador

Se agrega un resumen de las observaciones actuales de hasta 64 módems: únicamente
la presencia del APN como `[custom APN]` y los primeros ocho dígitos
del IMEI, el código de asignación de tipo (**TAC**). No es el código de área de
seguimiento. Los datos ausentes o inválidos se omiten. El APN configurado no
confirma cuál usó la conexión. El resumen no describe conexiones históricas. Si
falla, el registro se descarga igualmente con una marca de resumen no disponible.

## Qué se incluye y qué se retira

La descarga del sistema solo pide al registro los orígenes admitidos, de modo
que las 10 000 entradas son posibles pruebas: el servicio de CeraUI,
ModemManager, NetworkManager, wpa_supplicant, hostapd, el kernel y el propio
systemd (PID 1). Una entrada se admite solo si coinciden la unidad y el nombre
del proceso, campos que fija journald y que un mensaje no puede falsificar. Los
demás procesos de una unidad admitida, como el servidor DHCP del punto de acceso
(registra los nombres de los clientes), `pppd`, `sudo` y la auditoría, se
retiran. Las series retiradas aparecen como una sola marca con su número, y la
cabecera indica cuántas entradas se muestran y cuántas se retiran.

**Cada valor del archivo tiene un tipo.** La descarga no copia texto libre de
ninguna entrada: solo el texto fijo de este código, miembros de vocabularios
cerrados, números acotados, nombres de interfaz según la gramática del kernel y
marcadores fijos como `[name]` o `[address]`. Un valor fuera de su vocabulario
aparece como su marcador (`[state]`, `[reason]`, `[interface]`, `[process]`,
`[unit]`, `[value]`) y el resto de la línea se conserva.

Las líneas de ModemManager, NetworkManager, wpa_supplicant, hostapd y el kernel
deben coincidir con un **formato de línea**: cambios de estado y de registro,
motivos de fallo, eventos del cliente Wi-Fi y del punto de acceso, eventos USB,
subtensión y OOM. Los formatos se toman de los mensajes que los servicios
registran a nivel info o superior en las dos generaciones que usan los equipos:
Debian bookworm (ModemManager 1.20, NetworkManager 1.42) y trixie (ModemManager
1.24 de CeraLive, NetworkManager 1.52). Una línea sin formato se retira: cuesta
diagnóstico, nunca privacidad. El texto del kernel también debe coincidir con un
formato.

Una línea reconocida se reconstruye con el texto del formato y campos con tipo:
estados, motivos, tecnologías de acceso, pasos de conexión, tipos de bloqueo,
nombres de error D-Bus, estados de NetworkManager, wpa_supplicant y hostapd y
nombres de motivo 802.11, todos de listas cerradas generadas a partir del código
fuente de Debian de cada servicio (con sus SHA-256 en el archivo generado). Los
motivos de fin de llamada y los errores de protocolo QMI conservan su número, y
su apodo solo si es el que libqmi da a ese número. El texto de error de un módem
solo conserva las frases fijas de ModemManager; el resto pasa a `[reason]`. Las
interfaces se muestran solo si siguen la gramática de nombres del kernel; si no,
`[interface]`. Nunca se copian direcciones, nombres de red, de conexión, de
operador ni de producto USB, UUID, códigos de operador ni números de serie. Las
líneas de systemd se reconstruyen con su gramática; las unidades ajenas pasan a
`[unit]` y los procesos desconocidos a `[process]`.

Un evento estructurado de CeraUI solo conserva un mensaje que este código
escribe (lista generada de las llamadas al registro). **Cada hueco donde el
código inserta un valor es `[value]`**, salvo un elemento fijo (clase o fase de
un fallo de inicio, un estado o código conocido); los números y nombres dentro de
un mensaje nunca pasan. Los valores útiles viajan como metadatos con tipo:
nombre y código del error, una **clase de fallo** (`timeout`,
`missing-executable`, `permission`, `rejected-configuration`,
`network-unreachable`), código de salida, señal, proceso supervisado, interfaz,
estados, contadores, tiempos y, en un fallo de inicio de emisión, su clase,
fase, causa de captura y estado de reintento. El texto de error de una
herramienta es `[value]`. Un error de sistema solo se conserva si su llamada y su
código son reales. Las trazas RPC conservan el procedimiento solo si está en el
contrato RPC. El resto del texto sin estructura del servicio se retira.

Los corpus de `apps/backend/src/tests/support/` son entradas del registro que
pasan por el mismo código que la descarga: lo que nunca debe aparecer, lo que
debe conservarse y una muestra de tres incidencias (un módem que no conecta, un
Wi-Fi que se cae, una emisión que se detiene) para cada generación, construida a
partir de los formatos de los servicios y de los avisos y errores del propio
backend (no es una captura de un equipo). Comprueba que esas pruebas se
conservan (105 de 110 entradas con bookworm, 110 de 114 con trixie); no mide
cuánto de un registro real se muestra, porque las líneas sin formato se
retiran. En producción el backend solo escribe avisos y errores. Una entrada
manipulada aún puede elegir entre valores de las listas y números, pero no
puede introducir palabras en el archivo. No hay modo sin redactar. El texto del APN siempre se oculta. Revisa el archivo antes de compartirlo. Se
mantiene la autenticación existente.

Los prefijos QMI/MBIM normalizados y los errores de estado/protocolo de libmbim conservan solo nombres generados del código fuente. Se conservan las causas de desautenticación/desasociación, pérdida del AP o de balizas y red no encontrada. Los tiempos se redondean a milisegundos enteros; se usa la fecha del registro en vez de `ts`.
